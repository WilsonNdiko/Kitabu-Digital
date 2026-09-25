import { test } from 'node:test';
import assert from 'node:assert/strict';

import { friendlyStorageError, KitabuError, validationError } from '../src/foundation/errors.ts';

test('errors: raw SQLite constraint failures map to friendly messages (docs/UX.md §5)', () => {
  // Real message shapes produced by node:sqlite (partial unique indexes report columns).
  const unitDup = friendlyStorageError(new Error('SqliteError: UNIQUE constraint failed: units.property_id, units.label'));
  assert.ok(unitDup instanceof KitabuError);
  assert.match(unitDup.userMessage, /already exists/i);
  assert.ok(unitDup.technical !== undefined);

  const doubleLet = friendlyStorageError(new Error('SqliteError: UNIQUE constraint failed: tenancies.unit_id'));
  assert.match(doubleLet.userMessage, /already has a tenant/i);

  const rateDup = friendlyStorageError(new Error('SqliteError: UNIQUE constraint failed: rent_rates.tenancy_id, rent_rates.effective_from'));
  assert.match(rateDup.userMessage, /rent rate already exists/i);

  const fk = friendlyStorageError(new Error('SqliteError: FOREIGN KEY constraint failed'));
  assert.match(fk.userMessage, /linked to another record/i);

  const unknown = friendlyStorageError(new Error('disk I/O error'));
  assert.equal(unknown.code, 'STORAGE');
  assert.match(unknown.userMessage, /safe.*try again/i);
});

test('errors: kitabu errors carry code + user message + technical detail', () => {
  const err = validationError('Enter the monthly rent as a positive amount.', 'rentMinor <= 0');
  assert.equal(err.code, 'VALIDATION');
  assert.equal(err.userMessage, 'Enter the monthly rent as a positive amount.');
  assert.equal(err.technical, 'rentMinor <= 0');
  assert.equal(err.name, 'KitabuError');
});
