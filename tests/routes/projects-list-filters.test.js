// Tests for src/routes/projects.js — GET /api/projects filters.
//
// The admin projects list endpoint supports an AND-combined filter set:
//   - q (title/claimant LIKE)
//   - status (enum: concept|development|complete)
//   - type   (enum: sred|internal)
//   - claimant_id      (integer FK)
//   - manager_user_id  (integer FK on p.manager_user_id)
//
// We seed two claimants × multiple projects so each filter individually
// changes the result set, and so AND-combining two filters narrows it
// further. We also assert the 400 paths for bad enum and non-integer ids.

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
let claimantA, claimantB;
let managerA, managerB;
let projAlpha, projBeta, projGamma, projDelta;

before(async () => {
  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  const adminId = insertUser(ctx.db, {
    role: 'admin', status: 'active', email: 'admin-pf@example.com',
  });
  managerA = insertUser(ctx.db, {
    role: 'manager', status: 'active', email: 'mgr-a-pf@example.com',
  });
  managerB = insertUser(ctx.db, {
    role: 'manager', status: 'active', email: 'mgr-b-pf@example.com',
  });

  claimantA = insertClaimant(ctx.db, { legal_name: 'Alpha Claimant' });
  claimantB = insertClaimant(ctx.db, { legal_name: 'Bravo Claimant' });

  // Claimant A: two SR&ED projects, one Internal — covering all three statuses.
  projAlpha = insertProject(ctx.db, claimantA, {
    title: 'Alpha SR&ED Concept', status: 'concept', type: 'sred',
  });
  projBeta = insertProject(ctx.db, claimantA, {
    title: 'Alpha SR&ED Development', status: 'development', type: 'sred',
  });
  projGamma = insertProject(ctx.db, claimantA, {
    title: 'Alpha Internal Complete', status: 'complete', type: 'internal',
  });
  // Claimant B: one SR&ED with manager assigned, to exercise manager_user_id.
  projDelta = insertProject(ctx.db, claimantB, {
    title: 'Bravo SR&ED Development', status: 'development', type: 'sred',
  });

  // Attach managers post-insert: insertProject helper doesn't set
  // manager_user_id directly, and that column is what manager_user_id
  // filter matches on.
  ctx.db.prepare(`UPDATE projects SET manager_user_id = ? WHERE id = ?`)
    .run(managerA, projBeta);
  ctx.db.prepare(`UPDATE projects SET manager_user_id = ? WHERE id = ?`)
    .run(managerB, projDelta);

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

async function listProjects(query) {
  const res = await fetch(`${baseUrl}/api/projects${query}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  return { status: res.status, body: await res.json() };
}

test('GET /api/projects: status filter returns only matching status', async () => {
  const { status, body } = await listProjects('?status=development');
  assert.equal(status, 200);
  const ids = body.items.map(p => p.id).sort();
  assert.deepEqual(ids, [projBeta, projDelta].sort());
});

test('GET /api/projects: type filter returns only matching type', async () => {
  const { status, body } = await listProjects('?type=internal');
  assert.equal(status, 200);
  const ids = body.items.map(p => p.id);
  assert.deepEqual(ids, [projGamma]);
});

test('GET /api/projects: claimant_id filter scopes to one claimant', async () => {
  const { status, body } = await listProjects(`?claimant_id=${claimantA}`);
  assert.equal(status, 200);
  const ids = body.items.map(p => p.id).sort();
  assert.deepEqual(ids, [projAlpha, projBeta, projGamma].sort());
});

test('GET /api/projects: manager_user_id filter returns only that manager\'s projects', async () => {
  const { status, body } = await listProjects(`?manager_user_id=${managerA}`);
  assert.equal(status, 200);
  const ids = body.items.map(p => p.id);
  assert.deepEqual(ids, [projBeta]);
});

test('GET /api/projects: two filters AND-combine (claimant_id + status)', async () => {
  const { status, body } = await listProjects(
    `?claimant_id=${claimantA}&status=concept`,
  );
  assert.equal(status, 200);
  const ids = body.items.map(p => p.id);
  assert.deepEqual(ids, [projAlpha]);
});

test('GET /api/projects: two filters AND-combine (type + status)', async () => {
  const { status, body } = await listProjects('?type=sred&status=development');
  assert.equal(status, 200);
  const ids = body.items.map(p => p.id).sort();
  assert.deepEqual(ids, [projBeta, projDelta].sort());
});

test('GET /api/projects: bad status enum -> 400', async () => {
  const { status, body } = await listProjects('?status=wibble');
  assert.equal(status, 400);
  assert.equal(body.error.code, 'bad_request');
  assert.match(body.error.message, /status must be/);
});

test('GET /api/projects: bad type enum -> 400', async () => {
  const { status, body } = await listProjects('?type=garbage');
  assert.equal(status, 400);
  assert.equal(body.error.code, 'bad_request');
  assert.match(body.error.message, /type must be/);
});

test('GET /api/projects: non-integer claimant_id -> 400', async () => {
  const { status, body } = await listProjects('?claimant_id=abc');
  assert.equal(status, 400);
  assert.equal(body.error.code, 'bad_request');
  assert.match(body.error.message, /claimant_id must be an integer/);
});

test('GET /api/projects: non-integer manager_user_id -> 400', async () => {
  const { status, body } = await listProjects('?manager_user_id=1.5');
  assert.equal(status, 400);
  assert.equal(body.error.code, 'bad_request');
  assert.match(body.error.message, /manager_user_id must be an integer/);
});

test('GET /api/projects: empty filter values are ignored (returns full list)', async () => {
  const { status, body } = await listProjects('?status=&type=&claimant_id=&manager_user_id=');
  assert.equal(status, 200);
  // Four seeded projects — empty values shouldn't trigger validation.
  assert.equal(body.items.length, 4);
});
