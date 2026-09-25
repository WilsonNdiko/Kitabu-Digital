import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newKitabu, setupGreenView } from './helpers.ts';
import type { TenancyRow } from '../src/domain/types.ts';

function occupiedTenancy(kitabu: ReturnType<typeof newKitabu>['kitabu'], unitId: string, rentMinor = 1_200_000): TenancyRow {
  const tenant = kitabu.services.tenant.registerTenant({ fullName: `Tenant ${Math.floor(Math.random() * 1e9)}` });
  return kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId, rentMinor, startDate: '2026-01-05',
  });
}

const SIG_A = 'a'.repeat(64);
const SIG_B = 'b'.repeat(64);

test('receipt: numbers come from a lazily reserved block and never repeat', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const t1 = occupiedTenancy(kitabu, gv.units.a11);
  const t2 = occupiedTenancy(kitabu, gv.units.a12);

  const p1 = kitabu.services.payment.recordPayment({ tenancyId: t1.id, amountMinor: 1_000, method: 'CASH', paidAt: '2026-09-04' });
  const p2 = kitabu.services.payment.recordPayment({ tenancyId: t2.id, amountMinor: 1_000, method: 'CASH', paidAt: '2026-09-04' });
  const r1 = kitabu.services.receipt.issueReceipt(p1.id).receipt;
  const r2 = kitabu.services.receipt.issueReceipt(p2.id).receipt;
  assert.equal(r1.receipt_no, 'R-000001');
  assert.equal(r2.receipt_no, 'R-000002');
  assert.ok(kitabu.services.receipt.numbersRemainingInBlock() > 0);
  assert.ok(kitabu.services.receipt.numbersRemainingInBlock() < 500);

  // Voiding keeps the number spent; reissue takes the next number.
  kitabu.services.receipt.voidReceipt(r1.id, 'Printed for the wrong tenant');
  const re = kitabu.services.receipt.issueReceipt(p1.id);
  assert.equal(re.receipt.receipt_no, 'R-000003');
  kitabu.close();
});

test('receipt: snapshot is assembled from system data — nothing re-typed, everything frozen', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau', phone: '0712345678' });
  const tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a12, rentMinor: 1_200_000, startDate: '2026-01-05',
  });
  kitabu.services.ledger.generateMonthlyCharges('2026-08');
  kitabu.services.ledger.generateMonthlyCharges('2026-09');

  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 1_200_000, method: 'MPESA', paidAt: '2026-09-04', reference: 'QGH7XJ2M9L',
  });
  kitabu.services.payment.verifyPayment(payment.id, 'Checked');

  const { receipt, snapshot } = kitabu.services.receipt.issueReceipt(payment.id);
  assert.equal(snapshot.orgName, 'Wilson Properties');
  assert.equal(snapshot.propertyName, 'Green View Apartments');
  assert.equal(snapshot.tenantName, 'John Kamau');
  assert.equal(snapshot.unitLabel, 'A-12');
  assert.equal(snapshot.amountMinor, 1_200_000);
  assert.equal(snapshot.amountWords, 'Kenya Shillings Twelve Thousand Only');
  assert.equal(snapshot.method, 'MPESA');
  assert.equal(snapshot.reference, 'QGH7XJ2M9L');
  // Aug + Sep were both owed (24,000); the 12,000 payment settled August only.
  assert.equal(snapshot.previousBalanceMinor, 2_400_000);
  assert.equal(snapshot.remainingBalanceMinor, 1_200_000); // September still due
  assert.deepEqual(snapshot.periods, ['2026-08']); // waterfall settled August
  assert.ok(receipt.digest.length === 64);

  // Renaming the tenant/property afterwards must not change the issued receipt.
  kitabu.services.tenant.updateTenant(tenant.id, { fullName: 'John Kamau Senior' });
  const stored = kitabu.services.receipt.getReceipt(receipt.id);
  assert.ok(JSON.parse(stored.snapshot_json).tenantName === 'John Kamau');
  const integrity = kitabu.services.receipt.verifyReceiptIntegrity(stored);
  assert.equal(integrity.ok, true);
  assert.equal(integrity.signatureValid, true);
  kitabu.close();
});

test('receipt: signatures are per-scope — property-specific wins, org default as fallback', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  kitabu.services.receipt.registerSignature({ imageDigest: SIG_A, label: 'Org Default' });
  const other = kitabu.services.property.createProperty({ name: 'Riverside Court' });
  const u = kitabu.services.property.addUnit({ propertyId: other.id, label: 'R-1' });

  // Green View has no property signature → org default applies.
  const t1 = occupiedTenancy(kitabu, gv.units.a11);
  const p1 = kitabu.services.payment.recordPayment({ tenancyId: t1.id, amountMinor: 500, method: 'CASH', paidAt: '2026-09-04' });
  const s1 = kitabu.services.receipt.issueReceipt(p1.id).snapshot;
  assert.equal(s1.signatureLabel, 'Org Default');

  // Riverside gets its own signature.
  kitabu.services.receipt.registerSignature({ propertyId: other.id, imageDigest: SIG_B, label: 'Riverside Sign' });
  const t2 = occupiedTenancy(kitabu, u.id);
  const p2 = kitabu.services.payment.recordPayment({ tenancyId: t2.id, amountMinor: 500, method: 'CASH', paidAt: '2026-09-04' });
  const s2 = kitabu.services.receipt.issueReceipt(p2.id).snapshot;
  assert.equal(s2.signatureLabel, 'Riverside Sign');

  // Replacing the signature later does not touch issued receipts.
  kitabu.services.receipt.registerSignature({ imageDigest: 'c'.repeat(64), label: 'New Org Default' });
  assert.equal(s1.signatureDigest, SIG_A);
  const reissuedCheck = kitabu.services.receipt.getReceiptByNo(s1.receiptNo);
  assert.ok(JSON.parse(reissuedCheck.snapshot_json).signatureLabel === 'Org Default');
  kitabu.close();
});

test('receipt: one live receipt per payment; double issue is refused', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenancy = occupiedTenancy(kitabu, gv.units.a11);
  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 1_000, method: 'CASH', paidAt: '2026-09-04',
  });
  kitabu.services.receipt.issueReceipt(payment.id);
  assert.throws(() => kitabu.services.receipt.issueReceipt(payment.id), /already issued/i);
  kitabu.close();
});

test('receipt: reissue = void + new number; the voided receipt remains visible', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenancy = occupiedTenancy(kitabu, gv.units.a11);
  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 1_000, method: 'CASH', paidAt: '2026-09-04',
  });
  const first = kitabu.services.receipt.issueReceipt(payment.id).receipt;

  const { voided, reissued } = kitabu.services.receipt.reissueReceipt(first.id, 'Wrong amount printed');
  assert.equal(voided.voided_at !== null, true);
  assert.equal(voided.receipt_no, first.receipt_no);
  assert.notEqual(reissued.receipt.receipt_no, first.receipt_no);
  assert.equal(reissued.receipt.payment_id, payment.id);

  const all = kitabu.services.receipt.listReceipts({ includeVoided: true });
  assert.equal(all.length, 2);
  assert.equal(kitabu.services.receipt.listReceipts().length, 1);
  kitabu.close();
});

test('receipt: the DB forbids editing or deleting issued receipts', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenancy = occupiedTenancy(kitabu, gv.units.a11);
  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 1_000, method: 'CASH', paidAt: '2026-09-04',
  });
  const receipt = kitabu.services.receipt.issueReceipt(payment.id).receipt;
  const db = kitabu.services.receipt.ctx.db;

  assert.throws(() => db.prepare('UPDATE receipts SET snapshot_json = \'{"forged":true}\' WHERE id = ?').run(receipt.id), /RECEIPT_IMMUTABLE/);
  assert.throws(() => db.prepare('UPDATE receipts SET receipt_no = \'R-999999\' WHERE id = ?').run(receipt.id), /RECEIPT_IMMUTABLE/);
  assert.throws(() => db.prepare('DELETE FROM receipts WHERE id = ?').run(receipt.id), /RECEIPT_IMMUTABLE/);
  kitabu.close();
});

test('receipt: forged receipts fail integrity verification offline', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenancy = occupiedTenancy(kitabu, gv.units.a11);
  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 1_000, method: 'CASH', paidAt: '2026-09-04',
  });
  const good = kitabu.services.receipt.issueReceipt(payment.id).receipt;
  assert.equal(kitabu.services.receipt.verifyReceiptIntegrity(good).ok, true);

  // A receipt inserted with a tampered snapshot/digest fails verification.
  const db = kitabu.services.receipt.ctx.db;
  db.prepare(
    `INSERT INTO receipts (id, org_id, receipt_no, payment_id, tenancy_id, property_id, snapshot_json, digest, crypto_signature, issued_by_device_id, created_at, updated_at, version, hlc, origin_device_id)
     VALUES ('forged','${kitabu.orgId}','R-900001','${payment.id}','${tenancy.id}','${tenancy.property_id}','{"receiptNo":"R-900001","amountMinor":1}','${'0'.repeat(64)}','AAAA','${kitabu.deviceId}','t','t',1,'0','${kitabu.deviceId}')`,
  ).run();
  const forged = kitabu.services.receipt.getReceipt('forged');
  const result = kitabu.services.receipt.verifyReceiptIntegrity(forged);
  assert.equal(result.ok, false);
  assert.equal(result.digestMatches, false);
  assert.equal(result.signatureValid, false);
  kitabu.close();
});

test('receipt: the org signing key is generated once and reused', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const t1 = occupiedTenancy(kitabu, gv.units.a11);
  const t2 = occupiedTenancy(kitabu, gv.units.a12);
  const p1 = kitabu.services.payment.recordPayment({ tenancyId: t1.id, amountMinor: 1_000, method: 'CASH', paidAt: '2026-09-04' });
  const p2 = kitabu.services.payment.recordPayment({ tenancyId: t2.id, amountMinor: 1_000, method: 'CASH', paidAt: '2026-09-04' });
  kitabu.services.receipt.issueReceipt(p1.id);
  kitabu.services.receipt.issueReceipt(p2.id);

  const keys = kitabu.services.receipt.ctx.db.prepare('SELECT * FROM org_keys').all();
  assert.equal(keys.length, 1);
  assert.equal((keys[0] as { purpose: string }).purpose, 'receipt_signing');
  kitabu.close();
});

test('receipt: only the owner issues, voids and reissues receipts', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenancy = occupiedTenancy(kitabu, gv.units.a11);
  const caretaker = kitabu.services.organization.addUser({ fullName: 'Jane', role: 'CARETAKER' });
  kitabu.setActingUser(caretaker.id);

  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 1_000, method: 'MPESA', paidAt: '2026-09-04', reference: 'QDD44DD44D',
  });
  kitabu.setActingUser(caretaker.id);
  assert.throws(() => kitabu.services.receipt.issueReceipt(payment.id), /Only an owner/i);
  kitabu.close();
});
