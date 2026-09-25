/**
 * Ledger service — the append-only financial journal (docs/FINANCIAL-LEDGER.md).
 *
 *   Balance(tenancy) = Σ DEBIT entries − Σ CREDIT entries
 *
 * Everything here is INSERT-only (DB triggers forbid UPDATE/DELETE on
 * ledger_entries). Monthly rent charges are materialized rows, generated
 * idempotently against effective-dated rent rates. Payments post credits via the
 * payment service; allocations settle charges oldest-first.
 */

import type { ServiceContext } from './context.ts';
import { requireRole } from './context.ts';
import { appendAudit, recordOp, stampNew } from './mutations.ts';
import { insertRow } from '../db/crud.ts';
import type { LedgerDirection, LedgerEntryRow, LedgerKind, LedgerSource, TenancyRow } from '../domain/types.ts';
import { LEDGER_KINDS } from '../domain/types.ts';
import { isValidIsoDate } from '../foundation/clock.ts';
import { domainRule, validationError } from '../foundation/errors.ts';
import { formatKsh } from '../foundation/money.ts';

export interface ChargeGenerationResult {
  month: string;
  created: number;
  totalMinor: number;
  skipped: number;
}

export interface MonthStatus {
  tenancyId: string;
  month: string;
  chargeMinor: number;
  paidMinor: number;
  status: 'UNPAID' | 'PARTIAL' | 'PAID' | 'NO_CHARGE';
}

export interface ArrearsRow {
  tenancyId: string;
  tenantId: string;
  tenantName: string;
  unitId: string;
  unitLabel: string;
  propertyId: string;
  propertyName: string;
  balanceMinor: number;
  lastPaymentAt: string | null;
}

export interface StatementLine extends LedgerEntryRow {
  balance_after_minor: number;
}

export interface TenancyStatement {
  tenancy: TenancyRow;
  entries: StatementLine[];
  balanceMinor: number;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export class LedgerService {
  readonly ctx: ServiceContext;

  constructor(ctx: ServiceContext) {
    this.ctx = ctx;
  }

  // -- reads -------------------------------------------------------------------

  /** Balance = Σ debits − Σ credits (reversals net out naturally). Positive = owed. */
  tenancyBalance(tenancyId: string): number {
    const row = this.ctx.db
      .prepare(
        `SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount_minor ELSE -amount_minor END), 0) AS balance
         FROM ledger_entries WHERE tenancy_id = ? AND org_id = ? AND deleted_at IS NULL`,
      )
      .get(tenancyId, this.ctx.orgId) as { balance: number };
    return row.balance;
  }

  listEntries(tenancyId: string, input: { from?: string; to?: string } = {}): LedgerEntryRow[] {
    const clauses = ['tenancy_id = ?', 'org_id = ?', 'deleted_at IS NULL'];
    const params: (string)[] = [tenancyId, this.ctx.orgId];
    if (input.from !== undefined) {
      if (!isValidIsoDate(input.from)) throw validationError('The from date is not a valid date.');
      clauses.push('entry_date >= ?');
      params.push(input.from);
    }
    if (input.to !== undefined) {
      if (!isValidIsoDate(input.to)) throw validationError('The to date is not a valid date.');
      clauses.push('entry_date <= ?');
      params.push(input.to);
    }
    return this.ctx.db
      .prepare(`SELECT * FROM ledger_entries WHERE ${clauses.join(' AND ')} ORDER BY entry_date ASC, created_at ASC, id ASC`)
      .all(...params) as LedgerEntryRow[];
  }

  /** Full statement with running balance (tenant statements, reports). */
  statement(tenancyId: string, input: { from?: string; to?: string } = {}): TenancyStatement {
    const tenancy = this.#tenancy(tenancyId);
    const entries = this.listEntries(tenancyId, input);
    // Opening balance before the first listed entry:
    const before = input.from !== undefined
      ? this.listEntries(tenancyId, { to: previousDay(input.from) })
          .reduce((acc, e) => acc + signed(e), 0)
      : 0;
    let running = before;
    const lines: StatementLine[] = entries.map((e) => {
      running += signed(e);
      return { ...e, balance_after_minor: running };
    });
    return { tenancy, entries: lines, balanceMinor: running };
  }

  getEntry(id: string): LedgerEntryRow {
    const row = this.ctx.db
      .prepare('SELECT * FROM ledger_entries WHERE id = ? AND org_id = ? AND deleted_at IS NULL')
      .get(id, this.ctx.orgId) as LedgerEntryRow | undefined;
    if (row === undefined) throw domainRule('Ledger entry not found.');
    return row;
  }

  /** Status of a tenancy's rent for one month: UNPAID / PARTIAL / PAID / NO_CHARGE. */
  monthStatus(tenancyId: string, month: string): MonthStatus {
    if (!MONTH_RE.test(month)) throw validationError('Use a month like 2026-09.');
    const charge = this.ctx.db
      .prepare(
        `SELECT id, amount_minor FROM ledger_entries
         WHERE tenancy_id = ? AND org_id = ? AND entry_type = 'CHARGE' AND kind = 'RENT'
           AND period = ? AND deleted_at IS NULL
         ORDER BY amount_minor DESC LIMIT 1`,
      )
      .get(tenancyId, this.ctx.orgId, month) as { id: string; amount_minor: number } | undefined;
    if (charge === undefined) {
      return { tenancyId, month, chargeMinor: 0, paidMinor: 0, status: 'NO_CHARGE' };
    }
    const paid = this.#liveAllocatedMinor(charge.id);
    const status = paid <= 0 ? 'UNPAID' : paid < charge.amount_minor ? 'PARTIAL' : 'PAID';
    return { tenancyId, month, chargeMinor: charge.amount_minor, paidMinor: paid, status };
  }

  /** Month overview across active tenancies (dashboard "paid/partial/overdue"). */
  monthOverview(input: { propertyId?: string; month?: string } = {}): MonthStatus[] {
    const month = input.month ?? this.ctx.clock.today().slice(0, 7);
    const params: string[] = [this.ctx.orgId];
    let propertyFilter = '';
    if (input.propertyId !== undefined) {
      propertyFilter = 'AND t.property_id = ?';
      params.push(input.propertyId);
    }
    const tenancies = this.ctx.db
      .prepare(
        `SELECT t.id FROM tenancies t
         WHERE t.org_id = ? AND t.status = 'ACTIVE' AND t.deleted_at IS NULL ${propertyFilter}`,
      )
      .all(...params) as Array<{ id: string }>;
    return tenancies.map((t) => this.monthStatus(t.id, month));
  }

  /** Tenancies owing money (balance > 0), most overdue information included. */
  arrears(input: { propertyId?: string } = {}): ArrearsRow[] {
    const params: string[] = [this.ctx.orgId];
    let propertyFilter = '';
    if (input.propertyId !== undefined) {
      propertyFilter = 'AND t.property_id = ?';
      params.push(input.propertyId);
    }
    return this.ctx.db
      .prepare(
        `SELECT * FROM (
           SELECT t.id AS tenancyId, t.tenant_id AS tenantId, te.full_name AS tenantName,
                  t.unit_id AS unitId, u.label AS unitLabel, t.property_id AS propertyId,
                  p.name AS propertyName,
                  (SELECT COALESCE(SUM(CASE le.direction WHEN 'DEBIT' THEN le.amount_minor ELSE -le.amount_minor END), 0)
                     FROM ledger_entries le WHERE le.tenancy_id = t.id AND le.deleted_at IS NULL) AS balanceMinor,
                  (SELECT MAX(py.paid_at) FROM payments py
                     WHERE py.tenancy_id = t.id AND py.status = 'VERIFIED') AS lastPaymentAt
           FROM tenancies t
           JOIN tenants te ON te.id = t.tenant_id
           JOIN units u ON u.id = t.unit_id
           JOIN properties p ON p.id = t.property_id
           WHERE t.org_id = ? AND t.deleted_at IS NULL ${propertyFilter}
         ) owing
         WHERE owing.balanceMinor > 0
         ORDER BY owing.balanceMinor DESC`,
      )
      .all(...params) as ArrearsRow[];
  }

  /** Collection summary for a month: expected vs collected vs rate. */
  collectionSummary(input: { month?: string; propertyId?: string } = {}): {
    month: string;
    expectedMinor: number;
    collectedMinor: number;
    rate: number | null;
  } {
    const month = input.month ?? this.ctx.clock.today().slice(0, 7);
    if (!MONTH_RE.test(month)) throw validationError('Use a month like 2026-09.');
    const params: string[] = [this.ctx.orgId, month];
    let propertyFilter = '';
    if (input.propertyId !== undefined) {
      propertyFilter = 'AND property_id = ?';
      params.push(input.propertyId);
    }
    const expectedRow = this.ctx.db
      .prepare(
        `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM ledger_entries
         WHERE org_id = ? AND period = ? AND entry_type = 'CHARGE' AND kind = 'RENT'
           AND deleted_at IS NULL ${propertyFilter}`,
      )
      .get(...params) as { total: number };
    const collectedRow = this.ctx.db
      .prepare(
        `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM payments
         WHERE org_id = ? AND status = 'VERIFIED' AND substr(paid_at, 1, 7) = ? ${propertyFilter}`,
      )
      .get(...params) as { total: number };
    const expectedMinor = expectedRow.total;
    const collectedMinor = collectedRow.total;
    return {
      month,
      expectedMinor,
      collectedMinor,
      rate: expectedMinor === 0 ? null : collectedMinor / expectedMinor,
    };
  }

  /** Outstanding (unallocated, unreversed) charges for a tenancy, oldest first. */
  outstandingCharges(tenancyId: string): Array<LedgerEntryRow & { outstanding_minor: number }> {
    const charges = this.ctx.db
      .prepare(
        `SELECT * FROM ledger_entries
         WHERE tenancy_id = ? AND org_id = ? AND entry_type = 'CHARGE' AND deleted_at IS NULL
         ORDER BY entry_date ASC, created_at ASC, id ASC`,
      )
      .all(tenancyId, this.ctx.orgId) as LedgerEntryRow[];
    return charges
      .map((charge) => ({ ...charge, outstanding_minor: this.#effectiveOutstanding(charge) }))
      .filter((c) => c.outstanding_minor > 0);
  }

  // -- writes --------------------------------------------------------------------

  /**
   * Generate rent charges for a month — idempotent, effective-dated
   * (FINANCIAL-LEDGER.md §3). A tenancy is charged when it was occupied on the
   * due date (start_date <= due date AND (end_date IS NULL OR end_date >= due date)).
   * Proration is deliberately not modelled (Kenyan practice: full month).
   */
  generateMonthlyCharges(month: string, input: { propertyId?: string } = {}): ChargeGenerationResult {
    requireRole(this.ctx, ['OWNER'], 'generate monthly rent charges');
    if (!MONTH_RE.test(month)) throw validationError('Use a month like 2026-09.');

    return this.ctx.db.transaction(() => {
      const params: string[] = [this.ctx.orgId];
      let propertyFilter = '';
      if (input.propertyId !== undefined) {
        propertyFilter = 'AND t.property_id = ?';
        params.push(input.propertyId);
      }
      const tenancies = this.ctx.db
        .prepare(
          `SELECT t.*, te.full_name AS tenant_name, u.label AS unit_label
           FROM tenancies t
           JOIN tenants te ON te.id = t.tenant_id
           JOIN units u ON u.id = t.unit_id
           WHERE t.org_id = ? AND t.deleted_at IS NULL ${propertyFilter}`,
        )
        .all(...params) as Array<TenancyRow & { tenant_name: string; unit_label: string }>;

      let created = 0;
      let skipped = 0;
      let totalMinor = 0;

      for (const tenancy of tenancies) {
        const dueDate = `${month}-${String(tenancy.expected_payment_day).padStart(2, '0')}`;
        if (tenancy.start_date > dueDate) {
          skipped += 1; // not yet moved in at due date
          continue;
        }
        if (tenancy.end_date !== null && tenancy.end_date < dueDate) {
          skipped += 1; // moved out before the due date
          continue;
        }
        const rate = this.#rentOn(tenancy.id, dueDate);
        if (rate === null) {
          skipped += 1;
          continue;
        }
        const exists = this.ctx.db
          .prepare(
            `SELECT id FROM ledger_entries
             WHERE tenancy_id = ? AND entry_type = 'CHARGE' AND kind = 'RENT' AND period = ?
               AND source = 'AUTO_GENERATED' AND deleted_at IS NULL`,
          )
          .get(tenancy.id, month) as { id: string } | undefined;
        if (exists !== undefined) {
          skipped += 1;
          continue;
        }

        this.#insertEntry({
          tenancy,
          entryDate: dueDate,
          entryType: 'CHARGE',
          direction: 'DEBIT',
          amountMinor: rate,
          kind: 'RENT',
          period: month,
          source: 'AUTO_GENERATED',
          reason: null,
          note: `Rent for ${month}`,
          postedByUserId: this.ctx.userId,
        });
        created += 1;
        totalMinor += rate;
      }

      if (created > 0) {
        appendAudit(this.ctx, {
          action: 'RENT_CHARGES_GENERATED',
          entityType: 'organization',
          entityId: this.ctx.orgId,
          summary: `Rent charges generated for ${month}: ${created} houses, ${formatKsh(totalMinor)}.`,
          after: { month, created, totalMinor },
        });
      }
      return { month, created, skipped, totalMinor };
    });
  }

  /** Convenience for app open / dashboard: charges for the current month. */
  generateCurrentMonthCharges(input: { propertyId?: string } = {}): ChargeGenerationResult {
    return this.generateMonthlyCharges(this.ctx.clock.today().slice(0, 7), input);
  }

  /** Manual charge (water bill, garbage, penalty…). Owner-only in M2. */
  addCharge(input: {
    tenancyId: string;
    kind: LedgerKind;
    amountMinor: number;
    entryDate: string;
    period?: string;
    reason?: string;
  }): LedgerEntryRow {
    requireRole(this.ctx, ['OWNER'], 'add charges to a tenant account');
    if (!LEDGER_KINDS.includes(input.kind)) throw validationError('Unknown charge type.');
    if (!isValidIsoDate(input.entryDate)) throw validationError('The charge date is not a valid date.');
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw validationError('Enter the charge amount as a positive amount.');
    }
    if (input.period !== undefined && !MONTH_RE.test(input.period)) {
      throw validationError('Use a month like 2026-09 for the charge period.');
    }

    return this.ctx.db.transaction(() => {
      const tenancy = this.#tenancy(input.tenancyId);
      const entry = this.#insertEntry({
        tenancy,
        entryDate: input.entryDate,
        entryType: 'CHARGE',
        direction: 'DEBIT',
        amountMinor: input.amountMinor,
        kind: input.kind,
        period: input.period ?? null,
        source: 'MANUAL',
        reason: input.reason?.trim() || null,
        note: null,
        postedByUserId: this.ctx.userId,
      });
      appendAudit(this.ctx, {
        action: 'CHARGE_ADDED',
        entityType: 'tenancy',
        entityId: tenancy.id,
        summary: `${formatKsh(input.amountMinor)} ${input.kind} charge added.`,
        after: { ...entry },
      });
      return entry;
    });
  }

  /** Adjustment (discount reduces what is owed; penalty increases it). Owner-only. */
  addAdjustment(input: {
    tenancyId: string;
    direction: LedgerDirection;
    amountMinor: number;
    entryDate: string;
    reason: string;
  }): LedgerEntryRow {
    requireRole(this.ctx, ['OWNER'], 'adjust a tenant account');
    if (!isValidIsoDate(input.entryDate)) throw validationError('The adjustment date is not a valid date.');
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw validationError('Enter the adjustment amount as a positive amount.');
    }
    const reason = input.reason.trim();
    if (reason === '') throw validationError('Give a reason for the adjustment — it appears in the audit trail.');

    return this.ctx.db.transaction(() => {
      const tenancy = this.#tenancy(input.tenancyId);
      const entry = this.#insertEntry({
        tenancy,
        entryDate: input.entryDate,
        entryType: 'ADJUSTMENT',
        direction: input.direction,
        amountMinor: input.amountMinor,
        kind: input.direction === 'CREDIT' ? 'DISCOUNT' : 'PENALTY',
        period: null,
        source: 'MANUAL',
        reason,
        note: null,
        postedByUserId: this.ctx.userId,
      });
      appendAudit(this.ctx, {
        action: 'ADJUSTMENT_ADDED',
        entityType: 'tenancy',
        entityId: tenancy.id,
        summary: `${input.direction === 'CREDIT' ? 'Discount' : 'Penalty'} of ${formatKsh(input.amountMinor)}: ${reason}.`,
        after: { ...entry },
      });
      return entry;
    });
  }

  /** Reverse a charge or adjustment (wrong bill, disputed penalty). Owner-only. */
  reverseCharge(chargeId: string, reason: string): LedgerEntryRow {
    requireRole(this.ctx, ['OWNER'], 'reverse a charge');
    const why = reason.trim();
    if (why === '') throw validationError('Give a reason for the reversal.');

    return this.ctx.db.transaction(() => {
      const charge = this.getEntry(chargeId);
      if (charge.entry_type === 'PAYMENT_CREDIT' || charge.entry_type === 'REVERSAL') {
        throw domainRule('Only charges and adjustments can be reversed here. Reverse the payment instead.');
      }
      const alreadyReversed = this.ctx.db
        .prepare('SELECT id FROM ledger_entries WHERE reversal_of = ? AND deleted_at IS NULL')
        .get(charge.id) as { id: string } | undefined;
      if (alreadyReversed !== undefined) throw domainRule('This charge has already been reversed.');

      const tenancy = this.#tenancy(charge.tenancy_id);
      const entry = this.#insertEntry({
        tenancy,
        entryDate: this.ctx.clock.today(),
        entryType: 'REVERSAL',
        direction: charge.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
        amountMinor: charge.amount_minor,
        kind: charge.kind,
        period: null,
        source: 'MANUAL',
        reason: why,
        note: `Reversal of ${charge.entry_type} ${charge.id}`,
        postedByUserId: this.ctx.userId,
        reversalOf: charge.id,
      });
      appendAudit(this.ctx, {
        action: 'CHARGE_REVERSED',
        entityType: 'ledger_entry',
        entityId: charge.id,
        summary: `${formatKsh(charge.amount_minor)} ${charge.kind} charge reversed: ${why}.`,
        before: { ...charge },
        after: { ...entry },
      });
      return entry;
    });
  }

  // -- internals -------------------------------------------------------------------

  #insertEntry(input: {
    tenancy: TenancyRow;
    entryDate: string;
    entryType: LedgerEntryRow['entry_type'];
    direction: LedgerDirection;
    amountMinor: number;
    kind: LedgerKind;
    period: string | null;
    source: LedgerSource;
    reason: string | null;
    note: string | null;
    postedByUserId: string | null;
    paymentId?: string;
    reversalOf?: string;
  }): LedgerEntryRow {
    const stamp = stampNew(this.ctx);
    const entry: LedgerEntryRow = {
      ...stamp,
      tenancy_id: input.tenancy.id,
      property_id: input.tenancy.property_id,
      unit_id: input.tenancy.unit_id,
      tenant_id: input.tenancy.tenant_id,
      entry_date: input.entryDate,
      entry_type: input.entryType,
      direction: input.direction,
      amount_minor: input.amountMinor,
      kind: input.kind,
      period: input.period,
      payment_id: input.paymentId ?? null,
      reversal_of: input.reversalOf ?? null,
      reason: input.reason,
      note: input.note,
      source: input.source,
      posted_by_user_id: input.postedByUserId,
      posted_by_device_id: this.ctx.deviceId,
    };
    insertRow(this.ctx.db, 'ledger_entries', entry);
    recordOp(this.ctx, 'ledger_entries', entry);
    return entry;
  }

  #rentOn(tenancyId: string, date: string): number | null {
    const row = this.ctx.db
      .prepare(
        `SELECT amount_minor FROM rent_rates
         WHERE tenancy_id = ? AND deleted_at IS NULL AND effective_from <= ?
         ORDER BY effective_from DESC LIMIT 1`,
      )
      .get(tenancyId, date) as { amount_minor: number } | undefined;
    return row?.amount_minor ?? null;
  }

  #tenancy(id: string): TenancyRow {
    const row = this.ctx.db
      .prepare('SELECT * FROM tenancies WHERE id = ? AND org_id = ? AND deleted_at IS NULL')
      .get(id, this.ctx.orgId) as TenancyRow | undefined;
    if (row === undefined) throw domainRule('Tenancy not found.');
    return row;
  }

  /** Amount of a charge still owed: minus live allocations, zero if reversed. */
  #effectiveOutstanding(charge: LedgerEntryRow): number {
    const reversed = this.ctx.db
      .prepare('SELECT id FROM ledger_entries WHERE reversal_of = ? AND deleted_at IS NULL')
      .get(charge.id) as { id: string } | undefined;
    if (reversed !== undefined) return 0;
    return charge.amount_minor - this.#liveAllocatedMinor(charge.id);
  }

  /** Total allocated toward a charge by live (verified, non-reversed) payments. */
  #liveAllocatedMinor(chargeId: string): number {
    const row = this.ctx.db
      .prepare(
        `SELECT COALESCE(SUM(a.amount_minor), 0) AS total
         FROM payment_allocations a
         JOIN payments p ON p.id = a.payment_id
         WHERE a.charge_id = ? AND a.deleted_at IS NULL AND p.status = 'VERIFIED'`,
      )
      .get(chargeId) as { total: number };
    return row.total;
  }
}

function signed(entry: LedgerEntryRow): number {
  return entry.direction === 'DEBIT' ? entry.amount_minor : -entry.amount_minor;
}

function previousDay(isoDate: string): string {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  return new Date(t - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
