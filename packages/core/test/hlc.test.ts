import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ManualClock } from '../src/foundation/clock.ts';
import { Hlc, HybridLogicalClock } from '../src/foundation/hlc.ts';

const DEVICE_A = '018f5a00-0000-7000-8000-00000000000a';
const DEVICE_B = '018f5a00-0000-7000-8000-00000000000b';

test('hlc: strictly monotonic within the same millisecond', () => {
  const clock = new ManualClock(1_000_000);
  const hlc = new HybridLogicalClock(DEVICE_A, clock);
  const a = hlc.now();
  const b = hlc.now();
  const c = hlc.now();
  assert.equal(a.physicalMs, b.physicalMs);
  assert.ok(a.counter < b.counter && b.counter < c.counter);
  assert.ok(a.encoded < b.encoded && b.encoded < c.encoded, 'encoded order must match logical order');
});

test('hlc: follows wall clock when it advances', () => {
  const clock = new ManualClock(1_000_000);
  const hlc = new HybridLogicalClock(DEVICE_A, clock);
  const a = hlc.now();
  clock.advance(5_000);
  const b = hlc.now();
  assert.ok(b.physicalMs > a.physicalMs);
  assert.equal(b.counter, 0);
});

test('hlc: stays monotonic when the wall clock goes backwards', () => {
  const clock = new ManualClock(1_000_000);
  const hlc = new HybridLogicalClock(DEVICE_A, clock);
  const a = hlc.now();
  clock.set(new Date(500_000).toISOString()); // clock regressed
  const b = hlc.now();
  assert.ok(Hlc.compare(b, a) > 0, 'HLC must not regress with the wall clock');
  assert.equal(b.physicalMs, a.physicalMs, 'physical stays at the high watermark');
});

test('hlc: observe(remote) makes the next local tick greater than the remote', () => {
  const clockA = new ManualClock(1_000_000);
  const clockB = new ManualClock(2_000_000); // B's clock is far ahead
  const a = new HybridLogicalClock(DEVICE_A, clockA);
  const b = new HybridLogicalClock(DEVICE_B, clockB);

  const remote = b.now(); // physical=2_000_000
  a.observe(remote);
  const localAfter = a.now();
  assert.ok(Hlc.compare(localAfter, remote) > 0, 'local tick after observe must exceed remote');

  // And B observing a stale A event must not regress either.
  const stale = new Hlc(500_000, 3, DEVICE_A);
  const bAfter = b.observe(stale);
  assert.ok(Hlc.compare(bAfter, stale) > 0);
  assert.equal(bAfter.physicalMs, 2_000_000);
});

test('hlc: encoded form is lexicographically sortable', () => {
  const clock = new ManualClock(1_000_000);
  const a = new HybridLogicalClock(DEVICE_A, clock);
  const h1 = a.now();
  const h2 = a.now();
  clock.advance(1);
  const h3 = a.now();
  const encoded = [h3, h1, h2].map((h) => h.encoded).sort();
  assert.deepEqual(encoded, [h1.encoded, h2.encoded, h3.encoded]);
});

test('hlc: decode round-trips', () => {
  const clock = new ManualClock(1_760_000_000_123);
  const a = new HybridLogicalClock(DEVICE_A, clock);
  const h = a.now();
  const decoded = Hlc.decode(h.encoded);
  assert.equal(decoded.physicalMs, h.physicalMs);
  assert.equal(decoded.counter, h.counter);
  assert.equal(decoded.deviceId, h.deviceId);
  assert.equal(decoded.encoded, h.encoded);
  assert.throws(() => Hlc.decode('garbage'));
});

test('hlc: restore() prevents regression across restarts', () => {
  const clock = new ManualClock(1_000_000);
  const first = new HybridLogicalClock(DEVICE_A, clock);
  const persisted = first.now().encoded; // saved to app_settings by recordOp

  // Restart with a regressed wall clock.
  const clock2 = new ManualClock(900_000);
  const second = new HybridLogicalClock(DEVICE_A, clock2);
  second.restore(persisted);
  const next = second.now();
  assert.ok(next.encoded > persisted, 'post-restart HLC must exceed the persisted one');
});
