// Unit tests for the periodTotals() reducer that backs the per-period
// summary card on the employee My-activity tab. The reducer takes the
// three lists already in state (labour, expenses, evidence) and computes:
//
// - Hours, split into approved vs pending sub-figures (rejected dropped).
// - Expense amount, in cents, bucketed per currency (mixed-currency
//   datasets aren't summed at face value; FX is per-row and may be null).
// - Evidence count.
//
// "All periods" vs a single-period filter is just a difference in what's
// in the input arrays — the reducer doesn't care. DOM tests are skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { periodTotals } from '../../public/employee/activity.js';

test('periodTotals: empty arrays → zero everything', () => {
  const t = periodTotals([], [], []);
  assert.equal(t.hours.approved, 0);
  assert.equal(t.hours.pending, 0);
  assert.deepEqual(t.amountByCurrency, {});
  assert.equal(t.evidenceCount, 0);
});

test('periodTotals: handles null/undefined input gracefully', () => {
  const t = periodTotals(undefined, null, undefined);
  assert.equal(t.hours.approved, 0);
  assert.equal(t.hours.pending, 0);
  assert.deepEqual(t.amountByCurrency, {});
  assert.equal(t.evidenceCount, 0);
});

test('periodTotals: sums approved + pending hours, drops rejected', () => {
  const labour = [
    { hours: 8,    status: 'approved' },
    { hours: 4.5,  status: 'approved' },
    { hours: 2,    status: 'pending' },
    { hours: 6,    status: 'rejected' },  // must not contribute
  ];
  const t = periodTotals(labour, [], []);
  assert.equal(t.hours.approved, 12.5);
  assert.equal(t.hours.pending, 2);
});

test('periodTotals: expense amounts kept in cents, split by status', () => {
  const expenses = [
    { amount_cents: 10000, currency: 'CAD', status: 'approved' },
    { amount_cents: 2500,  currency: 'CAD', status: 'approved' },
    { amount_cents: 5000,  currency: 'CAD', status: 'pending'  },
    { amount_cents: 9999,  currency: 'CAD', status: 'rejected' }, // dropped
  ];
  const t = periodTotals([], expenses, []);
  assert.deepEqual(t.amountByCurrency, {
    CAD: { approved: 12500, pending: 5000 },
  });
});

test('periodTotals: mixed currencies bucket separately (no FX summation)', () => {
  const expenses = [
    { amount_cents: 10000, currency: 'CAD', status: 'approved' },
    { amount_cents: 8000,  currency: 'USD', status: 'approved' },
    { amount_cents: 1500,  currency: 'USD', status: 'pending'  },
    { amount_cents: 200,   currency: 'EUR', status: 'pending'  },
  ];
  const t = periodTotals([], expenses, []);
  assert.deepEqual(t.amountByCurrency, {
    CAD: { approved: 10000, pending: 0 },
    USD: { approved: 8000,  pending: 1500 },
    EUR: { approved: 0,     pending: 200 },
  });
});

test('periodTotals: missing currency defaults to CAD', () => {
  const expenses = [
    { amount_cents: 4200, currency: null, status: 'approved' },
    { amount_cents: 800,  status: 'pending' },  // no currency key at all
  ];
  const t = periodTotals([], expenses, []);
  assert.deepEqual(t.amountByCurrency, {
    CAD: { approved: 4200, pending: 800 },
  });
});

test('periodTotals: evidenceCount is the array length', () => {
  const evidence = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const t = periodTotals([], [], evidence);
  assert.equal(t.evidenceCount, 3);
});

test('periodTotals: mixed approved+pending across all three inputs', () => {
  const labour = [
    { hours: 7.5, status: 'approved' },
    { hours: 1.5, status: 'pending' },
  ];
  const expenses = [
    { amount_cents: 5000, currency: 'CAD', status: 'approved' },
    { amount_cents: 2000, currency: 'CAD', status: 'pending' },
    { amount_cents: 1000, currency: 'USD', status: 'pending' },
  ];
  const evidence = [{ id: 1 }, { id: 2 }];
  const t = periodTotals(labour, expenses, evidence);
  assert.equal(t.hours.approved, 7.5);
  assert.equal(t.hours.pending, 1.5);
  assert.deepEqual(t.amountByCurrency, {
    CAD: { approved: 5000, pending: 2000 },
    USD: { approved: 0,    pending: 1000 },
  });
  assert.equal(t.evidenceCount, 2);
});

test('periodTotals: tolerates string hours / amount_cents (parses to number)', () => {
  // Defensive: SQL number columns come through as JS numbers, but if a
  // future code path stringifies them the reducer should still cope.
  const labour   = [{ hours: '4.25', status: 'approved' }];
  const expenses = [{ amount_cents: '1500', currency: 'CAD', status: 'approved' }];
  const t = periodTotals(labour, expenses, []);
  assert.equal(t.hours.approved, 4.25);
  assert.equal(t.amountByCurrency.CAD.approved, 1500);
});
