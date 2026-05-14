// Tests for src/routes/evidence.js — multipart upload MIME allowlist.
//
// V-05 fix: the route must reject any file whose Content-Type is not in the
// allowlist (PDF / common image / plain text / CSV / markdown / common Office
// docs / zip). Anything else (HTML, SVG, executables, …) is a 400 and is
// never written to disk.
//
// Strategy:
//   - Stand up the real express app on a random port via the helpers in
//     setupTempDb (so the production db module is wired to the temp file).
//   - Seed an admin user, mint a JWT for them.
//   - POST multipart bodies (PDF, then HTML) through real HTTP and assert
//     the response status + the on-disk state of `uploads/`.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

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
let uploadsDir;
let projectId;

before(async () => {
  // Point uploads at a fresh tmp dir so we can inspect what (if anything)
  // landed on disk after each test.
  uploadsDir = path.join(
    os.tmpdir(),
    `sred-test-uploads-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  );
  fs.mkdirSync(uploadsDir, { recursive: true });
  process.env.UPLOADS_DIR = uploadsDir;

  ctx = await setupTempDb();

  // Now that env is locked in, import the production modules.
  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  // Seed an admin + claimant + period + project so the evidence POST has a
  // valid target.
  const adminId = insertUser(ctx.db, { role: 'admin', status: 'active', email: 'admin-evidence@example.com' });
  const claimantId = insertClaimant(ctx.db);
  insertFiscalPeriod(ctx.db, claimantId, {
    start_date: '2025-01-01', end_date: '2025-12-31', status: 'open',
  });
  insertUserClaimant(ctx.db, adminId, claimantId);
  projectId = insertProject(ctx.db, claimantId);

  adminToken = signSession({ id: adminId, role: 'admin' });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRouter);
  app.use(errorMiddleware);

  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  teardownTempDb(ctx);
  try { fs.rmSync(uploadsDir, { recursive: true, force: true }); } catch { /* */ }
});

beforeEach(() => {
  // Clean up any files left from a previous test so the on-disk assertions
  // are unambiguous.
  for (const f of fs.readdirSync(uploadsDir)) {
    fs.unlinkSync(path.join(uploadsDir, f));
  }
  // Wipe evidence rows too (the per-test fixture below inserts via HTTP).
  ctx.db.exec(`DELETE FROM evidence_items`);
});

function buildForm({ buffer, mime, filename, fields }) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([buffer], { type: mime }), filename);
  return fd;
}

test('accepts a PDF upload and stores it with a .pdf extension', async () => {
  // Minimal "PDF" — multer only inspects the Content-Type from multipart,
  // not the magic bytes. The fix's job is to enforce the MIME header.
  const pdfBytes = Buffer.from('%PDF-1.4\n%fake pdf for test\n%%EOF\n');

  const form = buildForm({
    buffer: pdfBytes,
    mime: 'application/pdf',
    filename: 'evidence.pdf',
    fields: {
      project_id: String(projectId),
      kind: 'file',
      caption: 'A receipt',
      evidence_date: '2025-03-15',
    },
  });

  const res = await fetch(`${baseUrl}/api/evidence`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: form,
  });
  const text = await res.text();
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${text}`);
  const body = JSON.parse(text);
  assert.equal(body.kind, 'file');
  assert.equal(body.file_mime, 'application/pdf');
  assert.ok(body.file_path, 'file_path should be set');
  assert.ok(body.file_path.endsWith('.pdf'), `file_path should end with .pdf: ${body.file_path}`);

  // The file is on disk under uploadsDir.
  assert.ok(
    fs.existsSync(path.join(uploadsDir, body.file_path)),
    'stored file should exist on disk'
  );
});

test('rejects an HTML upload with a 400 and writes nothing to disk', async () => {
  const htmlBytes = Buffer.from('<script>alert(1)</script>');

  const form = buildForm({
    buffer: htmlBytes,
    mime: 'text/html',
    filename: 'pwn.html',
    fields: {
      project_id: String(projectId),
      kind: 'file',
      caption: 'oops',
      evidence_date: '2025-03-15',
    },
  });

  const res = await fetch(`${baseUrl}/api/evidence`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: form,
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'bad_request');
  assert.match(body.error.message, /not allowed/);

  // No row inserted.
  const rows = ctx.db.prepare(`SELECT COUNT(*) AS n FROM evidence_items`).get();
  assert.equal(rows.n, 0);

  // No file landed on disk.
  assert.deepEqual(fs.readdirSync(uploadsDir), []);
});

test('normalises the stored extension from MIME, ignoring the originalname extension', async () => {
  // Attacker submits a file named pwn.html but with a PDF MIME. The route
  // must NOT trust the originalname — the stored extension comes from the
  // allowlisted MIME instead.
  const pdfBytes = Buffer.from('%PDF-1.4\n%fake\n%%EOF\n');

  const form = buildForm({
    buffer: pdfBytes,
    mime: 'application/pdf',
    filename: 'pwn.html',
    fields: {
      project_id: String(projectId),
      kind: 'file',
      caption: 'sneaky',
      evidence_date: '2025-03-15',
    },
  });

  const res = await fetch(`${baseUrl}/api/evidence`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: form,
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.file_path.endsWith('.pdf'), `expected .pdf, got ${body.file_path}`);
  assert.ok(!body.file_path.includes('.html'), 'stored name must not retain .html');
});
