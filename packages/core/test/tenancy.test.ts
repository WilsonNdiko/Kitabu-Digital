import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newKitabu, setupGreenView } from './helpers.ts';
import { KitabuError } from '../src/foundation/errors.ts';

/**
 * The heart of Milestone 1: tenancy history is never destroyed (brief §12, §48-6).
 */
test('tenancy: start makes the unit occupied and records the initial rent rate', () => {
  const { kitabu } = newKitabu();
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau', phone: '0712345678' });

  const tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id,
    unitId: gv.units.a12,
    rentMinor: 1_200_000, // KSh 12,000
    depositMinor: 2_400_000,
    startDate: '2026-01-05',
    expectedPaymentDay: 5,
  });

  assert.equal(tenancy.status, 'ACTIVE');
  assert.equal(tenancy.current_rent_minor, 1_200_000);
  assert.equal(kitabu.services.property.getUnit(gv.units.a12).status, 'OCCUPIED');

  const rates = kitabu.services.tenancy.rentRates(tenancy.id);
  assert.equal(rates.length, 1);
  assert.equal(rates[0]!.amount_minor, 1_200_000);
  assert.equal(rates[0]!.effective_from, '2026-01-05');
  kitabu.close();
});

test('tenancy: a unit cannot be double-let (friendly error + DB backstop)', () => {
  const { kitabu } = newKitabu();
  const gv = setupGreenView(kitabu);
  const t1 = kitabu.services.tenant.registerTenant({ fullName: 'One' });
  const t2 = kitabu.services.tenant.registerTenant({ fullName: 'Two' });

  kitabu.services.tenancy.startTenancy({
    tenantId: t1.id, unitId: gv.units.a11, rentMinor: 500_000, startDate: '2026-01-05',
  });
  assert.throws(
    () => kitabu.services.tenancy.startTenancy({
      tenantId: t2.id, unitId: gv.units.a11, rentMinor: 500_000, startDate: '2026-02-01',
    }),
    (err: unknown) => err instanceof KitabuError && /already has a tenant/i.test(err.userMessage),
  );

  // Even raw SQL cannot create a second ACTIVE tenancy on the unit.
  const tenancy1 = kitabu.services.tenancy.activeTenancyForUnit(gv.units.a11)!;
  assert.throws(
    () => kitabu.services.tenancy.ctx.db
      .prepare("INSERT INTO tenancies (id, org_id, tenant_id, unit_id, property_id, start_date, expected_payment_day, deposit_amount_minor, deposit_paid, current_rent_minor, status, created_at, updated_at, version, hlc, origin_device_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run('rawid', kitabu.orgId, t2.id, gv.units.a11, gv.propertyId, '2026-02-01', 5, 0, 0, 100, 'ACTIVE', 't', 't', 1, '0', kitabu.deviceId),
    /UNIQUE/i,
  );
  assert.ok(tenancy1);
  kitabu.close();
});

test('tenancy: end frees the unit and keeps the historical row', () => {
  const { kitabu } = newKitabu();
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'Peter Otieno' });
  const tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.b04, rentMinor: 800_000, startDate: '2026-01-05',
  });

  const ended = kitabu.services.tenancy.endTenancy(tenancy.id, '2026-08-31', 'Bought own house');
  assert.equal(ended.status, 'ENDED');
  assert.equal(ended.end_date, '2026-08-31');
  assert.equal(ended.end_reason, 'Bought own house');
  assert.equal(kitabu.services.property.getUnit(gv.units.b04).status, 'VACANT');

  // History preserved:
  const history = kitabu.services.tenancy.tenancyHistory(tenant.id);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.unit_label, 'B-04');
  assert.equal(history[0]!.status, 'ENDED');

  // Unit can be re-let immediately.
  const next = kitabu.services.tenant.registerTenant({ fullName: 'Next Tenant' });
  kitabu.services.tenancy.startTenancy({
    tenantId: next.id, unitId: gv.units.b04, rentMinor: 800_000, startDate: '2026-09-01',
  });
  assert.equal(kitabu.services.tenancy.tenancyHistory(next.id).length, 1);
  assert.equal(kitabu.services.tenancy.tenancyHistory(tenant.id).length, 1); // untouched
  kitabu.close();
});

test('tenancy: moving house preserves the previous tenancy and its rent history', () => {
  const { kitabu } = newKitabu();
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau' });

  const first = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a12, rentMinor: 1_200_000, startDate: '2025-01-05',
  });
  // Rent changed once during the first tenancy.
  kitabu.services.tenancy.changeRent(first.id, 1_350_000, '2026-01-05', 'Renewal');

  const { ended, started } = kitabu.services.tenancy.moveTenant(first.id, gv.units.b04, {
    date: '2026-09-01',
    newRentMinor: 1_500_000,
  });

  assert.equal(ended.status, 'ENDED');
  assert.equal(ended.end_date, '2026-09-01');
  assert.equal(started.status, 'ACTIVE');
  assert.equal(started.unit_id, gv.units.b04);
  assert.equal(started.current_rent_minor, 1_500_000);

  // Unit statuses flipped atomically.
  assert.equal(kitabu.services.property.getUnit(gv.units.a12).status, 'VACANT');
  assert.equal(kitabu.services.property.getUnit(gv.units.b04).status, 'OCCUPIED');

  // The history is intact: one tenant, two tenancies, three rent rates total.
  const history = kitabu.services.tenancy.tenancyHistory(tenant.id);
  assert.equal(history.length, 2);
  assert.equal(history[0]!.unit_label, 'A-12');
  assert.equal(history[1]!.unit_label, 'B-04');
  assert.equal(kitabu.services.tenancy.rentRates(first.id).length, 2);
  assert.equal(kitabu.services.tenancy.rentRates(started.id).length, 1);
  kitabu.close();
});

test('tenancy: move to an occupied unit is rejected atomically', () => {
  const { kitabu } = newKitabu();
  const gv = setupGreenView(kitabu);
  const john = kitabu.services.tenant.registerTenant({ fullName: 'John' });
  const mary = kitabu.services.tenant.registerTenant({ fullName: 'Mary' });

  const johnTenancy = kitabu.services.tenancy.startTenancy({
    tenantId: john.id, unitId: gv.units.a11, rentMinor: 500_000, startDate: '2026-01-05',
  });
  kitabu.services.tenancy.startTenancy({
    tenantId: mary.id, unitId: gv.units.a12, rentMinor: 500_000, startDate: '2026-01-05',
  });

  assert.throws(
    () => kitabu.services.tenancy.moveTenant(johnTenancy.id, gv.units.a12, { date: '2026-09-01' }),
    /already has a tenant/i,
  );
  // Atomic: John's original tenancy is untouched by the failed move.
  const still = kitabu.services.tenancy.getTenancy(johnTenancy.id);
  assert.equal(still.status, 'ACTIVE');
  assert.equal(kitabu.services.tenancy.tenancyHistory(john.id).length, 1);
  kitabu.close();
});

test('tenancy: rent changes are effective-dated and append-only', () => {
  const { kitabu } = newKitabu('2026-09-10T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'Grace Njeri' });
  const tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 1_000_000, startDate: '2026-01-01',
  });

  // A future-dated change is scheduled, not applied.
  const scheduled = kitabu.services.tenancy.changeRent(tenancy.id, 1_200_000, '2026-10-01', 'Renewal');
  assert.equal(scheduled.amount_minor, 1_200_000);
  assert.equal(kitabu.services.tenancy.getTenancy(tenancy.id).current_rent_minor, 1_000_000);

  // An immediate (already-effective) change applies now.
  kitabu.services.tenancy.changeRent(tenancy.id, 1_100_000, '2026-09-05');
  assert.equal(kitabu.services.tenancy.getTenancy(tenancy.id).current_rent_minor, 1_100_000);

  // rentOn() answers "what was the rent on date X" — history is queryable.
  assert.equal(kitabu.services.tenancy.rentOn(tenancy.id, '2026-05-01')!.amount_minor, 1_000_000);
  assert.equal(kitabu.services.tenancy.rentOn(tenancy.id, '2026-09-20')!.amount_minor, 1_100_000);
  assert.equal(kitabu.services.tenancy.rentOn(tenancy.id, '2026-12-01')!.amount_minor, 1_200_000);

  // Rates are append-only: a date can only ever have one rate.
  assert.throws(
    () => kitabu.services.tenancy.changeRent(tenancy.id, 900_000, '2026-09-05'),
    /already exists/i,
  );
  assert.equal(kitabu.services.tenancy.rentRates(tenancy.id).length, 3); // initial + scheduled + immediate
  kitabu.close();
});

test('tenancy: validation errors are friendly', () => {
  const { kitabu } = newKitabu();
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'X' });

  assert.throws(
    () => kitabu.services.tenancy.startTenancy({
      tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 0, startDate: '2026-01-01',
    }),
    /positive amount/i,
  );
  assert.throws(
    () => kitabu.services.tenancy.startTenancy({
      tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 100, startDate: '2026-13-45',
    }),
    /valid date/i,
  );
  assert.throws(
    () => kitabu.services.tenancy.startTenancy({
      tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 100, startDate: '2026-01-01', expectedPaymentDay: 31,
    }),
    /between 1 and 28/i,
  );
  assert.throws(
    () => kitabu.services.tenancy.endTenancy('missing-id', '2026-02-01'),
    /not found/i,
  );
  kitabu.close();
});

test('tenancy: archived tenants cannot start tenancies', () => {
  const { kitabu } = newKitabu();
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'Old Tenant' });
  kitabu.services.tenant.archiveTenant(tenant.id, 'Left');
  assert.throws(
    () => kitabu.services.tenancy.startTenancy({
      tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 500_000, startDate: '2026-01-01',
    }),
    /not found/i,
  );
  kitabu.close();
});
