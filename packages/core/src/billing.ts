/**
 * Idempotent monthly charge generation (docs/ARCHITECTURE.md §3).
 * Pure functions: given a tenancy and the periods already charged, return the
 * charges that are missing. No scheduler, no connectivity, deterministic ids.
 */
import { rentChargeId } from './ids.js';
import type { LedgerEntry } from './ledger.js';

export interface TenancyForBilling {
  id: string;
  rentMinor: number;
  startDate: string;          // ISO date
  endDate?: string | null;    // ISO date if ended
}

/** 'YYYY-MM' for a date. */
export function periodOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** All rent periods a tenancy is liable for, from start month → min(end, today). */
export function duePeriods(t: TenancyForBilling, todayIso: string): string[] {
  const start = periodOf(t.startDate);
  const last = t.endDate && t.endDate < todayIso ? periodOf(t.endDate) : periodOf(todayIso);
  if (start > last) return [];
  const out: string[] = [];
  let [y, m] = start.split('-').map(Number) as [number, number];
  for (;;) {
    const p = `${y}-${String(m).padStart(2, '0')}`;
    if (p > last) break;
    out.push(p);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** Charges that should exist but don't yet. Safe to call repeatedly, anywhere. */
export function missingCharges(
  t: TenancyForBilling,
  existingPeriods: Set<string>,
  todayIso: string,
): LedgerEntry[] {
  return duePeriods(t, todayIso)
    .filter((p) => !existingPeriods.has(p))
    .map((p) => ({
      id: rentChargeId(t.id, p),
      tenancyId: t.id,
      entryType: 'CHARGE' as const,
      amountMinor: t.rentMinor,
      period: p,
      effectiveDate: `${p}-01`,
      memo: `Rent for ${p}`,
    }));
}
