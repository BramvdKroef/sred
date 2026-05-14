// Integration tests for the admin-edits-their-own-approved-entry flow.
//
// Background: admin-logged labour and expense entries are auto-approved at
// POST time (the admin is also the reviewer). Previously assertEditable
// then locked the entry from PATCH, forcing admins to reject → edit →
// re-approve just to fix a typo on their own row.
//
// Fix: assertEditable now allows the approving admin to PATCH their own
// approved entry, and the PATCH handler reverts the row to pending (clears
// reviewed_by_user_id / reviewed_at) — mirroring the existing rejected →
// pending precedent. The change still has to be re-approved deliberately.
//
// What we assert here:
//   - Admin POSTs labour → status='approved', reviewed_by_user_id is admin.
//   - Admin PATCHes that labour → succeeds (200), status='pending',
//     reviewed_by_user_id / reviewed_at are cleared, the edited field
//     reflects the new value.
//   - Same flow for expenses.
//   - A *different* admin (not the original approver) is still blocked
//     from PATCHing the approved row — assertEditable only relaxes for
//     the approving admin themselves.

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
} from '../helpers/db.js';

let ctx;
let server;
let baseUrl;
let adminToken;
let otherAdminToken;
let adminUcId;
let projectId;

before(async () => {
  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  const claimantId = insertClaimant(ctx.db, { legal_name: 'AdminEdit Co' });
  insertFiscalPeriod(ctx.db, claimantId, {
    start_date: '2025-01-01', end_date: '2025-12-31', status: 'open',
  });

  const adminId = insertUser(ctx.db, {
    role: 'admin', status: 'active', email: 'admin-edit@example.com',
  });
  adminUcId = insertUserClaimant(ctx.db, adminId, claimantId);
  // Comp row needed because the labour cost calc joins through it; not
  // strictly required for POST/PATCH validation but keeps the fixture
  // realistic and lets a hypothetical T661 step succeed if added later.
  insertCompRow(ctx.db, adminUcId, {
    comp_type: 'salary', amount_cents: 12_000_000, hours_per_year: 2080,
    effective_from: '2025-01-01',
  });

  // A second admin who did not approve the entries; should remain locked
  // out of PATCH against the first admin's approved rows.
  const otherAdminId = insertUser(ctx.db, {
    role: 'admin', status: 'active', email: 'other-admin@example.com',
  });
  insertUserClaimant(ctx.db, otherAdminId, claimantId);

  projectId = insertProject(ctx.db, claimantId, { title: 'AdminEdit Project' });

  adminToken = signSession({ id: adminId, role: 'admin' });
  otherAdminToken = signSession({ id: otherAdminId, role: 'admin' });

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

async function callApi({ method, path, body, token }) {
  const init = {
    method,
    headers: { Authorization: `Bearer ${token}` },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('admin can PATCH their own auto-approved labour; row reverts to pending', async () => {
  const created = await callApi({
    method: 'POST', path: '/api/labour', token: adminToken,
    body: {
      project_id: projectId,
      user_claimant_id: adminUcId,
      work_date: '2025-04-15',
      hours: 5,
      description: 'typoed desription',
    },
  });
  assert.equal(created.status, 201, `expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
  assert.equal(created.body.status, 'approved');
  assert.ok(created.body.reviewed_by_user_id, 'admin-logged labour should record reviewer');

  const id = created.body.id;
  const patched = await callApi({
    method: 'PATCH', path: `/api/labour/${id}`, token: adminToken,
    body: { description: 'fixed description' },
  });
  assert.equal(patched.status, 200,
    `expected 200, got ${patched.status}: ${JSON.stringify(patched.body)}`);
  assert.equal(patched.body.description, 'fixed description');
  assert.equal(patched.body.status, 'pending', 'PATCH must revert approved→pending');
  assert.equal(patched.body.reviewed_by_user_id, null);
  assert.equal(patched.body.reviewed_at, null);
});

test('admin can PATCH their own auto-approved expense; row reverts to pending', async () => {
  const created = await callApi({
    method: 'POST', path: '/api/expenses', token: adminToken,
    body: {
      project_id: projectId,
      user_claimant_id: adminUcId,
      expense_date: '2025-04-15',
      category: 'material',
      amount_cents: 5_000,
      currency: 'CAD',
      description: 'typoed expense',
    },
  });
  assert.equal(created.status, 201, `expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
  assert.equal(created.body.status, 'approved');

  const id = created.body.id;
  const patched = await callApi({
    method: 'PATCH', path: `/api/expenses/${id}`, token: adminToken,
    body: { description: 'fixed expense', amount_cents: 6_500 },
  });
  assert.equal(patched.status, 200,
    `expected 200, got ${patched.status}: ${JSON.stringify(patched.body)}`);
  assert.equal(patched.body.description, 'fixed expense');
  assert.equal(patched.body.amount_cents, 6_500);
  assert.equal(patched.body.status, 'pending');
  assert.equal(patched.body.reviewed_by_user_id, null);
  assert.equal(patched.body.reviewed_at, null);
});

test('a different admin still cannot PATCH the approving admin\'s approved row', async () => {
  // First, create + approve a fresh labour row owned by the original admin.
  const created = await callApi({
    method: 'POST', path: '/api/labour', token: adminToken,
    body: {
      project_id: projectId,
      user_claimant_id: adminUcId,
      work_date: '2025-04-16',
      hours: 3,
      description: 'only the original admin can edit this',
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'approved');

  // A different admin attempts to PATCH it — assertEditable should still
  // throw badRequest because reviewed_by_user_id !== this admin's id.
  const patched = await callApi({
    method: 'PATCH', path: `/api/labour/${created.body.id}`, token: otherAdminToken,
    body: { description: 'cannot do this' },
  });
  assert.equal(patched.status, 400,
    `expected 400, got ${patched.status}: ${JSON.stringify(patched.body)}`);
  assert.match(patched.body.error?.message || '', /approved/i);
});
