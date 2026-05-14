// Tests for src/routes/projects.js — GET /api/projects/:id/revisions
//
// UC-A4 (sub-task 1): the project detail page now lists prior narrative
// revisions inline. To render `revised by <name>` without a second
// round-trip, the revisions endpoint joins `users` and additively
// exposes `revised_by_name` (and `manager_name` for the expanded panel).

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
let projectId;
let reviserName;
let managerName;

before(async () => {
  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  reviserName = 'Reviser Person';
  managerName = 'Manager Person';
  const adminId = insertUser(ctx.db, {
    role: 'admin', status: 'active',
    email: 'admin-rev@example.com', name: reviserName,
  });
  const managerId = insertUser(ctx.db, {
    role: 'manager', status: 'active',
    email: 'manager-rev@example.com', name: managerName,
  });
  const claimantId = insertClaimant(ctx.db);
  projectId = insertProject(ctx.db, claimantId, { title: 'Initial title' });

  // Seed two revisions so we exercise both newest-first ordering and the
  // join on revised_by_user_id. Manager column populated so the expanded
  // panel name resolution is also covered.
  ctx.db.prepare(`
    INSERT INTO project_revisions
      (project_id, title, field_of_science, advancement_sought, uncertainties,
       work_performed, type, manager_user_id, revised_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, 'First snapshot', 'cs', 'adv-1', 'unc-1', 'wp-1', 'sred', managerId, adminId);
  ctx.db.prepare(`
    INSERT INTO project_revisions
      (project_id, title, field_of_science, advancement_sought, uncertainties,
       work_performed, type, manager_user_id, revised_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, 'Second snapshot', 'cs', 'adv-2', 'unc-2', 'wp-2', 'sred', managerId, adminId);

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

test('GET /api/projects/:id/revisions exposes revised_by_name from the users join', async () => {
  const res = await fetch(`${baseUrl}/api/projects/${projectId}/revisions`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.items.length, 2);

  // Newest first (ORDER BY id DESC).
  assert.equal(body.items[0].title, 'Second snapshot');
  assert.equal(body.items[1].title, 'First snapshot');

  // Both rows expose the joined name. manager_name comes from the same
  // join and is consumed by the expanded panel; verify it too.
  for (const row of body.items) {
    assert.equal(row.revised_by_name, reviserName);
    assert.equal(row.manager_name, managerName);
    // Legacy fields stay untouched — UI and exporter both read these.
    assert.ok(Number.isInteger(row.revised_by_user_id));
    assert.equal(typeof row.revised_at, 'string');
  }
});
