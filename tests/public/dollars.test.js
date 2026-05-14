// Unit tests for the dollarsToCents() helper that backs the dollar-input
// usability fix. People were typing 9500000 into the old "Amount (cents)"
// box for a $95k salary; the helper accepts dollar strings and rounds to
// integer cents. Rendered-HTML tests are skipped — those are manual smoke
// tests in the spec.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dollarsToCents } from '../../public/api.js';

test('dollarsToCents: "100" → 10000', () => {
  assert.equal(dollarsToCents('100'), 10000);
});

test('dollarsToCents: "100.50" → 10050', () => {
  assert.equal(dollarsToCents('100.50'), 10050);
});

test('dollarsToCents: "1,234.56" strips commas → 123456', () => {
  assert.equal(dollarsToCents('1,234.56'), 123456);
});

test('dollarsToCents: empty string → null', () => {
  assert.equal(dollarsToCents(''), null);
});

test('dollarsToCents: null / undefined → null', () => {
  assert.equal(dollarsToCents(null), null);
  assert.equal(dollarsToCents(undefined), null);
});

test('dollarsToCents: "abc" → NaN', () => {
  assert.ok(Number.isNaN(dollarsToCents('abc')));
});

test('dollarsToCents: "-50" throws (negative not allowed)', () => {
  assert.throws(() => dollarsToCents('-50'), /negative/);
});

test('dollarsToCents: handles "$" and whitespace', () => {
  assert.equal(dollarsToCents(' $ 95,000 '), 9500000);
});

test('dollarsToCents: rounds to nearest cent (no float drift)', () => {
  // 0.1 + 0.2 is the classic float-precision case. Math.round in the helper
  // avoids 30.000000000000004 → 3000.0000000000005 → 3000.
  assert.equal(dollarsToCents('0.1'), 10);
  assert.equal(dollarsToCents('19.999'), 2000); // rounds up
});
