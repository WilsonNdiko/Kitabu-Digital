/**
 * Local device-to-device sync tests (docs/SYNC.md) — two real SQLite
 * databases exchanging change logs with NO network, exactly as two devices
 * on a hotspot would. Includes the §64 acceptance scenario from the brief.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { parseKshToMinor } from '@kitabu/core';
import { openDb, setSetting, type Ctx, type DB } from '../src/db/index.js';
import { getCtx, runSetup } from '../src/services/setup.js';
import { createTenant } from '../src/services/portfolio.js';
import { issueReceipt, recordPayment, rejectPayment, tenancyBalance, verifyPayment, ensureCharges } from '../src/services/finance.js';
import { createExpense, createMaintenance } from '../src/services/operations.js';
import { applyChanges, getChangesSince } from '../src/sync/engine.js';
import { applyJoinBundle, createPairing, directTransport, handleJoin, performSync } from '../src/sync/service.js';

const K = (s: string) => parseKshToMinor(s);
const today = new Date().toISOString().slice(0, 10);

let A: DB; // landlord laptop
let B: DB; // caretaker phone (Jane)
let ctxA: Ctx;
let ctxB: Ctx;

/** Pair device B into A's organization (the QR/code ceremony, minus HTTP). */
function pair(): void {
  createPairing(ctxA, 4000);
  const code = (A.prepare("SELECT value FROM settings WHERE key='pairing_code'").get() as any).value;
  const bundle = handleJoin(A, { code, deviceName: "Jane's phone", platform: 'android' });
  applyJoinBundle(B, bundle, 'localhost:4000');
  ctxB = getCtx(B)!;
}

/** Two-way sync initiated by `from` against `to` — like tapping "Sync Now". */
async function syncBetween(fromCtx: Ctx, toDb: DB) {
  return performSync(fromCtx, directTransport(toDb, fromCtx.deviceId));
}

beforeEach(() => {
  A = openDb(':memory:');
  B = openDb(':memory:');
  runSetup(A, {
    ownerName: 'Wilson', orgName: 'Green View Properties',
    propertyName: 'Green View Apartments', location: 'Kasarani',
    units: Array.from({ length: 30 }, (_, i) => ({ label: `A-${i + 1}`, rentMinor: K('9000') })),
  });
  ctxA = getCtx(A)!;
  pair();
});

describe('pairing & join', () => {
  it('the joining device receives the full organization state', () => {
    expect((B.prepare('SELECT COUNT(*) c FROM units').get() as any).c).toBe(30);
    expect((B.prepare('SELECT COUNT(*) c FROM properties').get() as any).c).toBe(1);
    expect((B.prepare('SELECT COUNT(*) c FROM devices').get() as any).c).toBe(2);
    expect(ctxB.orgId).toBe(ctxA.orgId);
    expect(ctxB.deviceId).not.toBe(ctxA.deviceId);
  });

  it('pairing codes are single-use and validated', () => {
    createPairing(ctxA, 4000);
    const code = (A.prepare("SELECT value FROM settings WHERE key='pairing_code'").get() as any).value;
    const C = openDb(':memory:');
    expect(() => handleJoin(A, { code: 'WRONG!', deviceName: 'x' })).toThrow(/pairing code/);
    const bundle = handleJoin(A, { code, deviceName: 'Third device' });
    applyJoinBundle(C, bundle, 'localhost:4000');
    expect(() => handleJoin(A, { code, deviceName: 'again' })).toThrow(/pairing code/); // spent
  });
});

describe('the §64 scenario: three days offline, then local sync', () => {
  it('converges with no duplicates, no lost data, no overwritten history', async () => {
    const unit = (label: string, db: DB) => (db.prepare('SELECT id FROM units WHERE label=?').get(label) as any).id;

    // --- Jane works offline on her phone (B) ---
    // (v1: Jane's device carries the owner identity — staff accounts are a later milestone,
    //  so her cash entries are VERIFIED at entry; her M-Pesa reference still lands PENDING)
    const t1 = createTenant(ctxB, { fullName: 'Amos Kiprop', phone: '0712000001', moveIn: { unitId: unit('A-1', B), startDate: today } });
    const t2 = createTenant(ctxB, { fullName: 'Beatrice Muthoni', phone: '0712000002', moveIn: { unitId: unit('A-2', B), startDate: today } });
    const p1 = recordPayment(ctxB, { tenancyId: t1.tenancyId!, amountMinor: K('9000'), method: 'CASH' });    // full
    const p2 = recordPayment(ctxB, { tenancyId: t2.tenancyId!, amountMinor: K('4000'), method: 'CASH' });    // partial
    const p3 = recordPayment(ctxB, { tenancyId: t1.tenancyId!, amountMinor: K('500'), method: 'MPESA', reference: 'SJK2M8N4QP' }); // M-Pesa ref, PENDING
    createMaintenance(ctxB, { propertyId: (B.prepare('SELECT id FROM properties').get() as any).id, unitId: unit('A-3', B), title: 'Blocked drain' });
    createMaintenance(ctxB, { propertyId: (B.prepare('SELECT id FROM properties').get() as any).id, title: 'Gate light broken' });

    // --- The landlord works offline on the laptop (A) ---
    createExpense(ctxA, { propertyId: (A.prepare('SELECT id FROM properties').get() as any).id, category: 'Security', amountMinor: K('6000'), description: 'Askari wages' });

    // --- They meet; devices sync over the hotspot ---
    const s1 = await syncBetween(ctxB, A); // Jane taps Sync Now
    expect(s1.pulled.applied).toBeGreaterThan(0); // she receives the expense
    expect(s1.pushed).toBeGreaterThan(0);         // laptop receives her records

    // Laptop received everything, exactly once
    expect((A.prepare('SELECT COUNT(*) c FROM tenants').get() as any).c).toBe(2);
    expect((A.prepare('SELECT COUNT(*) c FROM payments').get() as any).c).toBe(3);
    expect((A.prepare('SELECT COUNT(*) c FROM maintenance_requests').get() as any).c).toBe(2);
    expect((B.prepare('SELECT COUNT(*) c FROM expenses').get() as any).c).toBe(1);

    // The landlord verifies Jane's pending M-Pesa reference on the laptop
    expect((A.prepare('SELECT status FROM payments WHERE id=?').get(p3.id) as any).status).toBe('PENDING');
    verifyPayment(ctxA, p3.id);
    issueReceipt(ctxA, p1.id);
    void p2;

    // Sync again (initiated from the laptop side this time)
    await syncBetween(ctxA, B);

    // Jane's phone now shows verified payments + the receipt; balances agree
    expect((B.prepare('SELECT status FROM payments WHERE id=?').get(p1.id) as any).status).toBe('VERIFIED');
    expect((B.prepare('SELECT COUNT(*) c FROM receipts').get() as any).c).toBe(1);
    expect(tenancyBalance(ctxB, t1.tenancyId!)).toBe(tenancyBalance(ctxA, t1.tenancyId!));
    expect(tenancyBalance(ctxB, t1.tenancyId!)).toBe(K('9000') - K('9000') - K('500')); // -500 advance
    expect(tenancyBalance(ctxB, t2.tenancyId!)).toBe(K('5000'));

    // A third sync is a no-op: nothing new applied anywhere
    const s3 = await syncBetween(ctxB, A);
    expect(s3.pulled.applied).toBe(0);

    // No duplicated ledger rows or payments anywhere
    for (const db of [A, B]) {
      expect((db.prepare('SELECT COUNT(*) c FROM payments').get() as any).c).toBe(3);
      const dupLedger = db.prepare('SELECT id, COUNT(*) c FROM ledger_entries GROUP BY id HAVING c > 1').all();
      expect(dupLedger).toHaveLength(0);
      expect((db.prepare("SELECT COUNT(*) c FROM receipts").get() as any).c).toBe(1);
    }
  });
});

describe('idempotency & multi-path delivery', () => {
  it('re-delivering the same batch applies nothing (safe retries)', async () => {
    createTenant(ctxB, { fullName: 'Test Tenant' });
    const changes = getChangesSince(B, 0, 1000);
    const first = applyChanges(ctxA, changes);
    const again = applyChanges(ctxA, changes);
    expect(first.applied).toBeGreaterThan(0);
    expect(again.applied).toBe(0);
    expect((A.prepare("SELECT COUNT(*) c FROM tenants WHERE full_name='Test Tenant'").get() as any).c).toBe(1);
  });

  it("a device's own changes echoed back are skipped", () => {
    createTenant(ctxA, { fullName: 'Own Tenant' });
    const own = getChangesSince(A, 0, 1000);
    const res = applyChanges(ctxA, own);
    expect(res.applied).toBe(0);
  });

  it('changes from another organization are rejected (isolation)', () => {
    const X = openDb(':memory:');
    runSetup(X, { ownerName: 'Other', orgName: 'Other Org', propertyName: 'P', units: [{ label: 'U1', rentMinor: 100000 }] });
    const foreign = getChangesSince(X, 0, 1000);
    const res = applyChanges(ctxA, foreign);
    expect(res.applied).toBe(0);
    expect(res.conflicts).toBe(foreign.length);
  });
});

describe('conflict resolution', () => {
  it('verify-vs-reject race converges deterministically (REJECTED wins) and money is reconciled', async () => {
    const unitId = (A.prepare("SELECT id FROM units WHERE label='A-5'").get() as any).id;
    const t = createTenant(ctxA, { fullName: 'Race Tenant', moveIn: { unitId, startDate: today } });
    const p = recordPayment(ctxA, { tenancyId: t.tenancyId!, amountMinor: K('9000'), method: 'MPESA', reference: 'RACE123456' });
    await syncBetween(ctxA, B); // both devices now hold the PENDING payment

    verifyPayment(ctxA, p.id);                          // laptop verifies…
    rejectPayment(ctxB, p.id, 'Code not in statement'); // …phone rejects, offline

    await syncBetween(ctxA, B);
    await syncBetween(ctxB, A);

    for (const [db, ctx] of [[A, ctxA], [B, ctxB]] as const) {
      expect((db.prepare('SELECT status FROM payments WHERE id=?').get(p.id) as any).status).toBe('REJECTED');
      // the ledger self-corrected: PAYMENT entry got an automatic REVERSAL
      expect(tenancyBalance(ctx, t.tenancyId!)).toBe(K('9000'));
    }
  });

  it('double move-in for one house resolves to the same winner on both devices', async () => {
    const unitA = (A.prepare("SELECT id FROM units WHERE label='A-9'").get() as any).id;
    const tA = createTenant(ctxA, { fullName: 'From Laptop', moveIn: { unitId: unitA, startDate: today } });
    const tB = createTenant(ctxB, { fullName: 'From Phone', moveIn: { unitId: unitA, startDate: today } });

    await syncBetween(ctxB, A);
    await syncBetween(ctxA, B);
    await syncBetween(ctxB, A); // settle

    const activeA = A.prepare("SELECT id FROM tenancies WHERE unit_id=? AND status='ACTIVE'").all(unitA) as any[];
    const activeB = B.prepare("SELECT id FROM tenancies WHERE unit_id=? AND status='ACTIVE'").all(unitA) as any[];
    expect(activeA).toHaveLength(1);
    expect(activeB).toHaveLength(1);
    expect(activeA[0]!.id).toBe(activeB[0]!.id); // same deterministic winner
    // the loser tenancy still exists (parked as ENDED) — nothing lost
    expect((A.prepare('SELECT COUNT(*) c FROM tenancies WHERE unit_id=?').get(unitA) as any).c).toBe(2);
  });

  it('tenant profile edits: newer version wins on both sides', async () => {
    const t = createTenant(ctxA, { fullName: 'Edit Me' });
    await syncBetween(ctxA, B);
    // phone updates the phone number (version 2)
    B.prepare("UPDATE tenants SET phone='+254711111111', version=version+1, updated_at=? WHERE id=?").run(new Date(Date.now() + 1000).toISOString(), t.id);
    B.prepare(
      `INSERT INTO change_log(change_id, org_id, entity_type, entity_id, op, payload_json, hlc, origin_device_id, synced_to_cloud, created_at)
       SELECT 'chg_test_edit', org_id, 'tenants', id, 'UPSERT', json_object('id',id,'org_id',org_id,'full_name',full_name,'phone',phone,'alt_phone',alt_phone,'id_number',id_number,'email',email,'emergency_name',emergency_name,'emergency_phone',emergency_phone,'notes',notes,'version',version,'updated_at',updated_at,'deleted_at',deleted_at,'origin_device_id',origin_device_id), 'zzz', ?, 0, ? FROM tenants WHERE id=?`,
    ).run(ctxB.deviceId, new Date().toISOString(), t.id);
    await syncBetween(ctxB, A);
    expect((A.prepare('SELECT phone FROM tenants WHERE id=?').get(t.id) as any).phone).toBe('+254711111111');
  });
});

describe('device revocation', () => {
  it('a revoked device can no longer sync', async () => {
    // owner revokes Jane's phone on the laptop
    A.prepare("UPDATE devices SET status='REVOKED', version=version+1, updated_at=? WHERE id=?").run(new Date().toISOString(), ctxB.deviceId);
    await expect(syncBetween(ctxB, A)).rejects.toThrow(/revoked|not paired/);
  });
});

describe('deterministic charges across devices', () => {
  it('both devices generating the same month produce identical charges — no dupes after sync', async () => {
    const unitId = (A.prepare("SELECT id FROM units WHERE label='A-7'").get() as any).id;
    const t = createTenant(ctxA, { fullName: 'Charge Tenant', moveIn: { unitId, startDate: today } });
    await syncBetween(ctxA, B);
    ensureCharges(ctxA);
    ensureCharges(ctxB); // independently, while "offline"
    await syncBetween(ctxB, A);
    for (const db of [A, B]) {
      const charges = db.prepare("SELECT id FROM ledger_entries WHERE tenancy_id=? AND entry_type='CHARGE'").all(t.tenancyId) as any[];
      expect(charges).toHaveLength(1);
    }
  });
});
