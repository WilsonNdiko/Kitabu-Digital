import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openNodeSqlite } from '../src/node.ts';
import { migrate, MIGRATIONS, SCHEMA_VERSION } from '../src/db/schema.ts';
import { bootstrapOrganization } from '../src/services/organization.ts';
import { ManualClock } from '../src/foundation/clock.ts';
import { Kitabu } from '../src/kitabu.ts';
import { NodeCryptoPort } from '../src/node.ts';

test('migration: fresh database reaches the latest version', () => {
  const db = openNodeSqlite(':memory:');
  migrate(db);
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(row.user_version, SCHEMA_VERSION);
  for (const table of ['payments', 'ledger_entries', 'payment_allocations', 'receipts', 'signature_images', 'receipt_number_blocks', 'org_keys']) {
    const found = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
    assert.ok(found, `table ${table} missing`);
  }
  db.close();
});

test('migration: v1 database upgrades to v2 in place, keeping its data', () => {
  const db = openNodeSqlite(':memory:');
  // Build a v1 database exactly as Milestone 1 shipped it.
  db.transaction(() => {
    for (const stmt of MIGRATIONS[0]!.statements) db.exec(stmt);
    db.exec('PRAGMA user_version = 1');
  });

  // Bootstrap an organization while still on v1 (uses only v1 tables).
  const clock = new ManualClock('2026-09-01T08:00:00.000Z');
  const bootstrapped = bootstrapOrganization(db, clock, {
    organizationName: 'Upgrade Test',
    landlordName: 'Wilson',
    deviceName: 'Old Laptop',
    platform: 'WINDOWS',
  });
  assert.equal(bootstrapped.organization.name, 'Upgrade Test');

  // Now migrate to v2.
  migrate(db);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);

  // Open through the facade (loads existing org, no re-bootstrap) and use v2 features.
  const kitabu = Kitabu.open({ sqlite: db, clock, crypto: new NodeCryptoPort() });
  assert.equal(kitabu.isBootstrapped, true);
  assert.equal(kitabu.services.organization.get().name, 'Upgrade Test');

  const property = kitabu.services.property.createProperty({ name: 'Migrated Flats' });
  const unit = kitabu.services.property.addUnit({ propertyId: property.id, label: 'M-1' });
  const tenant = kitabu.services.tenant.registerTenant({ fullName: 'Legacy Tenant' });
  const tenancy = kitabu.services.tenancy.startTenancy({
    tenantId: tenant.id, unitId: unit.id, rentMinor: 900_000, startDate: '2026-01-05',
  });
  const generated = kitabu.services.ledger.generateMonthlyCharges('2026-09');
  assert.equal(generated.created, 1);

  const payment = kitabu.services.payment.recordPayment({
    tenancyId: tenancy.id, amountMinor: 900_000, method: 'CASH', paidAt: '2026-09-05',
  });
  assert.equal(payment.status, 'VERIFIED');
  const receipt = kitabu.services.receipt.issueReceipt(payment.id);
  assert.equal(receipt.receipt.receipt_no, 'R-000001');
  kitabu.close();
});

test('migration: rejects a database from a newer app version', () => {
  const db = openNodeSqlite(':memory:');
  migrate(db);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  assert.throws(() => migrate(db), /newer version/i);
  db.close();
});
