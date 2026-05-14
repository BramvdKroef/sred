// Tests for src/lib/route-helpers.js — entity loaders, period inference,
// user_claimant resolution, scope/edit checks.
//
// Strategy mirrors tests/lib/t661.test.js:
//   - One temp SQLite DB per file (before/after hooks).
//   - Each test wipes data tables and inserts its own fixtures.
//   - No mocking — we hit a real (temp) DB.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  setupTempDb,
  teardownTempDb,
  insertUser,
  insertClaimant,
  insertFiscalPeriod,
  insertUserClaimant,
  insertProject,
  insertLabourEntry,
} from '../helpers/db.js';

let ctx;
let getClaimant;
let getProject;
let getPeriod;
let getLabourEntry;
let findOpenPeriod;
let resolveUserClaimant;
let isOwnerOrAdmin;
let assertEditable;

before(async () => {
  ctx = await setupTempDb();
  ({
    getClaimant,
    getProject,
    getPeriod,
    getLabourEntry,
    findOpenPeriod,
    resolveUserClaimant,
    isOwnerOrAdmin,
    assertEditable,
  } = await import('../../src/lib/route-helpers.js'));
});

after(() => {
  teardownTempDb(ctx);
});

// Tables to clear between tests (children before parents for FKs).
const DATA_TABLES = [
  'evidence_items',
  'expenses',
  'labour_entries',
  'project_assignments',
  'project_revisions',
  'projects',
  'compensation_rows',
  'user_claimants',
  'fiscal_periods',
  'claimants',
  'users',
];

beforeEach(() => {
  ctx.db.pragma('foreign_keys = OFF');
  for (const table of DATA_TABLES) {
    ctx.db.exec(`DELETE FROM ${table}`);
  }
  ctx.db.pragma('foreign_keys = ON');
});

// --- getEntity / named wrappers ---------------------------------------------

test('named wrapper returns the row for an existing id', () => {
  const claimantId = insertClaimant(ctx.db, { legal_name: 'Acme Co' });
  const row = getClaimant(claimantId);
  assert.equal(row.id, claimantId);
  assert.equal(row.legal_name, 'Acme Co');
});

test('named wrapper throws notFound (404) when id does not exist', () => {
  assert.throws(
    () => getProject(99_999),
    err => {
      assert.equal(err.status, 404);
      assert.equal(err.code, 'not_found');
      assert.match(err.message, /project not found/);
      return true;
    }
  );
});

// --- findOpenPeriod ---------------------------------------------------------

test('findOpenPeriod returns the open period whose range covers the date', () => {
  const claimantId = insertClaimant(ctx.db);
  const periodId = insertFiscalPeriod(ctx.db, claimantId, {
    start_date: '2025-01-01',
    end_date: '2025-12-31',
    status: 'open',
  });
  const found = findOpenPeriod(claimantId, '2025-06-15');
  assert.equal(found.id, periodId);
  assert.equal(found.status, 'open');
});

test('findOpenPeriod throws unprocessable (422) when no open period covers the date', () => {
  const claimantId = insertClaimant(ctx.db);
  insertFiscalPeriod(ctx.db, claimantId, {
    start_date: '2025-01-01',
    end_date: '2025-12-31',
    status: 'open',
  });
  assert.throws(
    () => findOpenPeriod(claimantId, '2024-06-15'),
    err => {
      assert.equal(err.status, 422);
      assert.equal(err.code, 'unprocessable');
      assert.match(err.message, /no open fiscal period/);
      return true;
    }
  );
});

test('findOpenPeriod does not return a closed period even if the date falls in its range', () => {
  const claimantId = insertClaimant(ctx.db);
  insertFiscalPeriod(ctx.db, claimantId, {
    start_date: '2024-01-01',
    end_date: '2024-12-31',
    status: 'closed',
  });
  assert.throws(
    () => findOpenPeriod(claimantId, '2024-06-15'),
    err => {
      assert.equal(err.status, 422);
      return true;
    }
  );
});

test('findOpenPeriod does not return a period belonging to a different claimant', () => {
  const claimantA = insertClaimant(ctx.db, { legal_name: 'A Co' });
  const claimantB = insertClaimant(ctx.db, {
    legal_name: 'B Co',
    business_number: '987654321RC0001',
  });
  // Only claimant B has an open period covering the date.
  insertFiscalPeriod(ctx.db, claimantB, {
    start_date: '2025-01-01',
    end_date: '2025-12-31',
    status: 'open',
  });
  assert.throws(
    () => findOpenPeriod(claimantA, '2025-06-15'),
    err => {
      assert.equal(err.status, 422);
      return true;
    }
  );
});

// --- resolveUserClaimant ----------------------------------------------------

// Build a base scenario: claimant + project + employee user attached active.
function ucScenario(opts = {}) {
  const { db } = ctx;
  const claimantId = insertClaimant(db);
  const projectId = insertProject(db, claimantId);
  const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId);
  const userId = insertUser(db, opts.user);
  const ucId = insertUserClaimant(db, userId, claimantId, opts.userClaimant);
  return { claimantId, projectId, project, userId, ucId };
}

test('resolveUserClaimant: admin must supply requestedUcId (badRequest if missing)', () => {
  const s = ucScenario();
  const admin = { id: insertUser(ctx.db, { role: 'admin' }), role: 'admin' };
  assert.throws(
    () => resolveUserClaimant({ user: admin, project: s.project, requestedUcId: undefined }),
    err => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'bad_request');
      assert.match(err.message, /admin must specify user_claimant_id/);
      return true;
    }
  );
});

test('resolveUserClaimant: admin gets badRequest when the requested uc belongs to a different claimant', () => {
  const s = ucScenario();
  // A second claimant with its own user_claimant.
  const otherClaimantId = insertClaimant(ctx.db, {
    legal_name: 'Other Co',
    business_number: '987654321RC0001',
  });
  const otherUserId = insertUser(ctx.db);
  const otherUcId = insertUserClaimant(ctx.db, otherUserId, otherClaimantId);

  const admin = { id: insertUser(ctx.db, { role: 'admin' }), role: 'admin' };
  assert.throws(
    () => resolveUserClaimant({ user: admin, project: s.project, requestedUcId: otherUcId }),
    err => {
      assert.equal(err.status, 400);
      assert.match(err.message, /does not belong to this project/);
      return true;
    }
  );
});

test('resolveUserClaimant: admin gets badRequest when the uc is inactive', () => {
  const s = ucScenario({ userClaimant: { status: 'inactive' } });
  const admin = { id: insertUser(ctx.db, { role: 'admin' }), role: 'admin' };
  assert.throws(
    () => resolveUserClaimant({ user: admin, project: s.project, requestedUcId: s.ucId }),
    err => {
      assert.equal(err.status, 400);
      assert.match(err.message, /inactive/);
      return true;
    }
  );
});

test('resolveUserClaimant: admin happy path returns the uc', () => {
  const s = ucScenario();
  const admin = { id: insertUser(ctx.db, { role: 'admin' }), role: 'admin' };
  const uc = resolveUserClaimant({ user: admin, project: s.project, requestedUcId: s.ucId });
  assert.equal(uc.id, s.ucId);
  assert.equal(uc.claimant_id, s.claimantId);
  assert.equal(uc.status, 'active');
});

test('resolveUserClaimant: employee ignores requestedUcId; looks up own attachment', () => {
  const s = ucScenario();
  const employee = { id: s.userId, role: 'employee' };
  // Insert a separate uc on the same claimant; the helper must ignore it
  // even though we pass its id as requestedUcId.
  const someoneElse = insertUser(ctx.db);
  const otherUcOnSameClaimant = insertUserClaimant(ctx.db, someoneElse, s.claimantId);

  const uc = resolveUserClaimant({
    user: employee,
    project: s.project,
    requestedUcId: otherUcOnSameClaimant, // should be ignored
  });
  assert.equal(uc.id, s.ucId);
  assert.equal(uc.user_id, s.userId);
});

test('resolveUserClaimant: employee not attached to the project claimant -> forbidden', () => {
  const s = ucScenario();
  // Brand-new user with no user_claimant attachment.
  const strangerId = insertUser(ctx.db);
  const stranger = { id: strangerId, role: 'employee' };
  assert.throws(
    () => resolveUserClaimant({ user: stranger, project: s.project, requestedUcId: undefined }),
    err => {
      assert.equal(err.status, 403);
      assert.equal(err.code, 'forbidden');
      assert.match(err.message, /not attached/);
      return true;
    }
  );
});

test('resolveUserClaimant: employee with inactive attachment -> forbidden', () => {
  const s = ucScenario({ userClaimant: { status: 'inactive' } });
  const employee = { id: s.userId, role: 'employee' };
  assert.throws(
    () => resolveUserClaimant({ user: employee, project: s.project, requestedUcId: undefined }),
    err => {
      assert.equal(err.status, 403);
      assert.match(err.message, /inactive/);
      return true;
    }
  );
});

// --- isOwnerOrAdmin ---------------------------------------------------------

test('isOwnerOrAdmin: returns true for admins regardless of the uc', () => {
  const admin = { id: 9999, role: 'admin' };
  // Pass an id that does not exist — admin short-circuit must skip the lookup.
  assert.equal(isOwnerOrAdmin(admin, 1234567), true);
});

test('isOwnerOrAdmin: true for the employee whose user_id matches the uc.user_id', () => {
  const claimantId = insertClaimant(ctx.db);
  const userId = insertUser(ctx.db);
  const ucId = insertUserClaimant(ctx.db, userId, claimantId);
  assert.equal(isOwnerOrAdmin({ id: userId, role: 'employee' }, ucId), true);
});

test('isOwnerOrAdmin: false for any other employee', () => {
  const claimantId = insertClaimant(ctx.db);
  const ownerId = insertUser(ctx.db);
  const otherId = insertUser(ctx.db);
  const ucId = insertUserClaimant(ctx.db, ownerId, claimantId);
  assert.equal(isOwnerOrAdmin({ id: otherId, role: 'employee' }, ucId), false);
});

test('isOwnerOrAdmin: false when the uc does not exist (no crash)', () => {
  const employee = { id: 42, role: 'employee' };
  assert.equal(isOwnerOrAdmin(employee, 99_999), false);
});

// --- assertEditable ---------------------------------------------------------

// Build a labour entry tied to a period of the given status + entry status.
function entryWithStatuses({ entryStatus, periodStatus }) {
  const { db } = ctx;
  const claimantId = insertClaimant(db);
  const periodId = insertFiscalPeriod(db, claimantId, { status: periodStatus });
  const userId = insertUser(db);
  const ucId = insertUserClaimant(db, userId, claimantId);
  const projectId = insertProject(db, claimantId);
  const entryId = insertLabourEntry(db, projectId, ucId, periodId, { status: entryStatus });
  return getLabourEntry(entryId);
}

test('assertEditable: no-op when the entry is pending and the period is open', () => {
  const entry = entryWithStatuses({ entryStatus: 'pending', periodStatus: 'open' });
  assert.doesNotThrow(() => assertEditable(entry));
});

test('assertEditable: no-op when the entry is rejected and the period is open', () => {
  const entry = entryWithStatuses({ entryStatus: 'rejected', periodStatus: 'open' });
  assert.doesNotThrow(() => assertEditable(entry));
});

test('assertEditable: throws badRequest when the entry status is approved', () => {
  const entry = entryWithStatuses({ entryStatus: 'approved', periodStatus: 'open' });
  assert.throws(
    () => assertEditable(entry),
    err => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'bad_request');
      assert.match(err.message, /approved/);
      return true;
    }
  );
});

test('assertEditable: throws badRequest when the entry fiscal period is closed', () => {
  const entry = entryWithStatuses({ entryStatus: 'pending', periodStatus: 'closed' });
  assert.throws(
    () => assertEditable(entry),
    err => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'bad_request');
      assert.match(err.message, /closed/);
      return true;
    }
  );
});
