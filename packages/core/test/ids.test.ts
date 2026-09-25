import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isUlid, isUuidv7, UlidFactory, uuidv7, uuidv7Timestamp } from '../src/foundation/ids.ts';

test('uuidv7: format, version and variant', () => {
  for (let i = 0; i < 100; i++) {
    const id = uuidv7();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(isUuidv7(id), `version/variant wrong: ${id}`);
  }
});

test('uuidv7: uniqueness over 10k ids', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 10_000; i++) seen.add(uuidv7());
  assert.equal(seen.size, 10_000);
});

test('uuidv7: roughly time-ordered (timestamp prefix non-decreasing)', () => {
  let lastTs = 0;
  for (let i = 0; i < 500; i++) {
    const ts = uuidv7Timestamp(uuidv7());
    assert.ok(ts !== null);
    assert.ok(ts >= lastTs, 'uuidv7 timestamp went backwards');
    lastTs = ts;
  }
});

test('uuidv7Timestamp: rejects non-v7 uuids', () => {
  assert.equal(uuidv7Timestamp('123e4567-e89b-12d3-a456-426614174000'), null);
  assert.equal(uuidv7Timestamp('not-a-uuid'), null);
});

test('ulid: format, uniqueness, sortability', () => {
  const factory = new UlidFactory();
  const ids: string[] = [];
  for (let i = 0; i < 5_000; i++) ids.push(factory.next());
  for (const id of ids) assert.ok(isUlid(id), `bad ulid: ${id}`);
  assert.equal(new Set(ids).size, ids.length);
  const sorted = [...ids].sort();
  assert.deepEqual(sorted, ids, 'ULIDs from one factory must sort in generation order');
});

test('ulid: monotonic within the same millisecond', () => {
  const fixed = 1_760_000_000_000;
  const factory = new UlidFactory();
  const a = factory.next(fixed);
  const b = factory.next(fixed);
  const c = factory.next(fixed);
  assert.ok(a < b && b < c, `same-ms ULIDs must increase: ${a} ${b} ${c}`);
});

test('ulid: clock going backwards keeps monotonicity', () => {
  const factory = new UlidFactory();
  const a = factory.next(2_000);
  const b = factory.next(1_000); // earlier wall clock
  assert.ok(a < b, 'regressed clock must not regress ULIDs');
});
