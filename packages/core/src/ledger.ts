/**
 * The rent ledger — the financial heart of Kitabu.
 *
 * Balance is NEVER `monthlyRent - latestPayment`. All financial activity is
 * append-only entries; balance is their sum (docs/DATABASE.md §4).
 *
 * Sign convention:
 *   CHARGE      +  tenant owes more (debit)
 *   PAYMENT     -  tenant owes less (credit)
 *   ADJUSTMENT  +/- correction with mandatory memo
 *   CREDIT      -  goodwill / deposit application
 *   REVERSAL    negates a prior entry (points at it)
 */
import { assertMoney } from './money.js';

export type LedgerEntryType = 'CHARGE' | 'PAYMENT' | 'ADJUSTMENT' | 'CREDIT' | 'REVERSAL';

export interface LedgerEntry {
  id: string;
  tenancyId: string;
  entryType: LedgerEntryType;
  /** Signed integer minor units following the convention above. */
  amountMinor: number;
  /** Rent period 'YYYY-MM' for charges; optional otherwise. */
  period?: string | null;
  effectiveDate: string; // ISO date
  paymentId?: string | null;
  reversesEntryId?: string | null;
  memo?: string | null;
}

/** Validate that an entry respects the sign convention before it is stored. */
export function validateEntry(e: LedgerEntry): void {
  assertMoney(e.amountMinor, 'ledger amount');
  if (e.amountMinor === 0) throw new Error('Ledger entries cannot be zero');
  switch (e.entryType) {
    case 'CHARGE':
      if (e.amountMinor <= 0) throw new Error('A charge must be positive');
      if (!e.period) throw new Error('A charge needs a rent period');
      break;
    case 'PAYMENT':
      if (e.amountMinor >= 0) throw new Error('A payment entry must be negative');
      if (!e.paymentId) throw new Error('A payment entry must reference its payment');
      break;
    case 'CREDIT':
      if (e.amountMinor >= 0) throw new Error('A credit must be negative');
      break;
    case 'ADJUSTMENT':
      if (!e.memo) throw new Error('An adjustment requires a reason (memo)');
      break;
    case 'REVERSAL':
      if (!e.reversesEntryId) throw new Error('A reversal must reference the entry it reverses');
      break;
  }
}

/** Positive ⇒ tenant owes; negative ⇒ tenant has advance/credit. */
export function computeBalance(entries: Pick<LedgerEntry, 'amountMinor'>[]): number {
  return entries.reduce((sum, e) => sum + e.amountMinor, 0);
}

/** Build the REVERSAL entry for a given entry (used when reversing payments). */
export function buildReversal(
  target: LedgerEntry,
  opts: { id: string; effectiveDate: string; memo: string },
): LedgerEntry {
  if (target.entryType === 'REVERSAL') throw new Error('Cannot reverse a reversal');
  return {
    id: opts.id,
    tenancyId: target.tenancyId,
    entryType: 'REVERSAL',
    amountMinor: -target.amountMinor,
    period: target.period ?? null,
    effectiveDate: opts.effectiveDate,
    paymentId: target.paymentId ?? null,
    reversesEntryId: target.id,
    memo: opts.memo,
  };
}

export interface StatementLine extends LedgerEntry {
  runningBalanceMinor: number;
}

/** Ordered statement with running balance — the digital rent book page. */
export function buildStatement(entries: LedgerEntry[]): StatementLine[] {
  const sorted = [...entries].sort((a, b) =>
    a.effectiveDate === b.effectiveDate
      ? a.id.localeCompare(b.id)
      : a.effectiveDate.localeCompare(b.effectiveDate),
  );
  let bal = 0;
  return sorted.map((e) => {
    bal += e.amountMinor;
    return { ...e, runningBalanceMinor: bal };
  });
}
