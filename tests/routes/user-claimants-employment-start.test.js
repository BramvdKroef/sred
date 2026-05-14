// Tests for UC-A3 employment_start_date plumbing:
//   1. POST /api/users with attachments[0].employment_start_date persists it
//      on user_claimants and surfaces it on GET /api/users/:id.
//   2. POST /api/users/:id/attachments accepts the same field.
//   3. PATCH /api/user-claimants/:id can update it.

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
let claimantId;

before(async () => {
  process.env.SMTP_HOST = '';

  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  const adminId = insertUser(ctx.db, {
    role: 'admin', status: 'active', email: 'admin-uc-a3@example.com',
  });
  claimantId = insertClaimant(ctx.db);
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
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function patchJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function getJson(path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('POST /api/users persists attachment employment_start_date and GET surfaces it', async () => {
  const create = await postJson('/api/users', {
    email: 'employee-a3@example.com',
    name: 'Alice',
    role: 'employee',
    attachments: [{
      claimant_id: claimantId,
      title: 'Engineer',
      is_specified_employee: false,
      employment_start_date: '2024-06-15',
      compensation: {
        comp_type: 'salary',
        amount_cents: 9_500_000,
        effective_from: '2024-06-15',
      },
    }],
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body.id;

  // Surfaced on GET.
  const fetched = await getJson(`/api/users/${userId}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.attachments.length, 1);
  assert.equal(fetched.body.attachments[0].employment_start_date, '2024-06-15');
  assert.equal(fetched.body.attachments[0].title, 'Engineer');

  // And actually stored on the row, not just in the response shape.
  const row = ctx.db.prepare(
    `SELECT employment_start_date FROM user_claimants WHERE id = ?`
  ).get(fetched.body.attachments[0].id);
  assert.equal(row.employment_start_date, '2024-06-15');
});

test('POST /api/users/:id/attachments accepts employment_start_date for alt flow A3.a', async () => {
  const userId = insertUser(ctx.db, {
    email: 'employee-a3-attach@example.com', role: 'employee', status: 'active',
  });
  const claimant2 = insertClaimant(ctx.db, { legal_name: 'Beta Co' });

  const r = await postJson(`/api/users/${userId}/attachments`, {
    claimant_id: claimant2,
    title: 'Researcher',
    is_specified_employee: false,
    employment_start_date: '2023-01-09',
    compensation: {
      comp_type: 'salary',
      amount_cents: 7_500_000,
      effective_from: '2023-01-09',
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.employment_start_date, '2023-01-09');
});

test('PATCH /api/user-claimants/:id updates employment_start_date', async () => {
  // Seed an attachment with no start date set.
  const userId = insertUser(ctx.db, {
    email: 'employee-a3-patch@example.com', role: 'employee', status: 'active',
  });
  const ucId = ctx.db.prepare(`
    INSERT INTO user_claimants (user_id, claimant_id, title, is_specified_employee, status)
    VALUES (?, ?, ?, 0, 'active')
  `).run(userId, claimantId, 'IC').lastInsertRowid;

  const r = await patchJson(`/api/user-claimants/${ucId}`, {
    employment_start_date: '2022-04-01',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.employment_start_date, '2022-04-01');

  // Setting back to null clears it.
  const r2 = await patchJson(`/api/user-claimants/${ucId}`, {
    employment_start_date: null,
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.employment_start_date, null);
});

test('POST /api/users rejects non-string employment_start_date', async () => {
  const r = await postJson('/api/users', {
    email: 'rejected-a3@example.com',
    name: 'X',
    role: 'employee',
    attachments: [{
      claimant_id: claimantId,
      employment_start_date: 12345,  // invalid type
      compensation: {
        comp_type: 'salary',
        amount_cents: 1,
        effective_from: '2024-01-01',
      },
    }],
  });
  assert.equal(r.status, 400);
});
