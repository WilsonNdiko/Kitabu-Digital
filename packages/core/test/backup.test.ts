/**
 * Local encrypted backup export/restore tests (FR-22, NFR-09; SECURITY.md §4,
 * SYNC.md §6). Round-trip through the real archive format, wrong passphrase,
 * tampering, role enforcement, and snapshot semantics (live rows only,
 * local-only tables excluded, FK-safe order).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newKitabu, setupGreenView } from './helpers.ts';
import { NodeCryptoPort, openKitabuFromBackup, openNodeSqlite } from '../src/node.ts';
import { Kitabu } from '../src/kitabu.ts';
import { readBackup, applySnapshot, MIN_PASSPHRASE_LENGTH } from '../src/services/backup.ts';
import type { SnapshotPayload } from '../src/services/backup.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';
import { KitabuError } from '../src/foundation/errors.ts';

/** Tiny KDF costs so tests stay fast; format is identical, only Argon2 work shrinks. */
const FAST = { memoryKiB: 8, passes: 1, parallelism: 1 };
const PASSPHRASE = 'nyumba-huru-2026';

function seedWorld(kitabu: ReturnType<typeof newKitabu>['kitabu']): {
  tenancyId: string;
  paymentId: string;
  receipt: ReturnType<ReturnType<typeof newKitabu>['kitabu']['services']['receipt']['issueReceipt']>;
} {
  const gv = setupGreenView(kitabu);
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'Peter Otieno', phone: '0722123456' });
  const tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: gv.units.a11, rentMinor: 2_000_000, startDate: '2026-08-01',
  });
  kitabu.services.ledger.generateMonthlyCharges('2026-08');
  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 2_000_000, method: 'CASH', paidAt: '2026-08-05',
  }); // cash auto-verifies (roles.test.ts)
  const receipt = kitabu.services.receipt.issueReceipt(payment.id);
  return { tenancyId: tenancy.id, paymentId: payment.id, receipt };
}

test('backup: owner exports, restore brings the whole world back', () => {
  const { kitabu, clock } = newKitabu();
  const world = seedWorld(kitabu);
  clock.advance(19 * 24 * 60 * 60 * 1000);

  const backup = kitabu.exportBackup(PASSPHRASE, FAST);
  assert.ok(backup.length > 100);
  assert.equal(Buffer.from(backup.subarray(0, 8)).toString('latin1'), 'KITABUBK');

  const restored = openKitabuFromBackup(backup, PASSPHRASE, {}, { clock });
  assert.ok(restored.isBootstrapped);
  assert.equal(restored.orgId, kitabu.orgId, 'same organization id');

  // Dashboard-level data survived.
  const status = restored.services.ledger.monthStatus(world.tenancyId, '2026-08');
  assert.equal(status.chargeMinor, 2_000_000);
  assert.equal(status.paidMinor, 2_000_000);
  assert.equal(status.status, 'PAID');

  // Receipt chain + signature verification still work on the restored device.
  const integrity = restored.services.receipt.verifyReceiptIntegrity({
    ...world.receipt.receipt,
  } as Parameters<typeof restored.services.receipt.verifyReceiptIntegrity>[0]);
  assert.equal(integrity.ok, true);
  assert.equal(integrity.signatureValid, true);

  // The restored device adopts the snapshot's self-device identity.
  assert.equal(restored.deviceId, kitabu.deviceId);

  // New work continues on the restored device (HLC/ids still healthy).
  const tenant2 = restored.services.tenant.registerTenant({ fullName: 'Mary Wanjiku' });
  assert.ok(tenant2.id);

  kitabu.close();
  restored.close();
});

test('backup: passphrase is never in the file, wrong passphrase is rejected', () => {
  const { kitabu } = newKitabu();
  seedWorld(kitabu);
  const backup = kitabu.exportBackup(PASSPHRASE, FAST);

  const asText = Buffer.from(backup).toString('utf8');
  assert.ok(!asText.includes(PASSPHRASE), 'passphrase must not appear in the archive');

  assert.throws(
    () => readBackup(backup, 'not-the-passphrase', new NodeCryptoPort()),
    (err: unknown) => {
      assert.ok(err instanceof KitabuError);
      assert.equal(err.code, 'VALIDATION');
      assert.match(err.userMessage, /passphrase does not match/i);
      return true;
    },
  );

  // And the original still reads fine.
  const payload = readBackup(backup, PASSPHRASE, new NodeCryptoPort());
  assert.equal(payload.org.name, 'Wilson Properties');
  kitabu.close();
});

test('backup: a flipped ciphertext byte is detected (GCM auth)', () => {
  const { kitabu } = newKitabu();
  seedWorld(kitabu);
  const backup = kitabu.exportBackup(PASSPHRASE, FAST);

  const tampered = new Uint8Array(backup);
  tampered[tampered.length - 20]! ^= 0x01; // inside ciphertext/tag region
  assert.throws(
    () => readBackup(tampered, PASSPHRASE, new NodeCryptoPort()),
    /passphrase does not match this backup, or the file is damaged/i,
  );

  const notBackup = new TextEncoder().encode('definitely not a kitabu backup file at all');
  assert.throws(() => readBackup(notBackup, PASSPHRASE, new NodeCryptoPort()), /Kitabu backup/i);
  kitabu.close();
});

test('backup: only the owner can export (SECURITY.md §3 backup.manage)', () => {
  const { kitabu } = newKitabu();
  seedWorld(kitabu);

  const jane = kitabu.services.organization.addUser({ fullName: 'Jane Caretaker', role: 'CARETAKER' });
  kitabu.setActingUser(jane.id);
  assert.throws(
    () => kitabu.exportBackup(PASSPHRASE, FAST),
    (err: unknown) => {
      assert.ok(err instanceof KitabuError);
      assert.equal(err.code, 'PERMISSION');
      assert.match(err.userMessage, /only an owner can export an encrypted backup/i);
      return true;
    },
  );

  // Back on the owner's session it works, and records the export time.
  const owner = kitabu.services.organization.listUsers().find((u) => u.role === 'OWNER')!;
  kitabu.setActingUser(owner.id);
  kitabu.exportBackup(PASSPHRASE, FAST);
  assert.ok(kitabu.localSetting('backup.last_exported_at'));
  kitabu.close();
});

test('backup: passphrase must be at least 8 characters', () => {
  const { kitabu } = newKitabu();
  seedWorld(kitabu);
  assert.throws(
    () => kitabu.exportBackup('short', FAST),
    (err: unknown) => {
      assert.ok(err instanceof KitabuError);
      assert.equal(err.code, 'VALIDATION');
      assert.match(err.userMessage, new RegExp(String(MIN_PASSPHRASE_LENGTH)));
      return true;
    },
  );
  kitabu.close();
});

test('backup: snapshot contains live rows only; local-only tables excluded', () => {
  const { kitabu } = newKitabu();
  seedWorld(kitabu);

  // Register a tenant with no tenancy, then archive them — the snapshot must skip the deleted row.
  const extra = kitabu.services.tenant.registerTenant({ fullName: 'Grace Njeri' });
  const tenantsBefore = kitabu.services.tenant.listTenants().length;
  assert.equal(tenantsBefore, 2);
  kitabu.services.tenant.archiveTenant(extra.id, 'moved out');
  assert.equal(kitabu.services.tenant.listTenants().length, tenantsBefore - 1);

  const backup = kitabu.exportBackup(PASSPHRASE, FAST);
  const payload = readBackup(backup, PASSPHRASE, new NodeCryptoPort());

  assert.equal(payload.counts.tenants, tenantsBefore - 1, 'archived tenant not in snapshot');
  assert.equal(payload.tables.tenants!.length, tenantsBefore - 1);
  assert.ok(!('app_settings' in payload.tables), 'local-only app_settings excluded');
  assert.ok(!('change_log' in payload.tables), 'local-only change_log excluded');
  for (const table of Object.keys(payload.tables)) {
    for (const row of payload.tables[table as keyof typeof payload.tables]!) {
      assert.equal(row.deleted_at, null, `${table}: only live rows`);
    }
  }

  // Restored device sees only live tenants too.
  const restored = openKitabuFromBackup(backup, PASSPHRASE);
  assert.equal(restored.services.tenant.listTenants({ includeArchived: true }).length, tenantsBefore - 1);
  restored.close();
  kitabu.close();
});

test('backup: schema version mismatches are refused with a friendly error', () => {
  const { kitabu } = newKitabu();
  seedWorld(kitabu);
  const backup = kitabu.exportBackup(PASSPHRASE, FAST);
  const payload = readBackup(backup, PASSPHRASE, new NodeCryptoPort());

  const future: SnapshotPayload = { ...payload, schemaVersion: SCHEMA_VERSION + 1 };
  const fresh = openNodeSqlite(':memory:');
  assert.throws(
    () => applySnapshot(fresh, future),
    (err: unknown) => {
      assert.ok(err instanceof KitabuError);
      assert.equal(err.code, 'SCHEMA');
      assert.match(err.userMessage, /different version/i);
      return true;
    },
  );
  fresh.close();
  kitabu.close();
});

test('backup: refuses to restore onto a database that already has an organization', () => {
  const { kitabu } = newKitabu();
  seedWorld(kitabu);
  const backup = kitabu.exportBackup(PASSPHRASE, FAST);
  const payload = readBackup(backup, PASSPHRASE, new NodeCryptoPort());

  const occupied = openNodeSqlite(':memory:');
  Kitabu.open({ sqlite: occupied }).bootstrap({
    organizationName: 'Someone Else', landlordName: 'X', deviceName: 'd', platform: 'WINDOWS', unitTerm: 'House',
  });
  assert.throws(() => applySnapshot(occupied, payload), /already has an organization/i);
  occupied.close();
  kitabu.close();
});
