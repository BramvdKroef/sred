// Unit tests for the lockReason() pure helper that drives the "approved /
// period closed / locked" distinction in the employee activity table.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lockReason } from '../../public/api.js';

test('lockReason: pending entry in open period → null (editable)', () => {
  assert.equal(lockReason({ status: 'pending' }, { status: 'open' }), null);
});

test('lockReason: rejected entry in open period → null (server allows re-edit)', () => {
  // Rejected entries are editable; PATCH on the server clears the rejection
  // and moves them back to pending. The lock badge should not appear.
  assert.equal(lockReason({ status: 'rejected' }, { status: 'open' }), null);
});

test('lockReason: approved entry → "approved"', () => {
  assert.equal(lockReason({ status: 'approved' }, { status: 'open' }), 'approved');
});

test('lockReason: pending entry in closed period → "period closed"', () => {
  assert.equal(lockReason({ status: 'pending' }, { status: 'closed' }), 'period closed');
});

test('lockReason: approved beats period closed (deterministic ordering)', () => {
  // If both apply, prefer "approved" — it's the more specific reason.
  assert.equal(lockReason({ status: 'approved' }, { status: 'closed' }), 'approved');
});

test('lockReason: reads period_status off the entry when no period arg', () => {
  assert.equal(lockReason({ status: 'pending', period_status: 'closed' }), 'period closed');
  assert.equal(lockReason({ status: 'pending', period_status: 'open' }), null);
});

test('lockReason: entry arg only, no period info → null', () => {
  assert.equal(lockReason({ status: 'pending' }), null);
});

test('lockReason: tolerates undefined/null inputs', () => {
  assert.equal(lockReason(undefined), null);
  assert.equal(lockReason(null), null);
});
