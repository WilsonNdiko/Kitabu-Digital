import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newKitabu, setupGreenView } from './helpers.ts';
import type { TenancyRow } from '../src/domain/types.ts';
import { KitabuError } from '../src/foundation/errors.ts';

function occupiedTenancy(kitabu: ReturnType<typeof newKitabu>['kitabu'], unitId: string, rentMinor = 1_200_000): TenancyRow {
  const tenant = kitabu.services.tenant.registerTenant({ fullName: `Tenant ${Math.floor(Math.random() * 1e9)}` });
  return kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId, rentMinor, startDate: '2026-01-05',
  });
}

test('payment: cash recorded by the owner verifies immediately and posts the credit', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenancy = occupiedTenancy(kitabu, gv.units.a11);
  kitabu.services.ledger.generateMonthlyCharges('2026-09');

  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 1_200_000, method: 'CASH', paidAt: '2026-09-04',
  });
  assert.equal(payment.status, 'VERIFIED');
  assert.equal(payment.verified_by_user_id, kitabu.actingUserId);

  // Credit posted, balance settled.
  const credit = kitabu.services.payment.creditEntryFor(payment.id);
  assert.ok(credit);
  assert.equal(credit.direction, 'CREDIT');
  assert.equal(credit.payment_id, payment.id);
  assert.equal(kitabu.services.ledger.tenancyBalance(tenancy.id), 0);

  // Receipt issuable immediately.
  const receipt = kitabu.services.receipt.issueReceipt(payment.id);
  assert.equal(receipt.receipt.receipt_no, 'R-000001');
  kitabu.close();
});

test('payment: M-Pesa reference recorded by a caretaker stays PENDING — no credit, no receipt', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenancy = occupiedTenancy(kitabu, gv.units.a11);
  kitabu.services.ledger.generateMonthlyCharges('2026-09');

  const caretaker = kitabu.services.organization.addUser({ fullName: 'Jane Caretaker', role: 'CARETAKER' });
  kitabu.setActingUser(caretaker.id);

  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 1_200_000, method: 'MPESA', paidAt: '2026-09-04', reference: 'QGH7XJ2M9L',
  });
  assert.equal(payment.status, 'PENDING');
  assert.equal(kitabu.services.payment.creditEntryFor(payment.id), null);
  assert.equal(kitabu.services.ledger.tenancyBalance(tenancy.id), 1_200_000); // charge unpaid

  // Receipts are owner-only; switching back to the owner shows the PENDING state is what blocks it.
  const owner = kitabu.services.organization.listUsers().find((u) => u.role === 'OWNER')!;
  kitabu.setActingUser(owner.id);
  assert.throws(() => kitabu.services.receipt.issueReceipt(payment.id), /not verified yet/i);
  kitabu.close();
});

test('payment: caretaker cash also stays PENDING — only the owner trusts counted cash', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenancy = occupiedTenancy(kitabu, gv.units.a11);
  const caretaker = kitabu.services.organization.addUser({ fullName: 'Jane Caretaker', role: 'CARETAKER' });
  kitabu.setActingUser(caretaker.id);

  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 5_000, method: 'CASH', paidAt: '2026-09-04',
  });
  assert.equal(payment.status, 'PENDING');
  assert.equal(kitabu.services.payment.pending().length, 1);
  kitabu.close();
});

test('payment: owner verifies a pending payment — credit posts, waterfall allocates oldest-first', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenancy = occupiedTenancy(kitabu, gv.units.a11, 1_000_000);
  kitabu.services.ledger.generateMonthlyCharges('2026-07');
  kitabu.services.ledger.generateMonthlyCharges('2026-08');
  kitabu.services.ledger.generateMonthlyCharges('2026-09');

  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 1_500_000, method: 'MPESA', paidAt: '2026-09-04', reference: 'QAB12CD34E',
  });
  assert.equal(payment.status, 'PENDING');
  const verified = kitabu.services.payment.verifyPayment(payment.id, 'Checked M-Pesa message');
  assert.equal(verified.status, 'VERIFIED');

  // 15,000 paid: 10,000 settles July fully, 5,000 partially settles August.
  const allocations = kitabu.services.payment.ctx.db
    .prepare('SELECT * FROM payment_allocations WHERE payment_id = ? ORDER BY amount_minor DESC')
    .all(payment.id) as Array<{ charge_id: string; amount_minor: number }>;
  assert.equal(allocations.length, 2);
  assert.deepEqual(allocations.map((a) => a.amount_minor).sort((a, b) => b - a), [1_000_000, 500_000]);

  assert.equal(kitabu.services.ledger.monthStatus(tenancy.id, '2026-07').status, 'PAID');
  assert.equal(kitabu.services.ledger.monthStatus(tenancy.id, '2026-08').status, 'PARTIAL');
  assert.equal(kitabu.services.ledger.monthStatus(tenancy.id, '2026-09').status, 'UNPAID');
  assert.equal(kitabu.services.ledger.tenancyBalance(tenancy.id), 1_500_000); // 30,000 - 15,000
  kitabu.close();
});

test('payment: an over-payment becomes advance (negative balance), no phantom allocations', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenancy = occupiedTenancy(kitabu, gv.units.a11, 1_000_000);
  kitabu.services.ledger.generateMonthlyCharges('2026-09');

  kitabu.services.payment.recordPayment({ tenancyId: tenancy.id, amountMinor: 1_500_000, method: 'CASH', paidAt: '2026-09-04' });
  assert.equal(kitabu.services.ledger.tenancyBalance(tenancy.id), -500_000);

  const allocations = kitabu.services.payment.ctx.db.prepare('SELECT * FROM payment_allocations').all();
  assert.equal(allocations.length, 1); // only the 10,000 charge was settled
  kitabu.close();
});

test('payment: duplicate M-Pesa references are impossible (friendly + DB backstop)', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const t1 = occupiedTenancy(kitabu, gv.units.a11);
  const t2 = occupiedTenancy(kitabu, gv.units.a12);

  kitabu.services.payment.recordPayment({
    tenancyId: t1.id, amountMinor: 10_000, method: 'MPESA', paidAt: '2026-09-04', reference: 'qgh7xj2m9l',
  });
  assert.throws(
    () => kitabu.services.payment.recordPayment({
      tenancyId: t2.id, amountMinor: 10_000, method: 'MPESA', paidAt: '2026-09-04', reference: 'QGH7XJ2M9L',
    }),
    /already been recorded/i,
  );

  // Even raw SQL cannot sneak a duplicate past the partial unique index.
  const db = kitabu.services.payment.ctx.db;
  assert.throws(
    () => db.prepare(
      `INSERT INTO payments (id, org_id, tenancy_id, property_id, unit_id, tenant_id, amount_minor, method, paid_at, reference, status, recorded_by_device_id, created_at, updated_at, version, hlc, origin_device_id)
       VALUES ('x','${kitabu.orgId}','${t2.id}','x','x','x',1,'MPESA','2026-09-04','QGH7XJ2M9L','PENDING','x','t','t',1,'0','x')`,
    ).run(),
    /UNIQUE/i,
  );
  kitabu.close();
});

test('payment: M-Pesa requires a reference; validation errors are friendly', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenancy = occupiedTenancy(kitabu, gv.units.a11);

  assert.throws(
    () => kitabu.services.payment.recordPayment({ tenancyId: tenancy.id, amountMinor: 1_000, method: 'MPESA', paidAt: '2026-09-04' }),
    /M-Pesa code/i,
  );
  assert.throws(
    () => kitabu.services.payment.recordPayment({ tenancyId: tenancy.id, amountMinor: 0, method: 'CASH', paidAt: '2026-09-04' }),
    /positive/i,
  );
  assert.throws(
    () => kitabu.services.payment.recordPayment({ tenancyId: tenancy.id, amountMinor: 1_000, method: 'CASH', paidAt: '2026-13-01' }),
    /valid date/i,
  );
  kitabu.close();
});

test('payment: rejection closes a payment with a reason and posts nothing', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenancy = occupiedTenancy(kitabu, gv.units.a11);
  kitabu.services.ledger.generateMonthlyCharges('2026-09');

  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 1_200_000, method: 'MPESA', paidAt: '2026-09-04', reference: 'QZZ99ZZ99Z',
  });
  const rejected = kitabu.services.payment.rejectPayment(payment.id, 'Code not found on the M-Pesa statement');
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(kitabu.services.payment.creditEntryFor(payment.id), null);
  assert.equal(kitabu.services.ledger.tenancyBalance(tenancy.id), 1_200_000); // still owed

  // REJECTED is terminal — the trigger blocks any further transition.
  const db = kitabu.services.payment.ctx.db;
  assert.throws(
    () => db.prepare("UPDATE payments SET status = 'VERIFIED' WHERE id = ?").run(payment.id),
    /PAYMENT_ILLEGAL_TRANSITION/,
  );
  assert.throws(() => kitabu.services.payment.verifyPayment(payment.id), /closed/i);
  kitabu.close();
});

test('payment: reversal — the only correction path; history fully preserved', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenancy = occupiedTenancy(kitabu, gv.units.a11, 1_000_000);
  kitabu.services.ledger.generateMonthlyCharges('2026-09');

  // Cash 10,000 recorded, verified, receipted — but it should have been 8,000.
  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 1_000_000, method: 'CASH', paidAt: '2026-09-04',
  });
  const receipt = kitabu.services.receipt.issueReceipt(payment.id);

  const { payment: reversed, reversal } = kitabu.services.payment.reversePayment(payment.id, 'Over-recorded by KSh 2,000');
  assert.equal(reversed.status, 'REVERSED');
  assert.equal(reversed.reversal_reason, 'Over-recorded by KSh 2,000');
  assert.equal(reversal.direction, 'DEBIT');
  assert.equal(reversal.reversal_of, kitabu.services.payment.creditEntryFor(payment.id)!.id);

  // Balance restored to full charge; original entries all still present.
  assert.equal(kitabu.services.ledger.tenancyBalance(tenancy.id), 1_000_000);
  const entries = kitabu.services.ledger.listEntries(tenancy.id);
  assert.equal(entries.filter((e) => e.entry_type === 'CHARGE').length, 1);
  assert.equal(entries.filter((e) => e.entry_type === 'PAYMENT_CREDIT').length, 1);
  assert.equal(entries.filter((e) => e.entry_type === 'REVERSAL').length, 1);

  // The receipt was voided automatically; its number is kept.
  const voided = kitabu.services.receipt.getReceipt(receipt.receipt.id);
  assert.ok(voided.voided_at !== null);
  assert.match(voided.void_reason!, /Payment reversed/);

  // The corrected payment records cleanly and gets a fresh receipt number.
  const corrected = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 800_000, method: 'CASH', paidAt: '2026-09-04',
  });
  assert.equal(kitabu.services.ledger.tenancyBalance(tenancy.id), 200_000);
  const newReceipt = kitabu.services.receipt.issueReceipt(corrected.id);
  assert.notEqual(newReceipt.receipt.receipt_no, receipt.receipt.receipt_no);
  kitabu.close();
});

test('payment: verified payments are frozen — the DB trigger blocks amount edits', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenancy = occupiedTenancy(kitabu, gv.units.a11);
  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 1_000, method: 'CASH', paidAt: '2026-09-04',
  });
  const db = kitabu.services.payment.ctx.db;
  assert.throws(
    () => db.prepare('UPDATE payments SET amount_minor = 999999 WHERE id = ?').run(payment.id),
    /PAYMENT_IMMUTABLE/,
  );
  assert.throws(
    () => db.prepare("UPDATE payments SET paid_at = '2026-01-01' WHERE id = ?").run(payment.id),
    /PAYMENT_IMMUTABLE/,
  );
  // Legal state transitions still pass the trigger map (VERIFIED → REVERSED only).
  assert.throws(
    () => db.prepare("UPDATE payments SET status = 'PENDING' WHERE id = ?").run(payment.id),
    /PAYMENT_ILLEGAL_TRANSITION/,
  );
  kitabu.close();
});

test('payment: only the owner can verify, reject or reverse', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenancy = occupiedTenancy(kitabu, gv.units.a11);

  const caretaker = kitabu.services.organization.addUser({ fullName: 'Jane', role: 'CARETAKER' });
  kitabu.setActingUser(caretaker.id);
  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 1_000, method: 'MPESA', paidAt: '2026-09-04', reference: 'QAA11AA11A',
  });

  for (const fn of [
    () => kitabu.services.payment.verifyPayment(payment.id),
    () => kitabu.services.payment.rejectPayment(payment.id, 'no'),
    () => kitabu.services.payment.reversePayment(payment.id, 'no'),
  ]) {
    assert.throws(fn, (err: unknown) => err instanceof KitabuError && err.code === 'PERMISSION');
  }
  kitabu.close();
});

test('payment: a pending payment cannot be reversed (reject instead), a verified one cannot be rejected', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenancy = occupiedTenancy(kitabu, gv.units.a11);

  const pending = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 1_000, method: 'MPESA', paidAt: '2026-09-04', reference: 'QBB22BB22B',
  });
  assert.throws(() => kitabu.services.payment.reversePayment(pending.id, 'x'), /Only a verified payment/i);

  const verified = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 2_000, method: 'CASH', paidAt: '2026-09-04',
  });
  assert.throws(() => kitabu.services.payment.rejectPayment(verified.id, 'x'), /Only a pending payment/i);
  kitabu.close();
});

test('payment: payments on an ENDED tenancy still work (settling arrears after move-out)', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenancy = occupiedTenancy(kitabu, gv.units.a11, 1_000_000);
  kitabu.services.ledger.generateMonthlyCharges('2026-08');
  kitabu.services.tenancy.endTenancy(tenancy.id, '2026-08-31', 'Moved out owing');

  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 1_000_000, method: 'CASH', paidAt: '2026-09-10',
  });
  assert.equal(payment.status, 'VERIFIED');
  assert.equal(kitabu.services.ledger.tenancyBalance(tenancy.id), 0);
  assert.equal(kitabu.services.receipt.issueReceipt(payment.id).receipt.receipt_no, 'R-000001');
  kitabu.close();
});

test('payment: allocation cannot exceed the payment amount (DB backstop)', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenancy = occupiedTenancy(kitabu, gv.units.a11, 1_000_000);
  kitabu.services.ledger.generateMonthlyCharges('2026-09');
  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 400_000, method: 'CASH', paidAt: '2026-09-04',
  });
  const charge = kitabu.services.ledger.listEntries(tenancy.id).find((e) => e.entry_type === 'CHARGE')!;
  const db = kitabu.services.payment.ctx.db;
  assert.throws(
    () => db.prepare(
      `INSERT INTO payment_allocations (id, org_id, payment_id, charge_id, amount_minor, created_at, updated_at, version, hlc, origin_device_id)
       VALUES ('x','${kitabu.orgId}','${payment.id}','${charge.id}',999999999,'t','t',1,'0','x')`,
    ).run(),
    /ALLOCATION_EXCEEDS_PAYMENT/,
  );
  // Allocations are immutable.
  assert.throws(
    () => db.prepare('UPDATE payment_allocations SET amount_minor = 1').run(),
    /ALLOCATION_IMMUTABLE/,
  );
  kitabu.close();
});
