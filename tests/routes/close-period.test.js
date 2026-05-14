// Route-level integration tests for src/routes/periods.js.
//
// Verifies that closing a fiscal period locks all labour / expense / evidence
// rows in that period — both PATCH and DELETE on each kind return 4xx with a
// "period closed" error — and that reopening unlocks them again. Also asserts
// that close/reopen each write an audit_log row.
//
// Strategy mirrors tests/routes/evidence-upload.test.js: stand up the real
// express app on a random port via setupTempDb, mint admin and employee
// JWTs with signSession, drive requests via fetch.
//
// All tests share one set of seeded fixtures and run in declaration order:
// the period state machine (open → close → patch-blocked → delete-blocked
// → reopen → patches-work-again) is driven across consecutive tests rather
// than per-test reset.

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
let adminToken;
let employeeToken;
let periodId;
let labourId;
let expenseId;
let evidenceId;

before(async () => {
  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  // Seed: claimant + period + employee + comp + project + one each labour /
  // expense / evidence row (all 'pending' so assertEditable's approved-lock
  // branch isn't what blocks the PATCH/DELETE after close).
  const claimantId = insertClaimant(ctx.db);
  periodId = insertFiscalPeriod(ctx.db, claimantId, {
    start_date: '2025-01-01', end_date: '2025-12-31', status: 'open',
  });

  const adminId = insertUser(ctx.db, {
    role: 'admin', status: 'active', email: 'admin-close@example.com',
  });
  insertUserClaimant(ctx.db, adminId, claimantId);

  const empId = insertUser(ctx.db, {
    role: 'employee', status: 'active', email: 'emp-close@example.com',
  });
  const ucId = insertUserClaimant(ctx.db, empId, claimantId);
  insertCompRow(ctx.db, ucId, {
    comp_type: 'salary', amount_cents: 10_400_000, hours_per_year: 2080,
    effective_from: '2025-01-01',
  });

  const projectId = insertProject(ctx.db, claimantId, { title: 'Project Close' });

  labourId = insertLabourEntry(ctx.db, projectId, ucId, periodId, {
    work_date: '2025-03-15', hours: 4, description: 'before-close', status: 'pending',
  });
  expenseId = insertExpense(ctx.db, projectId, ucId, periodId, {
    expense_date: '2025-03-15', category: 'material', amount_cents: 5_000,
    description: 'lab consumables', status: 'pending',
  });
  const evInfo = ctx.db.prepare(`
    INSERT INTO evidence_items
      (project_id, fiscal_period_id, uploaded_by_user_id,
       kind, caption, evidence_date, note_text)
    VALUES (?, ?, ?, 'note', ?, '2025-03-15', ?)
  `).run(projectId, periodId, empId, 'note before close', 'evidence body');
  evidenceId = evInfo.lastInsertRowid;

  adminToken    = signSession({ id: adminId, role: 'admin' });
  employeeToken = signSession({ id: empId, role: 'employee' });

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

// --- helpers ---------------------------------------------------------------

async function req(method, path, { token = adminToken, body } = {}) {
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

function getPeriodStatus() {
  return ctx.db.prepare(`SELECT status FROM fiscal_periods WHERE id = ?`).get(periodId).status;
}

function countAuditRows(action) {
  return ctx.db.prepare(
    `SELECT COUNT(*) AS n FROM audit_log WHERE action = ?`
  ).get(action).n;
}

function assertClosedError(r, label) {
  assert.ok(r.status >= 400 && r.status < 500,
    `${label}: expected 4xx, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.match(
    r.body.error.message, /period.*closed|closed.*period|retained/i,
    `${label}: error message should mention closed period, got: ${r.body.error.message}`,
  );
}

// --- tests -----------------------------------------------------------------
//
// These tests share state by design (the period state machine is the
// subject), so they run in declaration order. Each test name describes its
// transition.

test('open period: labour PATCH succeeds (sanity)', async () => {
  assert.equal(getPeriodStatus(), 'open');
  const r = await req('PATCH', `/api/labour/${labourId}`, {
    token: employeeToken, body: { description: 'still open' },
  });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
});

test('POST /api/periods/:id/close transitions the period to closed and writes a close_period audit row', async () => {
  const before = countAuditRows('close_period');
  const r = await req('POST', `/api/periods/${periodId}/close`);
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.status, 'closed');
  assert.equal(getPeriodStatus(), 'closed');
  assert.equal(countAuditRows('close_period'), before + 1);
});

test('PATCH /api/labour/:id is blocked while the period is closed', async () => {
  const r = await req('PATCH', `/api/labour/${labourId}`, {
    token: employeeToken, body: { description: 'should be blocked' },
  });
  assertClosedError(r, 'labour PATCH after close');
});

test('PATCH /api/expenses/:id is blocked while the period is closed', async () => {
  const r = await req('PATCH', `/api/expenses/${expenseId}`, {
    token: employeeToken, body: { description: 'should be blocked' },
  });
  assertClosedError(r, 'expense PATCH after close');
});

test('PATCH /api/evidence/:id is blocked while the period is closed', async () => {
  const r = await req('PATCH', `/api/evidence/${evidenceId}`, {
    token: employeeToken, body: { caption: 'should be blocked' },
  });
  assertClosedError(r, 'evidence PATCH after close');
});

test('DELETE /api/labour/:id is blocked while the period is closed', async () => {
  const r = await req('DELETE', `/api/labour/${labourId}`, { token: employeeToken });
  assertClosedError(r, 'labour DELETE after close');
  assert.ok(ctx.db.prepare(`SELECT 1 FROM labour_entries WHERE id = ?`).get(labourId),
    'labour row must survive blocked DELETE');
});

test('DELETE /api/expenses/:id is blocked while the period is closed', async () => {
  const r = await req('DELETE', `/api/expenses/${expenseId}`, { token: employeeToken });
  assertClosedError(r, 'expense DELETE after close');
  assert.ok(ctx.db.prepare(`SELECT 1 FROM expenses WHERE id = ?`).get(expenseId),
    'expense row must survive blocked DELETE');
});

test('DELETE /api/evidence/:id is blocked while the period is closed', async () => {
  const r = await req('DELETE', `/api/evidence/${evidenceId}`, { token: employeeToken });
  assertClosedError(r, 'evidence DELETE after close');
  assert.ok(ctx.db.prepare(`SELECT 1 FROM evidence_items WHERE id = ?`).get(evidenceId),
    'evidence row must survive blocked DELETE');
});

test('POST /api/periods/:id/reopen transitions the period back to open and writes a reopen_period audit row', async () => {
  const before = countAuditRows('reopen_period');
  const r = await req('POST', `/api/periods/${periodId}/reopen`);
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.status, 'open');
  assert.equal(getPeriodStatus(), 'open');
  assert.equal(countAuditRows('reopen_period'), before + 1);
});

test('after reopen, PATCH on labour/expense/evidence succeeds again', async () => {
  const labour = await req('PATCH', `/api/labour/${labourId}`, {
    token: employeeToken, body: { description: 'works again' },
  });
  assert.equal(labour.status, 200);
  assert.equal(labour.body.description, 'works again');

  const expense = await req('PATCH', `/api/expenses/${expenseId}`, {
    token: employeeToken, body: { description: 'works again' },
  });
  assert.equal(expense.status, 200);
  assert.equal(expense.body.description, 'works again');

  const evidence = await req('PATCH', `/api/evidence/${evidenceId}`, {
    token: employeeToken, body: { caption: 'works again' },
  });
  assert.equal(evidence.status, 200);
  assert.equal(evidence.body.caption, 'works again');
});
