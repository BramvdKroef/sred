// Route-layer tests for migration 015's expense domain fields
// (SRED_DOMAIN_REVIEW P3.1 / P3.2 / P3.3).
//
// Asserts the POST + PATCH validators around `material_disposition`,
// `contract_arms_length`, and `fx_rate_source`:
//
//   P3.1 material_disposition (required when category='material'):
//     - POST category=material without disposition → 400.
//     - POST category=material with bad disposition → 400.
//     - POST category=material + disposition='consumed' → 201, persisted.
//     - POST category=contract with material_disposition → 400.
//     - PATCH material→contract auto-clears stale material_disposition.
//
//   P3.2 contract_arms_length (required when category='contract'):
//     - POST category=contract without arms-length flag → 400.
//     - POST category=contract with arms_length=0 → 201.
//     - POST category=contract with arms_length=true (bool) → 201
//       (coercer accepts boolean / int / numeric-string).
//     - POST category=material with contract_arms_length → 400.
//     - PATCH contract→material auto-clears stale contract_arms_length.
//
//   P3.3 fx_rate_source (required when fx_rate is set):
//     - POST with fx_rate + no source → 400.
//     - POST with fx_rate + empty source → 400.
//     - POST with fx_rate + valid source → 201, persisted.
//     - POST without fx_rate + a stray source → 400 (schema permits but
//       route blocks).
//     - PATCH clearing fx_rate auto-clears fx_rate_source.

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
} from '../helpers/db.js';

let ctx;
let server;
let baseUrl;
let adminToken;
let adminUcId;
let projectId;

before(async () => {
  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  const claimantId = insertClaimant(ctx.db, { legal_name: 'P3 Domain Co' });
  insertFiscalPeriod(ctx.db, claimantId, {
    start_date: '2025-01-01', end_date: '2025-12-31', status: 'open',
  });

  const adminId = insertUser(ctx.db, {
    role: 'admin', status: 'active', email: 'p3-admin@example.com',
  });
  adminUcId = insertUserClaimant(ctx.db, adminId, claimantId);
  projectId = insertProject(ctx.db, claimantId, { title: 'P3 Project' });
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

// Each helper builds a "valid for its category" body and lets the test
// override any field. Mirrors the postOverhead pattern from
// tests/routes/expense-overhead-fields.test.js so the two suites read
// alike.

function postMaterial(overrides = {}) {
  return callApi({
    method: 'POST', path: '/api/expenses', token: adminToken,
    body: {
      project_id: projectId,
      user_claimant_id: adminUcId,
      expense_date: '2025-03-15',
      category: 'material',
      amount_cents: 10_000,
      currency: 'CAD',
      description: 'lab supply',
      material_disposition: 'consumed',
      ...overrides,
    },
  });
}

function postContract(overrides = {}) {
  return callApi({
    method: 'POST', path: '/api/expenses', token: adminToken,
    body: {
      project_id: projectId,
      user_claimant_id: adminUcId,
      expense_date: '2025-03-15',
      category: 'contract',
      amount_cents: 10_000,
      currency: 'CAD',
      description: 'contracted work',
      contract_arms_length: 1,
      ...overrides,
    },
  });
}

// --- P3.1: material_disposition --------------------------------------------

test('POST category=material WITHOUT material_disposition → 400', async () => {
  const res = await postMaterial({ material_disposition: undefined });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.error?.message || '', /material_disposition/i);
});

test('POST category=material with bad enum value → 400', async () => {
  const res = await postMaterial({ material_disposition: 'recycled' });
  assert.equal(res.status, 400);
  assert.match(res.body.error?.message || '', /material_disposition/i);
});

test('POST category=material + disposition=consumed → 201, persisted', async () => {
  const res = await postMaterial({ expense_date: '2025-03-16' });
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.category, 'material');
  assert.equal(res.body.material_disposition, 'consumed');
});

test('POST category=material + disposition=transformed → 201, persisted', async () => {
  const res = await postMaterial({ expense_date: '2025-03-17', material_disposition: 'transformed' });
  assert.equal(res.status, 201);
  assert.equal(res.body.material_disposition, 'transformed');
});

test('POST category=contract with material_disposition → 400', async () => {
  const res = await postContract({ material_disposition: 'consumed' });
  assert.equal(res.status, 400);
  assert.match(res.body.error?.message || '', /material_disposition/i);
});

test('PATCH material→contract auto-clears stale material_disposition', async () => {
  const created = await postMaterial({ expense_date: '2025-03-18' });
  assert.equal(created.status, 201);
  const patched = await callApi({
    method: 'PATCH', path: `/api/expenses/${created.body.id}`, token: adminToken,
    body: { category: 'contract', contract_arms_length: 1 },
  });
  assert.equal(patched.status, 200, `expected 200, got ${patched.status}: ${JSON.stringify(patched.body)}`);
  assert.equal(patched.body.category, 'contract');
  assert.equal(patched.body.material_disposition, null);
  assert.equal(patched.body.contract_arms_length, 1);
});

// --- P3.2: contract_arms_length --------------------------------------------

test('POST category=contract WITHOUT contract_arms_length → 400', async () => {
  const res = await postContract({ contract_arms_length: undefined });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.error?.message || '', /contract_arms_length/i);
});

test('POST category=contract with arms_length=0 → 201', async () => {
  const res = await postContract({ expense_date: '2025-03-19', contract_arms_length: 0 });
  assert.equal(res.status, 201);
  assert.equal(res.body.contract_arms_length, 0);
});

test('POST category=contract with arms_length=true (bool) coerces to 1', async () => {
  const res = await postContract({ expense_date: '2025-03-20', contract_arms_length: true });
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.contract_arms_length, 1);
});

test('POST category=contract with arms_length=2 → 400 (out of {0,1})', async () => {
  const res = await postContract({ contract_arms_length: 2 });
  assert.equal(res.status, 400);
});

test('POST category=material with contract_arms_length → 400', async () => {
  const res = await postMaterial({ contract_arms_length: 1, expense_date: '2025-03-21' });
  assert.equal(res.status, 400);
  assert.match(res.body.error?.message || '', /contract_arms_length/i);
});

test('PATCH contract→material auto-clears stale contract_arms_length', async () => {
  const created = await postContract({ expense_date: '2025-03-22' });
  assert.equal(created.status, 201);
  const patched = await callApi({
    method: 'PATCH', path: `/api/expenses/${created.body.id}`, token: adminToken,
    body: { category: 'material', material_disposition: 'consumed' },
  });
  assert.equal(patched.status, 200, `expected 200, got ${patched.status}: ${JSON.stringify(patched.body)}`);
  assert.equal(patched.body.category, 'material');
  assert.equal(patched.body.contract_arms_length, null);
  assert.equal(patched.body.material_disposition, 'consumed');
});

// --- P3.3: fx_rate_source --------------------------------------------------

test('POST with fx_rate but NO fx_rate_source → 400', async () => {
  // Need a non-reporting currency to make fx_rate semantically valid here.
  const res = await postMaterial({
    expense_date: '2025-04-01',
    currency: 'USD', fx_rate: 1.35,
    fx_rate_source: undefined,
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.error?.message || '', /fx_rate_source/i);
});

test('POST with fx_rate + empty fx_rate_source → 400', async () => {
  const res = await postMaterial({
    expense_date: '2025-04-02',
    currency: 'USD', fx_rate: 1.35,
    fx_rate_source: '   ',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error?.message || '', /fx_rate_source/i);
});

test('POST with fx_rate + valid fx_rate_source → 201, persisted', async () => {
  const res = await postMaterial({
    expense_date: '2025-04-03',
    currency: 'USD', fx_rate: 1.35,
    fx_rate_source: 'Bank of Canada noon rate, 2025-04-03',
  });
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.fx_rate, 1.35);
  assert.equal(res.body.fx_rate_source, 'Bank of Canada noon rate, 2025-04-03');
});

test('POST without fx_rate but with a stray fx_rate_source → 400', async () => {
  const res = await postMaterial({
    expense_date: '2025-04-04',
    fx_rate_source: 'some label',
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.error?.message || '', /fx_rate_source/i);
});

test('PATCH clearing fx_rate auto-clears fx_rate_source', async () => {
  const created = await postMaterial({
    expense_date: '2025-04-05',
    currency: 'USD', fx_rate: 1.35,
    fx_rate_source: 'Bank of Canada noon rate, 2025-04-05',
  });
  assert.equal(created.status, 201);
  const patched = await callApi({
    method: 'PATCH', path: `/api/expenses/${created.body.id}`, token: adminToken,
    // Switch back to reporting currency + clear fx_rate. The route should
    // also null fx_rate_source automatically — the caller doesn't have to
    // remember (mirrors the overhead-fields auto-clear when category leaves
    // 'overhead').
    body: { currency: 'CAD', fx_rate: null },
  });
  assert.equal(patched.status, 200, `expected 200, got ${patched.status}: ${JSON.stringify(patched.body)}`);
  assert.equal(patched.body.fx_rate, null);
  assert.equal(patched.body.fx_rate_source, null);
});
