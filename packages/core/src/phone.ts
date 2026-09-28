/** Kenyan phone number helpers. Accepts 07xx…, 01xx…, +2547…, 2547…. */

export function normalizeKenyanPhone(input: string): string | null {
  const digits = input.replace(/[\s\-()]/g, '');
  if (/^\+254(7|1)\d{8}$/.test(digits)) return digits;
  if (/^254(7|1)\d{8}$/.test(digits)) return `+${digits}`;
  if (/^0(7|1)\d{8}$/.test(digits)) return `+254${digits.slice(1)}`;
  return null;
}

export function formatKenyanPhone(e164: string): string {
  if (/^\+254(7|1)\d{8}$/.test(e164)) {
    const local = `0${e164.slice(4)}`;
    return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
  }
  return e164;
}
