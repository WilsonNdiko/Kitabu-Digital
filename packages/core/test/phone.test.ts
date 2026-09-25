import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatKenyanMobile, isValidKenyanMobile, normalizeKenyanMobile } from '../src/foundation/phone.ts';

test('phone: normalizes every common Kenyan mobile format to E.164', () => {
  const expected = '+254712345678';
  assert.equal(normalizeKenyanMobile('+254712345678'), expected);
  assert.equal(normalizeKenyanMobile('254712345678'), expected);
  assert.equal(normalizeKenyanMobile('0712345678'), expected);
  assert.equal(normalizeKenyanMobile('712345678'), expected);
  assert.equal(normalizeKenyanMobile('0712 345 678'), expected);
  assert.equal(normalizeKenyanMobile('0712-345-678'), expected);
  assert.equal(normalizeKenyanMobile('(0712) 345678'), expected);
  assert.equal(normalizeKenyanMobile(' 712345678 '), expected);
});

test('phone: 01xx numbers (new-style prefixes) normalize', () => {
  assert.equal(normalizeKenyanMobile('0110123456'), '+254110123456');
  assert.equal(normalizeKenyanMobile('110123456'), '+254110123456');
});

test('phone: invalid inputs return null', () => {
  assert.equal(normalizeKenyanMobile(''), null);
  assert.equal(normalizeKenyanMobile('71234567'), null); // too short
  assert.equal(normalizeKenyanMobile('07123456789'), null); // too long
  assert.equal(normalizeKenyanMobile('0201234567'), null); // landline
  assert.equal(normalizeKenyanMobile('abc'), null);
  assert.equal(normalizeKenyanMobile('+2547123456a'), null);
  assert.equal(normalizeKenyanMobile('+1 555 010 1234'), null); // foreign
});

test('phone: isValidKenyanMobile', () => {
  assert.ok(isValidKenyanMobile('0712345678'));
  assert.ok(!isValidKenyanMobile('0201234567'));
});

test('phone: display formatting', () => {
  assert.equal(formatKenyanMobile('+254712345678'), '0712 345 678');
  assert.equal(formatKenyanMobile('+254110123456'), '0110 123 456');
  assert.equal(formatKenyanMobile('+15550101234'), '+15550101234'); // pass-through
});
