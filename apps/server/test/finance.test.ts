/**
 * Financial-core integration tests against a real in-memory SQLite database:
 * the data-integrity rules of §48 exercised end-to-end through the services.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { parseKshToMinor } from '@kitabu/core';
import { openDb, type Ctx, type DB } from '../src/db/index.js';
import { getCtx, runSetup } from '../src/services/setup.js';
import { createTenant, endTenancy, moveIn } from '../src/services/portfolio.js';
import { ensureCharges, issueReceipt, recordPayment, rejectPayment, reversePayment, tenancyBalance, verifyPayment } from '../src/services/finance.js';
import { arrears, dashboard, tenantDetail } from '../src/services/queries.js';

const K = (s: string) => parseKshToMinor(s);
const today = new Date().toISOString().slice(0, 10);
const firstOfMonth = `${today.slice(0, 7)}-01`;

let db: DB;
let ctx: Ctx;
let tenancyId: string;
let tenantId: string;

beforeEach(() => {
  db = openDb(':memory:');
  runSetup(db, {
    ownerName: 'Wilson', orgName: 'Green View Properties',
    propertyName: 'Green View Apartments', location: 'Kasarani',
    units: [{ label: 'A-12', rentMinor: K('12000') }, { label: 'A-13', rentMinor: K('12000') }],
  });
  ctx = getCtx(db)!;
  const unit = db.prepare("SELECT id FROM units WHERE label='A-12'").get() as any;
  const res = createTenant(ctx, {
    fullName: 'John Kamau', phone: '0712345678',
    moveIn: { unitId: unit.id, startDate: firstOfMonth },
  });
  tenantId = res.id; tenancyId = res.tenancyId!;
});

describe('rent charges', () => {
  it('generates the month charge idempotently', () => {
    ensureCharges(ctx);
    ensureCharges(ctx);
    const charges = db.prepare("SELECT * FROM ledger_entries WHERE entry_type='CHARGE'").all();
    expect(charges).toHaveLength(1);
    expect(tenancyBalance(ctx, tenancyId)).toBe(K('12000'));
  });
});

describe('recording payments (Kitabu records, never processes)', () => {
  it('owner cash → VERIFIED at entry, posts to ledger, gets a receipt', () => {
    const p = recordPayment(ctx, { tenancyId, amountMinor: K('12000'), method: 'CASH' });
    expect(p.status).toBe('VERIFIED');
    expect(tenancyBalance(ctx, tenancyId)).toBe(0);
    const r = issueReceipt(ctx, p.id);
    expect(r.receiptNo).toMatch(/^KD-[0-9A-Z]{4}-\d{6}$/);
  });

  it('M-Pesa reference → PENDING (never auto-trusted), no ledger effect until verified', () => {
    const p = recordPayment(ctx, { tenancyId, amountMinor: K('12000'), method: 'MPESA', reference: 'SFR8K2L9QX' });
    expect(p.status).toBe('PENDING');
    expect(tenancyBalance(ctx, tenancyId)).toBe(K('12000'));
    verifyPayment(ctx, p.id);
    expect(tenancyBalance(ctx, tenancyId)).toBe(0);
  });

  it('rejects duplicate M-Pesa references with a friendly message', () => {
    recordPayment(ctx, { tenancyId, amountMinor: K('8000'), method: 'MPESA', reference: 'SFR8K2L9QX' });
    expect(() =>
      recordPayment(ctx, { tenancyId, amountMinor: K('4000'), method: 'MPESA', reference: 'sfr8k2l9qx' }),
    ).toThrow(/already used/);
  });

  it('rejects malformed M-Pesa codes and non-positive amounts', () => {
    expect(() => recordPayment(ctx, { tenancyId, amountMinor: K('100'), method: 'MPESA', reference: 'BAD' })).toThrow(/M-Pesa/);
    expect(() => recordPayment(ctx, { tenancyId, amountMinor: 0, method: 'CASH' })).toThrow(/amount/);
    expect(() => recordPayment(ctx, { tenancyId, amountMinor: 100.5 as any, method: 'CASH' })).toThrow(/amount/);
  });

  it('partial payment leaves the right arrears', () => {
    recordPayment(ctx, { tenancyId, amountMinor: K('8000'), method: 'CASH' });
    expect(tenancyBalance(ctx, tenancyId)).toBe(K('4000'));
    const a = arrears(ctx, {});
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]!.monthStatus).toBe('PARTIAL');
    expect(a.totalArrearsMinor).toBe(K('4000'));
  });
});

describe('financial immutability (§17, §48)', () => {
  it('a rejected payment cannot later be verified', () => {
    const p = recordPayment(ctx, { tenancyId, amountMinor: K('5000'), method: 'MPESA', reference: 'TAB3XY9QL2' });
    rejectPayment(ctx, p.id, 'Reference not found in statement');
    expect(() => verifyPayment(ctx, p.id)).toThrow(/cannot/);
    expect(tenancyBalance(ctx, tenancyId)).toBe(K('12000'));
  });

  it('reversal restores the balance and keeps every original row', () => {
    const p = recordPayment(ctx, { tenancyId, amountMinor: K('12000'), method: 'CASH' });
    expect(tenancyBalance(ctx, tenancyId)).toBe(0);
    reversePayment(ctx, p.id, 'Recorded against the wrong tenant');
    expect(tenancyBalance(ctx, tenancyId)).toBe(K('12000'));
    const entries = db.prepare('SELECT entry_type FROM ledger_entries ORDER BY id').all() as any[];
    expect(entries.map((e) => e.entry_type).sort()).toEqual(['CHARGE', 'PAYMENT', 'REVERSAL']);
    const pay = db.prepare('SELECT status FROM payments WHERE id=?').get(p.id) as any;
    expect(pay.status).toBe('REVERSED');
  });

  it('a reversed payment cannot be re-verified or re-reversed', () => {
    const p = recordPayment(ctx, { tenancyId, amountMinor: K('12000'), method: 'CASH' });
    reversePayment(ctx, p.id, 'error');
    expect(() => reversePayment(ctx, p.id, 'again')).toThrow(/cannot/);
    expect(() => verifyPayment(ctx, p.id)).toThrow(/cannot/);
  });

  it('one receipt per payment; issuing twice returns the same receipt', () => {
    const p = recordPayment(ctx, { tenancyId, amountMinor: K('12000'), method: 'CASH' });
    const r1 = issueReceipt(ctx, p.id);
    const r2 = issueReceipt(ctx, p.id);
    expect(r2.id).toBe(r1.id);
    expect(r2.existed).toBe(true);
  });

  it('receipts cannot be issued for unverified payments', () => {
    const p = recordPayment(ctx, { tenancyId, amountMinor: K('5000'), method: 'MPESA', reference: 'QQQ1234567' });
    expect(() => issueReceipt(ctx, p.id)).toThrow(/verified/);
  });

  it('receipt snapshot freezes previous/remaining balances at issuance', () => {
    const p = recordPayment(ctx, { tenancyId, amountMinor: K('8000'), method: 'CASH' });
    const r = issueReceipt(ctx, p.id);
    const row = db.prepare('SELECT snapshot_json FROM receipts WHERE id=?').get(r.id) as any;
    const snap = JSON.parse(row.snapshot_json);
    expect(snap.previousBalanceMinor).toBe(K('12000'));
    expect(snap.remainingBalanceMinor).toBe(K('4000'));
    expect(snap.tenantName).toBe('John Kamau');
    expect(snap.unitLabel).toBe('A-12');
  });
});

describe('tenancy history (§12, §48.6-7)', () => {
  it('moving a tenant preserves the old tenancy and its ledger', () => {
    recordPayment(ctx, { tenancyId, amountMinor: K('12000'), method: 'CASH' });
    endTenancy(ctx, tenancyId, today);
    const unit13 = db.prepare("SELECT id FROM units WHERE label='A-13'").get() as any;
    const t2 = moveIn(ctx, tenantId, { unitId: unit13.id, startDate: today });
    const d = tenantDetail(ctx, tenantId)!;
    expect(d.tenancies).toHaveLength(2);
    expect(d.activeTenancy.id).toBe(t2.id);
    const oldLedger = db.prepare('SELECT COUNT(*) c FROM ledger_entries WHERE tenancy_id=?').get(tenancyId) as any;
    expect(oldLedger.c).toBeGreaterThan(0);
    const unit12 = db.prepare("SELECT status FROM units WHERE label='A-12'").get() as any;
    expect(unit12.status).toBe('VACANT');
  });

  it('a unit cannot have two active tenancies', () => {
    const unit12 = db.prepare("SELECT id FROM units WHERE label='A-12'").get() as any;
    const other = createTenant(ctx, { fullName: 'Mary Wanjiku' });
    expect(() => moveIn(ctx, other.id, { unitId: unit12.id, startDate: today })).toThrow(/already has a tenant/);
  });
});

describe('change log & audit (§26, §52)', () => {
  it('every write appends to the change log in the same transaction', () => {
    const before = (db.prepare('SELECT COUNT(*) c FROM change_log').get() as any).c;
    recordPayment(ctx, { tenancyId, amountMinor: K('12000'), method: 'CASH' });
    const after = (db.prepare('SELECT COUNT(*) c FROM change_log').get() as any).c;
    expect(after).toBeGreaterThan(before); // payment + charge + ledger entry
  });

  it('important actions are audit-logged with actor and device', () => {
    const p = recordPayment(ctx, { tenancyId, amountMinor: K('12000'), method: 'CASH' });
    issueReceipt(ctx, p.id);
    const actions = (db.prepare('SELECT action FROM audit_log').all() as any[]).map((a) => a.action);
    expect(actions).toContain('payment.recorded');
    expect(actions).toContain('receipt.issued');
    const row = db.prepare("SELECT actor_user_id, device_id FROM audit_log WHERE action='payment.recorded'").get() as any;
    expect(row.actor_user_id).toBe(ctx.userId);
    expect(row.device_id).toBe(ctx.deviceId);
  });
});

describe('dashboard', () => {
  it('answers "how are my properties doing?"', () => {
    recordPayment(ctx, { tenancyId, amountMinor: K('8000'), method: 'CASH' });
    const d = dashboard(ctx);
    expect(d.properties).toBe(1);
    expect(d.units).toBe(2);
    expect(d.occupied).toBe(1);
    expect(d.vacant).toBe(1);
    expect(d.expectedMinor).toBe(K('12000'));
    expect(d.collectedMinor).toBe(K('8000'));
    expect(d.outstandingMinor).toBe(K('4000'));
    expect(d.tenants.partial).toBe(1);
  });
});
