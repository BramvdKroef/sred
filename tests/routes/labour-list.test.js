// Tests for src/routes/labour.js, src/routes/expenses.js, and
// src/routes/evidence.js — the GET list endpoints must return
// `claimant_name` so the employee My-activity tab can show a Claimant
// column per row (UC-E4).
//
// Strategy mirrors evidence-upload.test.js: stand up the real express
// app on a random port, seed two claimants + one user attached to
// both, insert one labour / expense / evidence row per claimant, then
// GET each list endpoint as that user and assert `claimant_name` is
// populated and matches the row's project's claimant.

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
let userToken;
let claimantAId, claimantBId;

before(async () => {
  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  // Two claimants with distinctive names so we can assert the join is
  // mapping each row to the right one.
  claimantAId = insertClaimant(ctx.db, { legal_name: 'Acme Alpha Ltd', business_number: '111111111RC0001' });
  claimantBId = insertClaimant(ctx.db, { legal_name: 'Beta Boundless Inc', business_number: '222222222RC0001' });

  const periodAId = insertFiscalPeriod(ctx.db, claimantAId);
  const periodBId = insertFiscalPeriod(ctx.db, claimantBId);

  const userId = insertUser(ctx.db, { email: 'multi-claimant@example.com' });
  const ucAId = insertUserClaimant(ctx.db, userId, claimantAId);
  const ucBId = insertUserClaimant(ctx.db, userId, claimantBId);

  const projectAId = insertProject(ctx.db, claimantAId, { title: 'Project A' });
  const projectBId = insertProject(ctx.db, claimantBId, { title: 'Project B' });

  insertLabourEntry(ctx.db, projectAId, ucAId, periodAId, { description: 'work on A' });
  insertLabourEntry(ctx.db, projectBId, ucBId, periodBId, { description: 'work on B' });

  insertExpense(ctx.db, projectAId, ucAId, periodAId, { description: 'expense for A' });
  insertExpense(ctx.db, projectBId, ucBId, periodBId, { description: 'expense for B' });

  // Evidence has no `insertEvidence` helper — write it directly.
  ctx.db.prepare(`
    INSERT INTO evidence_items
      (project_id, fiscal_period_id, uploaded_by_user_id,
       kind, caption, evidence_date, note_text)
    VALUES (?, ?, ?, 'note', ?, '2025-03-15', ?)
  `).run(projectAId, periodAId, userId, 'note for A', 'body A');
  ctx.db.prepare(`
    INSERT INTO evidence_items
      (project_id, fiscal_period_id, uploaded_by_user_id,
       kind, caption, evidence_date, note_text)
    VALUES (?, ?, ?, 'note', ?, '2025-03-15', ?)
  `).run(projectBId, periodBId, userId, 'note for B', 'body B');

  userToken = signSession({ id: userId, role: 'employee' });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRouter);
  app.use(errorMiddleware);

  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  teardownTempDb(ctx);
});

async function getList(path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  return (await res.json()).items;
}

test('GET /api/labour returns claimant_name per row', async () => {
  const items = await getList('/api/labour');
  assert.equal(items.length, 2);
  for (const row of items) {
    assert.ok(row.claimant_name, `row ${row.id} is missing claimant_name`);
  }
  // Make sure the join wasn't cross-wired — each row's claimant_name
  // must match the description we used as a tracer above.
  const byDesc = Object.fromEntries(items.map(r => [r.description, r.claimant_name]));
  assert.equal(byDesc['work on A'], 'Acme Alpha Ltd');
  assert.equal(byDesc['work on B'], 'Beta Boundless Inc');
});

test('GET /api/expenses returns claimant_name per row', async () => {
  const items = await getList('/api/expenses');
  assert.equal(items.length, 2);
  const byDesc = Object.fromEntries(items.map(r => [r.description, r.claimant_name]));
  assert.equal(byDesc['expense for A'], 'Acme Alpha Ltd');
  assert.equal(byDesc['expense for B'], 'Beta Boundless Inc');
});

test('GET /api/evidence returns claimant_name per row', async () => {
  const items = await getList('/api/evidence');
  assert.equal(items.length, 2);
  const byCaption = Object.fromEntries(items.map(r => [r.caption, r.claimant_name]));
  assert.equal(byCaption['note for A'], 'Acme Alpha Ltd');
  assert.equal(byCaption['note for B'], 'Beta Boundless Inc');
});
