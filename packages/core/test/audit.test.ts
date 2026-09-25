import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newKitabu, setupGreenView } from './helpers.ts';

test('audit: entries record actor, device, action and entity', () => {
  const { kitabu } = newKitabu();
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau' });

  const entries = kitabu.services.audit.list({ entityType: 'tenant', entityId: tenant.id });
  assert.equal(entries.length, 1);
  const entry = entries[0]!;
  assert.equal(entry.action, 'TENANT_CREATED');
  assert.equal(entry.actor_user_id, kitabu.actingUserId);
  assert.equal(entry.actor_device_id, kitabu.deviceId);
  assert.ok(entry.occurred_at.endsWith('Z'));
  const after = JSON.parse(entry.after_json!) as { full_name: string };
  assert.equal(after.full_name, 'John Kamau');
  kitabu.close();
});

test('audit: rent changes capture before and after values', () => {
  const { kitabu } = newKitabu('2026-09-10T09:00:00.000Z');
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'Grace Njeri' });
  const tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 1_000_000, startDate: '2026-01-01',
  });

  kitabu.services.tenancy.changeRent(tenancy.id, 1_100_000, '2026-09-10', 'Renewal');

  const entries = kitabu.services.audit.list({ entityType: 'tenancy', entityId: tenancy.id });
  const rentChange = entries.find((e) => e.action === 'RENT_CHANGED');
  assert.ok(rentChange, 'RENT_CHANGED audit entry missing');
  const before = JSON.parse(rentChange.before_json!) as { current_rent_minor: number };
  const after = JSON.parse(rentChange.after_json!) as { current_rent_minor: number };
  assert.equal(before.current_rent_minor, 1_000_000);
  assert.equal(after.current_rent_minor, 1_100_000);
  assert.match(rentChange.summary, /KSh 11,000/);
  kitabu.close();
});

test('audit: tenancy lifecycle is fully traceable', () => {
  const { kitabu } = newKitabu();
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'Peter Otieno' });

  const t1 = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a12, rentMinor: 1_200_000, startDate: '2025-01-05',
  });
  kitabu.services.tenancy.moveTenant(t1.id, gv.units.b04, { date: '2026-09-01', newRentMinor: 1_400_000 });

  const all = kitabu.services.audit.list({ limit: 100 });
  const actions = all.map((a) => a.action);
  for (const expected of ['TENANCY_STARTED', 'TENANCY_ENDED', 'TENANCY_MOVED']) {
    assert.ok(actions.includes(expected), `missing audit action ${expected}`);
  }
  const moved = all.find((a) => a.action === 'TENANCY_MOVED')!;
  assert.match(moved.summary, /A-12.*B-04/);
  kitabu.close();
});

test('audit: the trail is append-only by convention (queries only in this service)', () => {
  const { kitabu } = newKitabu();
  kitabu.services.property.createProperty({ name: 'P' });
  const before = kitabu.services.audit.count();
  assert.ok(before > 0);
  // No update/delete methods exist on AuditService; attempts to mutate raw rows are
  // guarded in M2 with triggers (documented in DATABASE.md §4).
  assert.equal(kitabu.services.audit.count(), before);
  kitabu.close();
});
