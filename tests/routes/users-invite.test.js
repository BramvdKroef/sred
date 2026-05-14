// Tests for src/routes/users.js — POST /:id/invite response shape.
//
// V-06 fix: the response body MUST NOT include the raw magic_link. It must
// include user_id, purpose, and expires_at so the admin UI can show when
// the link expires. A `delivered` boolean is also surfaced (true when SMTP
// is configured, false in the dev / log-only path).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  setupTempDb,
  teardownTempDb,
  insertUser,
} from '../helpers/db.js';

let ctx;
let server;
let baseUrl;
let adminToken;
let adminUserId;
let targetUserId;

before(async () => {
  // Force the SMTP-disabled path (default in tests anyway, but make it
  // explicit so we're testing the dev branch that previously leaked the
  // link in the body).
  process.env.SMTP_HOST = '';

  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  // An admin who calls /invite, and a target user (also admin) who is being
  // invited — the exact V-06 scenario (admin inviting another admin).
  adminUserId = insertUser(ctx.db, {
    role: 'admin', status: 'active', email: 'inviter@example.com',
  });
  targetUserId = insertUser(ctx.db, {
    role: 'admin', status: 'pending', email: 'target-admin@example.com',
  });

  adminToken = signSession({ id: adminUserId, role: 'admin' });

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

test('POST /api/users/:id/invite does not leak magic_link and returns user_id/purpose/expires_at', async () => {
  const res = await fetch(`${baseUrl}/api/users/${targetUserId}/invite`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const text = await res.text();
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${text}`);
  const body = JSON.parse(text);

  // The raw magic link must NOT appear anywhere in the body — even with
  // SMTP disabled, it goes to stderr only.
  assert.equal(body.magic_link, undefined, 'magic_link must not be in response');
  // Also defensively check the serialised form for any /enroll?token=… url.
  const raw = JSON.stringify(body);
  assert.ok(
    !/\/enroll\?token=/.test(raw),
    `serialised body must not contain a magic link: ${raw}`
  );

  // Required fields are present.
  assert.equal(body.user_id, targetUserId);
  assert.equal(body.purpose, 'invite'); // target was 'pending'
  assert.ok(typeof body.expires_at === 'string' && body.expires_at.length > 0);

  // SMTP disabled => delivered:false.
  assert.equal(body.delivered, false);

  // The token row was actually minted (we just don't expose the raw value).
  const row = ctx.db.prepare(
    `SELECT user_id, purpose FROM email_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1`
  ).get(targetUserId);
  assert.equal(row.user_id, targetUserId);
  assert.equal(row.purpose, 'invite');
});

test('POST /api/users/:id/invite rejects self-invite with 400', async () => {
  // An admin can't mint a passkey-enrollment / add-device link for their
  // own account. The recovery flow exists for the locked-out case.
  const before = ctx.db.prepare(`SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = ?`).get(adminUserId).n;

  const res = await fetch(`${baseUrl}/api/users/${adminUserId}/invite`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const text = await res.text();
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${text}`);
  const body = JSON.parse(text);
  assert.match(body.error?.message || '', /yourself/i);

  // No token should have been minted.
  const after = ctx.db.prepare(`SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = ?`).get(adminUserId).n;
  assert.equal(after, before, 'self-invite must not mint a token');
});

test('POST /api/users/:id/invite writes audit row with target email + role in after_json', async () => {
  // Snapshot before so we can pick out the exact row this call appended.
  const beforeId = ctx.db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM audit_log`).get().m;

  const res = await fetch(`${baseUrl}/api/users/${targetUserId}/invite`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);

  const row = ctx.db.prepare(
    `SELECT action, entity_type, entity_id, after_json
       FROM audit_log
      WHERE id > ? AND entity_type = 'user' AND entity_id = ?
      ORDER BY id DESC LIMIT 1`
  ).get(beforeId, targetUserId);
  assert.ok(row, 'expected an audit row for the invite');
  // Action mirrors the purpose (invite vs add_device); target is pending so 'invite'.
  assert.equal(row.action, 'invite');
  assert.ok(row.after_json, 'after_json must be populated for invite audit');
  const after = JSON.parse(row.after_json);
  assert.equal(after.email, 'target-admin@example.com');
  assert.equal(after.role, 'admin');
});
