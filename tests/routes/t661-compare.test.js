// Route-level integration tests for the comparative two-period T661 export
// (UC-R2 alt flow R2.b). Verifies:
//   - POST /api/exports/t661/compare returns `a`, `b`, `diff` with arithmetic
//     deltas that match the underlying period totals.
//   - Missing or non-integer period ids return 400.
//   - A period that belongs to a different claimant returns 400.
//   - The download GET endpoint round-trips JSON, CSV, MD, PDF.
//   - A project present in only one period appears in `diff.projects` with
//     `missing_from` set; per-project diff is null on that side.
//
// Strategy mirrors tests/routes/t661-export-roundtrip.test.js: real express
// app on a random port via setupTempDb, admin JWT, fetch.

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
let claimantId;
let periodAId;
let periodBId;
let otherClaimantPeriodId;
let projectABId; // present in both periods
let projectAOnlyId; // only has labour in period A

before(async () => {
  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  // Traditional method so the overhead totals reflect overhead-category
  // expenses exactly (no implicit 55% proxy multiplier obscuring deltas).
  claimantId = insertClaimant(ctx.db, {
    legal_name: 'Compare Test Co', sred_method: 'traditional', reporting_currency: 'CAD',
  });
  periodAId = insertFiscalPeriod(ctx.db, claimantId, {
    start_date: '2024-01-01', end_date: '2024-12-31', status: 'closed',
  });
  periodBId = insertFiscalPeriod(ctx.db, claimantId, {
    start_date: '2025-01-01', end_date: '2025-12-31', status: 'open',
  });

  const adminId = insertUser(ctx.db, {
    role: 'admin', status: 'active', email: 'admin-cmp@example.com',
  });
  insertUserClaimant(ctx.db, adminId, claimantId);

  const empId = insertUser(ctx.db, {
    role: 'employee', status: 'active', email: 'emp-cmp@example.com', name: 'Emma',
  });
  const ucId = insertUserClaimant(ctx.db, empId, claimantId);
  // $50/hr salary — same rate in both periods so labour deltas are driven
  // purely by hours logged.
  insertCompRow(ctx.db, ucId, {
    comp_type: 'salary', amount_cents: 10_400_000, hours_per_year: 2080,
    effective_from: '2024-01-01',
  });

  projectABId = insertProject(ctx.db, claimantId, {
    title: 'Continuity Project', type: 'sred',
  });
  projectAOnlyId = insertProject(ctx.db, claimantId, {
    title: 'Discontinued Project', type: 'sred',
  });

  // Period A: 10h on continuity + 4h on discontinued + $100 materials + $50 overhead
  insertLabourEntry(ctx.db, projectABId, ucId, periodAId, {
    work_date: '2024-06-01', hours: 10, status: 'approved',
  });
  insertLabourEntry(ctx.db, projectAOnlyId, ucId, periodAId, {
    work_date: '2024-06-01', hours: 4, status: 'approved',
  });
  insertExpense(ctx.db, projectABId, ucId, periodAId, {
    expense_date: '2024-06-15', category: 'material', amount_cents: 10_000,
    currency: 'CAD', fx_rate: null, status: 'approved',
  });
  insertExpense(ctx.db, projectABId, ucId, periodAId, {
    expense_date: '2024-06-20', category: 'overhead', amount_cents: 5_000,
    currency: 'CAD', fx_rate: null, status: 'approved',
  });

  // Period B: 20h on continuity (doubled) + $200 materials. Discontinued has no rows.
  insertLabourEntry(ctx.db, projectABId, ucId, periodBId, {
    work_date: '2025-06-01', hours: 20, status: 'approved',
  });
  insertExpense(ctx.db, projectABId, ucId, periodBId, {
    expense_date: '2025-06-15', category: 'material', amount_cents: 20_000,
    currency: 'CAD', fx_rate: null, status: 'approved',
  });

  // Second claimant with its own period — for the cross-claimant 400 test.
  const otherClaimantId = insertClaimant(ctx.db, { legal_name: 'Other Co' });
  otherClaimantPeriodId = insertFiscalPeriod(ctx.db, otherClaimantId, {
    start_date: '2025-01-01', end_date: '2025-12-31', status: 'open',
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

async function postJson(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get(path) {
  return fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
}

// --- POST tests -------------------------------------------------------------

test('POST /api/exports/t661/compare returns 200 with a, b, diff', async () => {
  const res = await postJson('/api/exports/t661/compare', {
    claimant_id: claimantId, period_a_id: periodAId, period_b_id: periodBId,
  });
  const text = await res.text();
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${text}`);
  const body = JSON.parse(text);
  assert.ok(body.a && body.b && body.diff, 'body should have a, b, diff keys');
  assert.equal(body.a.fiscal_period.id, periodAId);
  assert.equal(body.b.fiscal_period.id, periodBId);
});

test('per-field grand_total deltas are arithmetic differences', async () => {
  const res = await postJson('/api/exports/t661/compare', {
    claimant_id: claimantId, period_a_id: periodAId, period_b_id: periodBId,
  });
  const { a, b, diff } = await res.json();
  for (const field of [
    'labour_cost_cents', 'materials_cents', 'contract_expenditures_cents',
    'third_party_payments_cents', 'overhead_cents', 'total_cents',
  ]) {
    const expected = (b.grand_total[field] ?? 0) - (a.grand_total[field] ?? 0);
    assert.equal(
      diff.grand_total[field].delta_cents, expected,
      `delta_cents for ${field}: expected ${expected}, got ${diff.grand_total[field].delta_cents}`
    );
    if (a.grand_total[field] === 0) {
      assert.equal(diff.grand_total[field].delta_pct, null,
        `delta_pct for ${field} should be null when A is 0`);
    } else {
      const expectedPct = (expected / a.grand_total[field]) * 100;
      assert.ok(
        Math.abs(diff.grand_total[field].delta_pct - expectedPct) < 1e-9,
        `delta_pct for ${field}: expected ${expectedPct}, got ${diff.grand_total[field].delta_pct}`
      );
    }
  }
});

test('labour delta matches the underlying hours difference', async () => {
  // Continuity project: 10h vs 20h at $50/hr; discontinued: 4h vs 0h.
  // Period A labour = (10 + 4) * 50 * 100 = 70_000c; Period B = 20 * 50 * 100 = 100_000c.
  const res = await postJson('/api/exports/t661/compare', {
    claimant_id: claimantId, period_a_id: periodAId, period_b_id: periodBId,
  });
  const { a, b, diff } = await res.json();
  assert.equal(a.grand_total.labour_cost_cents, 70_000);
  assert.equal(b.grand_total.labour_cost_cents, 100_000);
  assert.equal(diff.grand_total.labour_cost_cents.delta_cents, 30_000);
});

test('a project with no rows in B still appears in diff.projects with zero B totals', async () => {
  // Projects belong to a claimant (not a period), so `computeT661` returns
  // the same project list for every period — a project with no labour /
  // expense rows just appears with all-zero totals. The compare diff still
  // surfaces it with `missing_from: null` and a real per-project diff
  // (it's the labour/expense rows that move between periods, not the
  // project rows themselves).
  const res = await postJson('/api/exports/t661/compare', {
    claimant_id: claimantId, period_a_id: periodAId, period_b_id: periodBId,
  });
  const { diff } = await res.json();
  const disc = diff.projects.find(p => p.project_id === projectAOnlyId);
  assert.ok(disc, 'discontinued project must appear in diff.projects');
  assert.equal(disc.missing_from, null);
  assert.equal(disc.a.labour_cost_cents, 20_000); // 4h * $50
  assert.equal(disc.b.labour_cost_cents, 0);
  assert.equal(disc.diff.labour_cost_cents.delta_cents, -20_000);
});

test('a project present in both periods has a populated per-project diff', async () => {
  const res = await postJson('/api/exports/t661/compare', {
    claimant_id: claimantId, period_a_id: periodAId, period_b_id: periodBId,
  });
  const { diff } = await res.json();
  const cont = diff.projects.find(p => p.project_id === projectABId);
  assert.ok(cont, 'continuity project must appear in diff.projects');
  assert.equal(cont.missing_from, null);
  assert.equal(cont.a.labour_cost_cents, 50_000); // 10h * $50
  assert.equal(cont.b.labour_cost_cents, 100_000); // 20h * $50
  assert.equal(cont.diff.labour_cost_cents.delta_cents, 50_000);
  assert.equal(cont.diff.materials_cents.delta_cents, 10_000);
});

test('POST with a missing period_b_id returns 400', async () => {
  const res = await postJson('/api/exports/t661/compare', {
    claimant_id: claimantId, period_a_id: periodAId,
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'bad_request');
  assert.match(body.error.message, /period_b_id/);
});

test('POST with two identical periods returns 400', async () => {
  const res = await postJson('/api/exports/t661/compare', {
    claimant_id: claimantId, period_a_id: periodAId, period_b_id: periodAId,
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /differ/);
});

test('POST with a period from a different claimant returns 400', async () => {
  const res = await postJson('/api/exports/t661/compare', {
    claimant_id: claimantId, period_a_id: periodAId, period_b_id: otherClaimantPeriodId,
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'bad_request');
  assert.match(body.error.message, /does not belong to claimant/);
});

// --- GET download tests -----------------------------------------------------

test('GET /api/exports/compare/download?format=json returns json with a/b/diff', async () => {
  const res = await get(
    `/api/exports/compare/download?claimant_id=${claimantId}` +
    `&period_a=${periodAId}&period_b=${periodBId}&format=json`
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = JSON.parse(await res.text());
  assert.ok(body.a && body.b && body.diff);
});

test('GET compare download format=csv returns text/csv with header row', async () => {
  const res = await get(
    `/api/exports/compare/download?claimant_id=${claimantId}` +
    `&period_a=${periodAId}&period_b=${periodBId}&format=csv`
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/csv/);
  const body = await res.text();
  // Header columns include scope, delta_cents, delta_pct, etc.
  assert.match(body, /^scope,project_id,project_title,line,currency/);
  assert.match(body, /delta_cents/);
});

test('GET compare download format=md returns markdown with both period labels', async () => {
  const res = await get(
    `/api/exports/compare/download?claimant_id=${claimantId}` +
    `&period_a=${periodAId}&period_b=${periodBId}&format=md`
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/markdown/);
  const body = await res.text();
  assert.ok(body.includes('2024-01-01'), 'period A start_date should appear');
  assert.ok(body.includes('2025-01-01'), 'period B start_date should appear');
  assert.ok(body.includes('Δ'), 'delta column header should be rendered');
});

test('GET compare download format=pdf returns %PDF body', async () => {
  const res = await get(
    `/api/exports/compare/download?claimant_id=${claimantId}` +
    `&period_a=${periodAId}&period_b=${periodBId}&format=pdf`
  );
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.slice(0, 4).toString('ascii'), '%PDF');
});
