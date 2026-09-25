import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newKitabu, setupGreenView } from './helpers.ts';
import { KitabuError } from '../src/foundation/errors.ts';

test('property: create, list and count', () => {
  const { kitabu } = newKitabu();
  const p = kitabu.services.property.createProperty({ name: ' Green View Apartments ', town: 'Nairobi' });
  assert.equal(p.name, 'Green View Apartments');
  assert.equal(p.town, 'Nairobi');

  kitabu.services.property.addUnit({ propertyId: p.id, label: 'A-12' });
  kitabu.services.property.addUnit({ propertyId: p.id, label: 'B-04' });

  const list = kitabu.services.property.listProperties();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.unit_count, 2);
  assert.equal(list[0]!.occupied_count, 0);
  kitabu.close();
});

test('property: unit labels are unique within a property, but reusable across properties', () => {
  const { kitabu } = newKitabu();
  const greenView = kitabu.services.property.createProperty({ name: 'Green View' });
  const riverside = kitabu.services.property.createProperty({ name: 'Riverside' });

  kitabu.services.property.addUnit({ propertyId: greenView.id, label: 'A-12' });
  assert.throws(
    () => kitabu.services.property.addUnit({ propertyId: greenView.id, label: 'A-12' }),
    (err: unknown) => err instanceof KitabuError && /A-12/.test(err.userMessage),
  );
  // Same label in another property is perfectly fine.
  const other = kitabu.services.property.addUnit({ propertyId: riverside.id, label: 'A-12' });
  assert.equal(other.label, 'A-12');
  kitabu.close();
});

test('property: database-level backstop for duplicate labels (friendly mapping)', () => {
  const { kitabu } = newKitabu();
  const p = kitabu.services.property.createProperty({ name: 'P' });
  kitabu.services.property.addUnit({ propertyId: p.id, label: '1' });
  const db = kitabu.services.property.ctx.db;
  assert.throws(
    () => db.prepare('INSERT INTO units (id, org_id, property_id, label, kind, status, created_at, updated_at, version, hlc, origin_device_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run('x', kitabu.orgId, p.id, '1', 'HOUSE', 'VACANT', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1, '0', kitabu.deviceId),
    /UNIQUE/i,
  );
  kitabu.close();
});

test('property: maintenance flag rules', () => {
  const { kitabu } = newKitabu();
  const gv = setupGreenView(kitabu);
  const svc = kitabu.services.property;

  const unit = svc.setUnitMaintenance(gv.units.a11, true);
  assert.equal(unit.status, 'MAINTENANCE');
  assert.equal(svc.setUnitMaintenance(gv.units.a11, true).status, 'MAINTENANCE'); // idempotent

  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau' });
  kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 1_200_000, startDate: '2026-09-01',
  });
  assert.throws(
    () => svc.setUnitMaintenance(gv.units.a11, true),
    /tenant still lives/i,
  );
  kitabu.close();
});

test('property: archive is blocked while tenants occupy units, allowed after', () => {
  const { kitabu } = newKitabu();
  const gv = setupGreenView(kitabu);
  const svc = kitabu.services.property;

  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'Mary Wanjiku' });
  kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a12, rentMinor: 900_000, startDate: '2026-09-01',
  });

  assert.throws(() => svc.archiveProperty(gv.propertyId), /cannot archive/i);

  kitabu.services.tenancy.endTenancy(
    kitabu.services.tenancy.activeTenancyForUnit(gv.units.a12)!.id, '2026-09-20', 'Moving out');
  const archived = svc.archiveProperty(gv.propertyId);
  assert.ok(archived.deleted_at !== null);
  assert.equal(svc.listProperties().length, 0);
  assert.equal(svc.listUnits(gv.propertyId).length, 0); // units archived too
  kitabu.close();
});

test('property: summary counts statuses', () => {
  const { kitabu } = newKitabu();
  const gv = setupGreenView(kitabu);
  const svc = kitabu.services.property;

  const t1 = kitabu.services.tenant.registerTenant({ fullName: 'A' });
  kitabu.services.tenancy.startTenancy({
    tenantId: t1.id, unitId: gv.units.a11, rentMinor: 500_000, startDate: '2026-09-01',
  });
  svc.setUnitMaintenance(gv.units.b04, true);

  const summary = svc.summary(gv.propertyId);
  assert.equal(summary.totalUnits, 3);
  assert.equal(summary.occupied, 1);
  assert.equal(summary.vacant, 1);
  assert.equal(summary.maintenance, 1);
  kitabu.close();
});

test('property: update rules', () => {
  const { kitabu } = newKitabu();
  const svc = kitabu.services.property;
  const p = svc.createProperty({ name: 'Old Name' });
  const updated = svc.updateProperty(p.id, { name: 'New Name', town: ' Nakuru ' });
  assert.equal(updated.name, 'New Name');
  assert.equal(updated.town, 'Nakuru');
  assert.throws(() => svc.updateProperty(p.id, { name: '  ' }), /cannot be empty/i);
  kitabu.close();
});

test('property: buildings group units', () => {
  const { kitabu } = newKitabu();
  const svc = kitabu.services.property;
  const p = svc.createProperty({ name: 'Mwihoko Court' });
  const blockA = svc.addBuilding({ propertyId: p.id, name: 'Block A' });
  const unit = svc.addUnit({ propertyId: p.id, buildingId: blockA.id, label: 'A-1' });
  assert.equal(unit.building_id, blockA.id);
  assert.equal(svc.listBuildings(p.id).length, 1);
  assert.throws(() => svc.addBuilding({ propertyId: p.id, name: ' ' }), /name/i);
  kitabu.close();
});
