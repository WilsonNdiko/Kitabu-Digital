import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Money } from '../src/foundation/money.ts';

test('money: whole shillings round-trip', () => {
  const m = Money.fromShillings(12_500);
  assert.equal(m.minor, 1_250_000);
  assert.equal(m.format(), 'KSh 12,500');
});

test('money: minor units round-trip', () => {
  assert.equal(Money.fromMinor(1_250_050).format(), 'KSh 12,500.50');
  assert.equal(Money.fromMinor(50).format(), 'KSh 0.50');
});

test('money: parse accepts Kenyan input styles', () => {
  assert.equal(Money.parse('12500').minor, 1_250_000);
  assert.equal(Money.parse('12,500').minor, 1_250_000);
  assert.equal(Money.parse('KSh 12,500').minor, 1_250_000);
  assert.equal(Money.parse('ksh 12500').minor, 1_250_000);
  assert.equal(Money.parse(' 12 500 ').minor, 1_250_000);
  assert.equal(Money.parse('12500.5').minor, 1_250_050);
  assert.equal(Money.parse('12500.50').minor, 1_250_050);
  assert.equal(Money.parse('-4000').minor, -400_000);
});

test('money: parse rejects junk', () => {
  assert.throws(() => Money.parse(''));
  assert.throws(() => Money.parse('12.500')); // three decimals
  assert.throws(() => Money.parse('12,5.00.1'));
  assert.throws(() => Money.parse('abc'));
  assert.throws(() => Money.parse('12 5OO')); // letter O
});

test('money: arithmetic and comparison', () => {
  const a = Money.fromShillings(8_000);
  const b = Money.fromShillings(12_000);
  assert.equal(b.sub(a).format(), 'KSh 4,000');
  assert.equal(a.add(b).format(), 'KSh 20,000');
  assert.equal(a.compareTo(b), -1);
  assert.ok(a.negated().isNegative);
});

test('money: negative balances format with a leading minus', () => {
  assert.equal(Money.fromMinor(-120_000).format(), '-KSh 1,200');
  assert.equal(Money.fromMinor(-120_000).formatPlain(), '-1,200');
});

test('money: rejects unsafe values', () => {
  assert.throws(() => Money.fromMinor(1.5));
  assert.throws(() => Money.fromMinor(Number.NaN));
  assert.throws(() => Money.fromMinor(Infinity));
  assert.throws(() => Money.fromMinor(10 ** 15));
});

test('money: thousands separators scale', () => {
  assert.equal(Money.fromShillings(123_456_789).format(), 'KSh 123,456,789');
  assert.equal(Money.fromShillings(0).format(), 'KSh 0');
});
