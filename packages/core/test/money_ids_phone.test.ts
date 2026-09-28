import { describe, it, expect } from 'vitest';
import { formatKsh, parseKshToMinor } from '../src/money.js';
import { ulid, newId, receiptNumber, newDeviceCode } from '../src/ids.js';
import { normalizeKenyanPhone, formatKenyanPhone } from '../src/phone.js';

describe('money', () => {
  it('formats KSh', () => {
    expect(formatKsh(1200000)).toBe('KSh 12,000');
    expect(formatKsh(1200050)).toBe('KSh 12,000.50');
    expect(formatKsh(-400000)).toBe('-KSh 4,000');
    expect(formatKsh(0)).toBe('KSh 0');
  });
  it('parses user input', () => {
    expect(parseKshToMinor('12,000')).toBe(1200000);
    expect(parseKshToMinor('12000.5')).toBe(1200050);
    expect(parseKshToMinor('ksh 8500')).toBe(850000);
    expect(() => parseKshToMinor('twelve')).toThrow();
    expect(() => parseKshToMinor('-5')).toThrow();
  });
});

describe('ids', () => {
  it('ULIDs are unique, sortable, prefixed', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => ulid()));
    expect(ids.size).toBe(5000);
    const a = ulid(1000), b = ulid(2000);
    expect(a < b).toBe(true);
    expect(newId('pay')).toMatch(/^pay_[0-9A-Z]{26}$/);
  });
  it('receipt numbers are device-scoped', () => {
    expect(receiptNumber('7F3K', 42)).toBe('KD-7F3K-000042');
    expect(newDeviceCode()).toMatch(/^[0-9A-Z]{4}$/);
  });
});

describe('kenyan phones', () => {
  it('normalizes common formats to E.164', () => {
    expect(normalizeKenyanPhone('0712 345 678')).toBe('+254712345678');
    expect(normalizeKenyanPhone('0112345678')).toBe('+254112345678');
    expect(normalizeKenyanPhone('+254712345678')).toBe('+254712345678');
    expect(normalizeKenyanPhone('254712345678')).toBe('+254712345678');
    expect(normalizeKenyanPhone('12345')).toBeNull();
  });
  it('formats for display', () => {
    expect(formatKenyanPhone('+254712345678')).toBe('0712 345 678');
  });
});
