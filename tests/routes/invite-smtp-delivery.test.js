// Tests for the N-1/N-2 fix in src/routes/users.js + src/lib/email.js:
// POST /api/users/:id/invite must AWAIT sendMagicLink (when SMTP is
// configured) and report `delivered` honestly. On send failure / timeout
// the response is `delivered:false` with a short `error` describing why,
// instead of the previous lying `delivered:true`.
//
// We exercise the failure path by pointing SMTP_HOST at a locally-bound
// port that is then immediately closed, so the underlying socket attempt
// fails fast (ECONNREFUSED on most platforms) — well under the 8s
// SEND_TIMEOUT_MS cap. The connectionTimeout on the transport is set to
// 5s as a defence-in-depth in case the OS holds the port open briefly.
//
// The success path is asserted indirectly through the existing
// users-invite.test.js (SMTP-disabled => delivered:false, no leak); a
// real-SMTP success test would require a captive mail server, which is
// out of scope here.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

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
let unreachablePort;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

before(async () => {
  // Reserve a port then release it; SMTP attempts to it should get
  // ECONNREFUSED almost immediately.
  unreachablePort = await findFreePort();

  // Force the SMTP-enabled-but-broken path. This MUST be set before the
  // dynamic imports below (config.js reads env at module load, and the
  // email module reads config at its own load).
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(unreachablePort);

  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  const adminId = insertUser(ctx.db, {
    role: 'admin', status: 'active', email: 'admin-smtp@example.com',
  });
  targetUserId = insertUser(ctx.db, {
    role: 'employee', status: 'pending', email: 'target-smtp@example.com',
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
  // Leave SMTP env so any test that runs after us in the same node process
  // sees a deterministic value. Other test files set SMTP_HOST='' in their
  // own `before`, so order independence holds.
});

test('POST /api/users/:id/invite reports delivered:false with an error when SMTP send fails', async () => {
  const res = await fetch(`${baseUrl}/api/users/${targetUserId}/invite`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const text = await res.text();
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${text}`);
  const body = JSON.parse(text);

  // The whole point of the fix: when the SMTP transport fails (here,
  // connection refused to a closed port), `delivered` must be false. The
  // pre-fix code returned `delivered: Boolean(config.smtp.host)` => true.
  assert.equal(body.delivered, false, `delivered must reflect actual outcome, got: ${text}`);

  // And the response carries a short `error` describing what happened —
  // so the admin UI can surface "couldn't reach SMTP, try again" rather
  // than silently claiming success.
  assert.ok(
    typeof body.error === 'string' && body.error.length > 0,
    `expected a non-empty error string, got: ${text}`,
  );

  // Required shape preserved across the failure path.
  assert.equal(body.user_id, targetUserId);
  assert.equal(body.purpose, 'invite');
  assert.ok(typeof body.expires_at === 'string' && body.expires_at.length > 0);

  // V-06: the raw magic link must NOT appear in the body even on failure.
  assert.equal(body.magic_link, undefined);
  assert.ok(!/\/enroll\?token=/.test(text), 'response must not leak the magic link on failure');

  // Audit row was still written even though the send failed — admins can
  // see who they tried to invite and re-trigger the flow from there.
  const row = ctx.db.prepare(
    `SELECT action, entity_id FROM audit_log
       WHERE entity_type = 'user' AND entity_id = ?
       ORDER BY id DESC LIMIT 1`
  ).get(targetUserId);
  assert.ok(row, 'expected an audit row even for a failed send');
  assert.equal(row.action, 'invite');
});
