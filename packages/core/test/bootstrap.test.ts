import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openKitabuFile, openKitabuInMemory } from '../src/node.ts';
import { ManualClock } from '../src/foundation/clock.ts';
import { KitabuError } from '../src/foundation/errors.ts';
import { getRow } from '../src/db/port.ts';
import { newKitabu } from './helpers.ts';

test('bootstrap: creates organization, self device and owner in one shot', () => {
  const clock = new ManualClock('2026-09-01T08:00:00.000Z');
  const kitabu = openKitabuInMemory({ clock });
  const result = kitabu.bootstrap({
    organizationName: '  Wilson Properties  ',
    landlordName: 'Wilson Ndiko',
    phone: '0712 345 678',
    deviceName: 'Wilson Laptop',
    platform: 'WINDOWS',
  });

  assert.equal(result.organization.name, 'Wilson Properties');
  assert.equal(result.organization.phone, '+254712345678');
  assert.equal(result.device.is_self, 1);
  assert.equal(result.device.platform, 'WINDOWS');
  assert.equal(result.owner.role, 'OWNER');

  assert.equal(kitabu.isBootstrapped, true);
  assert.equal(kitabu.orgId, result.organization.id);
  assert.equal(kitabu.deviceId, result.device.id);
  assert.equal(kitabu.actingUserId, result.owner.id);
  assert.equal(kitabu.services.organization.get().name, 'Wilson Properties');

  const audit = kitabu.services.audit.list({ limit: 10 });
  const actions = audit.map((a) => a.action);
  assert.ok(actions.includes('ORGANIZATION_CREATED'));
  assert.ok(actions.includes('DEVICE_REGISTERED'));
  assert.ok(actions.includes('USER_ADDED'));
  kitabu.close();
});

test('bootstrap: rejects a second organization in the same database', () => {
  const kitabu = openKitabuInMemory();
  kitabu.bootstrap({ organizationName: 'One', deviceName: 'D', platform: 'ANDROID' });
  assert.throws(
    () => kitabu.bootstrap({ organizationName: 'Two', deviceName: 'D2', platform: 'ANDROID' }),
    (err: unknown) => err instanceof KitabuError && err.code === 'DOMAIN_RULE',
  );
  kitabu.close();
});

test('bootstrap: validation errors are friendly', () => {
  const kitabu = openKitabuInMemory();
  assert.throws(
    () => kitabu.bootstrap({ organizationName: '   ', deviceName: 'D', platform: 'ANDROID' }),
    /name/i,
  );
  assert.throws(
    () => kitabu.bootstrap({ organizationName: 'X', deviceName: '', platform: 'ANDROID' }),
    /device/i,
  );
  assert.throws(
    () => kitabu.bootstrap({ organizationName: 'X', deviceName: 'D', platform: 'ANDROID', phone: '0201234567' }),
    /phone/i,
  );
  kitabu.close();
});

test('bootstrap: no partial state on failure (transaction rollback)', () => {
  const kitabu = openKitabuInMemory();
  assert.throws(() =>
    kitabu.bootstrap({ organizationName: 'Bad', deviceName: 'D', platform: 'ANDROID', phone: 'not-a-phone' }));
  assert.equal(kitabu.isBootstrapped, false);
  // If the failed attempt had left any rows behind, this second bootstrap would be
  // rejected with DOMAIN_RULE ("already has a Kitabu organization").
  kitabu.bootstrap({ organizationName: 'Good', deviceName: 'D', platform: 'ANDROID' });
  assert.equal(kitabu.isBootstrapped, true);
  kitabu.close();
});

test('reopen: file database reloads organization and keeps HLC monotonic across restarts', () => {
  const path = join(tmpdir(), `kitabu-test-${Date.now()}.db`);
  const clock = new ManualClock('2026-09-01T08:00:00.000Z');

  {
    const kitabu = openKitabuFile(path, { clock });
    kitabu.bootstrap({ organizationName: 'Reopen Test', deviceName: 'Laptop', platform: 'WINDOWS' });
    kitabu.services.property.createProperty({ name: 'Plot 42' });
    kitabu.close();
  }

  {
    // Simulate a restart with a REGRESSED wall clock; HLC must not regress.
    const regressedClock = new ManualClock('2026-08-01T08:00:00.000Z');
    const kitabu = openKitabuFile(path, { clock: regressedClock });
    assert.equal(kitabu.isBootstrapped, true);
    assert.equal(kitabu.services.property.listProperties().length, 1);
    const lastHlc = getRow<{ value: string }>(
      kitabu.services.property.ctx.db,
      "SELECT value FROM app_settings WHERE key = 'last_hlc'",
    )!;
    // The new property must produce an HLC beyond the persisted watermark.
    kitabu.services.property.createProperty({ name: 'Plot 43' });
    const newLast = getRow<{ value: string }>(
      kitabu.services.property.ctx.db,
      "SELECT value FROM app_settings WHERE key = 'last_hlc'",
    )!;
    assert.ok(newLast.value > lastHlc.value, 'HLC regressed across restart');
    kitabu.close();
  }

  unlinkSync(path);
});

test('schema: fresh database starts at user_version 1 with foreign keys on', () => {
  const { kitabu } = newKitabu();
  const version = getRow<{ user_version: number }>(kitabu.services.audit.ctx.db, 'PRAGMA user_version');
  assert.equal(version?.user_version, 2);
  const fk = getRow<{ foreign_keys: number }>(kitabu.services.audit.ctx.db, 'PRAGMA foreign_keys');
  assert.equal(fk?.foreign_keys, 1);
  kitabu.close();
});
