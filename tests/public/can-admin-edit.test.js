// Unit tests for canAdminEdit() — the client-side gate that decides whether
// the admin activity-feed expansion shows the "✎ Edit fields" affordance
// for a labour/expense row. Must mirror the server's assertEditable rules
// (src/lib/route-helpers.js): pending/rejected always editable by admin,
// approved editable only by the approving admin, closed-period always
// locked, non-admins never see the affordance.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canAdminEdit } from '../../public/api.js';

const admin1 = { id: 1, role: 'admin' };
const admin2 = { id: 2, role: 'admin' };
const employee = { id: 7, role: 'employee' };

test('canAdminEdit: pending + admin + open period → true', () => {
  const entry = { status: 'pending', period_status: 'open', reviewed_by_user_id: null };
  assert.equal(canAdminEdit(entry, admin1), true);
});

test('canAdminEdit: rejected + admin + open period → true (PATCH reverts to pending)', () => {
  const entry = { status: 'rejected', period_status: 'open', reviewed_by_user_id: admin1.id };
  assert.equal(canAdminEdit(entry, admin1), true);
});

test('canAdminEdit: approved by THIS admin + open period → true (fix-own-typo path)', () => {
  const entry = { status: 'approved', period_status: 'open', reviewed_by_user_id: admin1.id };
  assert.equal(canAdminEdit(entry, admin1), true);
});

test('canAdminEdit: approved by a DIFFERENT admin → false', () => {
  const entry = { status: 'approved', period_status: 'open', reviewed_by_user_id: admin2.id };
  assert.equal(canAdminEdit(entry, admin1), false);
});

test('canAdminEdit: any status + closed period → false', () => {
  const pending = { status: 'pending', period_status: 'closed', reviewed_by_user_id: null };
  const rejected = { status: 'rejected', period_status: 'closed', reviewed_by_user_id: admin1.id };
  const approved = { status: 'approved', period_status: 'closed', reviewed_by_user_id: admin1.id };
  assert.equal(canAdminEdit(pending, admin1), false);
  assert.equal(canAdminEdit(rejected, admin1), false);
  assert.equal(canAdminEdit(approved, admin1), false);
});

test('canAdminEdit: non-admin (employee role) → always false', () => {
  const entry = { status: 'pending', period_status: 'open', reviewed_by_user_id: null };
  assert.equal(canAdminEdit(entry, employee), false);
});

test('canAdminEdit: missing currentUser or entry → false', () => {
  const entry = { status: 'pending', period_status: 'open', reviewed_by_user_id: null };
  assert.equal(canAdminEdit(entry, null), false);
  assert.equal(canAdminEdit(entry, undefined), false);
  assert.equal(canAdminEdit(null, admin1), false);
  assert.equal(canAdminEdit(undefined, admin1), false);
});

test('canAdminEdit: unknown status (defensive) → false', () => {
  const entry = { status: 'draft', period_status: 'open' };
  assert.equal(canAdminEdit(entry, admin1), false);
});

// --- Same shape as lockReason cases ---------------------------------------
// The spec asks that canAdminEdit's decision shape matches lockReason for
// the cases it covers. lockReason returns null when editable, a string
// reason otherwise. For an admin, canAdminEdit === true SHOULD imply
// lockReason returns null on that same entry (modulo the "approved" case
// where the server-side admin-self-approved exception is permitted but
// lockReason still flags it as 'approved' — that case is checked
// separately, not via this parity assertion).
import { lockReason } from '../../public/api.js';

test('canAdminEdit parity with lockReason for non-approved cases', () => {
  const pendingOpen = { status: 'pending', period_status: 'open' };
  const rejectedOpen = { status: 'rejected', period_status: 'open' };
  const pendingClosed = { status: 'pending', period_status: 'closed' };

  assert.equal(canAdminEdit(pendingOpen, admin1), lockReason(pendingOpen) === null);
  assert.equal(canAdminEdit(rejectedOpen, admin1), lockReason(rejectedOpen) === null);
  assert.equal(canAdminEdit(pendingClosed, admin1), lockReason(pendingClosed) === null);
});
