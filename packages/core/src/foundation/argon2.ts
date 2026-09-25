/**
 * Argon2id (RFC 9106, version 0x13) — the passphrase KDF for local encrypted
 * backups (SECURITY.md §4).
 *
 * Zero-dependency pure TypeScript, ported from the PHC reference
 * implementation (phc-winner-argon2 src/core.c + src/ref.c) and validated
 * against the RFC 9106 §5.3 test vectors.
 *
 * Performance approach: the memory-hard loop (compression function G) runs on
 * a flat Uint32Array where every 64-bit word is a (lo, hi) pair of uint32s.
 * All intermediate values fit in JS numbers exactly (< 2^53), so no BigInt is
 * needed in the hot path — only BLAKE2b digests (a handful of calls) use
 * BigInt.
 */

import { KitabuError } from './errors.ts';
import { blake2b } from './blake2b.ts';

export interface Argon2Input {
  password: Uint8Array;
  salt: Uint8Array;
  /** Memory in KiB (m). Must be >= 8 * parallelism. */
  memoryKiB: number;
  /** Number of passes (t), >= 1. */
  passes: number;
  /** Lanes / parallelism (p), >= 1. */
  parallelism: number;
  /** Tag length in bytes (T), >= 4. */
  tagLen: number;
  /** Optional secret value K. */
  secret?: Uint8Array;
  /** Optional associated data X. */
  associatedData?: Uint8Array;
}

const VERSION = 0x13;
const TYPE_ARGON2ID = 2;
const SYNC_POINTS = 4;
const ADDRESSES_IN_BLOCK = 128;
const QWORDS_IN_BLOCK = 128; // 1024 bytes / 8
const U32_PER_BLOCK = QWORDS_IN_BLOCK * 2;
const MAX_UINT32 = 4294967296;

/* ------------------------------------------------------------------ */
/* Little-endian helpers                                              */
/* ------------------------------------------------------------------ */

function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function le32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = value & 0xff;
  out[1] = (value >>> 8) & 0xff;
  out[2] = (value >>> 16) & 0xff;
  out[3] = (value >>> 24) & 0xff;
  return out;
}

function le32At(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function writeLe32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

/* ------------------------------------------------------------------ */
/* Exact 32x32 -> 64 multiply (all intermediates < 2^53)              */
/* ------------------------------------------------------------------ */

const mul32Out: [number, number] = [0, 0];

/**
 * Fills `mul32Out` with [lo, hi] = (a * b) mod 2^64 for uint32 a, b.
 * 16-bit limb decomposition keeps every intermediate exact in JS numbers.
 */
function mul32(a: number, b: number): [number, number] {
  const aL = a & 0xffff;
  const aH = a >>> 16;
  const bL = b & 0xffff;
  const bH = b >>> 16;
  const ll = aL * bL; // < 2^32
  const lh = aL * bH; // < 2^32
  const hl = aH * bL; // < 2^32
  const hh = aH * bH; // < 2^32
  const mid = lh + hl; // < 2^33, exact
  // NB: `<<` would truncate to signed int32 and `>>>` would drop bit 32 of mid;
  // plain multiplication/division keeps every value exact.
  const low = ll + (mid & 0xffff) * 65536; // true value, < 2^33
  mul32Out[0] = low >>> 0;
  const carry = low > 0xffffffff ? 1 : 0;
  mul32Out[1] = (hh + Math.floor(mid / 65536) + carry) >>> 0;
  return mul32Out;
}

/** High 32 bits of (a * b) for uint32 a, b — i.e. floor(a * b / 2^32). */
function mul32Hi(a: number, b: number): number {
  return mul32(a, b)[1]!;
}

/* ------------------------------------------------------------------ */
/* Compression function G on 32-bit pair state                        */
/* ------------------------------------------------------------------ */

// Scratch block for G (reused; the KDF is synchronous and single-threaded).
const scratchR = new Uint32Array(U32_PER_BLOCK);
const scratchT = new Uint32Array(U32_PER_BLOCK);

/**
 * GB positions inside a 16-word group (RFC 9106 Figure 18):
 * four column steps then four diagonal steps.
 */
const GB_POS = [
  0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15,
  0, 5, 10, 15, 1, 6, 11, 12, 2, 7, 8, 13, 3, 4, 9, 14,
] as const;

/**
 * The 16 permutation groups as u32 offsets into a block: first the eight
 * consecutive 16-word groups (ref.c: blockR.v[16i..16i+15]), then the eight
 * strided groups (ref.c: blockR.v[2i, 2i+1, 2i+16, 2i+17, ..., 2i+112, 2i+113]).
 */
const ROUND_GROUPS: readonly (readonly number[])[] = (() => {
  const groups: number[][] = [];
  for (let i = 0; i < 8; i++) {
    const g: number[] = [];
    for (let j = 0; j < 16; j++) g.push((16 * i + j) * 2);
    groups.push(g);
  }
  for (let i = 0; i < 8; i++) {
    const g: number[] = [];
    for (let j = 0; j < 16; j++) {
      const word = 2 * i + (j & 1) + (j >> 1) * 16;
      g.push(word * 2);
    }
    groups.push(g);
  }
  return groups;
})();

const groupLo = new Array<number>(16);
const groupHi = new Array<number>(16);

/** One application of permutation P to 16 u64 words at the given u32 offsets. */
function applyRound(mem: Uint32Array, idx: readonly number[]): void {
  for (let i = 0; i < 16; i++) {
    groupLo[i] = mem[idx[i]!]!;
    groupHi[i] = mem[idx[i]! + 1]!;
  }
  for (let g = 0; g < 32; g += 4) {
    gb(groupLo, groupHi, GB_POS[g]!, GB_POS[g + 1]!, GB_POS[g + 2]!, GB_POS[g + 3]!);
  }
  for (let i = 0; i < 16; i++) {
    mem[idx[i]!] = groupLo[i]!;
    mem[idx[i]! + 1] = groupHi[i]!;
  }
}

/**
 * GB with the fBlaMka 64-bit multiply (RFC 9106 Figure 19). Operates in place
 * on (lo, hi) pairs; every intermediate stays below 2^53.
 */
function gb(
  vLo: number[], vHi: number[],
  a: number, b: number, c: number, d: number,
): void {
  // Values are kept strictly in uint32 domain: XOR results are normalized with
  // >>> 0 because ^ yields signed int32 and these flow through plain arrays.
  let a0 = vLo[a]!, a1 = vHi[a]!;
  let b0 = vLo[b]!, b1 = vHi[b]!;
  let c0 = vLo[c]!, c1 = vHi[c]!;
  let d0 = vLo[d]!, d1 = vHi[d]!;
  let x0: number, x1: number, p: [number, number], low: number, carry: number;

  // 1. a = a + b + 2*trunc(a)*trunc(b)
  p = mul32(a0, b0);
  low = a0 + b0 + ((p[0]! * 2) % MAX_UINT32);
  a0 = low % MAX_UINT32;
  carry = (low - a0) / MAX_UINT32;
  a1 = (a1 + b1 + carry + p[1]! * 2 + (p[0]! >>> 31)) % MAX_UINT32;

  // 2. d = rotr(d ^ a, 32) — swap halves
  x0 = (d0 ^ a0) >>> 0; x1 = (d1 ^ a1) >>> 0;
  d0 = x1; d1 = x0;

  // 3. c = c + d + 2*trunc(c)*trunc(d)
  p = mul32(c0, d0);
  low = c0 + d0 + ((p[0]! * 2) % MAX_UINT32);
  c0 = low % MAX_UINT32;
  carry = (low - c0) / MAX_UINT32;
  c1 = (c1 + d1 + carry + p[1]! * 2 + (p[0]! >>> 31)) % MAX_UINT32;

  // 4. b = rotr(b ^ c, 24)
  x0 = (b0 ^ c0) >>> 0; x1 = (b1 ^ c1) >>> 0;
  b0 = ((x0 >>> 24) | ((x1 & 0xffffff) << 8)) >>> 0;
  b1 = ((x1 >>> 24) | ((x0 & 0xffffff) << 8)) >>> 0;

  // 5. a = a + b + 2*trunc(a)*trunc(b)
  p = mul32(a0, b0);
  low = a0 + b0 + ((p[0]! * 2) % MAX_UINT32);
  a0 = low % MAX_UINT32;
  carry = (low - a0) / MAX_UINT32;
  a1 = (a1 + b1 + carry + p[1]! * 2 + (p[0]! >>> 31)) % MAX_UINT32;

  // 6. d = rotr(d ^ a, 16)
  x0 = (d0 ^ a0) >>> 0; x1 = (d1 ^ a1) >>> 0;
  d0 = ((x0 >>> 16) | ((x1 & 0xffff) << 16)) >>> 0;
  d1 = ((x1 >>> 16) | ((x0 & 0xffff) << 16)) >>> 0;

  // 7. c = c + d + 2*trunc(c)*trunc(d)
  p = mul32(c0, d0);
  low = c0 + d0 + ((p[0]! * 2) % MAX_UINT32);
  c0 = low % MAX_UINT32;
  carry = (low - c0) / MAX_UINT32;
  c1 = (c1 + d1 + carry + p[1]! * 2 + (p[0]! >>> 31)) % MAX_UINT32;

  // 8. b = rotr(b ^ c, 63) — rotate left by 1
  x0 = (b0 ^ c0) >>> 0; x1 = (b1 ^ c1) >>> 0;
  b0 = ((x0 << 1) | (x1 >>> 31)) >>> 0;
  b1 = ((x1 << 1) | (x0 >>> 31)) >>> 0;

  vLo[a] = a0; vHi[a] = a1;
  vLo[b] = b0; vHi[b] = b1;
  vLo[c] = c0; vHi[c] = c1;
  vLo[d] = d0; vHi[d] = d1;
}

/**
 * Compression function G (RFC 9106 §3.5): out = G(prev, ref), i.e.
 * R = prev ^ ref; R' = P applied to rows then columns; out = R' ^ R
 * (with_xor additionally XORs the old block in — used for passes >= 1).
 * `b` and `out` may alias; all inputs are consumed before out is written.
 */
function fillBlock(
  a: Uint32Array, aOff: number,
  b: Uint32Array, bOff: number,
  out: Uint32Array, outOff: number,
  withXor: boolean,
): void {
  for (let i = 0; i < U32_PER_BLOCK; i++) {
    const r = a[aOff + i]! ^ b[bOff + i]!;
    scratchR[i] = r;
    scratchT[i] = withXor ? r ^ out[outOff + i]! : r;
  }
  for (let g = 0; g < 16; g++) {
    applyRound(scratchR, ROUND_GROUPS[g]!);
  }
  for (let i = 0; i < U32_PER_BLOCK; i++) {
    out[outOff + i] = scratchT[i]! ^ scratchR[i]!;
  }
}

/* ------------------------------------------------------------------ */
/* Variable-length hash H' (RFC 9106 §3.3)                            */
/* ------------------------------------------------------------------ */

function variableLengthHash(a: Uint8Array, T: number): Uint8Array {
  if (T <= 64) {
    return blake2b(concat(le32(T), a), T);
  }
  const r = Math.ceil(T / 32) - 2;
  const out = new Uint8Array(T);
  let v = blake2b(concat(le32(T), a), 64); // V_1
  for (let i = 1; i <= r; i++) {
    out.set(v.subarray(0, 32), (i - 1) * 32); // W_i
    if (i < r) v = blake2b(v, 64); // V_{i+1} — keep V_r for the tail below
  }
  const tail = blake2b(v, T - 32 * r); // V_{r+1} = H^(T-32r)(V_r)
  out.set(tail, r * 32);
  return out;
}

/* ------------------------------------------------------------------ */
/* Reference block index (RFC 9106 §3.4.2, ref.c index_alpha)         */
/* ------------------------------------------------------------------ */

function indexAlpha(
  pass: number, slice: number, index: number,
  pseudoRand: number, sameLane: boolean,
  segmentLength: number, laneLength: number,
): number {
  let area: number;
  if (pass === 0) {
    if (slice === 0) {
      area = index - 1; // all but the previous
    } else if (sameLane) {
      area = slice * segmentLength + index - 1;
    } else {
      area = slice * segmentLength + (index === 0 ? -1 : 0);
    }
  } else {
    if (sameLane) {
      area = laneLength - segmentLength + index - 1;
    } else {
      area = laneLength - segmentLength + (index === 0 ? -1 : 0);
    }
  }

  // zz = area - 1 - floor(area * floor(pseudoRand^2 / 2^32) / 2^32)  (Figure 13)
  const x = mul32Hi(pseudoRand, pseudoRand);
  const y = mul32Hi(area, x);
  const zz = area - 1 - y;

  let start = 0;
  if (pass !== 0) {
    start = slice === SYNC_POINTS - 1 ? 0 : (slice + 1) * segmentLength;
  }
  return (start + zz) % laneLength;
}

/* ------------------------------------------------------------------ */
/* Argon2id                                                           */
/* ------------------------------------------------------------------ */

export function argon2id(input: Argon2Input): Uint8Array {
  const { password, salt, memoryKiB: m, passes: t, parallelism: p, tagLen: T } = input;
  const secret = input.secret ?? new Uint8Array(0);
  const associatedData = input.associatedData ?? new Uint8Array(0);

  if (!Number.isInteger(m) || m < 8 * p) {
    throw new KitabuError('VALIDATION', 'Argon2 memory must be at least 8 KiB per lane.', `memoryKiB=${m}, parallelism=${p}`);
  }
  if (!Number.isInteger(t) || t < 1) {
    throw new KitabuError('VALIDATION', 'Argon2 passes must be at least 1.', `passes=${t}`);
  }
  if (!Number.isInteger(p) || p < 1) {
    throw new KitabuError('VALIDATION', 'Argon2 parallelism must be at least 1.', `parallelism=${p}`);
  }
  if (!Number.isInteger(T) || T < 4) {
    throw new KitabuError('VALIDATION', 'Argon2 tag length must be at least 4 bytes.', `tagLen=${T}`);
  }
  if (salt.length < 8) {
    throw new KitabuError('VALIDATION', 'Argon2 salt must be at least 8 bytes.', `saltLen=${salt.length}`);
  }

  // H_0 (RFC 9106 §3.2 Figure 1)
  const h0 = blake2b(concat(
    le32(p), le32(T), le32(m), le32(t), le32(VERSION), le32(TYPE_ARGON2ID),
    le32(password.length), password,
    le32(salt.length), salt,
    le32(secret.length), secret,
    le32(associatedData.length), associatedData,
  ), 64);

  // Memory allocation (§3.2 Figure 2): m' = 4p * floor(m / 4p) blocks of 1 KiB.
  const mPrime = 4 * p * Math.floor(m / (4 * p));
  const laneLength = mPrime / p; // q columns per lane
  const segmentLength = laneLength / SYNC_POINTS;

  const mem = new Uint32Array(mPrime * U32_PER_BLOCK);

  // First two blocks per lane (§3.2 Figures 3–4).
  for (let l = 0; l < p; l++) {
    for (let j = 0; j < 2; j++) {
      const block = variableLengthHash(concat(h0, le32(j), le32(l)), 1024);
      const off = (l * laneLength + j) * U32_PER_BLOCK;
      for (let w = 0; w < QWORDS_IN_BLOCK; w++) {
        mem[off + 2 * w] = le32At(block, 8 * w);
        mem[off + 2 * w + 1] = le32At(block, 8 * w + 4);
      }
    }
  }

  // Address generation state (ref.c: zero_block / input_block / address_block).
  const zero = new Uint32Array(U32_PER_BLOCK);
  const addrIn = new Uint32Array(U32_PER_BLOCK);
  const addr = new Uint32Array(U32_PER_BLOCK);

  const nextAddresses = (): void => {
    addrIn[12]!++; // input_block.v[6]++ (starts at 1 for the first block)
    fillBlock(zero, 0, addrIn, 0, addr, 0, false);
    fillBlock(zero, 0, addr, 0, addr, 0, false);
  };

  // Fill memory slicewise (§3.2 steps 5–6, ref.c fill_memory_blocks_st).
  for (let r = 0; r < t; r++) {
    for (let s = 0; s < SYNC_POINTS; s++) {
      for (let l = 0; l < p; l++) {
        // Argon2id: data-independent addressing on pass 0, slices 0 and 1.
        const dataIndependent = r === 0 && s < 2;
        if (dataIndependent) {
          // input_block: v[0]=pass, v[1]=lane, v[2]=slice, v[3]=m',
          // v[4]=passes, v[5]=type — each u64 word occupies slots (2k, 2k+1).
          addrIn.fill(0);
          addrIn[0] = r;          // v[0]
          addrIn[2] = l;          // v[1]
          addrIn[4] = s;          // v[2]
          addrIn[6] = mPrime;     // v[3]
          addrIn[8] = t;          // v[4]
          addrIn[10] = TYPE_ARGON2ID; // v[5]
          // v[6] (slots 12-13) stays 0; nextAddresses() increments it to 1.
        }

        let startingIndex = 0;
        if (r === 0 && s === 0) {
          startingIndex = 2; // first two blocks are precomputed
          if (dataIndependent) nextAddresses();
        }

        let currOffset = l * laneLength + s * segmentLength + startingIndex;
        let prevOffset = currOffset % laneLength === 0
          ? currOffset + laneLength - 1
          : currOffset - 1;

        for (let i = startingIndex; i < segmentLength; i++, currOffset++, prevOffset++) {
          if (currOffset % laneLength === 1) {
            prevOffset = currOffset - 1;
          }

          let j1: number; // low 32 bits of the pseudo-random word
          let j2: number; // high 32 bits
          if (dataIndependent) {
            if (i % ADDRESSES_IN_BLOCK === 0) nextAddresses();
            const w = (i % ADDRESSES_IN_BLOCK) * 2;
            j1 = addr[w]!;
            j2 = addr[w + 1]!;
          } else {
            const prevOff = prevOffset * U32_PER_BLOCK;
            j1 = mem[prevOff]!;
            j2 = mem[prevOff + 1]!;
          }

          let refLane = j2 % p;
          if (r === 0 && s === 0) {
            refLane = l; // cannot reference other lanes yet
          }
          const refIndex = indexAlpha(r, s, i, j1, refLane === l, segmentLength, laneLength);
          const refOffset = refLane * laneLength + refIndex;

          fillBlock(
            mem, prevOffset * U32_PER_BLOCK,
            mem, refOffset * U32_PER_BLOCK,
            mem, currOffset * U32_PER_BLOCK,
            r !== 0,
          );
        }
      }
    }
  }

  // Final block C: XOR of the last column (§3.2 Figure 7).
  const c = new Uint32Array(U32_PER_BLOCK);
  for (let l = 0; l < p; l++) {
    const off = (l * laneLength + laneLength - 1) * U32_PER_BLOCK;
    for (let i = 0; i < U32_PER_BLOCK; i++) {
      c[i] = c[i]! ^ mem[off + i]!;
    }
  }
  const cBytes = new Uint8Array(1024);
  for (let w = 0; w < QWORDS_IN_BLOCK; w++) {
    writeLe32(cBytes, 8 * w, c[2 * w]!);
    writeLe32(cBytes, 8 * w + 4, c[2 * w + 1]!);
  }

  // Tag: H'^T(C) (§3.2 Figure 8).
  return variableLengthHash(cBytes, T);
}
