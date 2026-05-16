// Parameterised integration test: every mutating API endpoint writes an
// audit_log row.
//
// Table-driven: each row is `{ name, method, path, body, expectedAction,
// expectedEntityType }`. The single `test()` body snapshots the audit_log
// row count, drives the request, then asserts count+1 and the latest row's
// action / entity_type.
//
// Some entries depend on entities created earlier in the table (we need the
// new claimant's id to nest projects under it, etc.). The driver captures
// the response body of each step into a small context object so later steps
// can substitute the freshly-minted ids into their paths / bodies.

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
} from '../helpers/db.js';

let ctx;
let server;
let baseUrl;
let adminToken;

// Bootstrap ids shared across cases.
let bootstrapClaimantId;
let bootstrapPeriodId;
let bootstrapProjectId;
let bootstrapUcId;
let bootstrapEmpUcId;
let bootstrapPendingLabourId;

before(async () => {
  ctx = await setupTempDb();
  // The append-only triggers on audit_log are tested separately in
  // tests/db/audit-log-append-only.test.js. We don't need to wipe the table
  // between cases here (we snapshot count before each call and assert
  // count+1), so the triggers can stay in place. The test only ever inserts
  // through the production audit() helper.

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  // Bootstrap: a claimant + open fiscal period + project + employee with
  // a comp row, all created OUTSIDE the API so we have stable ids to use
  // as the path/body for the API-driven cases below.
  bootstrapClaimantId = insertClaimant(ctx.db, { legal_name: 'Bootstrap Co' });
  bootstrapPeriodId = insertFiscalPeriod(ctx.db, bootstrapClaimantId, {
    start_date: '2025-01-01', end_date: '2025-12-31', status: 'open',
  });

  const adminId = insertUser(ctx.db, {
    role: 'admin', status: 'active', email: 'admin-audit@example.com',
  });
  // Admin needs an attachment to be selectable as a user_claimant for some
  // routes; bootstrapUcId is the admin's, bootstrapEmpUcId is the employee's.
  bootstrapUcId = insertUserClaimant(ctx.db, adminId, bootstrapClaimantId);

  const empId = insertUser(ctx.db, {
    role: 'employee', status: 'active', email: 'emp-audit@example.com',
  });
  bootstrapEmpUcId = insertUserClaimant(ctx.db, empId, bootstrapClaimantId);
  insertCompRow(ctx.db, bootstrapEmpUcId, {
    comp_type: 'salary', amount_cents: 10_400_000, hours_per_year: 2080,
    effective_from: '2025-01-01',
  });

  // A project the admin already manages (used as the bootstrap project for
  // PATCH /api/projects/:id and the labour/expense/evidence POSTs).
  bootstrapProjectId = insertProject(ctx.db, bootstrapClaimantId, {
    title: 'Bootstrap Project',
  });

  // A 'pending' labour row used as the PATCH /api/labour/:id target. We
  // can't reuse the labour row the API POSTs because admin-created rows
  // land as 'approved' (auto-approved) and assertEditable blocks PATCH on
  // approved entries.
  bootstrapPendingLabourId = insertLabourEntry(
    ctx.db, bootstrapProjectId, bootstrapEmpUcId, bootstrapPeriodId,
    { work_date: '2025-03-15', hours: 2, description: 'pending row', status: 'pending' },
  );

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

// --- helpers ---------------------------------------------------------------

function auditCount() {
  return ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get().n;
}

function latestAuditRow() {
  return ctx.db.prepare(
    `SELECT * FROM audit_log ORDER BY id DESC LIMIT 1`
  ).get();
}

async function callApi({ method, path, body }) {
  const init = {
    method,
    headers: { Authorization: `Bearer ${adminToken}` },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// --- the table -------------------------------------------------------------
//
// Each case is built lazily through a function so it can reference ids
// produced by earlier cases (captured in `state`).

function buildCases(state) {
  return [
    {
      name: 'POST /api/claimants → audit create claimant',
      method: 'POST', path: '/api/claimants',
      body: {
        legal_name: 'Audit Co',
        business_number: '777777777RC0001',
        fiscal_year_end_month: 12,
        fiscal_year_end_day: 31,
        sred_method: 'proxy',
      },
      expectedAction: 'create', expectedEntityType: 'claimant',
      capture: r => { state.newClaimantId = r.body.id; },
    },
    {
      name: 'PATCH /api/claimants/:id → audit update claimant',
      method: 'PATCH', path: () => `/api/claimants/${state.newClaimantId}`,
      body: { legal_name: 'Audit Co (renamed)' },
      expectedAction: 'update', expectedEntityType: 'claimant',
    },
    {
      name: 'POST /api/claimants/:id/projects → audit create project',
      method: 'POST', path: () => `/api/claimants/${state.newClaimantId}/projects`,
      body: {
        title: 'New Audit Project',
        field_of_science: 'computer_science',
        start_date: '2025-02-01',
        status: 'development',
        type: 'sred',
        advancement_sought: 'a',
        uncertainties: 'b',
        work_performed: 'c',
      },
      expectedAction: 'create', expectedEntityType: 'project',
      capture: r => {
        state.newProjectId = r.body.id;
        state.newProjectUpdatedAt = r.body.updated_at;
      },
    },
    {
      // Project PATCH requires an `__updated_at` precondition (strict
      // optimistic-concurrency: missing token = 400). The capture from the
      // preceding POST stashed the row's updated_at; pass it through here.
      name: 'PATCH /api/projects/:id → audit update project',
      method: 'PATCH', path: () => `/api/projects/${state.newProjectId}`,
      body: () => ({
        __updated_at: state.newProjectUpdatedAt,
        title: 'New Audit Project (v2)',
      }),
      expectedAction: 'update', expectedEntityType: 'project',
    },
    {
      name: 'POST /api/projects/:id/assignments → audit create project_assignment',
      method: 'POST', path: () => `/api/projects/${bootstrapProjectId}/assignments`,
      // The admin's own user_claimant on the bootstrap claimant — it belongs
      // to the same claimant as bootstrapProjectId so the FK check passes.
      body: () => ({ user_claimant_id: bootstrapUcId }),
      expectedAction: 'create', expectedEntityType: 'project_assignment',
    },
    {
      name: 'POST /api/labour → audit create labour_entry',
      method: 'POST', path: '/api/labour',
      body: () => ({
        project_id: bootstrapProjectId,
        user_claimant_id: bootstrapEmpUcId,
        work_date: '2025-03-15',
        hours: 4,
        description: 'audit-log create',
      }),
      expectedAction: 'create', expectedEntityType: 'labour_entry',
      capture: r => { state.newLabourId = r.body.id; },
    },
    {
      // The new labour row was created by the admin POST above and is
      // therefore auto-approved (and locked from PATCH). For the PATCH
      // case we target a separately-seeded pending row.
      name: 'PATCH /api/labour/:id → audit update labour_entry',
      method: 'PATCH', path: () => `/api/labour/${bootstrapPendingLabourId}`,
      body: { description: 'audit-log update' },
      expectedAction: 'update', expectedEntityType: 'labour_entry',
    },
    {
      name: 'POST /api/expenses → audit create expense',
      method: 'POST', path: '/api/expenses',
      body: () => ({
        project_id: bootstrapProjectId,
        user_claimant_id: bootstrapEmpUcId,
        expense_date: '2025-03-15',
        category: 'material',
        amount_cents: 12_500,
        currency: 'CAD',
        description: 'audit-log expense',
        material_disposition: 'consumed', // required since migration 015 (P3.1)
      }),
      expectedAction: 'create', expectedEntityType: 'expense',
    },
    {
      name: 'POST /api/evidence (link) → audit create evidence_item',
      method: 'POST', path: '/api/evidence',
      body: () => ({
        project_id: bootstrapProjectId,
        kind: 'link',
        caption: 'audit-log evidence',
        evidence_date: '2025-03-15',
        url: 'https://example.com/proof',
      }),
      expectedAction: 'create', expectedEntityType: 'evidence_item',
    },
    {
      name: 'POST /api/periods/:id/close → audit close_period',
      method: 'POST', path: () => `/api/periods/${bootstrapPeriodId}/close`,
      // No body.
      expectedAction: 'close_period', expectedEntityType: 'fiscal_period',
    },
    {
      // T661 needs a still-OPEN period for the seeded data, but the close
      // case above turns bootstrapPeriodId into 'closed'. The T661 compute
      // does NOT require the period to be open (it just rolls up approved
      // rows in the period), so this still works. The earlier
      // tests/lib/t661.test.js suite seeds a period status of 'open' but
      // doesn't depend on it.
      name: 'POST /api/exports/t661 → audit export_t661',
      method: 'POST', path: '/api/exports/t661',
      body: () => ({
        claimant_id: bootstrapClaimantId, fiscal_period_id: bootstrapPeriodId,
      }),
      expectedAction: 'export_t661', expectedEntityType: 't661_export',
    },
  ];
}

// --- the test --------------------------------------------------------------

test('every mutating endpoint writes exactly one audit_log row with the expected action + entity_type', async () => {
  const state = {};
  const cases = buildCases(state);

  for (const c of cases) {
    const before = auditCount();
    const path = typeof c.path === 'function' ? c.path() : c.path;
    const body = typeof c.body === 'function' ? c.body() : c.body;

    const res = await callApi({ method: c.method, path, body });
    assert.ok(res.status >= 200 && res.status < 300,
      `${c.name}: expected 2xx, got ${res.status}: ${JSON.stringify(res.body)}`);

    const after = auditCount();
    assert.equal(after, before + 1,
      `${c.name}: audit_log row count must increase by exactly 1 (was ${before}, now ${after})`);

    const latest = latestAuditRow();
    assert.equal(latest.action, c.expectedAction,
      `${c.name}: latest audit_log.action should be ${c.expectedAction}, got ${latest.action}`);
    assert.equal(latest.entity_type, c.expectedEntityType,
      `${c.name}: latest audit_log.entity_type should be ${c.expectedEntityType}, got ${latest.entity_type}`);

    if (c.capture) c.capture(res);
  }
});
