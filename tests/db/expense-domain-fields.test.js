// Migration 015 (expenses.material_disposition / contract_arms_length /
// fx_rate_source) schema-level tests.
//
// Schema invariants verified here:
//   - Migration 015 is recorded as applied + the three columns are present.
//   - A valid material row with disposition inserts cleanly.
//   - A non-material row carrying material_disposition fails the cross-
//     column CHECK.
//   - A material row WITHOUT disposition passes the schema CHECK — the
//     "must be present" rule lives in the route layer. The route-level
//     test in tests/routes/expense-domain-fields.test.js proves that path
//     returns 400.
//   - The material_disposition CHECK enum is enforced (only 'consumed' or
//     'transformed').
//   - A valid contract row with the arm's-length flag set inserts cleanly
//     (both 0 and 1).
//   - A non-contract row carrying contract_arms_length fails the cross-
//     column CHECK.
//   - A contract row with the flag NULL passes the schema CHECK (route
//     enforces presence).
//   - The contract_arms_length CHECK rejects ints outside {0, 1}.
//   - fx_rate_source is permissive at the schema layer — any text (or
//     null) is fine; the route enforces presence-when-fx_rate-is-set.
//   - The migration-014 cross-column guards on overhead_subcategory /
//     allocation_basis are preserved (we don't want migration 015 to
//     accidentally drop them).
//
// Why split this way: each new column is schema-permissive about "missing
// when required" so historical rows can be migrated forward in NULL and
// back-filled later via the admin edit form. The API path is strict, so
// freshly-submitted rows must have the right field for their category.

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
let projectId, ucId, periodId;

before(async () => {
  ctx = await setupTempDb();
  const userId = insertUser(ctx.db);
  const claimantId = insertClaimant(ctx.db);
  periodId = insertFiscalPeriod(ctx.db, claimantId);
  ucId = insertUserClaimant(ctx.db, userId, claimantId);
  projectId = insertProject(ctx.db, claimantId);
});

after(() => {
  teardownTempDb(ctx);
});

test('migration 015 is applied', () => {
  const { db } = ctx;
  const row = db.prepare(`SELECT filename FROM _migrations WHERE filename = ?`)
    .get('015_expense_domain_fields.sql');
  assert.ok(row, 'migration 015 should be recorded as applied');
});

test('expenses has material_disposition, contract_arms_length, fx_rate_source columns', () => {
  const { db } = ctx;
  const cols = db.prepare(`PRAGMA table_info(expenses)`).all().map(r => r.name);
  assert.ok(cols.includes('material_disposition'), `expenses should have material_disposition; got ${cols.join(', ')}`);
  assert.ok(cols.includes('contract_arms_length'), `expenses should have contract_arms_length; got ${cols.join(', ')}`);
  assert.ok(cols.includes('fx_rate_source'),       `expenses should have fx_rate_source; got ${cols.join(', ')}`);
});

const insertSql = `
  INSERT INTO expenses
    (project_id, user_claimant_id, fiscal_period_id, expense_date, category,
     amount_cents, currency, fx_rate, fx_rate_source, description, status,
     overhead_subcategory, allocation_basis,
     material_disposition, contract_arms_length)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

// Argument order: project_id, ucId, periodId, expense_date, category,
//                 amount_cents, currency, fx_rate, fx_rate_source,
//                 description, status,
//                 overhead_subcategory, allocation_basis,
//                 material_disposition, contract_arms_length.
function defaults(overrides = {}) {
  return {
    project_id: projectId,
    user_claimant_id: ucId,
    fiscal_period_id: periodId,
    expense_date: '2025-03-15',
    category: 'material',
    amount_cents: 50_000,
    currency: 'CAD',
    fx_rate: null,
    fx_rate_source: null,
    description: 'a thing',
    status: 'approved',
    overhead_subcategory: null,
    allocation_basis: null,
    material_disposition: null,
    contract_arms_length: null,
    ...overrides,
  };
}

function runInsert(db, overrides = {}) {
  const a = defaults(overrides);
  return db.prepare(insertSql).run(
    a.project_id, a.user_claimant_id, a.fiscal_period_id, a.expense_date, a.category,
    a.amount_cents, a.currency, a.fx_rate, a.fx_rate_source, a.description, a.status,
    a.overhead_subcategory, a.allocation_basis,
    a.material_disposition, a.contract_arms_length,
  );
}

function assertCheckFails(db, overrides, label) {
  assert.throws(
    () => runInsert(db, overrides),
    err => err && /CHECK constraint failed|SQLITE_CONSTRAINT_CHECK/.test(String(err.message ?? err)),
    `${label}: expected a CHECK constraint violation`,
  );
}

// --- P3.1: material_disposition --------------------------------------------

test('valid material row with disposition=consumed inserts cleanly', () => {
  const { db } = ctx;
  const info = runInsert(db, { category: 'material', material_disposition: 'consumed' });
  assert.equal(info.changes, 1);
  const row = db.prepare(`SELECT * FROM expenses WHERE id = ?`).get(info.lastInsertRowid);
  assert.equal(row.material_disposition, 'consumed');
});

test('valid material row with disposition=transformed inserts cleanly', () => {
  const { db } = ctx;
  const info = runInsert(db, { category: 'material', material_disposition: 'transformed' });
  assert.equal(info.changes, 1);
});

test('non-material row carrying material_disposition fails CHECK', () => {
  const { db } = ctx;
  assertCheckFails(
    db,
    { category: 'contract', material_disposition: 'consumed', contract_arms_length: 1 },
    'contract + material_disposition',
  );
});

test('overhead row carrying material_disposition fails CHECK', () => {
  const { db } = ctx;
  assertCheckFails(
    db,
    { category: 'overhead', material_disposition: 'consumed',
      overhead_subcategory: 'rent', allocation_basis: '50%' },
    'overhead + material_disposition',
  );
});

test('material row WITHOUT disposition passes schema CHECK (route enforces requiredness)', () => {
  const { db } = ctx;
  const info = runInsert(db, { category: 'material', material_disposition: null });
  assert.equal(info.changes, 1);
});

test('material_disposition CHECK rejects unknown enum values', () => {
  const { db } = ctx;
  assertCheckFails(
    db,
    { category: 'material', material_disposition: 'recycled' },
    'material_disposition=recycled',
  );
});

// --- P3.2: contract_arms_length --------------------------------------------

test('valid contract row with arms_length=1 inserts cleanly', () => {
  const { db } = ctx;
  const info = runInsert(db, { category: 'contract', contract_arms_length: 1 });
  assert.equal(info.changes, 1);
  const row = db.prepare(`SELECT * FROM expenses WHERE id = ?`).get(info.lastInsertRowid);
  assert.equal(row.contract_arms_length, 1);
});

test('valid contract row with arms_length=0 inserts cleanly', () => {
  const { db } = ctx;
  const info = runInsert(db, { category: 'contract', contract_arms_length: 0 });
  assert.equal(info.changes, 1);
});

test('non-contract row carrying contract_arms_length fails CHECK', () => {
  const { db } = ctx;
  assertCheckFails(
    db,
    { category: 'material', material_disposition: 'consumed', contract_arms_length: 1 },
    'material + contract_arms_length',
  );
});

test('third_party_payment row carrying contract_arms_length fails CHECK', () => {
  const { db } = ctx;
  assertCheckFails(
    db,
    { category: 'third_party_payment', contract_arms_length: 0 },
    'third_party_payment + contract_arms_length',
  );
});

test('contract row with NULL arms-length flag passes schema CHECK (route enforces requiredness)', () => {
  const { db } = ctx;
  const info = runInsert(db, { category: 'contract', contract_arms_length: null });
  assert.equal(info.changes, 1);
});

test('contract_arms_length CHECK rejects ints outside {0, 1}', () => {
  const { db } = ctx;
  assertCheckFails(
    db,
    { category: 'contract', contract_arms_length: 2 },
    'contract_arms_length=2',
  );
});

// --- P3.3: fx_rate_source --------------------------------------------------

test('row with fx_rate + fx_rate_source inserts cleanly (schema is permissive)', () => {
  const { db } = ctx;
  const info = runInsert(db, {
    category: 'material', material_disposition: 'consumed',
    currency: 'USD', fx_rate: 1.35,
    fx_rate_source: 'Bank of Canada noon rate, 2025-03-15',
  });
  assert.equal(info.changes, 1);
  const row = db.prepare(`SELECT * FROM expenses WHERE id = ?`).get(info.lastInsertRowid);
  assert.equal(row.fx_rate_source, 'Bank of Canada noon rate, 2025-03-15');
});

test('row with fx_rate but NULL fx_rate_source passes schema CHECK (route enforces requiredness)', () => {
  const { db } = ctx;
  // Schema is intentionally permissive — the route is the gate. Verifies a
  // grandfathered legacy row can be migrated forward and back-filled.
  const info = runInsert(db, {
    category: 'material', material_disposition: 'consumed',
    currency: 'USD', fx_rate: 1.35, fx_rate_source: null,
  });
  assert.equal(info.changes, 1);
});

test('row with NULL fx_rate but a stray fx_rate_source passes schema CHECK', () => {
  // The "fx_rate_source must be null when fx_rate is null" rule lives in
  // the route, not the schema. Confirming the schema lets this through so
  // we know the route is the only gate.
  const { db } = ctx;
  const info = runInsert(db, {
    category: 'material', material_disposition: 'consumed',
    fx_rate: null, fx_rate_source: 'some stray label',
  });
  assert.equal(info.changes, 1);
});

// --- Migration 014 invariants preserved ------------------------------------

test('migration 014 overhead-fields CHECK is still in effect', () => {
  // Sanity guard: migration 015 recreates the table; this verifies the
  // overhead cross-column CHECK survived the recreate.
  const { db } = ctx;
  assertCheckFails(
    db,
    { category: 'material', material_disposition: 'consumed',
      overhead_subcategory: 'rent' /* should be null on material */ },
    'material + overhead_subcategory',
  );
});

test('migration 014 overhead-subcategory enum CHECK is still in effect', () => {
  const { db } = ctx;
  assertCheckFails(
    db,
    { category: 'overhead', overhead_subcategory: 'travel', allocation_basis: '50%' },
    'overhead_subcategory=travel',
  );
});
