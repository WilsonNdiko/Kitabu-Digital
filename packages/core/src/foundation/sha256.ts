/**
 * SHA-256 — vendored, dependency-free, platform-neutral (Node, RN Hermes, browsers).
 *
 * Why vendored (ADR-012): receipt tamper-evidence digests must be computable
 * synchronously inside DB transactions on every platform without pulling a crypto
 * dependency into the core. Verified against NIST vectors and cross-checked against
 * node:crypto in tests. Not used for secrecy — digests only.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX = '0123456789abcdef';

export function sha256(input: Uint8Array): Uint8Array {
  const len = input.length;
  const totalBits = len * 8;
  const hi = Math.floor(totalBits / 2 ** 32);
  const lo = totalBits % 2 ** 32;

  // Padded message: data + 0x80 + zeros + 8-byte big-endian bit length, multiple of 64.
  const paddedLen = (Math.floor((len + 8) / 64) + 1) * 64;
  const m = new Uint8Array(paddedLen);
  m.set(input);
  m[len] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(paddedLen - 8, hi >>> 0);
  dv.setUint32(paddedLen - 4, lo >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let off = 0; off < paddedLen; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15]!;
      const y = w[t - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (s0 + w[t - 16]! + w[t - 7]! + s1) >>> 0;
    }

    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!;
    let e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;

    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = hh + S1 + ch + K[t]! + w[t]!;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = S0 + maj;
      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]!);
  return out;
}

export function sha256Hex(input: Uint8Array): string {
  const digest = sha256(input);
  let hex = '';
  for (const byte of digest) {
    hex += HEX[(byte >> 4) & 0xf]!;
    hex += HEX[byte & 0xf]!;
  }
  return hex;
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * UTF-8 decode without TextDecoder (Hermes lacks it): UTF-8 → JS string.
 * ~1 line of standard algorithm; backup snapshots are the only caller.
 */
export function utf8Text(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i]!;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
    } else if (b0 < 0xe0) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i + 1]! & 0x3f));
      i += 2;
    } else if (b0 < 0xf0) {
      out += String.fromCharCode(((b0 & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f));
      i += 3;
    } else {
      const cp = ((b0 & 0x07) << 18) | ((bytes[i + 1]! & 0x3f) << 12) | ((bytes[i + 2]! & 0x3f) << 6) | (bytes[i + 3]! & 0x3f);
      const minus = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (minus >> 10), 0xdc00 + (minus & 0x3ff));
      i += 4;
    }
  }
  return out;
}

export function sha256HexOfUtf8(text: string): string {
  return sha256Hex(utf8Bytes(text));
}
