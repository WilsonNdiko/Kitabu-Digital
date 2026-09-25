/**
 * Formatting — Kenyan landlordeze (docs/UX.md §6):
 * money `KSh 12,500`, phones `0712 345 678`, dates `14 Sep 2026`.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function ksh(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return '—';
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const shillings = Math.floor(abs / 100);
  const cents = abs % 100;
  const grouped = shillings.toLocaleString('en-KE');
  const body = cents === 0 ? `KSh ${grouped}` : `KSh ${grouped}.${String(cents).padStart(2, '0')}`;
  return negative ? `−${body}` : body;
}

export function dateKe(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  if (y === undefined || m === undefined || d === undefined) return iso;
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

export function dateTimeKe(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const d = dateKe(iso);
  const t = iso.slice(11, 16);
  return t === '' ? d : `${d}, ${t}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-');
  if (y === undefined || m === undefined) return month;
  return `${MONTHS_FULL[Number(m) - 1]} ${y}`;
}

export function phoneKe(phone: string | null | undefined): string {
  if (phone === null || phone === undefined || phone === '') return '—';
  // core stores +2547XXXXXXXX — display the familiar local form
  if (phone.startsWith('+254') && phone.length === 13) {
    const local = `0${phone.slice(4)}`;
    return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
  }
  return phone;
}

/** KSh text input → minor units. Returns null when not a valid amount. */
export function parseKsh(text: string): number | null {
  const cleaned = text.replace(/,/g, '').trim();
  if (cleaned === '') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

export function toKshInput(minor: number): string {
  return String(minor / 100);
}
