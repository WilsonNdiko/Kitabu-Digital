/**
 * Prefixed ULID identifiers — generated on-device, offline-safe, sortable.
 * See docs/DATABASE.md §1. No external dependencies so this runs in Node,
 * browsers, and the Capacitor webview identically.
 */

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const g: any = globalThis as any;
  if (g.crypto?.getRandomValues) {
    g.crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

/** 26-char ULID: 10 chars of ms timestamp + 16 chars of randomness. */
export function ulid(now: number = Date.now()): string {
  let ts = now;
  const time = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    time[i] = B32[ts % 32]!;
    ts = Math.floor(ts / 32);
  }
  const rnd = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += B32[rnd[i]! % 32]!;
  return time.join('') + rand;
}

export type IdPrefix =
  | 'org' | 'usr' | 'prop' | 'bld' | 'unit' | 'ten' | 'tcy'
  | 'pay' | 'led' | 'rcp' | 'exp' | 'mnt' | 'doc' | 'dev' | 'chg' | 'aud' | 'sig' | 'rate';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

/**
 * Deterministic id for a monthly rent charge: any device generating the
 * charge for the same tenancy + period produces the SAME id, making charge
 * generation idempotent across devices (docs/DATABASE.md, docs/SYNC.md).
 */
export function rentChargeId(tenancyId: string, period: string): string {
  return `led_rent_${tenancyId.replace(/^tcy_/, '')}_${period}`;
}

/** Short human-friendly device code used in receipt numbers, e.g. "7F3K". */
export function newDeviceCode(): string {
  const rnd = randomBytes(4);
  let s = '';
  for (let i = 0; i < 4; i++) s += B32[rnd[i]! % 32]!;
  return s;
}

/** Receipt number: one "receipt book" per device — offline-safe uniqueness. */
export function receiptNumber(deviceCode: string, seq: number): string {
  return `KD-${deviceCode}-${String(seq).padStart(6, '0')}`;
}
