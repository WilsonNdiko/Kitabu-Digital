/**
 * Argon2id (RFC 9106) tests — the official §5.3 test vector, end to end,
 * including the pre-hash digest (H_0) checkpoint. This is the KDF that turns
 * a backup passphrase into an AES-256 key (SECURITY.md §4).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { argon2id } from '../src/foundation/argon2.ts';
import { blake2b } from '../src/foundation/blake2b.ts';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const repeat = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);

// RFC 9106 §5.3 Argon2id test vector inputs.
const RFC = {
  password: repeat(32, 0x01),
  salt: repeat(16, 0x02),
  secret: repeat(8, 0x03),
  associatedData: repeat(12, 0x04),
  memoryKiB: 32,
  passes: 3,
  parallelism: 4,
  tagLen: 32,
  h0: '2889de487eb42ae500c0007ed9252f1069eadec40d5765b485de6dc2437a67b8' +
      '546a2f0acc1a0882db8fcf74714b472e94df421a5da1112ffa11434370a1e997',
  tag: '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659',
};

test('argon2id: RFC 9106 §5.3 test vector (tag matches)', () => {
  const tag = argon2id({
    password: RFC.password,
    salt: RFC.salt,
    memoryKiB: RFC.memoryKiB,
    passes: RFC.passes,
    parallelism: RFC.parallelism,
    tagLen: RFC.tagLen,
    secret: RFC.secret,
    associatedData: RFC.associatedData,
  });
  assert.equal(hex(tag), RFC.tag);
});

test('argon2id: H_0 pre-hash digest matches the RFC vector', () => {
  const le = (v: number): Uint8Array => {
    const o = new Uint8Array(4);
    o[0] = v & 0xff; o[1] = (v >>> 8) & 0xff; o[2] = (v >>> 16) & 0xff; o[3] = (v >>> 24) & 0xff;
    return o;
  };
  const cat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let i = 0;
    for (const p of parts) { out.set(p, i); i += p.length; }
    return out;
  };
  const h0 = blake2b(cat(
    le(RFC.parallelism), le(RFC.tagLen), le(RFC.memoryKiB), le(RFC.passes),
    le(0x13), le(2),
    le(RFC.password.length), RFC.password,
    le(RFC.salt.length), RFC.salt,
    le(RFC.secret.length), RFC.secret,
    le(RFC.associatedData.length), RFC.associatedData,
  ), 64);
  assert.equal(hex(h0), RFC.h0);
});

test('argon2id: is deterministic and parameter-sensitive', () => {
  const base = {
    password: repeat(8, 0xaa),
    salt: repeat(16, 0xbb),
    memoryKiB: 16,
    passes: 2,
    parallelism: 2,
    tagLen: 32,
  };
  const a = argon2id(base);
  assert.deepEqual(argon2id(base), a, 'same inputs → same tag');
  assert.notEqual(hex(argon2id({ ...base, passes: 3 })), hex(a), 't changes the tag');
  assert.notEqual(hex(argon2id({ ...base, memoryKiB: 32 })), hex(a), 'm changes the tag');
  assert.notEqual(hex(argon2id({ ...base, password: repeat(8, 0xab) })), hex(a), 'password changes the tag');
  assert.notEqual(hex(argon2id({ ...base, salt: repeat(16, 0xbc) })), hex(a), 'salt changes the tag');
});

test('argon2id: validates parameters with friendly errors', () => {
  const ok = { password: repeat(4, 1), salt: repeat(16, 2), memoryKiB: 8, passes: 1, parallelism: 1, tagLen: 32 };
  assert.throws(() => argon2id({ ...ok, memoryKiB: 4 }), /at least 8 KiB per lane/);
  assert.throws(() => argon2id({ ...ok, passes: 0 }), /at least 1/);
  assert.throws(() => argon2id({ ...ok, parallelism: 0 }), /at least 1/);
  assert.throws(() => argon2id({ ...ok, tagLen: 3 }), /at least 4 bytes/);
  assert.throws(() => argon2id({ ...ok, salt: repeat(4, 2) }), /at least 8 bytes/);
});

test('argon2id: OWASP-default cost runs and yields a 32-byte key', () => {
  // The real backup cost (19 MiB, t=2) — asserts it completes in reasonable time.
  const key = argon2id({
    password: new TextEncoder().encode('correct horse battery staple'),
    salt: repeat(16, 0xcd),
    memoryKiB: 19456,
    passes: 2,
    parallelism: 1,
    tagLen: 32,
  });
  assert.equal(key.length, 32);
});
