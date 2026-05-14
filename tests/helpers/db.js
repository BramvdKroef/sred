// Test bootstrap for a fresh temp SQLite DB.
//
// Usage:
//   import { setupTempDb, teardownTempDb } from '../helpers/db.js';
//   const ctx = await setupTempDb();   // { db, dbPath }
//   ...
//   teardownTempDb(ctx);
//
// IMPORTANT: This module sets `process.env.DATABASE_PATH` and
// `process.env.JWT_SECRET` before dynamically importing the production
// `db` and `migrate` modules. Do not statically import either of those
// elsewhere in a test file, or the env will already be locked in.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export async function setupTempDb() {
  const tmpFile = path.join(
    os.tmpdir(),
    `sred-test-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`
  );

  process.env.DATABASE_PATH = tmpFile;
  // config.js requires JWT_SECRET at module load.
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-secret';

  // Importing migrate.js runs the migration loop as a top-level side-effect.
  // The dynamic import here ensures DATABASE_PATH is already in env.
  await import('../../src/db/migrate.js');
  const { db } = await import('../../src/db/index.js');

  return { db, dbPath: tmpFile };
}

export function teardownTempDb({ db, dbPath }) {
  try { db.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* missing is fine */ }
  }
}

// --- Fixture helpers ---------------------------------------------------------
//
// Each helper returns the inserted row id (or row) so callers can chain.
// Defaults are picked to satisfy the schema's CHECK / NOT NULL constraints
// while letting callers override only the bits that matter to the test.

export function insertUser(db, overrides = {}) {
  const row = {
    email: `user-${crypto.randomBytes(4).toString('hex')}@example.com`,
    name: 'Test User',
    role: 'employee',
    status: 'active',
    ...overrides,
  };
  const info = db.prepare(
    `INSERT INTO users (email, name, role, status) VALUES (?, ?, ?, ?)`
  ).run(row.email, row.name, row.role, row.status);
  return info.lastInsertRowid;
}

export function insertClaimant(db, overrides = {}) {
  const row = {
    legal_name: 'Acme Co',
    business_number: '123456789RC0001',
    fiscal_year_end_month: 12,
    fiscal_year_end_day: 31,
    reporting_currency: 'CAD',
    sred_method: 'proxy',
    ...overrides,
  };
  const info = db.prepare(`
    INSERT INTO claimants
      (legal_name, business_number, fiscal_year_end_month, fiscal_year_end_day,
       reporting_currency, sred_method)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    row.legal_name, row.business_number, row.fiscal_year_end_month,
    row.fiscal_year_end_day, row.reporting_currency, row.sred_method
  );
  return info.lastInsertRowid;
}

export function insertFiscalPeriod(db, claimantId, overrides = {}) {
  const row = {
    start_date: '2025-01-01',
    end_date: '2025-12-31',
    status: 'open',
    ...overrides,
  };
  const info = db.prepare(`
    INSERT INTO fiscal_periods (claimant_id, start_date, end_date, status)
    VALUES (?, ?, ?, ?)
  `).run(claimantId, row.start_date, row.end_date, row.status);
  return info.lastInsertRowid;
}

export function insertUserClaimant(db, userId, claimantId, overrides = {}) {
  const row = {
    title: 'Engineer',
    is_specified_employee: 0,
    status: 'active',
    ...overrides,
  };
  const info = db.prepare(`
    INSERT INTO user_claimants
      (user_id, claimant_id, title, is_specified_employee, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, claimantId, row.title, row.is_specified_employee, row.status);
  return info.lastInsertRowid;
}

export function insertCompRow(db, userClaimantId, overrides = {}) {
  const row = {
    comp_type: 'salary',
    amount_cents: 10_000_000, // $100k
    hours_per_year: 2080,
    effective_from: '2025-01-01',
    ...overrides,
  };
  const info = db.prepare(`
    INSERT INTO compensation_rows
      (user_claimant_id, comp_type, amount_cents, hours_per_year, effective_from)
    VALUES (?, ?, ?, ?, ?)
  `).run(userClaimantId, row.comp_type, row.amount_cents, row.hours_per_year, row.effective_from);
  return info.lastInsertRowid;
}

export function insertProject(db, claimantId, overrides = {}) {
  const row = {
    title: 'Project X',
    field_of_science: 'computer_science',
    start_date: '2025-01-01',
    end_date: null,
    status: 'active',
    advancement_sought: 'TBD',
    uncertainties: 'TBD',
    work_performed: 'TBD',
    type: 'sred',
    phase: 'development',
    ...overrides,
  };
  const info = db.prepare(`
    INSERT INTO projects
      (claimant_id, title, field_of_science, start_date, end_date, status,
       advancement_sought, uncertainties, work_performed, type, phase)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    claimantId, row.title, row.field_of_science, row.start_date, row.end_date,
    row.status, row.advancement_sought, row.uncertainties, row.work_performed,
    row.type, row.phase
  );
  return info.lastInsertRowid;
}

export function insertLabourEntry(db, projectId, userClaimantId, periodId, overrides = {}) {
  const row = {
    work_date: '2025-03-15',
    hours: 8,
    description: 'work done',
    status: 'approved',
    ...overrides,
  };
  const info = db.prepare(`
    INSERT INTO labour_entries
      (project_id, user_claimant_id, fiscal_period_id, work_date, hours, description, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId, userClaimantId, periodId,
    row.work_date, row.hours, row.description, row.status
  );
  return info.lastInsertRowid;
}

export function insertExpense(db, projectId, userClaimantId, periodId, overrides = {}) {
  const row = {
    expense_date: '2025-03-15',
    category: 'material',
    amount_cents: 100000,
    currency: 'CAD',
    fx_rate: null,
    description: 'a thing',
    status: 'approved',
    ...overrides,
  };
  const info = db.prepare(`
    INSERT INTO expenses
      (project_id, user_claimant_id, fiscal_period_id, expense_date, category,
       amount_cents, currency, fx_rate, description, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId, userClaimantId, periodId, row.expense_date, row.category,
    row.amount_cents, row.currency, row.fx_rate, row.description, row.status
  );
  return info.lastInsertRowid;
}

export function getClaimant(db, id) {
  return db.prepare(`SELECT * FROM claimants WHERE id = ?`).get(id);
}

export function getFiscalPeriod(db, id) {
  return db.prepare(`SELECT * FROM fiscal_periods WHERE id = ?`).get(id);
}
