/**
 * Money value object (ADR-005).
 *
 * KES, integer minor units (cents). Never floats. Kenyan rent is typically whole
 * shillings, but M-Pesa amounts can carry cents, so storage is always minor units.
 */

/** Hard sanity cap: 1 trillion KSh in minor units (2 trillion cents). */
const MAX_MINOR = 2 * 10 ** 14;

export class Money {
  /** Minor units (cents). May be negative (advance/credit balance). */
  readonly minor: number;

  private constructor(minor: number) {
    if (!Number.isSafeInteger(minor)) {
      throw new RangeError(`Money minor units must be a safe integer, got ${minor}`);
    }
    if (Math.abs(minor) > MAX_MINOR) {
      throw new RangeError('Amount is too large for the books');
    }
    this.minor = minor;
  }

  static fromMinor(minor: number): Money {
    return new Money(minor);
  }

  /** Whole Kenyan shillings (the common case: rent 12500). */
  static fromShillings(shillings: number): Money {
    return new Money(Math.trunc(shillings * 100));
  }

  /**
   * Parse user input: "12500", "12,500", "KSh 12,500", "12500.50", "-4000".
   * Rejects anything with more than two decimals or non-numeric characters.
   */
  static parse(text: string): Money {
    let s = text.trim().replace(/^ksh\s*/i, '').replace(/,/g, '').replace(/\s+/g, '');
    if (s === '') throw new TypeError('Enter an amount');
    if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
      throw new TypeError(`"${text}" is not a valid amount`);
    }
    const negative = s.startsWith('-');
    if (negative) s = s.slice(1);
    const parts = s.split('.');
    const whole = parts[0]!;
    const frac = parts[1] ?? '';
    const minor = Number(whole) * 100 + (frac === '' ? 0 : Number(frac.padEnd(2, '0')));
    return new Money(negative ? -minor : minor);
  }

  get isNegative(): boolean {
    return this.minor < 0;
  }

  add(other: Money): Money {
    return new Money(this.minor + other.minor);
  }

  sub(other: Money): Money {
    return new Money(this.minor - other.minor);
  }

  negated(): Money {
    return new Money(-this.minor);
  }

  compareTo(other: Money): number {
    return this.minor < other.minor ? -1 : this.minor > other.minor ? 1 : 0;
  }

  /** "12,500" or "12,500.50" (no symbol). */
  formatPlain(): string {
    const negative = this.minor < 0;
    const abs = Math.abs(this.minor);
    const whole = Math.floor(abs / 100);
    const cents = abs % 100;
    const grouped = whole.toLocaleString('en-US');
    return `${negative ? '-' : ''}${grouped}${cents === 0 ? '' : `.${cents.toString().padStart(2, '0')}`}`;
  }

  /** "KSh 12,500" / "KSh 12,500.50" / "-KSh 4,000". */
  format(): string {
    const plain = this.formatPlain();
    return this.minor < 0 ? `-${'KSh'} ${plain.slice(1)}` : `KSh ${plain}`;
  }
}

/** Format minor units directly (convenience for row values). */
export function formatKsh(minor: number): string {
  return Money.fromMinor(minor).format();
}
