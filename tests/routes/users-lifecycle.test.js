// Tests for src/routes/users.js — deactivate / reactivate symmetry.
//
// Scenario: deactivate must bulk-flip user_claimants alongside the user, and
// reactivate must mirror that — but only for attachments that were taken
// inactive by the same user-level deactivate (tracked via the
// `deactivated_with_user_id` marker added in migration 012). Attachments
// that were already inactive at the time of deactivate keep their state on
// reactivate.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  setupTempDb,
  teardownTempDb,
  insertUser,
  insertClaimant,
  insertUserClaimant,
} from '../helpers/db.js';

let ctx;
let server;
let baseUrl;
let adminToken;

before(async () => {
  process.env.SMTP_HOST = '';
  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  const adminId = insertUser(ctx.db, {
    role: 'admin', status: 'active', email: 'lifecycle-admin@example.com',
  });
  adminToken = signSession({ id: adminId, role: 'admin' });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRouter);
  app.use(errorMiddleware);
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  teardownTempDb(ctx);
});

async function postJson(path) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function ucRow(id) {
  return ctx.db.prepare(
    `SELECT id, status, deactivated_with_user_id FROM user_claimants WHERE id = ?`
  ).get(id);
}

test('deactivate flips all active attachments inactive and tags them; reactivate flips back + clears tag', async () => {
  const userId = insertUser(ctx.db, {
    role: 'employee', email: 'emp-roundtrip@example.com', status: 'active',
  });
  const claimantA = insertClaimant(ctx.db, { legal_name: 'A Co', business_number: 'A123' });
  const claimantB = insertClaimant(ctx.db, { legal_name: 'B Co', business_number: 'B456' });
  const ucA = insertUserClaimant(ctx.db, userId, claimantA);
  const ucB = insertUserClaimant(ctx.db, userId, claimantB);

  // Sanity: both attachments start active with no marker.
  assert.equal(ucRow(ucA).status, 'active');
  assert.equal(ucRow(ucA).deactivated_with_user_id, null);
  assert.equal(ucRow(ucB).status, 'active');
  assert.equal(ucRow(ucB).deactivated_with_user_id, null);

  // Deactivate.
  const deact = await postJson(`/api/users/${userId}/deactivate`);
  assert.equal(deact.status, 200);
  assert.equal(deact.body.status, 'disabled');

  // Both attachments now inactive and tagged with the user_id.
  assert.equal(ucRow(ucA).status, 'inactive');
  assert.equal(ucRow(ucA).deactivated_with_user_id, userId);
  assert.equal(ucRow(ucB).status, 'inactive');
  assert.equal(ucRow(ucB).deactivated_with_user_id, userId);

  // Reactivate.
  const react = await postJson(`/api/users/${userId}/reactivate`);
  assert.equal(react.status, 200);
  assert.equal(react.body.status, 'active');

  // Both attachments flipped back to active and the marker cleared.
  assert.equal(ucRow(ucA).status, 'active');
  assert.equal(ucRow(ucA).deactivated_with_user_id, null);
  assert.equal(ucRow(ucB).status, 'active');
  assert.equal(ucRow(ucB).deactivated_with_user_id, null);
});

test('reactivate does NOT touch attachments that were already inactive at the time of deactivate', async () => {
  const userId = insertUser(ctx.db, {
    role: 'employee', email: 'emp-partial@example.com', status: 'active',
  });
  const claimantA = insertClaimant(ctx.db, { legal_name: 'A2 Co', business_number: 'A789' });
  const claimantB = insertClaimant(ctx.db, { legal_name: 'B2 Co', business_number: 'B987' });
  const ucA = insertUserClaimant(ctx.db, userId, claimantA);
  // ucB starts already inactive (e.g., employee left this claimant). No marker.
  const ucB = insertUserClaimant(ctx.db, userId, claimantB, { status: 'inactive' });
  assert.equal(ucRow(ucB).status, 'inactive');
  assert.equal(ucRow(ucB).deactivated_with_user_id, null);

  // Deactivate the user.
  const deact = await postJson(`/api/users/${userId}/deactivate`);
  assert.equal(deact.status, 200);

  // ucA: was active → now inactive + tagged.
  assert.equal(ucRow(ucA).status, 'inactive');
  assert.equal(ucRow(ucA).deactivated_with_user_id, userId);
  // ucB: already inactive → stays inactive, no tag added.
  assert.equal(ucRow(ucB).status, 'inactive');
  assert.equal(ucRow(ucB).deactivated_with_user_id, null);

  // Reactivate.
  const react = await postJson(`/api/users/${userId}/reactivate`);
  assert.equal(react.status, 200);
  assert.equal(react.body.status, 'active');

  // ucA: flipped back to active, tag cleared.
  assert.equal(ucRow(ucA).status, 'active');
  assert.equal(ucRow(ucA).deactivated_with_user_id, null);
  // ucB: stays inactive — admin must re-activate it explicitly if desired.
  assert.equal(ucRow(ucB).status, 'inactive');
  assert.equal(ucRow(ucB).deactivated_with_user_id, null);
});
