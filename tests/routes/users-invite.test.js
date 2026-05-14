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
  const adminId = insertUser(ctx.db, {
    role: 'admin', status: 'active', email: 'inviter@example.com',
  });
  targetUserId = insertUser(ctx.db, {
    role: 'admin', status: 'pending', email: 'target-admin@example.com',
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
