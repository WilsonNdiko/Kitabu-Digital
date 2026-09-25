import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newKitabu, setupGreenView } from './helpers.ts';

/**
 * The FINANCIAL-LEDGER.md §5 worked examples, executed end-to-end exactly as a
 * landlord would (minus the UI). These are the scenarios the brief demands the
 * books must never get wrong.
 */

test('workbook: partial payment with carried arrears (waterfall pays the oldest month first)', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau' });
  const tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a12, rentMinor: 1_200_000, startDate: '2026-01-05',
  });

  // Two months charged, nothing paid, then 8,000 arrives in September.
  kitabu.services.ledger.generateMonthlyCharges('2026-08');
  kitabu.services.ledger.generateMonthlyCharges('2026-09');
  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 800_000, method: 'MPESA', paidAt: '2026-09-04', reference: 'QGH7XJ2M9L',
  });
  kitabu.services.payment.verifyPayment(payment.id, 'Checked the statement');

  // Waterfall: August is settled first (4,000 outstanding), September untouched.
  const aug = kitabu.services.ledger.monthStatus(tenancy.id, '2026-08');
  const sep = kitabu.services.ledger.monthStatus(tenancy.id, '2026-09');
  assert.equal(aug.status, 'PARTIAL');
  assert.equal(aug.paidMinor, 800_000);
  assert.equal(sep.status, 'UNPAID');
  assert.equal(kitabu.services.ledger.tenancyBalance(tenancy.id), 1_600_000); // 24,000 - 8,000

  // Arrears view shows exactly this tenant with the right number.
  const arrears = kitabu.services.ledger.arrears();
  assert.equal(arrears.length, 1);
  assert.equal(arrears[0]!.tenantName, 'John Kamau');
  assert.equal(arrears[0]!.unitLabel, 'A-12');
  assert.equal(arrears[0]!.balanceMinor, 1_600_000);
  kitabu.close();
});

test('workbook: advance rent shows as advance, never as negative debt in the books', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'New Tenant' });
  const tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 1_200_000, startDate: '2026-09-01',
  });

  kitabu.services.ledger.generateMonthlyCharges('2026-09');
  kitabu.services.ledger.generateMonthlyCharges('2026-10');
  kitabu.services.payment.recordPayment({ tenancyId: tenancy.id, amountMinor: 2_400_000, method: 'CASH', paidAt: '2026-09-02' });
  assert.equal(kitabu.services.ledger.tenancyBalance(tenancy.id), 0);

  kitabu.services.payment.recordPayment({ tenancyId: tenancy.id, amountMinor: 1_200_000, method: 'CASH', paidAt: '2026-09-20' });
  const balance = kitabu.services.ledger.tenancyBalance(tenancy.id);
  assert.equal(balance, -1_200_000); // KSh 12,000 in advance

  // Advance tenants never appear in arrears.
  assert.equal(kitabu.services.ledger.arrears().length, 0);
  kitabu.close();
});

test('workbook: rent change mid-year leaves every historical charge untouched', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'Grace Njeri' });
  const tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 1_200_000, startDate: '2025-01-05',
  });

  for (const m of ['2026-06', '2026-07', '2026-08']) kitabu.services.ledger.generateMonthlyCharges(m);
  kitabu.services.tenancy.changeRent(tenancy.id, 1_400_000, '2026-09-01', 'Renewal');
  kitabu.services.ledger.generateMonthlyCharges('2026-09');

  const june = kitabu.services.ledger.monthStatus(tenancy.id, '2026-06');
  const september = kitabu.services.ledger.monthStatus(tenancy.id, '2026-09');
  assert.equal(june.chargeMinor, 1_200_000);
  assert.equal(september.chargeMinor, 1_400_000);

  // The rent history is fully queryable.
  const rates = kitabu.services.tenancy.rentRates(tenancy.id);
  assert.deepEqual(rates.map((r) => r.amount_minor), [1_200_000, 1_400_000]);
  assert.equal(rates[1]!.effective_from, '2026-09-01');
  kitabu.close();
});

test('workbook: error correction — over-recorded cash reversed, corrected, both receipts live in history', () => {
  const { kitabu, clock } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'Peter Otieno' });
  const tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.b04, rentMinor: 1_000_000, startDate: '2026-01-05',
  });
  kitabu.services.ledger.generateMonthlyCharges('2026-09'); // charge dated Sep 5 (due day)

  // Cash 10,000 recorded and receipted on the 6th — but only 8,000 was actually taken.
  const wrong = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 1_000_000, method: 'CASH', paidAt: '2026-09-06',
  });
  const wrongReceipt = kitabu.services.receipt.issueReceipt(wrong.id).receipt;

  // The error is found the next day: the reversal is dated when it happened.
  clock.set('2026-09-07T10:00:00.000Z');
  kitabu.services.payment.reversePayment(wrong.id, 'Over-recorded by KSh 2,000 — cash was 8,000');

  const right = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 800_000, method: 'CASH', paidAt: '2026-09-07',
  });
  const rightReceipt = kitabu.services.receipt.issueReceipt(right.id).receipt;

  // Final balance is exactly the 2,000 shortfall.
  assert.equal(kitabu.services.ledger.tenancyBalance(tenancy.id), 200_000);

  // The statement shows every step: charge, payment, reversal, corrected payment.
  const statement = kitabu.services.ledger.statement(tenancy.id);
  assert.deepEqual(
    statement.entries.map((e) => e.entry_type),
    ['CHARGE', 'PAYMENT_CREDIT', 'REVERSAL', 'PAYMENT_CREDIT'],
  );

  // Both receipts exist; the wrong one is voided, the right one is live.
  const all = kitabu.services.receipt.listReceipts({ includeVoided: true });
  assert.equal(all.length, 2);
  assert.equal(kitabu.services.receipt.getReceipt(wrongReceipt.id).voided_at !== null, true);
  assert.equal(kitabu.services.receipt.getReceipt(rightReceipt.id).voided_at, null);

  // The audit trail tells the whole story.
  const audit = kitabu.services.audit.list({ limit: 50 });
  const actions = audit.map((a) => a.action);
  for (const expected of ['PAYMENT_RECORDED', 'RECEIPT_ISSUED', 'PAYMENT_REVERSED', 'RECEIPT_VOIDED']) {
    assert.ok(actions.includes(expected), `audit missing ${expected}`);
  }
  kitabu.close();
});

test('workbook: one M-Pesa transaction can only ever pay once, whoever types the code', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const john = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau' });
  const mary = kitabu.services.tenant.registerTenant({ fullName: 'Mary Wanjiku' });
  const t1 = kitabu.services.tenancy.startTenancy({ tenantId: john.id, unitId: gv.units.a11, rentMinor: 1_200_000, startDate: '2026-01-05' });
  const t2 = kitabu.services.tenancy.startTenancy({ tenantId: mary.id, unitId: gv.units.a12, rentMinor: 1_200_000, startDate: '2026-01-05' });
  kitabu.services.ledger.generateMonthlyCharges('2026-09');

  // The landlord's phone records the code first (verified on the statement).
  const first = kitabu.services.payment.recordPayment({
    tenancyId: t1.id, amountMinor: 1_200_000, method: 'MPESA', paidAt: '2026-09-04', reference: 'QGH7XJ2M9L',
  });
  kitabu.services.payment.verifyPayment(first.id, 'Checked');

  // The caretaker (offline, not knowing) tries to record the same code for Mary.
  assert.throws(
    () => kitabu.services.payment.recordPayment({
      tenancyId: t2.id, amountMinor: 1_200_000, method: 'MPESA', paidAt: '2026-09-04', reference: 'QGH7XJ2M9L',
    }),
    /already been recorded/i,
  );

  // John's account settled exactly once; Mary's charge still stands, untouched.
  assert.equal(kitabu.services.ledger.tenancyBalance(t1.id), 0);
  assert.equal(kitabu.services.ledger.tenancyBalance(t2.id), 1_200_000);
  assert.equal(kitabu.services.payment.listPayments().length, 1);
  kitabu.close();
});
