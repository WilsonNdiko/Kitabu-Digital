import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newKitabu, setupGreenView } from './helpers.ts';
import { KitabuError } from '../src/foundation/errors.ts';

test('tenant: registration requires only a name; phone is normalized when given', () => {
  const { kitabu } = newKitabu();
  const minimal = kitabu.services.tenant.registerTenant({ fullName: '  Jane   Wanjiku  ' });
  assert.equal(minimal.full_name, 'Jane Wanjiku');
  assert.equal(minimal.phone, null);

  const withPhone = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau', phone: '0712 345 678' });
  assert.equal(withPhone.phone, '+254712345678');
  kitabu.close();
});

test('tenant: invalid phones are rejected with a friendly message', () => {
  const { kitabu } = newKitabu();
  assert.throws(
    () => kitabu.services.tenant.registerTenant({ fullName: 'X', phone: '0201234567' }),
    (err: unknown) => err instanceof KitabuError && /Kenyan mobile/i.test(err.userMessage),
  );
  assert.throws(() => kitabu.services.tenant.registerTenant({ fullName: '' }), /name/i);
  kitabu.close();
});

test('tenant: updates bump version and keep history auditable', () => {
  const { kitabu } = newKitabu();
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau', phone: '0712345678' });
  const before = tenant.version;

  const updated = kitabu.services.tenant.updateTenant(tenant.id, {
    phone: '0733 111 222',
    idNumber: '12345678',
    notes: 'Pays early',
  });
  assert.equal(updated.phone, '+254733111222');
  assert.equal(updated.id_number, '12345678');
  assert.equal(updated.version, before + 1);
  kitabu.close();
});

test('tenant: archive is soft — records survive, active tenants cannot be archived', () => {
  const { kitabu } = newKitabu();
  const gv = setupGreenView(kitabu);

  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'Doris Achieng' });
  kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 700_000, startDate: '2026-01-05',
  });
  assert.throws(
    () => kitabu.services.tenant.archiveTenant(tenant.id),
    /still lives/i,
  );

  kitabu.services.tenancy.endTenancy(
    kitabu.services.tenancy.activeTenancyForUnit(gv.units.a11)!.id, '2026-08-31');
  const archived = kitabu.services.tenant.archiveTenant(tenant.id, 'Moved abroad');
  assert.ok(archived.deleted_at !== null);

  // Hidden from daily lists, visible with includeArchived, history intact.
  assert.equal(kitabu.services.tenant.listTenants().length, 0);
  assert.equal(kitabu.services.tenant.listTenants({ includeArchived: true }).length, 1);
  assert.equal(kitabu.services.tenancy.tenancyHistory(tenant.id).length, 1);
  kitabu.close();
});

test('tenant: search finds by name, phone fragment and ID number', () => {
  const { kitabu } = newKitabu();
  const svc = kitabu.services.tenant;
  svc.registerTenant({ fullName: 'John Kamau', phone: '0712345678', idNumber: '28829911' });
  svc.registerTenant({ fullName: 'Mary Wanjiku', phone: '0733111222' });
  svc.registerTenant({ fullName: 'Johnson Mwangi' });

  assert.equal(svc.listTenants({ search: 'john' }).length, 2);         // John, Johnson
  assert.equal(svc.listTenants({ search: 'wanjiku' }).length, 1);
  assert.equal(svc.listTenants({ search: '0712345678' }).length, 1);   // full phone
  assert.equal(svc.listTenants({ search: '712345' }).length, 1);       // phone fragment
  assert.equal(svc.listTenants({ search: '28829911' }).length, 1);     // ID number
  assert.equal(svc.listTenants({ search: 'nonexistent' }).length, 0);
  assert.equal(svc.listTenants({ search: '50%' }).length, 0);          // LIKE metacharacters escaped
  kitabu.close();
});
