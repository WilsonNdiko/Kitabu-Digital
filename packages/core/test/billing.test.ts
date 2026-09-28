import { describe, it, expect } from 'vitest';
import { duePeriods, missingCharges, periodOf } from '../src/billing.js';
import { rentChargeId } from '../src/ids.js';

const t = { id: 'tcy_ABC', rentMinor: 850000, startDate: '2026-07-15', endDate: null };

describe('idempotent monthly billing', () => {
  it('charges every month from move-in through the current month', () => {
    expect(duePeriods(t, '2026-09-28')).toEqual(['2026-07', '2026-08', '2026-09']);
  });

  it('spans year boundaries', () => {
    expect(duePeriods({ ...t, startDate: '2025-11-03' }, '2026-02-10'))
      .toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('stops at the tenancy end date (move-out preserves history, adds no charges)', () => {
    expect(duePeriods({ ...t, endDate: '2026-08-20' }, '2026-09-28'))
      .toEqual(['2026-07', '2026-08']);
  });

  it('future tenancies are not charged yet', () => {
    expect(duePeriods({ ...t, startDate: '2026-12-01' }, '2026-09-28')).toEqual([]);
  });

  it('only generates missing charges — calling twice is a no-op', () => {
    const first = missingCharges(t, new Set(), '2026-09-28');
    expect(first).toHaveLength(3);
    const again = missingCharges(t, new Set(first.map((c) => c.period!)), '2026-09-28');
    expect(again).toHaveLength(0);
  });

  it('deterministic charge ids: two devices produce the SAME charge (no dupes on sync)', () => {
    const a = missingCharges(t, new Set(), '2026-09-28');
    const b = missingCharges(t, new Set(), '2026-09-28');
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(a[0]!.id).toBe(rentChargeId('tcy_ABC', '2026-07'));
  });

  it('periodOf', () => {
    expect(periodOf('2026-09-28')).toBe('2026-09');
  });
});
