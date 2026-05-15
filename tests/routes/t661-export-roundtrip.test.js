// Route-level integration tests for src/routes/exports.js.
//
// Verifies the T661 export round-trip: POST creates an export row + writes
// totals to the DB; GET download returns sensible content for each of the
// four formats; POST evidence-package builds a zip and GET evidence-package
// streams it back; cross-claimant period mismatch is a 400.
//
// Strategy mirrors tests/routes/evidence-upload.test.js — stand up the real
// express app on a random port via setupTempDb, mint an admin JWT,
// drive requests via fetch.

import { test, before, after } from 'node:test';
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
  insertCompRow,
  insertProject,
  insertLabourEntry,
  insertExpense,
} from '../helpers/db.js';

let ctx;
let server;
let baseUrl;
let adminToken;
let claimantId;
let otherClaimantId;
let periodId;
let otherPeriodId;
let projectTitle;
let uploadsDir;
let bundlesDir;

before(async () => {
  // The exports route creates a bundles dir relative to config.uploadsDir.
  // Point uploads at a fresh tmp dir so the zip lands somewhere we can clean up.
  uploadsDir = path.join(
    os.tmpdir(),
    `sred-test-uploads-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  );
  fs.mkdirSync(uploadsDir, { recursive: true });
  process.env.UPLOADS_DIR = uploadsDir;
  bundlesDir = path.join(uploadsDir, '..', 'data', 'bundles');

  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  // Primary claimant — proxy method, $50/hr salary, a few approved labour
  // entries, a few approved expenses (one with FX), one evidence link.
  claimantId = insertClaimant(ctx.db, {
    legal_name: 'T661 Test Co', sred_method: 'proxy', reporting_currency: 'CAD',
  });
  periodId = insertFiscalPeriod(ctx.db, claimantId, {
    start_date: '2025-01-01', end_date: '2025-12-31', status: 'open',
  });

  const adminId = insertUser(ctx.db, {
    role: 'admin', status: 'active', email: 'admin-t661@example.com',
  });
  insertUserClaimant(ctx.db, adminId, claimantId);

  const empId = insertUser(ctx.db, {
    role: 'employee', status: 'active', email: 'emp-t661@example.com', name: 'Emma Employee',
  });
  const ucId = insertUserClaimant(ctx.db, empId, claimantId);
  // $50/hr salary = $50 * 2080 = $104,000/yr = 10_400_000 cents
  insertCompRow(ctx.db, ucId, {
    comp_type: 'salary', amount_cents: 10_400_000, hours_per_year: 2080,
    effective_from: '2025-01-01',
  });

  projectTitle = 'Acme SRED Project';
  const projectId = insertProject(ctx.db, claimantId, {
    title: projectTitle, type: 'sred',
    advancement_sought: 'novel algorithm', uncertainties: 'real-time perf',
    work_performed: 'prototype + benchmark',
  });

  // Three approved labour entries: 8h, 4h, 6h = 18h × $50 = $900 = 90_000 cents
  insertLabourEntry(ctx.db, projectId, ucId, periodId, {
    work_date: '2025-03-01', hours: 8, description: 'design', status: 'approved',
  });
  insertLabourEntry(ctx.db, projectId, ucId, periodId, {
    work_date: '2025-03-15', hours: 4, description: 'code', status: 'approved',
  });
  insertLabourEntry(ctx.db, projectId, ucId, periodId, {
    work_date: '2025-04-01', hours: 6, description: 'test', status: 'approved',
  });

  // Two approved expenses — one CAD material, one USD contract with FX.
  insertExpense(ctx.db, projectId, ucId, periodId, {
    expense_date: '2025-03-10', category: 'material', amount_cents: 25_000,
    currency: 'CAD', fx_rate: null, description: 'lab supplies', status: 'approved',
  });
  insertExpense(ctx.db, projectId, ucId, periodId, {
    expense_date: '2025-04-05', category: 'contract', amount_cents: 100_000,
    currency: 'USD', fx_rate: 1.35, description: 'consultant', status: 'approved',
  });

  // One evidence link.
  ctx.db.prepare(`
    INSERT INTO evidence_items
      (project_id, fiscal_period_id, uploaded_by_user_id,
       kind, caption, evidence_date, url)
    VALUES (?, ?, ?, 'link', ?, '2025-03-15', ?)
  `).run(projectId, periodId, adminId, 'design doc', 'https://example.com/doc');

  // Second, unrelated claimant + period for the cross-claimant mismatch test.
  otherClaimantId = insertClaimant(ctx.db, {
    legal_name: 'Other Co', business_number: '999999999RC0001',
  });
  otherPeriodId = insertFiscalPeriod(ctx.db, otherClaimantId, {
    start_date: '2025-01-01', end_date: '2025-12-31', status: 'open',
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
  try { fs.rmSync(uploadsDir, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(bundlesDir, { recursive: true, force: true }); } catch { /* */ }
});

// --- helpers ---------------------------------------------------------------

async function postJson(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get(path) {
  return fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
}

// Mutable cross-test state: the id of the export we POST in the first test
// is reused by the download / package tests below.
let exportId;
let postedGrandTotalCents;

test('POST /api/exports/t661 returns 201 with id and grand_total > 0', async () => {
  const res = await postJson('/api/exports/t661', {
    claimant_id: claimantId, fiscal_period_id: periodId, draft: false,
  });
  const text = await res.text();
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${text}`);
  const body = JSON.parse(text);
  assert.ok(Number.isInteger(body.id), `body.id should be an integer: ${body.id}`);
  assert.ok(body.totals, 'body.totals should be present');
  assert.ok(body.totals.grand_total, 'body.totals.grand_total should be present');
  assert.ok(
    body.totals.grand_total.total_cents > 0,
    `grand_total.total_cents should be > 0, got ${body.totals.grand_total.total_cents}`,
  );

  // Sanity: labour worksheet picked up the 18h × $50 = $900 worth of work,
  // and the proxy overhead row is 55% of labour. (We don't pin the exact
  // numbers here — the unit suite for t661.js does that — but they should
  // both be present and positive.)
  assert.ok(body.totals.grand_total.labour_cost_cents > 0);
  assert.ok(body.totals.grand_total.overhead_cents > 0);

  exportId = body.id;
  postedGrandTotalCents = body.totals.grand_total.total_cents;
});

test('GET /api/exports/:id/download?format=json round-trips the totals', async () => {
  const res = await get(`/api/exports/${exportId}/download?format=json`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const totals = JSON.parse(await res.text());
  assert.equal(
    totals.grand_total.total_cents, postedGrandTotalCents,
    'JSON download grand_total must match POST response totals',
  );
});

test('GET /api/exports/:id/download?format=csv returns text/csv and a non-empty body', async () => {
  const res = await get(`/api/exports/${exportId}/download?format=csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/csv/);
  const body = await res.text();
  assert.ok(body.length > 0, 'csv body must be non-empty');
  // Has the header row. (t661_line column inserted between project_title and
  // currency for the SRED_DOMAIN_REVIEW F2 fix.)
  assert.match(body, /^line,project_id,project_title,t661_line,currency,amount_cents/);
});

test('GET /api/exports/:id/download?format=md returns text/markdown and includes the project title', async () => {
  const res = await get(`/api/exports/${exportId}/download?format=md`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/markdown/);
  const body = await res.text();
  assert.ok(body.includes(projectTitle), `markdown body should contain project title "${projectTitle}"`);
});

test('GET /api/exports/:id/download?format=pdf returns a body starting with %PDF', async () => {
  const res = await get(`/api/exports/${exportId}/download?format=pdf`);
  assert.equal(res.status, 200);
  // pdfkit pipes a binary stream; read as a buffer.
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 4, 'pdf body must be non-empty');
  assert.equal(buf.slice(0, 4).toString('ascii'), '%PDF',
    `pdf body must start with %PDF, got: ${buf.slice(0, 8).toString('ascii')}`);
});

test('POST /api/exports/:id/evidence-package builds the zip, GET downloads it', async () => {
  const postRes = await postJson(`/api/exports/${exportId}/evidence-package`, {});
  const postText = await postRes.text();
  assert.equal(postRes.status, 201, `expected 201, got ${postRes.status}: ${postText}`);
  const postBody = JSON.parse(postText);
  assert.ok(postBody.bundle_path, 'bundle_path should be set');
  assert.ok(postBody.size_bytes > 0, 'size_bytes should be > 0');

  // The bundle exists on disk and is a valid zip (PK\x03\x04 magic).
  assert.ok(fs.existsSync(postBody.bundle_path), `bundle must exist on disk: ${postBody.bundle_path}`);
  const bundleBytes = fs.readFileSync(postBody.bundle_path);
  assert.equal(bundleBytes.slice(0, 2).toString('ascii'), 'PK',
    'bundle bytes must start with the zip "PK" magic');

  const downloadRes = await get(`/api/exports/${exportId}/evidence-package`);
  assert.equal(downloadRes.status, 200);
  const downloadBytes = Buffer.from(await downloadRes.arrayBuffer());
  assert.equal(downloadBytes.length, bundleBytes.length,
    'downloaded bundle size must match on-disk bundle size');
  assert.equal(downloadBytes.slice(0, 2).toString('ascii'), 'PK');
});

test('POST /api/exports/t661 with a fiscal_period_id from a different claimant returns 400', async () => {
  const res = await postJson('/api/exports/t661', {
    claimant_id: claimantId, fiscal_period_id: otherPeriodId, draft: false,
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'bad_request');
  assert.match(body.error.message, /does not belong to claimant/);
});
