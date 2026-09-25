/**
 * BLAKE2b (RFC 7693) — the hash inside Argon2 (RFC 9106 §3.2).
 *
 * Zero-dependency pure TypeScript. BigInt internals on purpose: this hash is
 * called only for the initial/final digests (~100 short calls per Argon2 run),
 * so clarity beats micro-optimization here — the memory-hard loop lives in
 * argon2.ts on 32-bit pairs. Correctness is cross-checked against node:crypto's
 * blake2b512 in the test suite.
 *
 * Only what Argon2 needs: unkeyed, sequential (fanout=1, depth=1), digest
 * length 1..64.
 */

import { KitabuError } from './errors.ts';

const IV: readonly bigint[] = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];

/** Message-word schedule (RFC 7693 §2.7); 10 rows, cycled over 12 rounds. */
const SIGMA: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const MASK64 = (1n << 64n) - 1n;

function rotr64(x: bigint, n: number): bigint {
  const N = BigInt(n);
  return ((x >> N) | (x << (64n - N))) & MASK64;
}

function readU64Le(bytes: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[offset + i]!);
  }
  return v;
}

function writeU64Le(bytes: Uint8Array, offset: number, value: bigint): void {
  let v = value & MASK64;
  for (let i = 0; i < 8; i++) {
    bytes[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

const m: bigint[] = new Array(16).fill(0n);
const v: bigint[] = new Array(16).fill(0n);

/** One BLAKE2b compression over a 128-byte block (RFC 7693 §2.7–2.9). */
function compress(h: bigint[], block: Uint8Array, t: bigint, last: boolean): void {
  for (let i = 0; i < 16; i++) {
    m[i] = readU64Le(block, i * 8);
  }
  for (let i = 0; i < 8; i++) {
    v[i] = h[i]!;
    v[i + 8] = IV[i]!;
  }
  v[12]! ^= t; // low counter word (our inputs never reach the high word)
  if (last) v[14]! ^= MASK64; // f0 finalization flag (f1 stays 0)

  for (let round = 0; round < 12; round++) {
    const s = SIGMA[round % 10]!;
    gb(v, 0, 4, 8, 12, m[s[0]!]!, m[s[1]!]!);
    gb(v, 1, 5, 9, 13, m[s[2]!]!, m[s[3]!]!);
    gb(v, 2, 6, 10, 14, m[s[4]!]!, m[s[5]!]!);
    gb(v, 3, 7, 11, 15, m[s[6]!]!, m[s[7]!]!);
    gb(v, 0, 5, 10, 15, m[s[8]!]!, m[s[9]!]!);
    gb(v, 1, 6, 11, 12, m[s[10]!]!, m[s[11]!]!);
    gb(v, 2, 7, 8, 13, m[s[12]!]!, m[s[13]!]!);
    gb(v, 3, 4, 9, 14, m[s[14]!]!, m[s[15]!]!);
  }

  for (let i = 0; i < 8; i++) {
    h[i]! ^= v[i]! ^ v[i + 8]!;
  }
}

/** BLAKE2b mixing function G. */
function gb(
  vv: bigint[],
  a: number, b: number, c: number, d: number,
  x: bigint, y: bigint,
): void {
  vv[a]! = (vv[a]! + vv[b]! + x) & MASK64;
  vv[d]! = rotr64(vv[d]! ^ vv[a]!, 32);
  vv[c]! = (vv[c]! + vv[d]!) & MASK64;
  vv[b]! = rotr64(vv[b]! ^ vv[c]!, 24);
  vv[a]! = (vv[a]! + vv[b]! + y) & MASK64;
  vv[d]! = rotr64(vv[d]! ^ vv[a]!, 16);
  vv[c]! = (vv[c]! + vv[d]!) & MASK64;
  vv[b]! = rotr64(vv[b]! ^ vv[c]!, 63);
}

/**
 * BLAKE2b of `input` with digest length `outLen` (1..64), unkeyed, sequential.
 * Matches the reference C implementation: the final partial block is zero-padded
 * internally and the byte counter holds the true input length.
 */
export function blake2b(input: Uint8Array, outLen: number): Uint8Array {
  if (!Number.isInteger(outLen) || outLen < 1 || outLen > 64) {
    throw new KitabuError(
      'VALIDATION', 'BLAKE2b digest length must be between 1 and 64 bytes.', `outLen=${outLen}`,
    );
  }

  const h: bigint[] = [...IV];
  // Parameter block: digest length, key length 0, fanout 1, depth 1.
  h[0]! ^= 0x01010000n ^ BigInt(outLen);

  const len = input.length;
  const block = new Uint8Array(128);

  if (len === 0) {
    block.fill(0);
    compress(h, block, 0n, true);
  } else {
    const total = Math.ceil(len / 128);
    for (let i = 0; i < total; i++) {
      const isLast = i === total - 1;
      if (isLast && len % 128 !== 0) {
        block.fill(0);
        block.set(input.subarray(i * 128));
        compress(h, block, BigInt(len), true);
      } else {
        compress(h, input.subarray(i * 128, i * 128 + 128), BigInt((i + 1) * 128), isLast);
      }
    }
  }

  const out = new Uint8Array(outLen);
  const chunk = new Uint8Array(8);
  for (let i = 0; i < 8 && i * 8 < outLen; i++) {
    writeU64Le(chunk, 0, h[i]!);
    const take = Math.min(8, outLen - i * 8);
    out.set(chunk.subarray(0, take), i * 8);
  }
  return out;
}
