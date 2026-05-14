// Tests for src/routes/labour.js and src/routes/expenses.js — GET / list
// responses now expose the joined project title + employee name/email
// alongside the existing fields, so the admin review queue can render
// human-readable columns without an extra round-trip.
//
// UC-R1 (sub-task 1): the review queue was rendering raw `project_id` and
// `user_claimant_id` numbers. The list endpoints now additively include
// `project_title`, `user_name`, and `user_email`. Existing fields are
// untouched — other tabs (employee My-activity, etc.) keep working.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  setupTempDb,
  teardownTempDb,
  insertUser,
  insertClaimant,
  insertFiscalPeriod,
  insertUserClaimant,
  insertProject,
  insertLabourEntry,
  insertExpense,
} from '../helpers/db.js';

let ctx;
let server;
let baseUrl;
let adminToken;
let projectId;
let employeeName;
let employeeEmail;
let projectTitle;
let userClaimantId;

before(async () => {
  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  const adminId = insertUser(ctx.db, {
    role: 'admin', status: 'active', email: 'admin-list@example.com', name: 'Admin Person',
  });
  employeeEmail = 'employee-list@example.com';
  employeeName = 'Eve Mployee';
  const employeeId = insertUser(ctx.db, {
    role: 'employee', status: 'active', email: employeeEmail, name: employeeName,
  });
  const claimantId = insertClaimant(ctx.db);
  const periodId = insertFiscalPeriod(ctx.db, claimantId, {
    start_date: '2025-01-01', end_date: '2025-12-31', status: 'open',
  });
  insertUserClaimant(ctx.db, adminId, claimantId);
  userClaimantId = insertUserClaimant(ctx.db, employeeId, claimantId);
  projectTitle = 'Quantum Widget Research';
  projectId = insertProject(ctx.db, claimantId, { title: projectTitle });

  insertLabourEntry(ctx.db, projectId, userClaimantId, periodId, {
    work_date: '2025-03-15', hours: 4, description: 'pending labour', status: 'pending',
  });
  insertExpense(ctx.db, projectId, userClaimantId, periodId, {
    expense_date: '2025-03-15', amount_cents: 12345, description: 'pending expense', status: 'pending',
  });

  adminToken = signSession({ id: adminId, role: 'admin' });

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

test('GET /api/labour exposes project_title, user_name, and user_email alongside the legacy fields', async () => {
  const res = await fetch(`${baseUrl}/api/labour?status=pending`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.items.length, 1);
  const row = body.items[0];

  // New fields are present and joined correctly.
  assert.equal(row.project_title, projectTitle);
  assert.equal(row.user_name, employeeName);
  assert.equal(row.user_email, employeeEmail);

  // Existing fields are NOT renamed — additive only (other tabs depend on
  // these field names verbatim).
  assert.equal(row.project_id, projectId);
  assert.equal(row.user_claimant_id, userClaimantId);
  assert.equal(row.status, 'pending');
  assert.equal(row.hours, 4);
});

test('GET /api/expenses exposes project_title, user_name, and user_email alongside the legacy fields', async () => {
  const res = await fetch(`${baseUrl}/api/expenses?status=pending`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.items.length, 1);
  const row = body.items[0];

  assert.equal(row.project_title, projectTitle);
  assert.equal(row.user_name, employeeName);
  assert.equal(row.user_email, employeeEmail);

  assert.equal(row.project_id, projectId);
  assert.equal(row.user_claimant_id, userClaimantId);
  assert.equal(row.status, 'pending');
  assert.equal(row.amount_cents, 12345);
});
