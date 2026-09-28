import { describe, it, expect } from 'vitest';
import {
  computeBalance, buildStatement, buildReversal, validateEntry,
  type LedgerEntry,
} from '../src/ledger.js';

const charge = (id: string, period: string, amount: number): LedgerEntry => ({
  id, tenancyId: 'tcy_1', entryType: 'CHARGE', amountMinor: amount,
  period, effectiveDate: `${period}-01`,
});
const payment = (id: string, date: string, amount: number): LedgerEntry => ({
  id, tenancyId: 'tcy_1', entryType: 'PAYMENT', amountMinor: -amount,
  effectiveDate: date, paymentId: `pay_${id}`,
});

describe('rent ledger', () => {
  it('full payment clears the month', () => {
    const entries = [charge('c1', '2026-09', 1200000), payment('p1', '2026-09-05', 1200000)];
    expect(computeBalance(entries)).toBe(0);
  });

  it('partial payment leaves arrears (John pays 8,000 of 12,000)', () => {
    const entries = [charge('c1', '2026-09', 1200000), payment('p1', '2026-09-05', 800000)];
    expect(computeBalance(entries)).toBe(400000);
  });

  it('advance payment carries a credit into the next month', () => {
    const entries = [charge('c1', '2026-09', 1200000), payment('p1', '2026-09-05', 2400000)];
    expect(computeBalance(entries)).toBe(-1200000);
    entries.push(charge('c2', '2026-10', 1200000));
    expect(computeBalance(entries)).toBe(0);
  });

  it('arrears accumulate across months', () => {
    const entries = [
      charge('c1', '2026-08', 1200000),
      charge('c2', '2026-09', 1200000),
      payment('p1', '2026-08-10', 1000000),
    ];
    expect(computeBalance(entries)).toBe(1400000);
  });

  it('reversal restores the balance and preserves history', () => {
    const p = payment('p1', '2026-09-05', 1200000);
    const entries = [charge('c1', '2026-09', 1200000), p];
    const rev = buildReversal(p, { id: 'r1', effectiveDate: '2026-09-06', memo: 'Recorded in error' });
    entries.push(rev);
    expect(computeBalance(entries)).toBe(1200000);
    expect(entries).toHaveLength(3);          // nothing deleted
    expect(rev.reversesEntryId).toBe('p1');
    expect(rev.amountMinor).toBe(1200000);
  });

  it('cannot reverse a reversal', () => {
    const p = payment('p1', '2026-09-05', 500000);
    const rev = buildReversal(p, { id: 'r1', effectiveDate: '2026-09-06', memo: 'err' });
    expect(() => buildReversal(rev, { id: 'r2', effectiveDate: '2026-09-07', memo: 'no' })).toThrow();
  });

  it('rent change: history is preserved because each period charged its own rate', () => {
    const entries = [
      charge('c1', '2026-08', 1200000),   // old rent 12,000
      payment('p1', '2026-08-03', 1200000),
      charge('c2', '2026-09', 1500000),   // new rent 15,000
    ];
    expect(computeBalance(entries)).toBe(1500000);
    expect(entries[0]!.amountMinor).toBe(1200000); // August unchanged
  });

  it('statement produces a correct running balance in date order', () => {
    const lines = buildStatement([
      payment('p1', '2026-09-05', 800000),
      charge('c1', '2026-09', 1200000),
    ]);
    expect(lines.map((l) => l.runningBalanceMinor)).toEqual([1200000, 400000]);
  });

  it('validation enforces the sign convention and mandatory fields', () => {
    expect(() => validateEntry({ ...charge('c', '2026-09', -5), amountMinor: -5 })).toThrow();
    expect(() => validateEntry({ ...payment('p', '2026-09-01', -5), amountMinor: 5 })).toThrow();
    expect(() => validateEntry({
      id: 'a', tenancyId: 't', entryType: 'ADJUSTMENT', amountMinor: -100,
      effectiveDate: '2026-09-01',
    })).toThrow(/reason/);
    expect(() => validateEntry({ ...charge('c', '2026-09', 100), amountMinor: 100.5 })).toThrow();
    expect(() => validateEntry({ ...charge('c', '2026-09', 100), amountMinor: 0 })).toThrow();
  });
});
