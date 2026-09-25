import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newKitabu, setupGreenView } from './helpers.ts';
import { KitabuError } from '../src/foundation/errors.ts';

/**
 * Rent charges: materialized, idempotent, effective-dated (FINANCIAL-LEDGER.md §3).
 */
test('ledger: generateMonthlyCharges creates one RENT charge per occupied tenancy', () => {
  const { kitabu } = newKitabu('2026-09-01T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const t1 = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau' });
  const t2 = kitabu.services.tenant.registerTenant({ fullName: 'Mary Wanjiku' });
  kitabu.services.tenancy.startTenancy({ tenantId: t1.id, unitId: gv.units.a11, rentMinor: 1_000_000, startDate: '2026-01-05' });
  kitabu.services.tenancy.startTenancy({ tenantId: t2.id, unitId: gv.units.a12, rentMinor: 1_200_000, startDate: '2026-01-05' });

  const result = kitabu.services.ledger.generateMonthlyCharges('2026-09');
  assert.equal(result.created, 2);
  assert.equal(result.totalMinor, 2_200_000);

  // Idempotent: running again creates nothing new (same device or another device offline).
  const again = kitabu.services.ledger.generateMonthlyCharges('2026-09');
  assert.equal(again.created, 0);
  assert.equal(again.skipped, 2);
  kitabu.close();
});

test('ledger: charges use the rent rate effective at the due date — never rewrite history', () => {
  const { kitabu } = newKitabu('2026-09-01T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'Grace Njeri' });
  const tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 1_000_000, startDate: '2026-01-05',
  });

  kitabu.services.ledger.generateMonthlyCharges('2026-08'); // at 10,000
  kitabu.services.tenancy.changeRent(tenancy.id, 1_350_000, '2026-09-01', 'Renewal');
  kitabu.services.ledger.generateMonthlyCharges('2026-09'); // at 13,500

  const aug = kitabu.services.ledger.monthStatus(tenancy.id, '2026-08');
  const sep = kitabu.services.ledger.monthStatus(tenancy.id, '2026-09');
  assert.equal(aug.chargeMinor, 1_000_000); // unchanged forever
  assert.equal(sep.chargeMinor, 1_350_000);
  assert.equal(aug.status, 'UNPAID');
  kitabu.close();
});

test('ledger: skips tenants not yet moved in or already moved out at the due date', () => {
  const { kitabu } = newKitabu('2026-09-01T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const future = kitabu.services.tenant.registerTenant({ fullName: 'Future Tenant' });
  const past = kitabu.services.tenant.registerTenant({ fullName: 'Past Tenant' });

  // Moves in October — no September charge.
  kitabu.services.tenancy.startTenancy({ tenantId: future.id, unitId: gv.units.a11, rentMinor: 500_000, startDate: '2026-10-01' });
  // Moved out 3 Sep (before due date 5 Sep) — no September charge.
  const pastTenancy = kitabu.services.tenancy.startTenancy({
    tenantId: past.id, unitId: gv.units.a12, rentMinor: 500_000, startDate: '2026-01-05',
  });
  kitabu.services.tenancy.endTenancy(pastTenancy.id, '2026-09-03', 'Left');

  const result = kitabu.services.ledger.generateMonthlyCharges('2026-09');
  assert.equal(result.created, 0);
  assert.equal(result.skipped, 2);

  // But a tenancy that ended 20 Sep (after due date) IS charged for September.
  const midMonth = kitabu.services.tenant.registerTenant({ fullName: 'Mid Month' });
  const midTenancy = kitabu.services.tenancy.startTenancy({
    tenantId: midMonth.id, unitId: gv.units.b04, rentMinor: 700_000, startDate: '2026-01-05',
  });
  kitabu.services.tenancy.endTenancy(midTenancy.id, '2026-09-20', 'Left');
  assert.equal(kitabu.services.ledger.generateMonthlyCharges('2026-09').created, 1);
  kitabu.close();
});

test('ledger: DB forbids editing or deleting journal entries (immutability triggers)', () => {
  const { kitabu } = newKitabu('2026-09-01T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau' });
  const tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 1_000_000, startDate: '2026-01-05',
  });
  kitabu.services.ledger.generateMonthlyCharges('2026-09');
  const charge = kitabu.services.ledger.listEntries(tenancy.id)[0]!;

  const db = kitabu.services.ledger.ctx.db;
  assert.throws(() => db.prepare('UPDATE ledger_entries SET amount_minor = 1 WHERE id = ?').run(charge.id), /LEDGER_IMMUTABLE/);
  assert.throws(() => db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(charge.id), /LEDGER_IMMUTABLE/);
  kitabu.close();
});

test('ledger: manual charges, adjustments and charge reversal keep the journal balanced', () => {
  const { kitabu } = newKitabu('2026-09-01T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau' });
  const tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 1_000_000, startDate: '2026-01-05',
  });
  const svc = kitabu.services.ledger;

  svc.generateMonthlyCharges('2026-09');                     // +10,000 (debit)
  svc.addCharge({ tenancyId: tenancy.id, kind: 'WATER', amountMinor: 350_000, entryDate: '2026-09-10', period: '2026-09', reason: 'August water bill' });
  svc.addAdjustment({ tenancyId: tenancy.id, direction: 'CREDIT', amountMinor: 100_000, entryDate: '2026-09-11', reason: 'Goodwill discount' });
  assert.equal(svc.tenancyBalance(tenancy.id), 1_000_000 + 350_000 - 100_000);

  // Reversing the water charge removes exactly its effect.
  const water = svc.listEntries(tenancy.id).find((e) => e.kind === 'WATER')!;
  svc.reverseCharge(water.id, 'Wrong bill — different house');
  assert.equal(svc.tenancyBalance(tenancy.id), 1_000_000 - 100_000);

  // Double reversal is blocked.
  assert.throws(() => svc.reverseCharge(water.id, 'again'), /already been reversed/i);

  // Reversing a reversal is blocked (payments have their own path).
  const reversal = svc.listEntries(tenancy.id).find((e) => e.entry_type === 'REVERSAL')!;
  assert.throws(() => svc.reverseCharge(reversal.id, 'no'), /Reverse the payment instead/i);
  kitabu.close();
});

test('ledger: adjustments require a reason and the owner role', () => {
  const { kitabu } = newKitabu('2026-09-01T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau' });
  const tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 1_000_000, startDate: '2026-01-05',
  });

  assert.throws(() =>
    kitabu.services.ledger.addAdjustment({ tenancyId: tenancy.id, direction: 'CREDIT', amountMinor: 1, entryDate: '2026-09-01', reason: '   ' }),
    /reason/i);

  const caretaker = kitabu.services.organization.addUser({ fullName: 'Jane Caretaker', role: 'CARETAKER' });
  kitabu.setActingUser(caretaker.id);
  assert.throws(
    () => kitabu.services.ledger.addAdjustment({ tenancyId: tenancy.id, direction: 'CREDIT', amountMinor: 100, entryDate: '2026-09-01', reason: 'discount' }),
    (err: unknown) => err instanceof KitabuError && err.code === 'PERMISSION',
  );
  kitabu.close();
});

test('ledger: statement shows every entry with a correct running balance', () => {
  const { kitabu } = newKitabu('2026-09-01T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau' });
  const tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 1_000_000, startDate: '2026-01-05',
  });
  kitabu.services.ledger.generateMonthlyCharges('2026-08');
  kitabu.services.ledger.generateMonthlyCharges('2026-09');
  kitabu.services.payment.recordPayment({ tenancyId: tenancy.id, amountMinor: 600_000, method: 'CASH', paidAt: '2026-09-03' });

  const statement = kitabu.services.ledger.statement(tenancy.id);
  // Ordered by entry date: Aug charge (Aug 5), payment credit (Sep 3), Sep charge (Sep 5).
  assert.equal(statement.entries.length, 3);
  assert.equal(statement.entries[0]!.balance_after_minor, 1_000_000);
  assert.equal(statement.entries[1]!.balance_after_minor, 400_000);
  assert.equal(statement.entries[2]!.balance_after_minor, 1_400_000);
  assert.equal(statement.balanceMinor, 1_400_000);

  // Date-filtered statement carries the opening balance forward.
  const fromSep = kitabu.services.ledger.statement(tenancy.id, { from: '2026-09-01' });
  assert.equal(fromSep.entries.length, 2); // credit (Sep 3), Sep charge (Sep 5)
  assert.equal(fromSep.entries[0]!.balance_after_minor, 400_000); // opening 10,000 minus the credit
  assert.equal(fromSep.entries[1]!.balance_after_minor, 1_400_000);
  kitabu.close();
});

test('ledger: arrears lists tenancies owing, with last payment dates', () => {
  const { kitabu } = newKitabu('2026-09-01T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const owing = kitabu.services.tenant.registerTenant({ fullName: 'Owes Tenant' });
  const clear = kitabu.services.tenant.registerTenant({ fullName: 'Clear Tenant' });
  const t1 = kitabu.services.tenancy.startTenancy({ tenantId: owing.id, unitId: gv.units.a11, rentMinor: 1_000_000, startDate: '2026-01-05' });
  const t2 = kitabu.services.tenancy.startTenancy({ tenantId: clear.id, unitId: gv.units.a12, rentMinor: 1_000_000, startDate: '2026-01-05' });
  kitabu.services.ledger.generateMonthlyCharges('2026-09');
  kitabu.services.payment.recordPayment({ tenancyId: t2.id, amountMinor: 1_000_000, method: 'CASH', paidAt: '2026-09-04' });

  const arrears = kitabu.services.ledger.arrears();
  assert.equal(arrears.length, 1);
  assert.equal(arrears[0]!.tenancyId, t1.id);
  assert.equal(arrears[0]!.balanceMinor, 1_000_000);
  assert.equal(arrears[0]!.tenantName, 'Owes Tenant');

  const paidOff = kitabu.services.ledger.arrears().find((a) => a.tenancyId === t2.id);
  assert.equal(paidOff, undefined);
  const clearRow = kitabu.services.ledger.arrears();
  assert.ok(clearRow.every((a) => a.balanceMinor > 0));
  kitabu.close();
});

test('ledger: collection summary — expected vs collected vs rate', () => {
  const { kitabu } = newKitabu('2026-09-01T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau' });
  const tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 1_000_000, startDate: '2026-01-05',
  });
  kitabu.services.ledger.generateMonthlyCharges('2026-09');
  kitabu.services.payment.recordPayment({ tenancyId: tenancy.id, amountMinor: 600_000, method: 'CASH', paidAt: '2026-09-03' });

  const summary = kitabu.services.ledger.collectionSummary({ month: '2026-09' });
  assert.equal(summary.expectedMinor, 1_000_000);
  assert.equal(summary.collectedMinor, 600_000);
  assert.ok(Math.abs(summary.rate! - 0.6) < 1e-9);
  kitabu.close();
});

test('ledger: monthOverview gives dashboard paid/partial/unpaid counts', () => {
  const { kitabu } = newKitabu('2026-09-01T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const unpaid = kitabu.services.tenant.registerTenant({ fullName: 'U' });
  const partial = kitabu.services.tenant.registerTenant({ fullName: 'P' });
  const paid = kitabu.services.tenant.registerTenant({ fullName: 'C' });
  const vacantTenant = kitabu.services.tenant.registerTenant({ fullName: 'V' }); // no tenancy

  const t1 = kitabu.services.tenancy.startTenancy({ tenantId: unpaid.id, unitId: gv.units.a11, rentMinor: 1_000_000, startDate: '2026-01-05' });
  const t2 = kitabu.services.tenancy.startTenancy({ tenantId: partial.id, unitId: gv.units.a12, rentMinor: 1_000_000, startDate: '2026-01-05' });
  const t3 = kitabu.services.tenancy.startTenancy({ tenantId: paid.id, unitId: gv.units.b04, rentMinor: 1_000_000, startDate: '2026-01-05' });
  assert.ok(vacantTenant);
  kitabu.services.ledger.generateMonthlyCharges('2026-09');
  kitabu.services.payment.recordPayment({ tenancyId: t2.id, amountMinor: 400_000, method: 'CASH', paidAt: '2026-09-03' });
  kitabu.services.payment.recordPayment({ tenancyId: t3.id, amountMinor: 1_000_000, method: 'CASH', paidAt: '2026-09-03' });

  const overview = kitabu.services.ledger.monthOverview({ month: '2026-09' });
  assert.equal(overview.length, 3);
  assert.equal(overview.filter((s) => s.status === 'UNPAID').length, 1);
  assert.equal(overview.filter((s) => s.status === 'PARTIAL').length, 1);
  assert.equal(overview.filter((s) => s.status === 'PAID').length, 1);
  assert.ok(overview.some((s) => s.tenancyId === t1.id && s.status === 'UNPAID'));
  kitabu.close();
});
