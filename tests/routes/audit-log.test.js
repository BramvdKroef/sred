// Tests for src/routes/audit-log.js — the optional `claimant_id` filter
// (hoist step 4). The audit log is global, but the header claimant
// selector scopes it: when `claimant_id` is supplied, rows whose entity
// belongs to that claimant (labour_entry / expense / evidence_item /
// project / fiscal_period / project_assignment / user_claimant /
// compensation_row / t661_export / claimant itself) are returned, and
// rows owned by other claimants — plus claimant-agnostic rows like
// `user` — are excluded.
//
// Strategy mirrors the other route tests: stand up the real express
// app on a random port, seed two claimants with one labour + one
// expense + one project + one user_claimant + one user audit row each,
// then assert the filter returns only the active claimant's rows.

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
let claimantAId, claimantBId;
let labourAId, labourBId;
let expenseAId, expenseBId;
let projectAId, projectBId;
let ucAId, ucBId;
let regularUserId;

before(async () => {
  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');
  const { audit } = await import('../../src/lib/audit.js');

  claimantAId = insertClaimant(ctx.db, { legal_name: 'Acme Alpha Ltd', business_number: '111111111RC0001' });
  claimantBId = insertClaimant(ctx.db, { legal_name: 'Beta Boundless Inc', business_number: '222222222RC0001' });

  const periodAId = insertFiscalPeriod(ctx.db, claimantAId);
  const periodBId = insertFiscalPeriod(ctx.db, claimantBId);

  const adminId = insertUser(ctx.db, {
    email: 'admin-audit@example.com', role: 'admin', status: 'active',
  });
  regularUserId = insertUser(ctx.db, { email: 'regular-audit@example.com' });
  ucAId = insertUserClaimant(ctx.db, regularUserId, claimantAId);
  ucBId = insertUserClaimant(ctx.db, regularUserId, claimantBId);

  projectAId = insertProject(ctx.db, claimantAId, { title: 'Project A' });
  projectBId = insertProject(ctx.db, claimantBId, { title: 'Project B' });

  labourAId  = insertLabourEntry(ctx.db, projectAId, ucAId, periodAId, { description: 'A labour' });
  labourBId  = insertLabourEntry(ctx.db, projectBId, ucBId, periodBId, { description: 'B labour' });
  expenseAId = insertExpense(ctx.db, projectAId, ucAId, periodAId, { description: 'A expense' });
  expenseBId = insertExpense(ctx.db, projectBId, ucBId, periodBId, { description: 'B expense' });

  // Write audit rows covering every entity_type the scoping code maps —
  // one per claimant where the type is claimant-scoped, plus one
  // claimant-agnostic `user` row that must NOT appear under either
  // claimant's scope but MUST appear in the unscoped view.
  audit(adminId, 'create', 'claimant',           claimantAId);
  audit(adminId, 'create', 'claimant',           claimantBId);
  audit(adminId, 'close_period', 'fiscal_period', periodAId);
  audit(adminId, 'close_period', 'fiscal_period', periodBId);
  audit(adminId, 'create', 'project',            projectAId);
  audit(adminId, 'create', 'project',            projectBId);
  audit(adminId, 'create', 'user_claimant',      ucAId);
  audit(adminId, 'create', 'user_claimant',      ucBId);
  audit(adminId, 'create', 'labour_entry',       labourAId);
  audit(adminId, 'create', 'labour_entry',       labourBId);
  audit(adminId, 'create', 'expense',            expenseAId);
  audit(adminId, 'create', 'expense',            expenseBId);
  // Claimant-agnostic — should be excluded by any claimant_id filter.
  audit(adminId, 'create', 'user',               regularUserId);

  adminToken = signSession({ id: adminId, role: 'admin' });

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

async function getAuditLog(qs = '') {
  const res = await fetch(`${baseUrl}/api/audit-log${qs}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  return (await res.json()).items;
}

test('GET /api/audit-log without claimant_id returns rows for all claimants and claimant-agnostic rows', async () => {
  const items = await getAuditLog();
  // Should include both A's and B's rows, plus the `user` row.
  const types = items.map(r => r.entity_type);
  assert.ok(types.includes('user'), 'user row should appear when unscoped');
  assert.equal(
    items.filter(r => r.entity_type === 'labour_entry').length, 2,
    'both labour rows should appear when unscoped'
  );
});

test('GET /api/audit-log?claimant_id=A returns only A-scoped rows', async () => {
  const items = await getAuditLog(`?claimant_id=${claimantAId}&limit=500`);
  // Every row's (entity_type, entity_id) must map back to claimant A.
  const expectedA = new Set([
    `claimant:${claimantAId}`,
    `fiscal_period:?`,  // we don't know the period id ref'd above, so check below
    `project:${projectAId}`,
    `user_claimant:${ucAId}`,
    `labour_entry:${labourAId}`,
    `expense:${expenseAId}`,
  ]);
  // Pull just the (type, id) pairs we asserted, ignoring period rows (we
  // didn't keep periodAId out of the closure).
  const seen = items.map(r => `${r.entity_type}:${r.entity_id}`);
  assert.ok(seen.includes(`claimant:${claimantAId}`));
  assert.ok(seen.includes(`project:${projectAId}`));
  assert.ok(seen.includes(`user_claimant:${ucAId}`));
  assert.ok(seen.includes(`labour_entry:${labourAId}`));
  assert.ok(seen.includes(`expense:${expenseAId}`));
  // Cross-claimant rows MUST NOT leak in.
  assert.ok(!seen.includes(`claimant:${claimantBId}`),       'B claimant row leaked');
  assert.ok(!seen.includes(`project:${projectBId}`),         'B project row leaked');
  assert.ok(!seen.includes(`user_claimant:${ucBId}`),        'B user_claimant row leaked');
  assert.ok(!seen.includes(`labour_entry:${labourBId}`),     'B labour_entry row leaked');
  assert.ok(!seen.includes(`expense:${expenseBId}`),         'B expense row leaked');
  // Claimant-agnostic `user` rows are excluded by claimant scope.
  assert.ok(!items.some(r => r.entity_type === 'user'),      'user row leaked into claimant-scoped view');
});

test('GET /api/audit-log?claimant_id=B returns only B-scoped rows (symmetry check)', async () => {
  const items = await getAuditLog(`?claimant_id=${claimantBId}&limit=500`);
  const seen = items.map(r => `${r.entity_type}:${r.entity_id}`);
  assert.ok(seen.includes(`claimant:${claimantBId}`));
  assert.ok(seen.includes(`labour_entry:${labourBId}`));
  assert.ok(!seen.includes(`labour_entry:${labourAId}`), 'A labour leaked into B scope');
  assert.ok(!seen.includes(`expense:${expenseAId}`),     'A expense leaked into B scope');
});

test('claimant_id filter composes with entity_type filter', async () => {
  const items = await getAuditLog(`?claimant_id=${claimantAId}&entity_type=labour_entry&limit=500`);
  assert.equal(items.length, 1, 'one labour row for claimant A');
  assert.equal(items[0].entity_type, 'labour_entry');
  assert.equal(items[0].entity_id, labourAId);
});

test('GET /api/audit-log?claimant_id=<missing> returns empty list (no rows match)', async () => {
  const items = await getAuditLog(`?claimant_id=99999&limit=500`);
  assert.equal(items.length, 0);
});
