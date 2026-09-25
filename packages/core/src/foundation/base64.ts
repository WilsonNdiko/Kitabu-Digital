/**
 * Base64 helpers (standard alphabet) — used to store key material as TEXT so that
 * op-log payloads and cross-platform row values stay plain JSON strings.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += ALPHABET[b0 >> 2]!;
    out += ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]!;
    out += b1 === undefined ? '=' : ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]!;
    out += b2 === undefined ? '=' : ALPHABET[b2 & 63]!;
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new TypeError('Invalid base64 string');
  }
  let buffer = 0;
  let bits = 0;
  const out: number[] = [];
  for (const ch of text) {
    if (ch === '=') break;
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new TypeError('Invalid base64 string');
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}
