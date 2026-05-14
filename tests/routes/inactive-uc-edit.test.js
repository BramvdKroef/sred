// Tests for the S-3 fix in src/lib/route-helpers.js: isOwnerOrAdmin must
// also check user_claimants.status, so an employee whose attachment was
// flipped to 'inactive' can no longer mutate their existing rows even if
// their JWT is still valid (the user-level `disabled` gate is enforced in
// requireAuth, but the per-attachment status had no enforcement on the
// mutation path before this fix).
//
// We also assert the list-endpoint visibility filter: GET /api/labour and
// GET /api/expenses scope non-admin callers to ACTIVE attachments, so a
// rolled-off employee no longer sees their old rows in the list either.
//
// Strategy: stand up the real express app, seed an employee + active uc +
// one approved labour entry on an OPEN period. Flip uc.status to 'inactive'
// and confirm:
//   - PATCH /api/labour/:id returns 403 (was 200 before the fix).
//   - DELETE /api/labour/:id returns 403.
//   - GET /api/labour returns zero items for that employee.
// A control case (uc still active) PATCHes successfully — the same fixture
// shape that worked before the fix still works, so we know we haven't
// over-tightened.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  setupTempDb,
  teardownTempDb,
  insertUser,
  insertClaimant,
  insertFiscalPeriod,
  insertUserClaimant,
  insertCompRow,
  insertProject,
  insertLabourEntry,
  insertExpense,
} from '../helpers/db.js';

let ctx;
let server;
let baseUrl;
let employeeToken;
let employeeId;
let ucId;
let labourEntryId;
let expenseId;
let controlLabourId;
let controlUcId;

before(async () => {
  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  const claimantId = insertClaimant(ctx.db, { legal_name: 'Inactive UC Co' });
  const periodId = insertFiscalPeriod(ctx.db, claimantId, {
    start_date: '2025-01-01', end_date: '2025-12-31', status: 'open',
  });

  employeeId = insertUser(ctx.db, {
    role: 'employee', status: 'active', email: 'rolled-off@example.com',
  });
  ucId = insertUserClaimant(ctx.db, employeeId, claimantId); // active by default
  insertCompRow(ctx.db, ucId);

  const projectId = insertProject(ctx.db, claimantId, { title: 'P-inactive' });

  // Pending rows because assertEditable would already block an approved
  // employee row; we want the test to fail-or-pass on isOwnerOrAdmin alone.
  labourEntryId = insertLabourEntry(ctx.db, projectId, ucId, periodId, {
    description: 'will be patched after deactivation', status: 'pending',
  });
  expenseId = insertExpense(ctx.db, projectId, ucId, periodId, {
    description: 'will be patched after deactivation', status: 'pending',
  });

  // Control: a second claimant with an active attachment. PATCHing rows on
  // THIS attachment must still succeed — proves we narrowed by status
  // rather than by user/claimant pair.
  const controlClaimantId = insertClaimant(ctx.db, {
    legal_name: 'Still-active Co', business_number: '999999999RC0001',
  });
  const controlPeriodId = insertFiscalPeriod(ctx.db, controlClaimantId, {
    start_date: '2025-01-01', end_date: '2025-12-31', status: 'open',
  });
  controlUcId = insertUserClaimant(ctx.db, employeeId, controlClaimantId);
  insertCompRow(ctx.db, controlUcId);
  const controlProjectId = insertProject(ctx.db, controlClaimantId, { title: 'P-control' });
  controlLabourId = insertLabourEntry(ctx.db, controlProjectId, controlUcId, controlPeriodId, {
    description: 'should still be editable', status: 'pending',
  });

  employeeToken = signSession({ id: employeeId, role: 'employee' });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRouter);
  app.use(errorMiddleware);

  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  teardownTempDb(ctx);
});

test('control: employee can PATCH labour row on an ACTIVE attachment', async () => {
  // Sanity baseline so a later test failure on the inactive case can't be
  // attributed to broken plumbing.
  const res = await fetch(`${baseUrl}/api/labour/${controlLabourId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${employeeToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ description: 'edited while attachment is active' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.description, 'edited while attachment is active');
});

test('PATCH /api/labour/:id is forbidden once user_claimant.status flips to inactive', async () => {
  // Flip the attachment to inactive — the user-level `users.status` stays
  // 'active', so requireAuth still admits the request. The only gate left
  // is isOwnerOrAdmin, which we just taught about uc.status.
  ctx.db.prepare(`UPDATE user_claimants SET status = 'inactive' WHERE id = ?`).run(ucId);

  const res = await fetch(`${baseUrl}/api/labour/${labourEntryId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${employeeToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ description: 'should not be allowed' }),
  });
  assert.equal(res.status, 403, `expected 403, got ${res.status}`);

  // And the row in the DB is unchanged — proves the PATCH didn't slip
  // through before we checked the response code.
  const row = ctx.db.prepare(`SELECT description FROM labour_entries WHERE id = ?`).get(labourEntryId);
  assert.equal(row.description, 'will be patched after deactivation');
});

test('DELETE /api/labour/:id is forbidden once user_claimant.status flips to inactive', async () => {
  const res = await fetch(`${baseUrl}/api/labour/${labourEntryId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${employeeToken}` },
  });
  assert.equal(res.status, 403, `expected 403, got ${res.status}`);
  const stillThere = ctx.db.prepare(
    `SELECT id FROM labour_entries WHERE id = ?`
  ).get(labourEntryId);
  assert.ok(stillThere, 'row must still exist after the forbidden DELETE');
});

test('PATCH /api/expenses/:id is forbidden once user_claimant.status flips to inactive', async () => {
  const res = await fetch(`${baseUrl}/api/expenses/${expenseId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${employeeToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ description: 'should not be allowed' }),
  });
  assert.equal(res.status, 403, `expected 403, got ${res.status}`);
});

test('GET /api/labour omits rows reached through an inactive attachment', async () => {
  // The employee's labour list must scope to ACTIVE attachments for
  // non-admins. The inactive-uc row should be filtered out; the
  // control-uc row should remain.
  const res = await fetch(`${baseUrl}/api/labour`, {
    headers: { Authorization: `Bearer ${employeeToken}` },
  });
  assert.equal(res.status, 200);
  const { items } = await res.json();
  const ids = items.map(r => r.id);
  assert.ok(!ids.includes(labourEntryId), 'inactive-uc labour row must not appear');
  assert.ok(ids.includes(controlLabourId), 'active-uc labour row must still appear');
});

test('GET /api/expenses omits rows reached through an inactive attachment', async () => {
  const res = await fetch(`${baseUrl}/api/expenses`, {
    headers: { Authorization: `Bearer ${employeeToken}` },
  });
  assert.equal(res.status, 200);
  const { items } = await res.json();
  const ids = items.map(r => r.id);
  assert.ok(!ids.includes(expenseId), 'inactive-uc expense row must not appear');
});
