import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newKitabu, setupGreenView } from './helpers.ts';
import type { ChangeLogRow } from '../src/domain/types.ts';
import { allRows } from '../src/db/port.ts';

function ops(kitabu: ReturnType<typeof newKitabu>['kitabu']): ChangeLogRow[] {
  return allRows<ChangeLogRow>(kitabu.services.audit.ctx.db, 'SELECT * FROM change_log ORDER BY seq ASC');
}

test('changelog: every mutation writes an op with the full row snapshot', () => {
  const { kitabu } = newKitabu();
  setupGreenView(kitabu); // side effect: properties + units exist
  const before = ops(kitabu).length;

  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau' });

  const after = ops(kitabu);
  assert.equal(after.length, before + 2, 'tenant row op + audit row op expected');

  const tenantOp = after.find((o) => o.table_name === 'tenants' && o.row_id === tenant.id);
  assert.ok(tenantOp);
  assert.equal(tenantOp.op, 'UPSERT');
  assert.equal(tenantOp.row_version, 1);
  assert.equal(tenantOp.org_id, kitabu.orgId);
  assert.equal(tenantOp.origin_device_id, kitabu.deviceId);
  const payload = JSON.parse(tenantOp.payload_json!) as { full_name: string; version: number };
  assert.equal(payload.full_name, 'John Kamau');
  assert.equal(payload.version, 1);
  kitabu.close();
});

test('changelog: updates bump row_version in the op stream', () => {
  const { kitabu } = newKitabu();
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'John Kamau' });
  kitabu.services.tenant.updateTenant(tenant.id, { phone: '0712345678' });
  kitabu.services.tenant.updateTenant(tenant.id, { notes: 'Reliable' });

  const tenantOps = ops(kitabu).filter((o) => o.table_name === 'tenants' && o.row_id === tenant.id);
  assert.deepEqual(tenantOps.map((o) => o.row_version), [1, 2, 3]);
  // HLC strictly increases across the ops of one row.
  assert.ok(tenantOps[0]!.hlc < tenantOps[1]!.hlc);
  assert.ok(tenantOps[1]!.hlc < tenantOps[2]!.hlc);
  kitabu.close();
});

test('changelog: ops for every table touched by a tenancy start', () => {
  const { kitabu } = newKitabu();
  const gv = setupGreenView(kitabu);
  const start = ops(kitabu).length;

  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'Mary' });
  kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a12, rentMinor: 1_200_000, startDate: '2026-01-05',
  });

  const tables = new Set(ops(kitabu).slice(start).map((o) => o.table_name));
  for (const expected of ['tenants', 'tenancies', 'rent_rates', 'units', 'audit_log']) {
    assert.ok(tables.has(expected), `missing op for ${expected}`);
  }
  // The unit's occupancy change is captured (version bumped from 1 to 2).
  const unitOps = ops(kitabu).filter((o) => o.table_name === 'units' && o.row_id === gv.units.a12);
  assert.equal(unitOps.length, 2); // created VACANT, then OCCUPIED
  const lastUnitPayload = JSON.parse(unitOps[1]!.payload_json!) as { status: string };
  assert.equal(lastUnitPayload.status, 'OCCUPIED');
  kitabu.close();
});

test('changelog: change ids are unique ULIDs and the stream is append-only', () => {
  const { kitabu } = newKitabu();
  setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'X' });
  kitabu.services.tenant.archiveTenant(tenant.id);

  const all = ops(kitabu);
  const ids = all.map((o) => o.change_id);
  assert.equal(new Set(ids).size, ids.length, 'change ids must be unique');
  for (const id of ids) assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  // seq is strictly increasing with insertion order
  const seqs = all.map((o) => o.seq);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i]! > seqs[i - 1]!);
  kitabu.close();
});

test('changelog: HLC watermark is persisted for restart safety', () => {
  const { kitabu } = newKitabu();
  kitabu.services.tenant.registerTenant({ fullName: 'X' });
  const db = kitabu.services.audit.ctx.db;
  const watermark = (db.prepare("SELECT value FROM app_settings WHERE key = 'last_hlc'").get() as { value: string }).value;
  // The watermark must equal the highest HLC written so far (the last op in seq order).
  const lastOp = ops(kitabu).at(-1)!;
  assert.equal(watermark, lastOp.hlc);
  kitabu.close();
});

test('changelog: failed mutations leave no ops (transactional integrity)', () => {
  const { kitabu } = newKitabu();
  const gv = setupGreenView(kitabu);
  const before = ops(kitabu).length;

  const t1 = kitabu.services.tenant.registerTenant({ fullName: 'A' });
  kitabu.services.tenancy.startTenancy({
    tenantId: t1.id, unitId: gv.units.a11, rentMinor: 500_000, startDate: '2026-01-01',
  });
  const mid = ops(kitabu).length;
  assert.ok(mid > before);

  // This move must fail (target occupied) and leave no trace in the op stream.
  const t2 = kitabu.services.tenant.registerTenant({ fullName: 'B' });
  const t2Tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: t2.id, unitId: gv.units.a12, rentMinor: 500_000, startDate: '2026-01-01',
  });
  const beforeFailed = ops(kitabu).length;
  assert.throws(() =>
    kitabu.services.tenancy.moveTenant(t2Tenancy.id, gv.units.a11, { date: '2026-09-01' }));
  assert.equal(ops(kitabu).length, beforeFailed, 'failed mutation must not append ops');
  kitabu.close();
});
