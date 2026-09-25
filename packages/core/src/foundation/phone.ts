/**
 * Kenyan mobile phone numbers (PRD §45).
 *
 * Stored as E.164 (`+2547XXXXXXXX`), displayed as `0712 345 678`.
 * Kenyan mobile prefixes: 07xx / 01xx (Safaricom, Airtel, Telkom, Jambo).
 */

const DIGITS_RE = /^[0-9]+$/;

/**
 * Normalize a Kenyan mobile number to E.164. Returns null when the input cannot be a
 * valid Kenyan mobile (wrong length, bad prefix, non-digits).
 *
 * Accepted: +254712345678 · 254712345678 · 0712345678 · 712345678 · 0110123456
 */
export function normalizeKenyanMobile(input: string): string | null {
  let s = input.replace(/[\s\-()]/g, '');
  if (s === '') return null;

  let national: string; // 9 digits starting with 7 or 1
  if (s.startsWith('+254')) national = s.slice(4);
  else if (s.startsWith('254')) national = s.slice(3);
  else if (s.startsWith('0')) national = s.slice(1);
  else national = s;

  if (national.length !== 9) return null;
  if (!DIGITS_RE.test(national)) return null;
  if (national[0] !== '7' && national[0] !== '1') return null;
  return `+254${national}`;
}

export function isValidKenyanMobile(input: string): boolean {
  return normalizeKenyanMobile(input) !== null;
}

/** `+254712345678` → `0712 345 678`. Non-Kenyan values pass through unchanged. */
export function formatKenyanMobile(e164: string): string {
  if (/^\+254[17]\d{8}$/.test(e164)) {
    const n = e164.slice(4);
    return `0${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  }
  return e164;
}
