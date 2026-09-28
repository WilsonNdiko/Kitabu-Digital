/**
 * Money is ALWAYS integer minor units (cents of KES). Floats are forbidden
 * in financial code (docs/DATABASE.md §4).
 */

export function assertMoney(minor: number, label = 'amount'): void {
  if (!Number.isInteger(minor)) throw new Error(`${label} must be an integer amount in cents`);
}

/** "KSh 12,000" (drops cents when zero, shows them otherwise). */
export function formatKsh(minor: number): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const shillings = Math.floor(abs / 100);
  const cents = abs % 100;
  const whole = shillings.toLocaleString('en-KE');
  const body = cents === 0 ? whole : `${whole}.${String(cents).padStart(2, '0')}`;
  return `${negative ? '-' : ''}KSh ${body}`;
}

/** Parse user input like "12,000" or "12000.50" into minor units. */
export function parseKshToMinor(input: string): number {
  const cleaned = input.replace(/[,\sKkSsHh]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error('Enter a valid amount, e.g. 12000 or 12,000.50');
  }
  const [whole, frac = ''] = cleaned.split('.');
  return parseInt(whole!, 10) * 100 + (frac ? parseInt(frac.padEnd(2, '0'), 10) : 0);
}
