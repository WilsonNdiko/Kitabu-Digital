/** Talks only to the LOCAL core service — never directly to any cloud. */

async function req(path: string, opts?: RequestInit): Promise<any> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Something went wrong. Please try again.');
  return body;
}

export const api = {
  get: (path: string) => req(path),
  post: (path: string, data?: unknown) => req(path, { method: 'POST', body: JSON.stringify(data ?? {}) }),
};

// ---- money helpers (display only; the server owns all arithmetic) ----
export function ksh(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const sh = Math.floor(abs / 100).toLocaleString('en-KE');
  const cents = abs % 100;
  return `${neg ? '-' : ''}KSh ${cents ? `${sh}.${String(cents).padStart(2, '0')}` : sh}`;
}

export function toMinor(input: string): number {
  const cleaned = input.replace(/[,\s]/g, '');
  const n = Number(cleaned);
  if (!isFinite(n) || n < 0) throw new Error('Enter a valid amount, e.g. 12000');
  return Math.round(n * 100);
}

export function monthName(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, 1).toLocaleString('en-KE', { month: 'long', year: 'numeric' });
}
