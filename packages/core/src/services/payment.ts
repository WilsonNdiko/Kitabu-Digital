/**
 * Payment service — recording, verification, rejection, reversal
 * (docs/FINANCIAL-LEDGER.md §4).
 *
 * State machine (enforced by DB triggers AND the service):
 *
 *   PENDING ──► VERIFYING ──► VERIFIED ──► REVERSED
 *     │             │             ▲
 *     └─────────────┴──► REJECTED │ (rejected/terminal)
 *
 * - Only VERIFIED payments post a PAYMENT_CREDIT ledger entry + allocations.
 * - A counted-cash payment by the OWNER verifies immediately (cash counted = trusted).
 * - M-Pesa codes are evidence, never proof: they stay PENDING until verified
 *   (M2: manually by the owner after checking; M7: by the Daraja provider).
 * - Corrections are reversals — verified payments are never edited.
 */

import type { ServiceContext } from './context.ts';
import { currentUserRole, requireRole } from './context.ts';
import { appendAudit, recordOp, stampNew, stampUpdate } from './mutations.ts';
import { insertRow, updateRow } from '../db/crud.ts';
import type { LedgerEntryRow, PaymentMethod, PaymentRow, ReceiptRow, TenancyRow } from '../domain/types.ts';
import { PAYMENT_METHODS } from '../domain/types.ts';
import { isValidIsoDate } from '../foundation/clock.ts';
import { domainRule, validationError } from '../foundation/errors.ts';
import { formatKsh } from '../foundation/money.ts';
import { voidReceiptTx } from './receipt.ts';

export interface RecordPaymentInput {
  tenancyId: string;
  amountMinor: number;
  method: PaymentMethod;
  /** Date the tenant paid (YYYY-MM-DD). */
  paidAt: string;
  /** M-Pesa code / bank slip reference. Required for M-Pesa. */
  reference?: string;
  payerName?: string;
}

export class PaymentService {
  readonly ctx: ServiceContext;

  constructor(ctx: ServiceContext) {
    this.ctx = ctx;
  }

  // -- reads -------------------------------------------------------------------

  getPayment(id: string): PaymentRow {
    const row = this.ctx.db
      .prepare('SELECT * FROM payments WHERE id = ? AND org_id = ? AND deleted_at IS NULL')
      .get(id, this.ctx.orgId) as PaymentRow | undefined;
    if (row === undefined) throw domainRule('Payment not found.');
    return row;
  }

  listPayments(input: {
    tenancyId?: string;
    propertyId?: string;
    status?: PaymentRow['status'];
    method?: PaymentMethod;
    month?: string;
    limit?: number;
  } = {}): PaymentRow[] {
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
    const clauses = ['org_id = ?', 'deleted_at IS NULL'];
    const params: string[] = [this.ctx.orgId];
    if (input.tenancyId !== undefined) {
      clauses.push('tenancy_id = ?');
      params.push(input.tenancyId);
    }
    if (input.propertyId !== undefined) {
      clauses.push('property_id = ?');
      params.push(input.propertyId);
    }
    if (input.status !== undefined) {
      clauses.push('status = ?');
      params.push(input.status);
    }
    if (input.method !== undefined) {
      clauses.push('method = ?');
      params.push(input.method);
    }
    if (input.month !== undefined) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) throw validationError('Use a month like 2026-09.');
      clauses.push('substr(paid_at, 1, 7) = ?');
      params.push(input.month);
    }
    return this.ctx.db
      .prepare(`SELECT * FROM payments WHERE ${clauses.join(' AND ')} ORDER BY paid_at DESC, created_at DESC LIMIT ?`)
      .all(...params, String(limit)) as PaymentRow[];
  }

  /** The verification queue: payments awaiting a decision (caretaker submissions). */
  pending(input: { propertyId?: string } = {}): PaymentRow[] {
    const params: string[] = [this.ctx.orgId];
    let propertyFilter = '';
    if (input.propertyId !== undefined) {
      propertyFilter = 'AND property_id = ?';
      params.push(input.propertyId);
    }
    return this.ctx.db
      .prepare(
        `SELECT * FROM payments WHERE org_id = ? AND status IN ('PENDING','VERIFYING') AND deleted_at IS NULL ${propertyFilter}
         ORDER BY paid_at ASC`,
      )
      .all(...params) as PaymentRow[];
  }

  /** The credit entry a payment posted (null while unverified). */
  creditEntryFor(paymentId: string): LedgerEntryRow | null {
    const row = this.ctx.db
      .prepare("SELECT * FROM ledger_entries WHERE payment_id = ? AND entry_type = 'PAYMENT_CREDIT' AND deleted_at IS NULL")
      .get(paymentId) as LedgerEntryRow | undefined;
    return row ?? null;
  }

  // -- writes --------------------------------------------------------------------

  /**
   * Record a payment. Cash recorded by the OWNER verifies immediately (counted
   * money); everything else stays PENDING until verified. Duplicate M-Pesa/bank
   * references per organization are impossible (friendly check + DB unique index).
   */
  recordPayment(input: RecordPaymentInput): PaymentRow {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw validationError('Enter the payment amount as a positive amount.');
    }
    if (!PAYMENT_METHODS.includes(input.method)) throw validationError('Choose Cash, M-Pesa, Bank or Other.');
    if (!isValidIsoDate(input.paidAt)) throw validationError('The payment date is not a valid date.');

    let reference: string | null = null;
    if (input.reference !== undefined && input.reference.trim() !== '') {
      reference = input.reference.trim().toUpperCase().replace(/\s+/g, '');
    }
    if (input.method === 'MPESA' && reference === null) {
      throw validationError('Enter the M-Pesa code from the confirmation message.');
    }

    return this.ctx.db.transaction(() => {
      const tenancy = this.#tenancy(input.tenancyId);

      if (reference !== null) {
        const duplicate = this.ctx.db
          .prepare('SELECT id FROM payments WHERE org_id = ? AND method = ? AND reference = ? AND deleted_at IS NULL')
          .get(this.ctx.orgId, input.method, reference) as { id: string } | undefined;
        if (duplicate !== undefined) {
          throw domainRule(
            `This ${input.method === 'MPESA' ? 'M-Pesa code' : 'reference'} (${reference}) has already been recorded.`,
          );
        }
      }

      // Only the owner's counted cash verifies on recording (SECURITY.md §3).
      const role = currentUserRole(this.ctx);
      const autoVerify = input.method === 'CASH' && role === 'OWNER';

      const stamp = stampNew(this.ctx);
      const payment: PaymentRow = {
        ...stamp,
        tenancy_id: tenancy.id,
        property_id: tenancy.property_id,
        unit_id: tenancy.unit_id,
        tenant_id: tenancy.tenant_id,
        amount_minor: input.amountMinor,
        method: input.method,
        paid_at: input.paidAt,
        reference,
        payer_name: input.payerName?.trim() || null,
        status: autoVerify ? 'VERIFIED' : 'PENDING',
        verified_at: autoVerify ? this.ctx.clock.nowIso() : null,
        verified_by_user_id: autoVerify ? this.ctx.userId : null,
        verification_note: null,
        reversal_reason: null,
        recorded_by_user_id: this.ctx.userId,
        recorded_by_device_id: this.ctx.deviceId,
      };
      insertRow(this.ctx.db, 'payments', payment);
      recordOp(this.ctx, 'payments', payment);

      appendAudit(this.ctx, {
        action: 'PAYMENT_RECORDED',
        entityType: 'payment',
        entityId: payment.id,
        summary: `${formatKsh(input.amountMinor)} ${methodName(input.method)} payment recorded for ${this.#tenantName(tenancy)}${autoVerify ? ' (cash counted — verified)' : ''}.`,
        after: { ...payment },
      });

      if (autoVerify) {
        this.#postCreditAndAllocate(payment);
      }
      return payment;
    });
  }

  /**
   * Verify a payment (Owner checks the M-Pesa message / bank slip / caretaker's cash).
   * M7 replaces the manual check with provider verification — same transition.
   */
  verifyPayment(paymentId: string, note?: string): PaymentRow {
    requireRole(this.ctx, ['OWNER'], 'verify a payment');

    return this.ctx.db.transaction(() => {
      const payment = this.getPayment(paymentId);
      if (payment.status === 'VERIFIED') throw domainRule('This payment is already verified.');
      if (payment.status === 'REJECTED' || payment.status === 'REVERSED') {
        throw domainRule('This payment is closed. Record a new payment if needed.');
      }

      const before = { ...payment };
      stampUpdate(this.ctx, payment);
      payment.status = 'VERIFIED';
      payment.verified_at = this.ctx.clock.nowIso();
      payment.verified_by_user_id = this.ctx.userId;
      payment.verification_note = note?.trim() || null;
      updateRow(this.ctx.db, 'payments', payment);
      recordOp(this.ctx, 'payments', payment);

      this.#postCreditAndAllocate(payment);

      appendAudit(this.ctx, {
        action: 'PAYMENT_VERIFIED',
        entityType: 'payment',
        entityId: payment.id,
        summary: `${formatKsh(payment.amount_minor)} ${methodName(payment.method)} payment verified for ${this.#tenantName(this.#tenancy(payment.tenancy_id))}.`,
        before,
        after: { ...payment },
      });
      return payment;
    });
  }

  /** Reject a pending payment (wrong code, amount mismatch…). Posts nothing. */
  rejectPayment(paymentId: string, reason: string): PaymentRow {
    requireRole(this.ctx, ['OWNER'], 'reject a payment');
    const why = reason.trim();
    if (why === '') throw validationError('Give a reason for rejecting this payment.');

    return this.ctx.db.transaction(() => {
      const payment = this.getPayment(paymentId);
      if (payment.status !== 'PENDING' && payment.status !== 'VERIFYING') {
        throw domainRule('Only a pending payment can be rejected. Reversed? Use reversal instead.');
      }

      const before = { ...payment };
      stampUpdate(this.ctx, payment);
      payment.status = 'REJECTED';
      payment.verification_note = why;
      updateRow(this.ctx.db, 'payments', payment);
      recordOp(this.ctx, 'payments', payment);

      appendAudit(this.ctx, {
        action: 'PAYMENT_REJECTED',
        entityType: 'payment',
        entityId: payment.id,
        summary: `${formatKsh(payment.amount_minor)} payment rejected: ${why}.`,
        before,
        after: { ...payment },
      });
      return payment;
    });
  }

  /**
   * Reverse a VERIFIED payment — the only correction path (FINANCIAL-LEDGER.md §5).
   * Posts an opposite REVERSAL entry, keeps every original row, voids the receipt.
   */
  reversePayment(paymentId: string, reason: string): { payment: PaymentRow; reversal: LedgerEntryRow } {
    requireRole(this.ctx, ['OWNER'], 'reverse a payment');
    const why = reason.trim();
    if (why === '') throw validationError('Give a reason for the reversal — it is kept in the audit trail.');

    return this.ctx.db.transaction(() => {
      const payment = this.getPayment(paymentId);
      if (payment.status !== 'VERIFIED') {
        throw domainRule('Only a verified payment can be reversed. Pending payments can be rejected instead.');
      }

      const credit = this.creditEntryFor(payment.id);
      if (credit === null) throw domainRule('This payment has no posted credit to reverse.');

      const tenancy = this.#tenancy(payment.tenancy_id);

      // 1. Reversal ledger entry (opposite direction, linked to the credit).
      const stamp = stampNew(this.ctx);
      const reversal: LedgerEntryRow = {
        ...stamp,
        tenancy_id: tenancy.id,
        property_id: tenancy.property_id,
        unit_id: tenancy.unit_id,
        tenant_id: tenancy.tenant_id,
        entry_date: this.ctx.clock.today(),
        entry_type: 'REVERSAL',
        direction: 'DEBIT',
        amount_minor: payment.amount_minor,
        kind: 'OTHER',
        period: null,
        payment_id: payment.id,
        reversal_of: credit.id,
        reason: why,
        note: `Reversal of ${methodName(payment.method)} payment`,
        source: 'MANUAL',
        posted_by_user_id: this.ctx.userId,
        posted_by_device_id: this.ctx.deviceId,
      };
      insertRow(this.ctx.db, 'ledger_entries', reversal);
      recordOp(this.ctx, 'ledger_entries', reversal);

      // 2. Payment moves to REVERSED (original rows untouched otherwise).
      const before = { ...payment };
      stampUpdate(this.ctx, payment);
      payment.status = 'REVERSED';
      payment.reversal_reason = why;
      updateRow(this.ctx.db, 'payments', payment);
      recordOp(this.ctx, 'payments', payment);

      // 3. Any receipt issued for it is voided (number never reused).
      this.#voidReceiptFor(payment.id, `Payment reversed: ${why}`);

      appendAudit(this.ctx, {
        action: 'PAYMENT_REVERSED',
        entityType: 'payment',
        entityId: payment.id,
        summary: `${formatKsh(payment.amount_minor)} payment reversed (${why}). Original records kept.`,
        before,
        after: { ...payment, reversal_entry: { ...reversal } },
      });
      return { payment, reversal };
    });
  }

  // -- internals -------------------------------------------------------------------

  /** Post the PAYMENT_CREDIT and allocate it to outstanding charges, oldest first. */
  #postCreditAndAllocate(payment: PaymentRow): void {
    const tenancy = this.#tenancy(payment.tenancy_id);

    const stamp = stampNew(this.ctx);
    const credit: LedgerEntryRow = {
      ...stamp,
      tenancy_id: tenancy.id,
      property_id: tenancy.property_id,
      unit_id: tenancy.unit_id,
      tenant_id: tenancy.tenant_id,
      entry_date: payment.paid_at,
      entry_type: 'PAYMENT_CREDIT',
      direction: 'CREDIT',
      amount_minor: payment.amount_minor,
      kind: 'OTHER',
      period: null,
      payment_id: payment.id,
      reversal_of: null,
      reason: null,
      note: `${methodName(payment.method)}${payment.reference ? ` ${payment.reference}` : ''}`,
      source: 'MANUAL',
      posted_by_user_id: this.ctx.userId,
      posted_by_device_id: this.ctx.deviceId,
    };
    insertRow(this.ctx.db, 'ledger_entries', credit);
    recordOp(this.ctx, 'ledger_entries', credit);

    this.#allocate(payment);
  }

  /**
   * Waterfall allocation: settle outstanding charges oldest-first; the remainder
   * (if any) stays as advance/credit balance (FINANCIAL-LEDGER.md §4.3).
   */
  #allocate(payment: PaymentRow): void {
    let remaining = payment.amount_minor;
    const charges = this.ctx.db
      .prepare(
        `SELECT * FROM ledger_entries
         WHERE tenancy_id = ? AND org_id = ? AND entry_type = 'CHARGE' AND deleted_at IS NULL
         ORDER BY entry_date ASC, created_at ASC, id ASC`,
      )
      .all(payment.tenancy_id, this.ctx.orgId) as LedgerEntryRow[];

    for (const charge of charges) {
      if (remaining <= 0) break;
      const reversed = this.ctx.db
        .prepare('SELECT id FROM ledger_entries WHERE reversal_of = ? AND deleted_at IS NULL')
        .get(charge.id) as { id: string } | undefined;
      if (reversed !== undefined) continue;

      const allocatedRow = this.ctx.db
        .prepare(
          `SELECT COALESCE(SUM(a.amount_minor), 0) AS total
           FROM payment_allocations a
           JOIN payments p ON p.id = a.payment_id
           WHERE a.charge_id = ? AND a.deleted_at IS NULL AND p.status = 'VERIFIED'`,
        )
        .get(charge.id) as { total: number };
      const outstanding = charge.amount_minor - allocatedRow.total;
      if (outstanding <= 0) continue;

      const apply = Math.min(outstanding, remaining);
      const stamp = stampNew(this.ctx);
      const allocation = {
        ...stamp,
        payment_id: payment.id,
        charge_id: charge.id,
        amount_minor: apply,
      };
      insertRow(this.ctx.db, 'payment_allocations', allocation);
      recordOp(this.ctx, 'payment_allocations', allocation);
      remaining -= apply;
    }
    // remaining > 0 → advance balance; no allocation rows needed.
  }

  #voidReceiptFor(paymentId: string, reason: string): void {
    const receipt = this.ctx.db
      .prepare('SELECT * FROM receipts WHERE payment_id = ? AND org_id = ? AND voided_at IS NULL AND deleted_at IS NULL')
      .get(paymentId, this.ctx.orgId) as ReceiptRow | undefined;
    if (receipt === undefined) return;
    voidReceiptTx(this.ctx, receipt, reason);
  }

  #tenancy(id: string): TenancyRow {
    const row = this.ctx.db
      .prepare('SELECT * FROM tenancies WHERE id = ? AND org_id = ? AND deleted_at IS NULL')
      .get(id, this.ctx.orgId) as TenancyRow | undefined;
    if (row === undefined) throw domainRule('Tenancy not found.');
    return row;
  }

  #tenantName(tenancy: TenancyRow): string {
    const row = this.ctx.db
      .prepare('SELECT full_name FROM tenants WHERE id = ?')
      .get(tenancy.tenant_id) as { full_name: string } | undefined;
    return row?.full_name ?? 'tenant';
  }
}

function methodName(method: PaymentMethod): string {
  if (method === 'MPESA') return 'M-Pesa';
  if (method === 'CASH') return 'cash';
  if (method === 'BANK') return 'bank';
  return 'other';
}
