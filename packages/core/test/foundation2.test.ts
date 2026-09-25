import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { sha256, sha256Hex, sha256HexOfUtf8, utf8Bytes } from '../src/foundation/sha256.ts';
import { bytesToBase64, base64ToBytes } from '../src/foundation/base64.ts';
import { canonicalJson } from '../src/foundation/canonicaljson.ts';
import { shillingsInWords } from '../src/foundation/numwords.ts';

test('sha256: NIST test vectors', () => {
  assert.equal(sha256HexOfUtf8(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256HexOfUtf8('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256HexOfUtf8('The quick brown fox jumps over the lazy dog'), 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
  assert.equal(sha256HexOfUtf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('sha256: cross-checked against node:crypto on random inputs of many lengths', () => {
  for (const len of [0, 1, 3, 31, 32, 33, 55, 63, 64, 65, 127, 128, 129, 1000, 4096, 10000]) {
    const data = new Uint8Array(randomBytes(len));
    const expected = createHash('sha256').update(data).digest('hex');
    assert.equal(sha256Hex(data), expected, `mismatch at length ${len}`);
  }
});

test('sha256: output is a fresh 32-byte buffer', () => {
  const a = sha256(utf8Bytes('kitabu'));
  const b = sha256(utf8Bytes('kitabu'));
  assert.equal(a.length, 32);
  assert.notEqual(a, b); // different buffer objects
  assert.deepEqual(a, b); // same content
});

test('base64: round-trips arbitrary bytes', () => {
  for (const len of [0, 1, 2, 3, 4, 5, 31, 32, 64, 100]) {
    const bytes = new Uint8Array(randomBytes(len));
    const encoded = bytesToBase64(bytes);
    assert.match(encoded, /^[A-Za-z0-9+/]*={0,2}$/);
    assert.deepEqual(base64ToBytes(encoded), bytes, `round-trip failed at length ${len}`);
  }
  assert.throws(() => base64ToBytes('not valid!!'));
});

test('canonicalJson: key order is irrelevant, output is deterministic', () => {
  const a = { b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } };
  const b = { a: { c: 'x', d: [3, { y: 2, z: 1 }] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
});

test('canonicalJson: unicode names survive identically (Kenyan names)', () => {
  const snapshot = { tenant: 'Wanjĩku Mũigai', amount: 12500 };
  const roundTripped = JSON.parse(canonicalJson(snapshot));
  assert.equal(roundTripped.tenant, 'Wanjĩku Mũigai');
});

test('numwords: Kenyan receipt amounts in words', () => {
  assert.equal(shillingsInWords(0), 'Kenya Shillings Zero Only');
  assert.equal(shillingsInWords(100), 'Kenya Shillings One Only');
  assert.equal(shillingsInWords(1_250_000), 'Kenya Shillings Twelve Thousand Five Hundred Only');
  assert.equal(shillingsInWords(12_500_000), 'Kenya Shillings One Hundred Twenty-Five Thousand Only');
  assert.equal(shillingsInWords(1_200_050), 'Kenya Shillings Twelve Thousand and Fifty Cents Only');
  assert.equal(shillingsInWords(1_200_000_000), 'Kenya Shillings Twelve Million Only');
  assert.equal(shillingsInWords(125), 'Kenya Shillings One and Twenty-Five Cents Only');
  assert.equal(shillingsInWords(1_050_000_000_000), 'Kenya Shillings Ten Billion Five Hundred Million Only');
  assert.throws(() => shillingsInWords(-1));
  assert.throws(() => shillingsInWords(1.5));
});
