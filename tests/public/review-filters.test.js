// Unit tests for buildListUrl(), the pure URL-builder behind the Review
// queue's filter dropdowns + claimant scoping. We pin the query-string shape
// so the labour/expense list endpoints get exactly the params they support
// (status, period_id, project_id, user_claimant_id, claimant_id).
//
// Driving the DOM (checkboxes, action bar, dropdown wiring) is left to manual
// smoke tests — there's no jsdom in package.json and the spec explicitly says
// not to add one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildListUrl } from '../../public/admin/review.js';

test('buildListUrl: empty filters → no query string', () => {
  assert.equal(buildListUrl('/api/labour', {}), '/api/labour');
});

test('buildListUrl: only empty / nullish values → no query string', () => {
  assert.equal(
    buildListUrl('/api/labour', { period_id: '', project_id: null, user_claimant_id: undefined }),
    '/api/labour'
  );
});

test('buildListUrl: single filter → one ?key=value param', () => {
  assert.equal(
    buildListUrl('/api/labour', { status: 'pending' }),
    '/api/labour?status=pending'
  );
});

test('buildListUrl: multiple filters joined with &', () => {
  const url = buildListUrl('/api/labour', {
    status: 'pending',
    claimant_id: 3,
    project_id: 7,
  });
  // Order follows Object.entries insertion order — pinning so the network
  // requests are deterministic for snapshot-style debugging.
  assert.equal(url, '/api/labour?status=pending&claimant_id=3&project_id=7');
});

test('buildListUrl: skips empty-string values but keeps populated ones', () => {
  const url = buildListUrl('/api/expenses', {
    status: 'pending',
    period_id: '',
    project_id: 12,
    employee_uc_id: '',
  });
  assert.equal(url, '/api/expenses?status=pending&project_id=12');
});

test('buildListUrl: percent-encodes special characters in values', () => {
  const url = buildListUrl('/api/labour', { q: 'a&b c' });
  assert.equal(url, '/api/labour?q=a%26b%20c');
});

test('buildListUrl: numeric and string values both serialize', () => {
  // Filters come in from <select> as strings; from state as numbers. The
  // helper must handle both without coercion surprises.
  assert.equal(
    buildListUrl('/api/labour', { claimant_id: 3 }),
    buildListUrl('/api/labour', { claimant_id: '3' })
  );
});
