// Route-layer round-trip for the migration-016 audit-defensibility fields
// on `projects` (SRED_DOMAIN_REVIEW.md P3): `hypothesis` and
// `uncertainty_identified_at`.
//
// Schema invariants are covered in tests/db/project-audit-fields.test.js.
// This file proves the routes:
//
//   - POST /api/claimants/:id/projects accepts the two fields, persists
//     them on the project row, AND snapshots them on the initial
//     project_revisions row (UC-A4 snapshot contract).
//   - PATCH /api/projects/:id accepts the two fields, updates them, AND
//     when they change (narrative-shaped), inserts a new
//     project_revisions row with the updated values.
//   - PATCH validates the ISO-date shape on `uncertainty_identified_at`
//     before the SQL fires, so a malformed value returns 400 (not a 500
//     wrapped around a CHECK violation).
//   - Both fields are optional on create — omitting them returns 201 and
//     stores NULL on both columns.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  setupTempDb,
  teardownTempDb,
  insertUser,
  insertClaimant,
} from '../helpers/db.js';

let ctx;
let server;
let baseUrl;
let adminToken;
let adminId;
let claimantId;

before(async () => {
  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  adminId = insertUser(ctx.db, {
    role: 'admin', status: 'active', email: 'admin-audit-fields@example.com',
  });
  claimantId = insertClaimant(ctx.db, { legal_name: 'AuditFields Co' });
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
  const init = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('POST /api/claimants/:id/projects round-trips hypothesis + uncertainty_identified_at', async () => {
  const res = await callApi({
    method: 'POST',
    path: `/api/claimants/${claimantId}/projects`,
    token: adminToken,
    body: {
      title: 'Streaming Graph Inference',
      start_date: '2024-01-01',
      status: 'development',
      type: 'sred',
      advancement_sought: 'Sub-second correlation across multi-tenant deployment.',
      uncertainties: 'Whether streaming graph inference converges fast enough is unproven.',
      work_performed: 'Prototyped a Flink pipeline; measured precision/recall.',
      hypothesis: 'A token-bucket variant with online capacity estimation will converge under correlated churn.',
      uncertainty_identified_at: '2024-02-14',
    },
  });
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.hypothesis,
    'A token-bucket variant with online capacity estimation will converge under correlated churn.');
  assert.equal(res.body.uncertainty_identified_at, '2024-02-14');

  // The initial project_revisions row must carry both fields too — that's
  // the snapshot contract (a later narrative edit creates a new row; the
  // first row is the "as-created" baseline).
  const rev = ctx.db.prepare(`
    SELECT * FROM project_revisions WHERE project_id = ? ORDER BY id DESC LIMIT 1
  `).get(res.body.id);
  assert.ok(rev, 'initial project_revisions row should exist');
  assert.equal(rev.hypothesis, res.body.hypothesis);
  assert.equal(rev.uncertainty_identified_at, '2024-02-14');
});

test('POST /api/claimants/:id/projects accepts omitted audit fields (defaults to NULL)', async () => {
  const res = await callApi({
    method: 'POST',
    path: `/api/claimants/${claimantId}/projects`,
    token: adminToken,
    body: {
      title: 'No audit fields',
      start_date: '2024-01-01',
      status: 'development',
      type: 'sred',
    },
  });
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.hypothesis, null);
  assert.equal(res.body.uncertainty_identified_at, null);
});

test('POST /api/claimants/:id/projects rejects malformed uncertainty_identified_at', async () => {
  const res = await callApi({
    method: 'POST',
    path: `/api/claimants/${claimantId}/projects`,
    token: adminToken,
    body: {
      title: 'Bad date',
      start_date: '2024-01-01',
      status: 'development',
      type: 'sred',
      uncertainty_identified_at: 'not-a-date',
    },
  });
  assert.equal(res.status, 400,
    `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.error?.message || '', /uncertainty_identified_at/);
});

test('PATCH /api/projects/:id round-trips both fields and snapshots a new revision', async () => {
  // Seed a fresh project so the revisions count is predictable.
  const created = await callApi({
    method: 'POST',
    path: `/api/claimants/${claimantId}/projects`,
    token: adminToken,
    body: {
      title: 'Patch round-trip',
      start_date: '2024-01-01',
      status: 'development',
      type: 'sred',
      advancement_sought: 'orig',
      uncertainties: 'orig',
      work_performed: 'orig',
    },
  });
  assert.equal(created.status, 201);
  const project = created.body;
  const revsBefore = ctx.db.prepare(
    `SELECT COUNT(*) AS n FROM project_revisions WHERE project_id = ?`
  ).get(project.id).n;

  const patched = await callApi({
    method: 'PATCH',
    path: `/api/projects/${project.id}`,
    token: adminToken,
    body: {
      __updated_at: project.updated_at,
      hypothesis: 'Hypothesis added after the fact during a narrative pass.',
      uncertainty_identified_at: '2024-04-22',
    },
  });
  assert.equal(patched.status, 200,
    `expected 200, got ${patched.status}: ${JSON.stringify(patched.body)}`);
  assert.equal(patched.body.hypothesis,
    'Hypothesis added after the fact during a narrative pass.');
  assert.equal(patched.body.uncertainty_identified_at, '2024-04-22');

  // A narrative-shaped change (hypothesis is in SNAPSHOT_FIELDS) must insert
  // a new project_revisions row carrying the updated values.
  const revsAfter = ctx.db.prepare(
    `SELECT COUNT(*) AS n FROM project_revisions WHERE project_id = ?`
  ).get(project.id).n;
  assert.equal(revsAfter, revsBefore + 1,
    'PATCH that changes hypothesis must insert exactly one new revision row');

  const latestRev = ctx.db.prepare(`
    SELECT * FROM project_revisions WHERE project_id = ? ORDER BY id DESC LIMIT 1
  `).get(project.id);
  assert.equal(latestRev.hypothesis,
    'Hypothesis added after the fact during a narrative pass.');
  assert.equal(latestRev.uncertainty_identified_at, '2024-04-22');
});

test('PATCH /api/projects/:id rejects malformed uncertainty_identified_at with 400', async () => {
  // Re-use a project from an earlier test by hitting list + take the last.
  const list = await callApi({
    method: 'GET', path: `/api/claimants/${claimantId}/projects`, token: adminToken,
  });
  const project = list.body.items[0];
  const fresh = await callApi({
    method: 'GET', path: `/api/projects/${project.id}`, token: adminToken,
  });
  const res = await callApi({
    method: 'PATCH',
    path: `/api/projects/${project.id}`,
    token: adminToken,
    body: {
      __updated_at: fresh.body.updated_at,
      uncertainty_identified_at: '2024/04/22', // wrong separator
    },
  });
  assert.equal(res.status, 400,
    `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.error?.message || '', /uncertainty_identified_at/);
});

test('PATCH /api/projects/:id accepts explicit null on both audit fields', async () => {
  const created = await callApi({
    method: 'POST',
    path: `/api/claimants/${claimantId}/projects`,
    token: adminToken,
    body: {
      title: 'Patch-to-null',
      start_date: '2024-01-01',
      status: 'development',
      type: 'sred',
      hypothesis: 'preset',
      uncertainty_identified_at: '2024-05-05',
    },
  });
  assert.equal(created.status, 201);
  const res = await callApi({
    method: 'PATCH',
    path: `/api/projects/${created.body.id}`,
    token: adminToken,
    body: {
      __updated_at: created.body.updated_at,
      hypothesis: null,
      uncertainty_identified_at: null,
    },
  });
  assert.equal(res.status, 200,
    `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.hypothesis, null);
  assert.equal(res.body.uncertainty_identified_at, null);
});
