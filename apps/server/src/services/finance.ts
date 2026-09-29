import {
  assertPaymentTransition, canVerifyPayments, formatKsh, initialPaymentStatus,
  looksLikeMpesaRef, missingCharges, newId, periodOf, receiptNumber,
  type PaymentMethod, type PaymentStatus,
} from '@kitabu/core';
import {
  AppError, audit, getSetting, insertRow, insertRowIfAbsent, nowIso, setSetting,
  todayIso, updateRow, type Ctx,
} from '../db/index.js';
import { getActiveSignature } from './signatures.js';

// ---------------------------------------------------------------- billing --
/** Idempotently ensure monthly rent charges exist for all tenancies (lazy, offline). */
export function ensureCharges(ctx: Ctx): void {
  const tenancies = ctx.db.prepare(
    "SELECT id, rent_minor, start_date, end_date FROM tenancies WHERE org_id = ? AND deleted_at IS NULL",
  ).all(ctx.orgId) as any[];
  const today = todayIso();
  const tx = ctx.db.transaction(() => {
    for (const t of tenancies) {
      const existing = new Set(
        (ctx.db.prepare(
          "SELECT period FROM ledger_entries WHERE tenancy_id = ? AND entry_type = 'CHARGE'",
        ).all(t.id) as any[]).map((r) => r.period as string),
      );
      for (const c of missingCharges(
        { id: t.id, rentMinor: t.rent_minor, startDate: t.start_date, endDate: t.end_date },
        existing, today,
      )) {
        insertRowIfAbsent(ctx, 'ledger_entries', {
          id: c.id, org_id: ctx.orgId, tenancy_id: c.tenancyId, entry_type: 'CHARGE',
          amount_minor: c.amountMinor, period: c.period, effective_date: c.effectiveDate,
          payment_id: null, reverses_entry_id: null, memo: c.memo, created_by: 'system',
        });
      }
    }
  });
  tx();
}

export function tenancyBalance(ctx: Ctx, tenancyId: string): number {
  const row = ctx.db.prepare(
    'SELECT COALESCE(SUM(amount_minor),0) AS bal FROM ledger_entries WHERE tenancy_id = ?',
  ).get(tenancyId) as any;
  return row.bal as number;
}

// --------------------------------------------------------------- payments --
export interface RecordPaymentInput {
  tenancyId: string;
  amountMinor: number;
  method: PaymentMethod;
  reference?: string;
  payerName?: string;
  paymentDate?: string; // ISO date, default today
  notes?: string;
}

/**
 * Record a payment made OUTSIDE Kitabu (M-Pesa/cash/bank). Kitabu never moves
 * money — it records, verifies, ledgers and issues the receipt (docs/MPESA.md).
 */
export function recordPayment(ctx: Ctx, input: RecordPaymentInput) {
  const t = ctx.db.prepare(
    `SELECT tc.*, u.label AS unit_label, tn.full_name AS tenant_name
       FROM tenancies tc JOIN units u ON u.id = tc.unit_id JOIN tenants tn ON tn.id = tc.tenant_id
      WHERE tc.id = ? AND tc.org_id = ?`,
  ).get(input.tenancyId, ctx.orgId) as any;
  if (!t) throw new AppError('Tenant\u2019s tenancy not found. Choose the tenant again.', 404);
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw new AppError('Enter a valid amount.');

  const reference = input.reference?.trim().toUpperCase() || null;
  if (input.method === 'MPESA') {
    if (!reference) throw new AppError('Enter the M-Pesa transaction code (e.g. SFR8K2L9QX).');
    if (!looksLikeMpesaRef(reference)) throw new AppError('That does not look like an M-Pesa code. Check it and try again.');
  }
  if (reference) {
    const dup = ctx.db.prepare(
      `SELECT p.id, p.payment_date, tn.full_name FROM payments p JOIN tenants tn ON tn.id = p.tenant_id
        WHERE p.org_id = ? AND p.method = ? AND p.reference = ?`,
    ).get(ctx.orgId, input.method, reference) as any;
    if (dup) {
      throw new AppError(
        `This ${input.method === 'MPESA' ? 'M-Pesa code' : 'reference'} was already used on a payment for ${dup.full_name} on ${dup.payment_date}.`,
      );
    }
  }

  const status = initialPaymentStatus(input.method, ctx.userRole);
  const id = newId('pay');
  const paymentDate = input.paymentDate || todayIso();

  ctx.db.transaction(() => {
    ensureChargesForTenancy(ctx, t);
    insertRow(ctx, 'payments', {
      id, org_id: ctx.orgId, tenancy_id: t.id, tenant_id: t.tenant_id, unit_id: t.unit_id,
      property_id: t.property_id, amount_minor: input.amountMinor, method: input.method,
      reference, payer_name: input.payerName?.trim() || t.tenant_name, payment_date: paymentDate,
      status, recorded_by: ctx.userId,
      verified_by: status === 'VERIFIED' ? ctx.userId : null,
      verified_at: status === 'VERIFIED' ? nowIso() : null,
      rejected_reason: null, notes: input.notes?.trim() || null,
    });
    audit(ctx, 'payment.recorded', 'payments', id, undefined, {
      amount: formatKsh(input.amountMinor), method: input.method, reference, status,
    });
    if (status === 'VERIFIED') postPaymentToLedger(ctx, id, t.id, input.amountMinor, paymentDate);
  })();

  return { id, status };
}

function ensureChargesForTenancy(ctx: Ctx, t: any): void {
  const existing = new Set(
    (ctx.db.prepare("SELECT period FROM ledger_entries WHERE tenancy_id = ? AND entry_type = 'CHARGE'").all(t.id) as any[])
      .map((r) => r.period as string),
  );
  for (const c of missingCharges(
    { id: t.id, rentMinor: t.rent_minor, startDate: t.start_date, endDate: t.end_date }, existing, todayIso(),
  )) {
    insertRowIfAbsent(ctx, 'ledger_entries', {
      id: c.id, org_id: ctx.orgId, tenancy_id: c.tenancyId, entry_type: 'CHARGE',
      amount_minor: c.amountMinor, period: c.period, effective_date: c.effectiveDate,
      payment_id: null, reverses_entry_id: null, memo: c.memo, created_by: 'system',
    });
  }
}

/** The PAYMENT ledger entry is posted exactly when a payment becomes VERIFIED. */
export function postPaymentToLedger(ctx: Ctx, paymentId: string, tenancyId: string, amountMinor: number, date: string): void {
  insertRowIfAbsent(ctx, 'ledger_entries', {
    id: `led_pay_${paymentId.replace(/^pay_/, '')}`,   // deterministic: idempotent across devices
    org_id: ctx.orgId, tenancy_id: tenancyId, entry_type: 'PAYMENT',
    amount_minor: -amountMinor, period: periodOf(date), effective_date: date,
    payment_id: paymentId, reverses_entry_id: null, memo: null, created_by: ctx.userId,
  });
}

function getPayment(ctx: Ctx, id: string): any {
  const p = ctx.db.prepare('SELECT * FROM payments WHERE id = ? AND org_id = ?').get(id, ctx.orgId);
  if (!p) throw new AppError('Payment not found.', 404);
  return p;
}

export function verifyPayment(ctx: Ctx, paymentId: string) {
  if (!canVerifyPayments(ctx.userRole)) throw new AppError('Only the owner or a manager can verify payments.', 403);
  const p = getPayment(ctx, paymentId);
  assertPaymentTransition(p.status as PaymentStatus, 'VERIFIED');
  ctx.db.transaction(() => {
    updateRow(ctx, 'payments', paymentId, { status: 'VERIFIED', verified_by: ctx.userId, verified_at: nowIso() });
    postPaymentToLedger(ctx, paymentId, p.tenancy_id, p.amount_minor, p.payment_date);
    audit(ctx, 'payment.verified', 'payments', paymentId, { status: p.status }, { status: 'VERIFIED' });
  })();
}

export function rejectPayment(ctx: Ctx, paymentId: string, reason: string) {
  if (!canVerifyPayments(ctx.userRole)) throw new AppError('Only the owner or a manager can reject payments.', 403);
  if (!reason?.trim()) throw new AppError('Please give a reason for rejecting this payment.');
  const p = getPayment(ctx, paymentId);
  assertPaymentTransition(p.status as PaymentStatus, 'REJECTED');
  ctx.db.transaction(() => {
    updateRow(ctx, 'payments', paymentId, { status: 'REJECTED', rejected_reason: reason.trim() });
    audit(ctx, 'payment.rejected', 'payments', paymentId, { status: p.status }, { status: 'REJECTED', reason });
  })();
}

/** Reverse a VERIFIED payment: original rows stay; a REVERSAL entry restores the balance. */
export function reversePayment(ctx: Ctx, paymentId: string, reason: string) {
  if (!canVerifyPayments(ctx.userRole)) throw new AppError('Only the owner or a manager can reverse payments.', 403);
  if (!reason?.trim()) throw new AppError('Please give a reason for reversing this payment.');
  const p = getPayment(ctx, paymentId);
  assertPaymentTransition(p.status as PaymentStatus, 'REVERSED');
  const entry = ctx.db.prepare(
    "SELECT * FROM ledger_entries WHERE payment_id = ? AND entry_type = 'PAYMENT'",
  ).get(paymentId) as any;
  ctx.db.transaction(() => {
    updateRow(ctx, 'payments', paymentId, { status: 'REVERSED' });
    if (entry) {
      insertRowIfAbsent(ctx, 'ledger_entries', {
        id: `led_rev_${paymentId.replace(/^pay_/, '')}`,
        org_id: ctx.orgId, tenancy_id: entry.tenancy_id, entry_type: 'REVERSAL',
        amount_minor: -entry.amount_minor, period: entry.period, effective_date: todayIso(),
        payment_id: paymentId, reverses_entry_id: entry.id, memo: reason.trim(), created_by: ctx.userId,
      });
    }
    audit(ctx, 'payment.reversed', 'payments', paymentId, { status: p.status }, { status: 'REVERSED', reason });
  })();
}

// --------------------------------------------------------------- receipts --
/**
 * Issue the immutable receipt for a VERIFIED payment. Numbering is
 * device-scoped (one receipt book per device — docs/DATABASE.md §5).
 */
export function issueReceipt(ctx: Ctx, paymentId: string) {
  const p = getPayment(ctx, paymentId);
  if (p.status !== 'VERIFIED') throw new AppError('Receipts can only be issued for verified payments.');
  const existing = ctx.db.prepare('SELECT id FROM receipts WHERE payment_id = ?').get(paymentId) as any;
  if (existing) return { id: existing.id, existed: true };

  const info = ctx.db.prepare(
    `SELECT tn.full_name AS tenant_name, tn.phone AS tenant_phone, u.label AS unit_label,
            pr.name AS property_name, pr.location AS property_location, o.name AS org_name,
            tc.id AS tenancy_id
       FROM payments p
       JOIN tenancies tc ON tc.id = p.tenancy_id
       JOIN tenants tn ON tn.id = p.tenant_id
       JOIN units u ON u.id = p.unit_id
       JOIN properties pr ON pr.id = p.property_id
       JOIN organizations o ON o.id = p.org_id
      WHERE p.id = ?`,
  ).get(paymentId) as any;

  const balanceAfter = tenancyBalance(ctx, info.tenancy_id);
  const issuedBy = (ctx.db.prepare('SELECT full_name FROM users WHERE id = ?').get(ctx.userId) as any)?.full_name ?? 'Unknown';
  const signature = getActiveSignature(ctx, p.property_id); // frozen into the snapshot

  const id = newId('rcp');
  let receiptNo = '';
  ctx.db.transaction(() => {
    const seq = parseInt(getSetting(ctx.db, 'receipt_seq') || '0', 10) + 1;
    setSetting(ctx.db, 'receipt_seq', String(seq));
    receiptNo = receiptNumber(ctx.deviceCode, seq);
    const snapshot = {
      receiptNo, issuedAt: nowIso(), issuedBy,
      orgName: info.org_name, propertyName: info.property_name, propertyLocation: info.property_location,
      tenantName: info.tenant_name, tenantPhone: info.tenant_phone, unitLabel: info.unit_label,
      amountMinor: p.amount_minor, method: p.method, reference: p.reference,
      paymentDate: p.payment_date, period: periodOf(p.payment_date),
      previousBalanceMinor: balanceAfter + p.amount_minor,
      remainingBalanceMinor: balanceAfter,
      signature: signature ? { dataUrl: signature.dataUrl, sha256: signature.sha256 } : null,
    };
    insertRow(ctx, 'receipts', {
      id, org_id: ctx.orgId, receipt_no: receiptNo, payment_id: paymentId,
      issued_at: nowIso(), issued_by: ctx.userId, snapshot_json: JSON.stringify(snapshot),
    });
    audit(ctx, 'receipt.issued', 'receipts', id, undefined, { receiptNo, paymentId });
  })();
  return { id, receiptNo, existed: false };
}
