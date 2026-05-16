// Cross-tenant isolation tests.
//
// The route-helpers unit suite covers resolveUserClaimant / isOwnerOrAdmin /
// assertAttached in isolation. This file proves they are actually wired in
// at every route — i.e. an employee attached only to claimant A cannot read
// or mutate claimant B's labour, expenses, or evidence via any HTTP path,
// and a global admin can still see both.
//
// Fixture:
//   - Claimant A ("Alpha Industries Ltd")  with project Pa, period FPa,
//     employee Alice owning labour/expense/evidence rows.
//   - Claimant B ("Bravo Holdings Inc")    with project Pb, period FPb,
//     employee Bob   owning labour/expense/evidence rows.
//   - Admin user (Carol) attached to neither claimant — exercises the
//     "admin sees both" branch through the role check alone.
//
// Alice's token drives every "must not access B" assertion. Bob's token
// is unused in assertions but Bob's rows exist so Alice has a concrete
// foreign target to probe.
//
// On expected status codes:
//   - PATCH/DELETE on a B-row as Alice  -> 403 (isOwnerOrAdmin → forbidden).
//   - GET on a B-row as Alice           -> 403 for labour/expense/evidence
//     (same helper). The 404 vs 403 distinction is asserted below — labour/
//     expense raise notFound first when the id is wrong, but on a real
//     foreign id they reach the isOwnerOrAdmin check and 403.
//   - POST against a B-project as Alice -> 403 (resolveUserClaimant or
//     assertAttached → forbidden).

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

// Tokens
let aliceToken, bobToken, adminToken;

// Claimant A side
let claimantAId, periodAId, projectAId, aliceUcId;
let labourAId, expenseAId, evidenceAId;

// Claimant B side
let claimantBId, periodBId, projectBId, bobUcId;
let labourBId, expenseBId, evidenceBId;

// Exports owned by each claimant (used by audit-log / exports tests)
let exportAId, exportBId;

async function call({ method, path, body, token }) {
  const init = {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { status: res.status, body: parsed };
}

before(async () => {
  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  // --- Claimant A ----------------------------------------------------------
  claimantAId = insertClaimant(ctx.db, {
    legal_name: 'Alpha Industries Ltd', business_number: '111111111RC0001',
  });
  periodAId = insertFiscalPeriod(ctx.db, claimantAId, {
    start_date: '2025-01-01', end_date: '2025-12-31', status: 'open',
  });
  projectAId = insertProject(ctx.db, claimantAId, { title: 'Alpha Project' });

  const aliceId = insertUser(ctx.db, {
    email: 'alice@example.com', role: 'employee', status: 'active', name: 'Alice A',
  });
  aliceUcId = insertUserClaimant(ctx.db, aliceId, claimantAId);
  insertCompRow(ctx.db, aliceUcId, {
    comp_type: 'salary', amount_cents: 10_000_000, hours_per_year: 2080,
    effective_from: '2025-01-01',
  });
  labourAId  = insertLabourEntry(ctx.db, projectAId, aliceUcId, periodAId, {
    work_date: '2025-03-15', hours: 4, description: 'A: labour entry', status: 'pending',
  });
  expenseAId = insertExpense(ctx.db, projectAId, aliceUcId, periodAId, {
    expense_date: '2025-03-16', category: 'material', amount_cents: 1234,
    currency: 'CAD', description: 'A: expense', status: 'pending',
  });
  // Note-kind evidence — file-kind would require multipart plumbing, and
  // the ownership check is identical across kinds.
  const evA = ctx.db.prepare(`
    INSERT INTO evidence_items
      (project_id, fiscal_period_id, uploaded_by_user_id, kind, caption, evidence_date, note_text)
    VALUES (?, ?, ?, 'note', ?, ?, ?)
  `).run(projectAId, periodAId, aliceId, 'A: evidence note', '2025-03-15', 'A note body');
  evidenceAId = evA.lastInsertRowid;

  // --- Claimant B ----------------------------------------------------------
  claimantBId = insertClaimant(ctx.db, {
    legal_name: 'Bravo Holdings Inc', business_number: '222222222RC0001',
  });
  periodBId = insertFiscalPeriod(ctx.db, claimantBId, {
    start_date: '2025-01-01', end_date: '2025-12-31', status: 'open',
  });
  projectBId = insertProject(ctx.db, claimantBId, { title: 'Bravo Project' });

  const bobId = insertUser(ctx.db, {
    email: 'bob@example.com', role: 'employee', status: 'active', name: 'Bob B',
  });
  bobUcId = insertUserClaimant(ctx.db, bobId, claimantBId);
  insertCompRow(ctx.db, bobUcId, {
    comp_type: 'salary', amount_cents: 10_000_000, hours_per_year: 2080,
    effective_from: '2025-01-01',
  });
  labourBId  = insertLabourEntry(ctx.db, projectBId, bobUcId, periodBId, {
    work_date: '2025-03-15', hours: 6, description: 'B: labour entry', status: 'pending',
  });
  expenseBId = insertExpense(ctx.db, projectBId, bobUcId, periodBId, {
    expense_date: '2025-03-16', category: 'material', amount_cents: 5678,
    currency: 'CAD', description: 'B: expense', status: 'pending',
  });
  const evB = ctx.db.prepare(`
    INSERT INTO evidence_items
      (project_id, fiscal_period_id, uploaded_by_user_id, kind, caption, evidence_date, note_text)
    VALUES (?, ?, ?, 'note', ?, ?, ?)
  `).run(projectBId, periodBId, bobId, 'B: evidence note', '2025-03-15', 'B note body');
  evidenceBId = evB.lastInsertRowid;

  // --- Admin ---------------------------------------------------------------
  const adminId = insertUser(ctx.db, {
    email: 'admin@example.com', role: 'admin', status: 'active', name: 'Carol Admin',
  });

  // --- T661 exports for each claimant (used by exports cross-tenant probe) -
  const exA = ctx.db.prepare(`
    INSERT INTO t661_exports
      (claimant_id, fiscal_period_id, generated_by_user_id, is_draft,
       totals_json, project_revisions_json, evidence_manifest_json)
    VALUES (?, ?, ?, 0, '{}', '[]', '[]')
  `).run(claimantAId, periodAId, adminId);
  exportAId = exA.lastInsertRowid;
  const exB = ctx.db.prepare(`
    INSERT INTO t661_exports
      (claimant_id, fiscal_period_id, generated_by_user_id, is_draft,
       totals_json, project_revisions_json, evidence_manifest_json)
    VALUES (?, ?, ?, 0, '{}', '[]', '[]')
  `).run(claimantBId, periodBId, adminId);
  exportBId = exB.lastInsertRowid;

  aliceToken = signSession({ id: aliceId, role: 'employee' });
  bobToken   = signSession({ id: bobId,   role: 'employee' });
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

// ---------------------------------------------------------------------------
// READ-SIDE ISOLATION
// ---------------------------------------------------------------------------

test('GET /api/labour as Alice returns only A-scoped rows', async () => {
  const r = await call({ method: 'GET', path: '/api/labour', token: aliceToken });
  assert.equal(r.status, 200);
  const ids = r.body.items.map(x => x.id);
  assert.ok(ids.includes(labourAId), 'expected A labour row');
  assert.ok(!ids.includes(labourBId), 'B labour row leaked into Alice view');
});

test('GET /api/labour?claimant_id=B as Alice still returns nothing from B (user filter dominates)', async () => {
  // The query exposes a `claimant_id` filter (the review-queue scope). For a
  // non-admin caller, the WHERE clause also pins `uc.user_id = req.user.id`,
  // so combining the two yields zero rows for a foreign claimant — Alice
  // is not attached to B, so no labour row joins through to her user id.
  const r = await call({
    method: 'GET', path: `/api/labour?claimant_id=${claimantBId}`, token: aliceToken,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 0, 'foreign claimant_id filter must return zero for non-admin');
});

test('GET /api/labour/:id on a B-row as Alice → 403', async () => {
  const r = await call({
    method: 'GET', path: `/api/labour/${labourBId}`, token: aliceToken,
  });
  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
});

test('GET /api/expenses as Alice returns only A-scoped rows', async () => {
  const r = await call({ method: 'GET', path: '/api/expenses', token: aliceToken });
  assert.equal(r.status, 200);
  const ids = r.body.items.map(x => x.id);
  assert.ok(ids.includes(expenseAId));
  assert.ok(!ids.includes(expenseBId), 'B expense leaked into Alice view');
});

test('GET /api/expenses/:id on a B-row as Alice → 403', async () => {
  const r = await call({
    method: 'GET', path: `/api/expenses/${expenseBId}`, token: aliceToken,
  });
  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
});

test('GET /api/evidence as Alice returns only her own uploads (no B-evidence)', async () => {
  const r = await call({ method: 'GET', path: '/api/evidence', token: aliceToken });
  assert.equal(r.status, 200);
  const ids = r.body.items.map(x => x.id);
  assert.ok(ids.includes(evidenceAId));
  assert.ok(!ids.includes(evidenceBId), 'B evidence leaked into Alice view');
});

test('GET /api/evidence/:id on a B-row as Alice → 403', async () => {
  const r = await call({
    method: 'GET', path: `/api/evidence/${evidenceBId}`, token: aliceToken,
  });
  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
});

test('GET /api/projects as Alice → 403 (projects router is admin-only)', async () => {
  // Note: the /api/projects router is requireAdmin at the router level, so
  // Alice can't see projects (her or B's) at all here. The employee-facing
  // list lives under /api/me/projects (asserted below).
  const r = await call({ method: 'GET', path: '/api/projects', token: aliceToken });
  assert.equal(r.status, 403, `expected 403 (admin-only), got ${r.status}`);
});

test('GET /api/projects/:id (B-project) as Alice → 403 (admin-only router)', async () => {
  const r = await call({
    method: 'GET', path: `/api/projects/${projectBId}`, token: aliceToken,
  });
  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
});

test('GET /api/me/projects as Alice returns only A-claimant projects', async () => {
  // /me/projects joins through project_assignments; Alice has no assignment
  // yet, so the list is empty. The relevant cross-tenant invariant is that
  // B's project never appears regardless of assignment state.
  const r = await call({ method: 'GET', path: '/api/me/projects', token: aliceToken });
  assert.equal(r.status, 200);
  const claimantIds = new Set(r.body.items.map(p => p.claimant_id));
  assert.ok(!claimantIds.has(claimantBId), 'B-claimant project leaked into /me/projects');
});

test('GET /api/me/periods as Alice returns only A-claimant periods', async () => {
  const r = await call({ method: 'GET', path: '/api/me/periods', token: aliceToken });
  assert.equal(r.status, 200);
  const claimantIds = new Set(r.body.items.map(p => p.claimant_id));
  assert.ok(claimantIds.has(claimantAId), 'A-claimant period missing');
  assert.ok(!claimantIds.has(claimantBId), 'B-claimant period leaked into /me/periods');
});

test('GET /api/exports as Alice → 403 (admin-only router)', async () => {
  const r = await call({ method: 'GET', path: '/api/exports', token: aliceToken });
  assert.equal(r.status, 403, `expected 403, got ${r.status}`);
});

test('GET /api/exports/:id for B-export as Alice → 403 (admin-only router)', async () => {
  const r = await call({
    method: 'GET', path: `/api/exports/${exportBId}`, token: aliceToken,
  });
  assert.equal(r.status, 403, `expected 403, got ${r.status}`);
});

test('GET /api/audit-log as Alice → 403 (admin-only router)', async () => {
  const r = await call({ method: 'GET', path: '/api/audit-log', token: aliceToken });
  assert.equal(r.status, 403, `expected 403, got ${r.status}`);
});

// ---------------------------------------------------------------------------
// WRITE-SIDE ISOLATION
// ---------------------------------------------------------------------------

test('POST /api/labour against B project as Alice → 403 (resolveUserClaimant)', async () => {
  const r = await call({
    method: 'POST', path: '/api/labour', token: aliceToken,
    body: {
      project_id: projectBId,
      work_date: '2025-03-15',
      hours: 1,
      description: 'cross-tenant labour attempt',
    },
  });
  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
});

test('POST /api/expenses against B project as Alice → 403 (resolveUserClaimant)', async () => {
  const r = await call({
    method: 'POST', path: '/api/expenses', token: aliceToken,
    body: {
      project_id: projectBId,
      expense_date: '2025-03-15',
      category: 'material',
      amount_cents: 100,
      currency: 'CAD',
      description: 'cross-tenant expense attempt',
      material_disposition: 'consumed', // required since migration 015 (P3.1)
    },
  });
  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
});

test('POST /api/evidence against B project as Alice → 403 (assertAttached)', async () => {
  // Note-kind so we don't need multipart. The assertAttached check happens
  // before file/note/link branching, so the rejection path is independent
  // of the evidence kind.
  const r = await call({
    method: 'POST', path: '/api/evidence', token: aliceToken,
    body: {
      project_id: projectBId,
      kind: 'note',
      caption: 'cross-tenant note attempt',
      evidence_date: '2025-03-15',
      note_text: 'should not be created',
    },
  });
  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
});

test('PATCH /api/labour/:id on a B-row as Alice → 403 (isOwnerOrAdmin)', async () => {
  const r = await call({
    method: 'PATCH', path: `/api/labour/${labourBId}`, token: aliceToken,
    body: { description: 'pwned' },
  });
  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);

  // Belt-and-braces: the underlying row must still have its original text.
  const row = ctx.db.prepare(`SELECT description FROM labour_entries WHERE id = ?`).get(labourBId);
  assert.equal(row.description, 'B: labour entry', 'description must not have been overwritten');
});

test('DELETE /api/labour/:id on a B-row as Alice → 403 (isOwnerOrAdmin)', async () => {
  const r = await call({
    method: 'DELETE', path: `/api/labour/${labourBId}`, token: aliceToken,
  });
  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  const row = ctx.db.prepare(`SELECT id FROM labour_entries WHERE id = ?`).get(labourBId);
  assert.ok(row, 'row must still exist after blocked DELETE');
});

test('PATCH /api/expenses/:id on a B-row as Alice → 403', async () => {
  const r = await call({
    method: 'PATCH', path: `/api/expenses/${expenseBId}`, token: aliceToken,
    body: { description: 'pwned' },
  });
  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  const row = ctx.db.prepare(`SELECT description FROM expenses WHERE id = ?`).get(expenseBId);
  assert.equal(row.description, 'B: expense');
});

test('DELETE /api/expenses/:id on a B-row as Alice → 403', async () => {
  const r = await call({
    method: 'DELETE', path: `/api/expenses/${expenseBId}`, token: aliceToken,
  });
  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  const row = ctx.db.prepare(`SELECT id FROM expenses WHERE id = ?`).get(expenseBId);
  assert.ok(row, 'row must still exist after blocked DELETE');
});

test('PATCH /api/evidence/:id on a B-row as Alice → 403', async () => {
  const r = await call({
    method: 'PATCH', path: `/api/evidence/${evidenceBId}`, token: aliceToken,
    body: { caption: 'pwned' },
  });
  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  const row = ctx.db.prepare(`SELECT caption FROM evidence_items WHERE id = ?`).get(evidenceBId);
  assert.equal(row.caption, 'B: evidence note');
});

test('DELETE /api/evidence/:id on a B-row as Alice → 403', async () => {
  const r = await call({
    method: 'DELETE', path: `/api/evidence/${evidenceBId}`, token: aliceToken,
  });
  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  const row = ctx.db.prepare(`SELECT id FROM evidence_items WHERE id = ?`).get(evidenceBId);
  assert.ok(row, 'row must still exist after blocked DELETE');
});

// ---------------------------------------------------------------------------
// ADMIN HAPPY-PATH (sanity check)
// ---------------------------------------------------------------------------
//
// The admin user is attached to NEITHER claimant. They should still see
// rows from BOTH (and audit log, projects, exports), proving the
// isolation guards don't accidentally lock the admin out.

test('admin sees BOTH claimants\' labour rows', async () => {
  const r = await call({ method: 'GET', path: '/api/labour', token: adminToken });
  assert.equal(r.status, 200);
  const ids = r.body.items.map(x => x.id);
  assert.ok(ids.includes(labourAId), 'admin should see A labour');
  assert.ok(ids.includes(labourBId), 'admin should see B labour');
});

test('admin sees BOTH claimants\' expenses', async () => {
  const r = await call({ method: 'GET', path: '/api/expenses', token: adminToken });
  assert.equal(r.status, 200);
  const ids = r.body.items.map(x => x.id);
  assert.ok(ids.includes(expenseAId));
  assert.ok(ids.includes(expenseBId));
});

test('admin can GET a foreign-claimant labour row', async () => {
  const r = await call({
    method: 'GET', path: `/api/labour/${labourBId}`, token: adminToken,
  });
  assert.equal(r.status, 200, `admin must be able to view B's labour; got ${r.status}`);
  assert.equal(r.body.id, labourBId);
});

test('admin can list audit-log and exports across claimants', async () => {
  const audit = await call({ method: 'GET', path: '/api/audit-log', token: adminToken });
  assert.equal(audit.status, 200);
  const exports_ = await call({ method: 'GET', path: '/api/exports', token: adminToken });
  assert.equal(exports_.status, 200);
});
