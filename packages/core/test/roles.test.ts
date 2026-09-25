import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newKitabu, setupGreenView } from './helpers.ts';

/**
 * The SECURITY.md §3 role matrix, enforced in the core (the same checks run in
 * every shell and in the cloud). Caretakers record tenants and payments; the
 * owner runs the business. Nothing here is UI policy — it is bookkeeping law.
 */

function caretakerSession() {
  const { kitabu, clock } = newKitabu('2026-09-04T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const jane = kitabu.services.organization.addUser({ fullName: 'Jane Caretaker', role: 'CARETAKER' });
  kitabu.setActingUser(jane.id);
  return { kitabu, clock, gv, jane };
}

test('roles: a caretaker can register tenants and record payments — the daily work', () => {
  const { kitabu, gv } = caretakerSession();
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau', phone: '0712345678' });
  assert.equal(tenant.full_name, 'John Kamau');

  // The owner must place the tenant (done below) — but recording payments is open.
  kitabu.setActingUser(kitabu.services.organization.listUsers().find((u) => u.role === 'OWNER')!.id);
  const tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 1_200_000, startDate: '2026-09-01',
  });
  kitabu.services.ledger.generateMonthlyCharges('2026-09');
  kitabu.setActingUser(caretakerId(kitabu));
  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 1_200_000, method: 'MPESA', paidAt: '2026-09-04', reference: 'QGH7XJ2M9L',
  });
  assert.equal(payment.status, 'PENDING'); // caretaker M-Pesa never auto-verifies
  kitabu.close();
});

function caretakerId(kitabu: ReturnType<typeof newKitabu>['kitabu']): string {
  return kitabu.services.organization.listUsers().find((u) => u.role === 'CARETAKER')!.id;
}

test('roles: letting decisions are owner-only — properties, houses, tenancies, rent', () => {
  const { kitabu, gv } = caretakerSession();
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau', phone: '0712345678' });

  assert.throws(() => kitabu.services.property.createProperty({ name: 'Sneaky Apartments' }), /Only an owner/i);
  assert.throws(() => kitabu.services.property.addUnit({ propertyId: gv.propertyId, label: 'X-01' }), /Only an owner/i);
  assert.throws(
    () => kitabu.services.tenancy.startTenancy({
      tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 1_200_000, startDate: '2026-09-01',
    }),
    /Only an owner/i,
  );
  assert.throws(() => kitabu.services.ledger.generateMonthlyCharges('2026-09'), /Only an owner/i);
  assert.throws(
    () => kitabu.services.tenancy.changeRent('any', 1_400_000, '2026-10-01'),
    /Only an owner/i,
  );
  assert.throws(
    () => kitabu.services.tenancy.endTenancy('any', '2026-09-30'),
    /Only an owner/i,
  );
  kitabu.close();
});

test('roles: a caretaker cannot edit or archive tenants — only register them', () => {
  const { kitabu } = caretakerSession();
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau', phone: '0712345678' });
  assert.throws(() => kitabu.services.tenant.updateTenant(tenant.id, { fullName: 'Someone Else' }), /Only an owner or manager/i);
  assert.throws(() => kitabu.services.tenant.archiveTenant(tenant.id), /Only an owner or manager/i);
  kitabu.close();
});

test('roles: organization settings and team changes are owner-only', () => {
  const { kitabu } = caretakerSession();
  assert.throws(() => kitabu.services.organization.update({ name: 'Jane Properties' }), /Only an owner/i);
  assert.throws(() => kitabu.services.organization.addUser({ fullName: 'Bob', role: 'MANAGER' }), /Only an owner/i);
  kitabu.close();
});

test('roles: a manager may edit tenants (SECURITY.md matrix) but not run the books', () => {
  const { kitabu } = newKitabu('2026-09-04T09:00:00.000Z');
  const greenView = setupGreenView(kitabu);
  const manager = kitabu.services.organization.addUser({ fullName: 'Mary Manager', role: 'MANAGER' });
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau', phone: '0712345678' });
  kitabu.setActingUser(manager.id);

  const updated = kitabu.services.tenant.updateTenant(tenant.id, { notes: 'Prefers evening calls' });
  assert.equal(updated.notes, 'Prefers evening calls');

  assert.throws(() => kitabu.services.property.addUnit({ propertyId: greenView.propertyId, label: 'X-01' }), /Only an owner/i);
  assert.throws(() => kitabu.services.ledger.generateMonthlyCharges('2026-09'), /Only an owner/i);
  assert.throws(
    () => kitabu.services.tenancy.startTenancy({
      tenantId: tenant.id, unitId: greenView.units.a11, rentMinor: 1_200_000, startDate: '2026-09-01',
    }),
    /Only an owner/i,
  );
  kitabu.close();
});
