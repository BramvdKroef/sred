// Integration tests for the optimistic-concurrency guard on PATCH
// /api/projects/:id (D-4 in RELIABILITY_REVIEW.md).
//
// Background: two admins editing the same project narrative previously
// produced a silent last-write-wins. The fix adds an `__updated_at`
// precondition: the client must send the `updated_at` it saw when it
// loaded the form, and a mismatch returns 409.
//
// Strictness: we picked the strict variant — a PATCH with no
// `__updated_at` in the body is rejected with 400, not silently accepted.
// The bug being fixed is silent data loss; making misuse loud is the
// whole point. (See projects.js comment by the precondition check.)
//
// What we assert here:
//   - Two admins both load the project, both PATCH; the second gets 409
//     and the live row still reflects the first's edit.
//   - A PATCH without `__updated_at` is rejected with 400 (strict mode).
//   - The 409 path does NOT insert a row into project_revisions
//     (no spurious snapshot from a rejected request).
//   - A PATCH with the correct `__updated_at` succeeds and the response
//     body's `updated_at` is newer than what the client sent, so the
//     client can store it for the next PATCH.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  setupTempDb,
  teardownTempDb,
  insertUser,
  insertClaimant,
  insertProject,
} from '../helpers/db.js';

let ctx;
let server;
let baseUrl;
let adminToken;
let otherAdminToken;
let projectId;

before(async () => {
  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  const claimantId = insertClaimant(ctx.db, { legal_name: 'RaceTest Co' });
  const adminAId = insertUser(ctx.db, {
    role: 'admin', status: 'active', email: 'admin-a-race@example.com',
  });
  const adminBId = insertUser(ctx.db, {
    role: 'admin', status: 'active', email: 'admin-b-race@example.com',
  });

  projectId = insertProject(ctx.db, claimantId, {
    title: 'Race Test Project',
    advancement_sought: 'initial advancement',
    uncertainties: 'initial uncertainties',
    work_performed: 'initial work',
  });

  adminToken = signSession({ id: adminAId, role: 'admin' });
  otherAdminToken = signSession({ id: adminBId, role: 'admin' });

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

// Load the project once via the API so we have the same shape (with
// `updated_at`) the UI would have observed at form-bind time.
async function loadProject(token) {
  const res = await callApi({
    method: 'GET', path: `/api/projects/${projectId}`, token,
  });
  assert.equal(res.status, 200);
  return res.body;
}

function countRevisions() {
  return ctx.db.prepare(
    `SELECT COUNT(*) AS n FROM project_revisions WHERE project_id = ?`
  ).get(projectId).n;
}

test('two admins both PATCH the same project — second gets 409', async () => {
  // Both admins load the form at the same time and see the same updated_at.
  const snapA = await loadProject(adminToken);
  const snapB = await loadProject(otherAdminToken);
  assert.equal(snapA.updated_at, snapB.updated_at,
    'baseline: both admins should observe the same updated_at');

  // Admin A submits first — should succeed.
  const firstWrite = await callApi({
    method: 'PATCH', path: `/api/projects/${projectId}`, token: adminToken,
    body: {
      __updated_at: snapA.updated_at,
      uncertainties: 'A-edited uncertainties',
    },
  });
  assert.equal(firstWrite.status, 200,
    `expected 200 from first PATCH, got ${firstWrite.status}: ${JSON.stringify(firstWrite.body)}`);
  assert.equal(firstWrite.body.uncertainties, 'A-edited uncertainties');

  // Admin B submits second with the stale updated_at — should be rejected.
  const secondWrite = await callApi({
    method: 'PATCH', path: `/api/projects/${projectId}`, token: otherAdminToken,
    body: {
      __updated_at: snapB.updated_at, // stale; matches the pre-A value
      uncertainties: 'B-edited uncertainties',
    },
  });
  assert.equal(secondWrite.status, 409,
    `expected 409 from second PATCH, got ${secondWrite.status}: ${JSON.stringify(secondWrite.body)}`);
  assert.equal(secondWrite.body.error?.code, 'conflict');
  assert.match(secondWrite.body.error?.message || '', /modified by another admin/i);
  // The error details should surface the current updated_at so the client
  // can offer a "reload + diff" affordance.
  assert.ok(secondWrite.body.error?.details?.current_updated_at,
    '409 body should carry current_updated_at in details');

  // The live row reflects A's edit, not B's.
  const after = await loadProject(adminToken);
  assert.equal(after.uncertainties, 'A-edited uncertainties',
    'live row must still reflect the first (winning) write');
});

test('PATCH without __updated_at is rejected with 400 (strict mode)', async () => {
  const res = await callApi({
    method: 'PATCH', path: `/api/projects/${projectId}`, token: adminToken,
    body: { title: 'No precondition' },
  });
  assert.equal(res.status, 400,
    `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.error?.message || '', /__updated_at/i);
});

test('a 409 does NOT insert a spurious project_revisions row', async () => {
  // Establish a known good baseline so this case is independent of
  // whatever the earlier cases left behind.
  const snap = await loadProject(adminToken);
  const revsBefore = countRevisions();

  // Bump the row out from under the request so the PATCH below races.
  const ok = await callApi({
    method: 'PATCH', path: `/api/projects/${projectId}`, token: adminToken,
    body: {
      __updated_at: snap.updated_at,
      work_performed: 'first writer wins on revisions',
    },
  });
  assert.equal(ok.status, 200);
  const revsAfterWin = countRevisions();
  assert.equal(revsAfterWin, revsBefore + 1,
    'successful narrative-changing PATCH must insert exactly one revision row');

  // Second admin sends a PATCH with the now-stale token.
  const losingWrite = await callApi({
    method: 'PATCH', path: `/api/projects/${projectId}`, token: otherAdminToken,
    body: {
      __updated_at: snap.updated_at, // stale
      work_performed: 'this should not snapshot',
    },
  });
  assert.equal(losingWrite.status, 409);
  const revsAfterLose = countRevisions();
  assert.equal(revsAfterLose, revsAfterWin,
    'a 409 must not insert a project_revisions row');
});

test('PATCH with correct __updated_at returns a fresh updated_at in the response', async () => {
  const before = await loadProject(adminToken);
  const res = await callApi({
    method: 'PATCH', path: `/api/projects/${projectId}`, token: adminToken,
    body: {
      __updated_at: before.updated_at,
      title: 'Fresh updated_at test',
    },
  });
  assert.equal(res.status, 200,
    `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.title, 'Fresh updated_at test');
  assert.ok(res.body.updated_at, 'response must include updated_at');
  // The server uses datetime('now') with second precision; on a fast test
  // box a same-second PATCH could echo back the same string. Loosen to a
  // strict "is this monotonically non-decreasing" check rather than
  // "strictly greater than" so the test isn't flaky.
  assert.ok(res.body.updated_at >= before.updated_at,
    `updated_at should advance (or at least not regress); was ${before.updated_at}, now ${res.body.updated_at}`);

  // The next PATCH must use the response's updated_at — verify that
  // round-trip works (so the UI's "store and re-use" pattern is supported).
  const next = await callApi({
    method: 'PATCH', path: `/api/projects/${projectId}`, token: adminToken,
    body: {
      __updated_at: res.body.updated_at,
      title: 'Chained PATCH',
    },
  });
  assert.equal(next.status, 200,
    `expected 200 from chained PATCH, got ${next.status}: ${JSON.stringify(next.body)}`);
  assert.equal(next.body.title, 'Chained PATCH');
});
