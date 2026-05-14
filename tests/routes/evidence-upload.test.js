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

// --- content-sniff (V-05 follow-up) ----------------------------------------
//
// multer's fileFilter only checks the (attacker-controlled) Content-Type from
// the multipart envelope. The follow-up adds a magic-byte check via the
// `file-type` library AFTER the file lands on disk but BEFORE INSERT. The
// next four tests cover the matrix.

test('content-sniff: rejects a file with PDF Content-Type but HTML body', async () => {
  // This is the V-05 follow-up's headline case: an attacker submits a .html
  // page (executable in a browser) with a Content-Type of application/pdf
  // so the multer allowlist lets it through. The content sniff must reject.
  const htmlBytes = Buffer.from('<!DOCTYPE html><script>fetch("/api/users/1")</script>');

  const form = buildForm({
    buffer: htmlBytes,
    mime: 'application/pdf',
    filename: 'looks-like.pdf',
    fields: {
      project_id: String(projectId),
      kind: 'file',
      caption: 'sneaky-2',
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
  // The route raises "file content does not match supplied type: …" when
  // file-type has no signature for the content but the supplied MIME isn't
  // in the text family. Match the route's wording loosely.
  assert.match(body.error.message, /does not match supplied type/);

  // Nothing in the DB, nothing on disk.
  const rows = ctx.db.prepare(`SELECT COUNT(*) AS n FROM evidence_items`).get();
  assert.equal(rows.n, 0);
  assert.deepEqual(fs.readdirSync(uploadsDir), []);
});

test('content-sniff: zip Content-Type with PDF body accepts and normalises to .pdf', async () => {
  // Behaviour chosen: when the SUPPLIED and DETECTED MIMEs are both in the
  // allowlist, the detected one wins and the on-disk extension is normalised
  // to match. This keeps the stored extension truthful for an admin who
  // later double-clicks the bundle, even if the uploader's Content-Type was
  // off by a category.
  const pdfBytes = Buffer.from('%PDF-1.4\n%fake content-sniff\n%%EOF\n');

  const form = buildForm({
    buffer: pdfBytes,
    mime: 'application/zip',
    filename: 'archive.zip',
    fields: {
      project_id: String(projectId),
      kind: 'file',
      caption: 'mislabelled-as-zip',
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

  // file_mime in the DB reflects the detected (truthful) type.
  assert.equal(body.file_mime, 'application/pdf');
  // The stored extension is .pdf, not .zip.
  assert.ok(body.file_path.endsWith('.pdf'), `expected .pdf, got ${body.file_path}`);
  // The file is on disk under the renamed name.
  assert.ok(
    fs.existsSync(path.join(uploadsDir, body.file_path)),
    'renamed file should exist on disk'
  );
  // No stray .zip-extensioned file left behind from multer's original write.
  const stray = fs.readdirSync(uploadsDir).filter(f => f.endsWith('.zip'));
  assert.deepEqual(stray, [], 'no .zip-extensioned stray should remain');
});

test('content-sniff: text/plain with no magic bytes is accepted (text-family exception)', async () => {
  // file-type returns nothing for plain text files (no magic header). The
  // route must treat the supplied MIME as authoritative for text-family
  // types only.
  const textBytes = Buffer.from('hello, this is some plain text content.\n');

  const form = buildForm({
    buffer: textBytes,
    mime: 'text/plain',
    filename: 'notes.txt',
    fields: {
      project_id: String(projectId),
      kind: 'file',
      caption: 'lab notes',
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
  assert.equal(body.file_mime, 'text/plain');
  assert.ok(body.file_path.endsWith('.txt'), `expected .txt, got ${body.file_path}`);
  assert.ok(
    fs.existsSync(path.join(uploadsDir, body.file_path)),
    'stored text file should exist on disk'
  );
});
