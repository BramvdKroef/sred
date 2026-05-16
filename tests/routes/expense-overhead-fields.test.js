// Route-layer tests for migration 014's expense overhead fields
// (SRED_DOMAIN_REVIEW F5).
//
// Asserts the POST + PATCH validators around `overhead_subcategory` and
// `allocation_basis`:
//   - POST category=overhead WITHOUT subcategory → 400.
//   - POST category=overhead WITHOUT allocation_basis → 400.
//   - POST category=overhead with both → 201, persisted, returned in body.
//   - POST category=material WITH overhead_subcategory → 400.
//   - PATCH category overhead→material clears overhead fields automatically.
//   - PATCH adding overhead_subcategory='travel' (out of enum) → 400.

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

  const claimantId = insertClaimant(ctx.db, { legal_name: 'Overhead Co' });
  insertFiscalPeriod(ctx.db, claimantId, {
    start_date: '2025-01-01', end_date: '2025-12-31', status: 'open',
  });

  const adminId = insertUser(ctx.db, {
    role: 'admin', status: 'active', email: 'overhead-admin@example.com',
  });
  adminUcId = insertUserClaimant(ctx.db, adminId, claimantId);
  projectId = insertProject(ctx.db, claimantId, { title: 'Overhead Project' });
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

function postOverhead(overrides = {}) {
  return callApi({
    method: 'POST', path: '/api/expenses', token: adminToken,
    body: {
      project_id: projectId,
      user_claimant_id: adminUcId,
      expense_date: '2025-03-15',
      category: 'overhead',
      amount_cents: 10_000,
      currency: 'CAD',
      description: 'office rent share',
      overhead_subcategory: 'rent',
      allocation_basis: '30% of total floor area',
      ...overrides,
    },
  });
}

test('POST category=overhead WITHOUT overhead_subcategory → 400', async () => {
  const res = await postOverhead({ overhead_subcategory: undefined });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.error?.message || '', /overhead_subcategory/i);
});

test('POST category=overhead WITHOUT allocation_basis → 400', async () => {
  const res = await postOverhead({ allocation_basis: undefined });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.error?.message || '', /allocation_basis/i);
});

test('POST category=overhead with empty-string allocation_basis → 400', async () => {
  const res = await postOverhead({ allocation_basis: '   ' });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.error?.message || '', /allocation_basis/i);
});

test('POST category=overhead with valid subcat + basis → 201, fields persisted', async () => {
  const res = await postOverhead();
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.category, 'overhead');
  assert.equal(res.body.overhead_subcategory, 'rent');
  assert.equal(res.body.allocation_basis, '30% of total floor area');
});

test('POST category=material with overhead_subcategory → 400', async () => {
  const res = await callApi({
    method: 'POST', path: '/api/expenses', token: adminToken,
    body: {
      project_id: projectId,
      user_claimant_id: adminUcId,
      expense_date: '2025-03-16',
      category: 'material',
      amount_cents: 5_000,
      currency: 'CAD',
      description: 'lab supply',
      overhead_subcategory: 'rent',
    },
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('POST category=overhead with subcat not in enum → 400', async () => {
  const res = await postOverhead({ overhead_subcategory: 'travel' });
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('PATCH overhead → material auto-clears overhead fields', async () => {
  const created = await postOverhead({ expense_date: '2025-03-17' });
  assert.equal(created.status, 201);
  const patched = await callApi({
    method: 'PATCH', path: `/api/expenses/${created.body.id}`, token: adminToken,
    // Migration 015 (P3.1): switching to material also requires the new
    // disposition field. The overhead → material auto-clear is what this
    // test cares about — we still need to provide a valid material body.
    body: { category: 'material', material_disposition: 'consumed' },
  });
  assert.equal(patched.status, 200, `expected 200, got ${patched.status}: ${JSON.stringify(patched.body)}`);
  assert.equal(patched.body.category, 'material');
  assert.equal(patched.body.overhead_subcategory, null);
  assert.equal(patched.body.allocation_basis, null);
});

test('PATCH supplying invalid overhead_subcategory on overhead row → 400', async () => {
  const created = await postOverhead({ expense_date: '2025-03-18' });
  assert.equal(created.status, 201);
  const patched = await callApi({
    method: 'PATCH', path: `/api/expenses/${created.body.id}`, token: adminToken,
    body: { overhead_subcategory: 'travel' },
  });
  assert.equal(patched.status, 400, `expected 400, got ${patched.status}: ${JSON.stringify(patched.body)}`);
});
