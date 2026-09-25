/**
 * Clock port — injectable time (ADR-004). Domain time is always injectable so tests
 * are deterministic. "Today" for rental dates uses the organization timezone
 * (default Africa/Nairobi — EAT, no DST).
 */

export interface Clock {
  /** Wall-clock milliseconds since epoch. */
  nowMs(): number;
  /** ISO-8601 UTC timestamp (stored on rows). */
  nowIso(): string;
  /** Calendar date `YYYY-MM-DD` in the given timezone (default Africa/Nairobi). */
  today(timeZone?: string): string;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }

  nowIso(): string {
    return new Date().toISOString();
  }

  today(timeZone: string = 'Africa/Nairobi'): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date());
  }
}

/** Deterministic clock for tests. Advances only when told. */
export class ManualClock implements Clock {
  #ms: number;

  constructor(startIsoOrMs: string | number = '2026-09-01T09:00:00.000Z') {
    this.#ms = typeof startIsoOrMs === 'number' ? startIsoOrMs : Date.parse(startIsoOrMs);
  }

  nowMs(): number {
    return this.#ms;
  }

  nowIso(): string {
    return new Date(this.#ms).toISOString();
  }

  today(_timeZone?: string): string {
    return new Date(this.#ms).toISOString().slice(0, 10);
  }

  set(iso: string): void {
    this.#ms = Date.parse(iso);
  }

  advance(ms: number): void {
    this.#ms += ms;
  }
}

/** True for real calendar dates in `YYYY-MM-DD` form. */
export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === value;
}
