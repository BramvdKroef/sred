// Tests for the admin CSV bulk-import endpoint on src/routes/labour.js
// (`POST /api/labour-logs/import`).
//
// Covers:
//   - Happy path: 3 valid rows → 201 + imported:3
//   - One invalid row out of 3 → 400 + no rows committed
//   - Missing header column → 400
//   - Empty CSV → 400
//   - user_claimant from a different claimant than the project's claimant → 400

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

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
let projectId, projectBId;
let ucId, ucBId;

before(async () => {
  ctx = await setupTempDb();

  const express = (await import('express')).default;
  const apiRouter = (await import('../../src/routes/index.js')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  const { signSession } = await import('../../src/auth/jwt.js');

  const adminId = insertUser(ctx.db, {
    role: 'admin', email: 'admin-csv@example.com', name: 'Admin CSV',
  });
  const empId = insertUser(ctx.db, {
    role: 'employee', email: 'emp-csv@example.com', name: 'Emp CSV',
  });
  const empBId = insertUser(ctx.db, {
    role: 'employee', email: 'emp-b-csv@example.com', name: 'Emp B',
  });

  const claimantA = insertClaimant(ctx.db, { legal_name: 'Acme A', business_number: '111111111RC0001' });
  const claimantB = insertClaimant(ctx.db, { legal_name: 'Beta B', business_number: '222222222RC0001' });

  insertFiscalPeriod(ctx.db, claimantA, { start_date: '2025-01-01', end_date: '2025-12-31', status: 'open' });
  insertFiscalPeriod(ctx.db, claimantB, { start_date: '2025-01-01', end_date: '2025-12-31', status: 'open' });

  // The admin needs an active attachment per the schema? No — resolveUserClaimant
  // looks up uc by the requestedUcId for admins. We just need the target uc.
  ucId  = insertUserClaimant(ctx.db, empId,  claimantA);
  ucBId = insertUserClaimant(ctx.db, empBId, claimantB);

  projectId  = insertProject(ctx.db, claimantA, { title: 'Project A' });
  projectBId = insertProject(ctx.db, claimantB, { title: 'Project B' });

  adminToken = signSession({ id: adminId, role: 'admin' });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRouter);
  app.use(errorMiddleware);

  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  teardownTempDb(ctx);
});

async function postImport(csv) {
  return fetch(`${baseUrl}/api/labour-logs/import`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ csv }),
  });
}

function labourCount() {
  return ctx.db.prepare(`SELECT COUNT(*) AS n FROM labour_entries`).get().n;
}

test('happy path: 3 valid rows → 201 + imported:3', async () => {
  const before = labourCount();
  const csv = [
    'date,user_claimant_id,project_id,hours,description',
    `2025-03-15,${ucId},${projectId},4.5,"work on widget A"`,
    `2025-03-16,${ucId},${projectId},8,"work on widget B, with a comma in the description"`,
    `2025-03-17,${ucId},${projectId},6.25,"reviewed PRs"`,
  ].join('\n');

  const res = await postImport(csv);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.imported, 3);
  assert.equal(body.skipped, 0);
  assert.deepEqual(body.errors, []);

  assert.equal(labourCount(), before + 3);

  // Verify one of the inserted rows kept its embedded-comma description intact
  // and was marked approved (admin actor).
  const inserted = ctx.db.prepare(
    `SELECT * FROM labour_entries WHERE work_date = '2025-03-16'`
  ).get();
  assert.equal(inserted.description, 'work on widget B, with a comma in the description');
  assert.equal(inserted.status, 'approved');

  // One audit row per inserted entry.
  const audits = ctx.db.prepare(
    `SELECT * FROM audit_log WHERE entity_type = 'labour_entry' AND action = 'create'`
  ).all();
  assert.ok(audits.length >= 3, `expected at least 3 audit rows, got ${audits.length}`);
});

test('one invalid row out of 3 → 400 + no rows committed', async () => {
  const before = labourCount();
  const csv = [
    'date,user_claimant_id,project_id,hours,description',
    `2025-03-18,${ucId},${projectId},4,"valid row 1"`,
    `2025-03-19,${ucId},${projectId},30,"invalid: hours > 24"`,
    `2025-03-20,${ucId},${projectId},6,"valid row 3"`,
  ].join('\n');

  const res = await postImport(csv);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'csv_invalid');
  assert.ok(Array.isArray(body.error.rows));
  assert.equal(body.error.rows.length, 1);
  assert.equal(body.error.rows[0].row, 3); // header=1, data starts at 2 → bad row is line 3
  assert.match(body.error.rows[0].reason, /hours/);

  assert.equal(labourCount(), before,
    `no rows should have been inserted (was ${before}, now ${labourCount()})`);
});

test('missing required header column → 400', async () => {
  const before = labourCount();
  // Header missing `hours`
  const csv = [
    'date,user_claimant_id,project_id,description',
    `2025-03-21,${ucId},${projectId},"no hours column"`,
  ].join('\n');

  const res = await postImport(csv);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'bad_request');
  assert.match(body.error.message, /hours/);
  assert.equal(labourCount(), before);
});

test('empty CSV → 400', async () => {
  const before = labourCount();
  const res = await postImport('');
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'bad_request');
  assert.equal(labourCount(), before);

  // Whitespace-only is also rejected.
  const res2 = await postImport('   \n\n');
  assert.equal(res2.status, 400);

  // Header-only CSV (no data rows) is also rejected.
  const res3 = await postImport('date,user_claimant_id,project_id,hours,description');
  assert.equal(res3.status, 400);
});

test('user_claimant_id from a different claimant than the project → 400', async () => {
  const before = labourCount();
  // ucBId is attached to claimantB, but projectId belongs to claimantA.
  const csv = [
    'date,user_claimant_id,project_id,hours,description',
    `2025-03-22,${ucBId},${projectId},4,"cross-claimant row"`,
  ].join('\n');

  const res = await postImport(csv);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'csv_invalid');
  assert.equal(body.error.rows.length, 1);
  assert.match(body.error.rows[0].reason, /claimant/);
  assert.equal(labourCount(), before);
});

test('column-order independence: header in a different order still works', async () => {
  const before = labourCount();
  const csv = [
    'description,project_id,user_claimant_id,hours,date',
    `"shuffled columns",${projectId},${ucId},2.5,2025-03-23`,
  ].join('\n');

  const res = await postImport(csv);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.imported, 1);
  assert.equal(labourCount(), before + 1);

  const inserted = ctx.db.prepare(
    `SELECT * FROM labour_entries WHERE work_date = '2025-03-23'`
  ).get();
  assert.equal(inserted.description, 'shuffled columns');
  assert.equal(inserted.hours, 2.5);
});
