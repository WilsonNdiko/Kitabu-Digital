/**
 * BLAKE2b (RFC 7693) tests — cross-checked against node:crypto's blake2b512
 * (OpenSSL) over boundary lengths, plus digest-length variation sanity.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { blake2b } from '../src/foundation/blake2b.ts';

function pseudoRandom(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let s = seed;
  for (let i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s & 0xff;
  }
  return out;
}

test('blake2b: matches node:crypto blake2b512 across boundary lengths', () => {
  const lengths = [0, 1, 63, 64, 65, 76, 127, 128, 129, 191, 192, 255, 256, 257, 500, 1024, 1025];
  for (const len of lengths) {
    const input = pseudoRandom(len, len + 1);
    const ours = Buffer.from(blake2b(input, 64)).toString('hex');
    const theirs = createHash('blake2b512').update(Buffer.from(input)).digest('hex');
    assert.equal(ours, theirs, `length ${len}`);
  }
});

test('blake2b: every digest length 1..64 is distinct and stable', () => {
  const input = pseudoRandom(200, 42);
  const seen = new Set<string>();
  for (let outLen = 1; outLen <= 64; outLen++) {
    const digest = blake2b(input, outLen);
    assert.equal(digest.length, outLen);
    const hex = Buffer.from(digest).toString('hex');
    assert.ok(!seen.has(hex), `duplicate digest at outLen=${outLen}`);
    seen.add(hex);
    // Deterministic across calls.
    assert.deepEqual(blake2b(input, outLen), digest);
  }
});

test('blake2b: parameter block affects the digest (outLen is part of the input)', () => {
  const input = pseudoRandom(100, 7);
  const d32 = blake2b(input, 32);
  const d64 = blake2b(input, 64);
  // Not a prefix relationship — the digest length is mixed into the parameter block.
  assert.notEqual(Buffer.from(d64.subarray(0, 32)).toString('hex'), Buffer.from(d32).toString('hex'));
});

test('blake2b: rejects invalid digest lengths', () => {
  const input = new Uint8Array(10);
  assert.throws(() => blake2b(input, 0), /between 1 and 64/);
  assert.throws(() => blake2b(input, 65), /between 1 and 64/);
  assert.throws(() => blake2b(input, 32.5), /between 1 and 64/);
});
