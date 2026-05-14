// Tests for src/lib/t661.js — the T661 calculation engine.
//
// Strategy:
//   - One temp SQLite DB per file (before/after hooks).
//   - Each test wipes data tables and inserts its own fixtures.
//   - No mocking of better-sqlite3 — we hit a real (temp) DB.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

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
  getClaimant,
  getFiscalPeriod,
} from '../helpers/db.js';

let ctx;
let computeT661;
let snapshotProjectRevisions;
let collectEvidenceManifest;

before(async () => {
  ctx = await setupTempDb();
  ({ computeT661, snapshotProjectRevisions, collectEvidenceManifest } =
    await import('../../src/lib/t661.js'));
});

after(() => {
  teardownTempDb(ctx);
});

// Tables we want to clear between tests. Order matters for FK constraints
// (children before parents).
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

// --- Shared scenario builder -------------------------------------------------

// Builds a minimal claimant + active SR&ED project + one user_claimant + comp row.
// Returns the ids/rows callers need.
function scenario(opts = {}) {
  const { db } = ctx;
  const claimantId = insertClaimant(db, opts.claimant);
  const periodId = insertFiscalPeriod(db, claimantId, opts.period);
  const userId = insertUser(db, opts.user);
  const ucId = insertUserClaimant(db, userId, claimantId, opts.userClaimant);
  const compId = opts.skipComp
    ? null
    : insertCompRow(db, ucId, opts.comp);
  const projectId = insertProject(db, claimantId, opts.project);

  return {
    claimantId,
    claimant: getClaimant(db, claimantId),
    periodId,
    period: getFiscalPeriod(db, periodId),
    userId,
    ucId,
    compId,
    projectId,
  };
}

// --- Tests -------------------------------------------------------------------

test('computes labour cost from a salary comp row for a single labour entry', () => {
  const s = scenario({
    comp: { comp_type: 'salary', amount_cents: 10_400_000, hours_per_year: 2080 },
  });
  // hourly = 10_400_000 / 2080 = 5000 cents = $50/hr. 8 hours => $400 = 40_000 cents.
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
    work_date: '2025-03-15',
    hours: 8,
  });

  const out = computeT661({ claimant: s.claimant, period: s.period });

  assert.equal(out.projects.length, 1);
  const project = out.projects[0];
  assert.equal(project.totals.labour_cost_cents, 40_000);
  assert.equal(project.labour_worksheet.length, 1);
  const row = project.labour_worksheet[0];
  assert.equal(row.total_hours, 8);
  assert.equal(row.labour_cost_cents, 40_000);
  assert.equal(row.cap_applied, false);
  // Grand total mirrors the single project.
  assert.equal(out.grand_total.labour_cost_cents, 40_000);
});

test('hourly comp row produces the same calculation path', () => {
  const s = scenario({
    comp: { comp_type: 'hourly', amount_cents: 5000, hours_per_year: 2080 },
  });
  // hourly amount_cents is the rate directly. 8h * 5000c = 40_000c.
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
    work_date: '2025-03-15',
    hours: 8,
  });

  const out = computeT661({ claimant: s.claimant, period: s.period });
  assert.equal(out.projects[0].totals.labour_cost_cents, 40_000);
  assert.equal(out.projects[0].labour_worksheet[0].cap_applied, false);
});

test('aggregates multiple labour entries for one employee into a single worksheet row', () => {
  const s = scenario({
    comp: { comp_type: 'salary', amount_cents: 10_400_000, hours_per_year: 2080 },
  });
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, { work_date: '2025-03-10', hours: 4 });
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, { work_date: '2025-03-11', hours: 6 });
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, { work_date: '2025-03-12', hours: 2 });

  const out = computeT661({ claimant: s.claimant, period: s.period });
  const ws = out.projects[0].labour_worksheet;
  assert.equal(ws.length, 1);
  assert.equal(ws[0].total_hours, 12);
  assert.equal(ws[0].labour_cost_cents, 60_000); // 12h * $50
});

test('applies the specified-employee wage cap when the annual base exceeds it', () => {
  // 2025 cap is $357,500 = 35_750_000c. Set salary above that.
  const s = scenario({
    userClaimant: { is_specified_employee: 1 },
    comp: { comp_type: 'salary', amount_cents: 50_000_000, hours_per_year: 2080 },
  });
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
    work_date: '2025-03-15',
    hours: 10,
  });

  const out = computeT661({ claimant: s.claimant, period: s.period });
  // Effective annual is capped at 35_750_000, hourly = 35_750_000 / 2080 = 17_187.5,
  // line = 10 * 17_187.5 = 171_875c (Math.round of an exact .5 boundary).
  const expectedHourly = 35_750_000 / 2080;
  const expectedLine = Math.round(10 * expectedHourly);
  assert.equal(out.projects[0].totals.labour_cost_cents, expectedLine);
  assert.equal(out.projects[0].labour_worksheet[0].cap_applied, true);
});

test('does NOT apply the cap when the employee is not flagged as specified', () => {
  const s = scenario({
    userClaimant: { is_specified_employee: 0 },
    comp: { comp_type: 'salary', amount_cents: 50_000_000, hours_per_year: 2080 },
  });
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
    work_date: '2025-03-15', hours: 10,
  });

  const out = computeT661({ claimant: s.claimant, period: s.period });
  const expectedLine = Math.round(10 * (50_000_000 / 2080));
  assert.equal(out.projects[0].totals.labour_cost_cents, expectedLine);
  assert.equal(out.projects[0].labour_worksheet[0].cap_applied, false);
});

test('selects the comp row in effect on the labour entry work_date', () => {
  const s = scenario({ skipComp: true });
  // Two comp rows: $50/hr-equivalent before April, $100/hr-equivalent from April.
  insertCompRow(ctx.db, s.ucId, {
    comp_type: 'salary', amount_cents: 10_400_000, effective_from: '2025-01-01',
  });
  insertCompRow(ctx.db, s.ucId, {
    comp_type: 'salary', amount_cents: 20_800_000, effective_from: '2025-04-01',
  });

  // One entry under the old rate, one under the new.
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
    work_date: '2025-03-31', hours: 8,  // old rate => 40_000c
  });
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
    work_date: '2025-04-01', hours: 8,  // new rate => 80_000c
  });

  const out = computeT661({ claimant: s.claimant, period: s.period });
  assert.equal(out.projects[0].totals.labour_cost_cents, 40_000 + 80_000);
  // Single worksheet row because it's the same employee.
  assert.equal(out.projects[0].labour_worksheet[0].total_hours, 16);
});

test('throws when a labour entry has no comp row in effect on its work_date', () => {
  const s = scenario({ skipComp: true });
  insertCompRow(ctx.db, s.ucId, {
    comp_type: 'salary', amount_cents: 10_400_000, effective_from: '2025-06-01',
  });
  // Work date predates the only comp row.
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
    work_date: '2025-03-15', hours: 8,
  });

  assert.throws(
    () => computeT661({ claimant: s.claimant, period: s.period }),
    err => {
      assert.equal(err.status, 422);
      assert.equal(err.code, 'unprocessable');
      assert.match(err.message, /no compensation row/);
      return true;
    }
  );
});

test('excludes type=internal projects; only type=sred projects appear in the output', () => {
  const s = scenario({
    comp: { comp_type: 'salary', amount_cents: 10_400_000 },
    project: { title: 'SR&ED One', type: 'sred' },
  });
  const internalId = insertProject(ctx.db, s.claimantId, {
    title: 'Internal Tools', type: 'internal',
  });
  // Labour on both projects.
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
    work_date: '2025-03-15', hours: 4,
  });
  insertLabourEntry(ctx.db, internalId, s.ucId, s.periodId, {
    work_date: '2025-03-15', hours: 4,
  });

  const out = computeT661({ claimant: s.claimant, period: s.period });
  assert.equal(out.projects.length, 1);
  assert.equal(out.projects[0].title, 'SR&ED One');
  // Internal labour did not leak into grand_total.
  assert.equal(out.grand_total.labour_cost_cents, 20_000); // 4h * $50
});

test('rolls up materials, contract, and third_party_payment expenses by category', () => {
  const s = scenario({
    claimant: { sred_method: 'traditional' }, // avoid proxy overhead obscuring totals
    comp: { comp_type: 'salary', amount_cents: 10_400_000 },
  });
  insertExpense(ctx.db, s.projectId, s.ucId, s.periodId, {
    category: 'material', amount_cents: 12_345,
  });
  insertExpense(ctx.db, s.projectId, s.ucId, s.periodId, {
    category: 'material', amount_cents: 7_655,
  });
  insertExpense(ctx.db, s.projectId, s.ucId, s.periodId, {
    category: 'contract', amount_cents: 50_000,
  });
  insertExpense(ctx.db, s.projectId, s.ucId, s.periodId, {
    category: 'third_party_payment', amount_cents: 25_000,
  });
  insertExpense(ctx.db, s.projectId, s.ucId, s.periodId, {
    category: 'overhead', amount_cents: 9_999,
  });

  const out = computeT661({ claimant: s.claimant, period: s.period });
  const t = out.projects[0].totals;
  assert.equal(t.materials_cents, 20_000);
  assert.equal(t.contract_expenditures_cents, 50_000);
  assert.equal(t.third_party_payments_cents, 25_000);
  // Traditional method => overhead is the sum of overhead-category expenses.
  assert.equal(t.overhead_cents, 9_999);
  assert.equal(t.total_cents, 0 + 20_000 + 50_000 + 25_000 + 9_999);
});

test('converts a USD expense into CAD using fx_rate', () => {
  const s = scenario({
    claimant: { sred_method: 'traditional' },
    comp: { comp_type: 'salary', amount_cents: 10_400_000 },
  });
  insertExpense(ctx.db, s.projectId, s.ucId, s.periodId, {
    category: 'material',
    amount_cents: 100_00,    // $100 USD
    currency: 'USD',
    fx_rate: 1.37,
  });

  const out = computeT661({ claimant: s.claimant, period: s.period });
  // 100_00 * 1.37 = 13700, rounded.
  assert.equal(out.projects[0].totals.materials_cents, 13_700);
  const line = out.projects[0].expense_lines[0];
  assert.equal(line.currency, 'USD');
  assert.equal(line.amount_cents, 10_000);
  assert.equal(line.reporting_amount_cents, 13_700);
});

test('proxy overhead is 55% of project labour, regardless of overhead expenses', () => {
  const s = scenario({
    claimant: { sred_method: 'proxy' },
    comp: { comp_type: 'salary', amount_cents: 10_400_000 }, // $50/hr
  });
  // 4 entries * 20h = 80h. labour = 80 * $50 = $4000 = 400_000c.
  for (let i = 0; i < 4; i++) {
    insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
      work_date: `2025-03-1${i}`, hours: 20,
    });
  }
  // Overhead-category expense should be ignored under proxy.
  insertExpense(ctx.db, s.projectId, s.ucId, s.periodId, {
    category: 'overhead', amount_cents: 999_999,
  });

  const out = computeT661({ claimant: s.claimant, period: s.period });
  assert.equal(out.projects[0].totals.labour_cost_cents, 400_000);
  // 0.55 * 400_000 = 220_000c.
  assert.equal(out.projects[0].totals.overhead_cents, 220_000);
});

test('traditional overhead method sums overhead-category expenses (ignores 55% proxy)', () => {
  const s = scenario({
    claimant: { sred_method: 'traditional' },
    comp: { comp_type: 'salary', amount_cents: 10_400_000 },
  });
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
    work_date: '2025-03-15', hours: 20,
  });
  insertExpense(ctx.db, s.projectId, s.ucId, s.periodId, {
    category: 'overhead', amount_cents: 12_345,
  });

  const out = computeT661({ claimant: s.claimant, period: s.period });
  assert.equal(out.projects[0].totals.overhead_cents, 12_345);
});

test('excludes pending and rejected labour entries', () => {
  const s = scenario({
    comp: { comp_type: 'salary', amount_cents: 10_400_000 },
  });
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
    work_date: '2025-03-15', hours: 8, status: 'approved',
  });
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
    work_date: '2025-03-15', hours: 8, status: 'pending',
  });
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
    work_date: '2025-03-15', hours: 8, status: 'rejected',
  });

  const out = computeT661({ claimant: s.claimant, period: s.period });
  // Only the approved one (8h * $50 = $400).
  assert.equal(out.projects[0].totals.labour_cost_cents, 40_000);
});

test('excludes pending and rejected expenses', () => {
  const s = scenario({
    claimant: { sred_method: 'traditional' },
    comp: { comp_type: 'salary', amount_cents: 10_400_000 },
  });
  insertExpense(ctx.db, s.projectId, s.ucId, s.periodId, {
    category: 'material', amount_cents: 10_000, status: 'approved',
  });
  insertExpense(ctx.db, s.projectId, s.ucId, s.periodId, {
    category: 'material', amount_cents: 99_999, status: 'pending',
  });
  insertExpense(ctx.db, s.projectId, s.ucId, s.periodId, {
    category: 'material', amount_cents: 99_999, status: 'rejected',
  });

  const out = computeT661({ claimant: s.claimant, period: s.period });
  assert.equal(out.projects[0].totals.materials_cents, 10_000);
});

test('excludes labour entries from other fiscal periods (period scoping)', () => {
  const s = scenario({
    comp: { comp_type: 'salary', amount_cents: 10_400_000 },
  });
  // Second period on the same claimant.
  const otherPeriodId = insertFiscalPeriod(ctx.db, s.claimantId, {
    start_date: '2024-01-01', end_date: '2024-12-31',
  });

  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
    work_date: '2025-06-01', hours: 8,
  });
  // Belongs to the other period — must not roll up into the requested one.
  insertCompRow(ctx.db, s.ucId, {
    comp_type: 'salary', amount_cents: 10_400_000, effective_from: '2024-01-01',
  });
  insertLabourEntry(ctx.db, s.projectId, s.ucId, otherPeriodId, {
    work_date: '2024-06-01', hours: 20,
  });

  const out = computeT661({ claimant: s.claimant, period: s.period });
  assert.equal(out.projects[0].totals.labour_cost_cents, 40_000); // only the 8h entry
});

test('excludes expenses from other fiscal periods', () => {
  const s = scenario({
    claimant: { sred_method: 'traditional' },
    comp: { comp_type: 'salary', amount_cents: 10_400_000 },
  });
  const otherPeriodId = insertFiscalPeriod(ctx.db, s.claimantId, {
    start_date: '2024-01-01', end_date: '2024-12-31',
  });
  insertExpense(ctx.db, s.projectId, s.ucId, s.periodId, {
    category: 'material', amount_cents: 10_000,
  });
  insertExpense(ctx.db, s.projectId, s.ucId, otherPeriodId, {
    category: 'material', amount_cents: 999_999,
  });

  const out = computeT661({ claimant: s.claimant, period: s.period });
  assert.equal(out.projects[0].totals.materials_cents, 10_000);
});

test('rejects a period that does not belong to the claimant', () => {
  const s = scenario({
    comp: { comp_type: 'salary', amount_cents: 10_400_000 },
  });
  const otherClaimantId = insertClaimant(ctx.db, { legal_name: 'Other Co' });
  const otherPeriodId = insertFiscalPeriod(ctx.db, otherClaimantId);
  const otherPeriod = getFiscalPeriod(ctx.db, otherPeriodId);

  assert.throws(
    () => computeT661({ claimant: s.claimant, period: otherPeriod }),
    err => {
      assert.equal(err.status, 422);
      assert.match(err.message, /does not belong/);
      return true;
    }
  );
});

test('reports grand totals as the sum of project totals across multiple SR&ED projects', () => {
  const s = scenario({
    claimant: { sred_method: 'traditional' },
    comp: { comp_type: 'salary', amount_cents: 10_400_000 },
  });
  const projectB = insertProject(ctx.db, s.claimantId, { title: 'B', type: 'sred' });
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
    work_date: '2025-03-15', hours: 8,    // 40_000c
  });
  insertLabourEntry(ctx.db, projectB, s.ucId, s.periodId, {
    work_date: '2025-03-15', hours: 4,    // 20_000c
  });
  insertExpense(ctx.db, projectB, s.ucId, s.periodId, {
    category: 'contract', amount_cents: 99_000,
  });

  const out = computeT661({ claimant: s.claimant, period: s.period });
  assert.equal(out.projects.length, 2);
  assert.equal(out.grand_total.labour_cost_cents, 60_000);
  assert.equal(out.grand_total.contract_expenditures_cents, 99_000);
  assert.equal(out.grand_total.total_cents, 60_000 + 99_000);
});

// --- snapshotProjectRevisions -----------------------------------------------

test('snapshotProjectRevisions: returns null for a project with no revisions', () => {
  const s = scenario({ comp: { comp_type: 'salary', amount_cents: 10_400_000 } });
  const snap = snapshotProjectRevisions(s.claimantId);
  assert.deepEqual(Object.keys(snap).map(Number), [s.projectId]);
  assert.equal(snap[s.projectId], null);
});

test('snapshotProjectRevisions: returns the latest revision per project', () => {
  const s = scenario({ comp: { comp_type: 'salary', amount_cents: 10_400_000 } });
  ctx.db.prepare(`
    INSERT INTO project_revisions
      (project_id, title, field_of_science, advancement_sought, uncertainties,
       work_performed, revised_by_user_id, type, revised_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'sred', ?)
  `).run(s.projectId, 'v1', 'cs', 'a1', 'u1', 'w1', s.userId, '2025-01-01');
  ctx.db.prepare(`
    INSERT INTO project_revisions
      (project_id, title, field_of_science, advancement_sought, uncertainties,
       work_performed, revised_by_user_id, type, revised_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'sred', ?)
  `).run(s.projectId, 'v2', 'cs', 'a2', 'u2', 'w2', s.userId, '2025-02-01');

  const snap = snapshotProjectRevisions(s.claimantId);
  assert.equal(snap[s.projectId].title, 'v2');
  assert.equal(snap[s.projectId].advancement_sought, 'a2');
});

// --- collectEvidenceManifest -------------------------------------------------

test('collectEvidenceManifest: returns evidence items scoped to the claimant + period', () => {
  const s = scenario({ comp: { comp_type: 'salary', amount_cents: 10_400_000 } });

  // In-scope evidence (correct claimant + period).
  ctx.db.prepare(`
    INSERT INTO evidence_items
      (project_id, fiscal_period_id, uploaded_by_user_id, kind, caption, evidence_date, note_text)
    VALUES (?, ?, ?, 'note', 'a note', '2025-03-15', 'hello')
  `).run(s.projectId, s.periodId, s.userId);

  // Out-of-scope: different period on the same project.
  const otherPeriodId = insertFiscalPeriod(ctx.db, s.claimantId, {
    start_date: '2024-01-01', end_date: '2024-12-31',
  });
  ctx.db.prepare(`
    INSERT INTO evidence_items
      (project_id, fiscal_period_id, uploaded_by_user_id, kind, caption, evidence_date, note_text)
    VALUES (?, ?, ?, 'note', 'old', '2024-03-15', 'old note')
  `).run(s.projectId, otherPeriodId, s.userId);

  // Out-of-scope: different claimant entirely.
  const otherClaimantId = insertClaimant(ctx.db, { legal_name: 'Other Co' });
  const otherClaimantProjectId = insertProject(ctx.db, otherClaimantId);
  const otherClaimantPeriodId = insertFiscalPeriod(ctx.db, otherClaimantId);
  ctx.db.prepare(`
    INSERT INTO evidence_items
      (project_id, fiscal_period_id, uploaded_by_user_id, kind, caption, evidence_date, note_text)
    VALUES (?, ?, ?, 'note', 'other claimant', '2025-03-15', 'no')
  `).run(otherClaimantProjectId, otherClaimantPeriodId, s.userId);

  const items = collectEvidenceManifest(s.claimantId, s.periodId);
  assert.equal(items.length, 1);
  assert.equal(items[0].caption, 'a note');
});

// --- effective_until on compensation rows -----------------------------------

test('findEffectiveComp rejects a work_date after the comp row was closed out', () => {
  const s = scenario({ skipComp: true });
  // Comp row valid only Jan–Mar 2025. A labour entry on Apr 1 must NOT match.
  ctx.db.prepare(`
    INSERT INTO compensation_rows
      (user_claimant_id, comp_type, amount_cents, hours_per_year,
       effective_from, effective_until)
    VALUES (?, 'salary', 10_400_000, 2080, '2025-01-01', '2025-03-31')
  `).run(s.ucId);

  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
    work_date: '2025-04-01', hours: 8,
  });

  assert.throws(
    () => computeT661({ claimant: s.claimant, period: s.period }),
    err => {
      assert.equal(err.status, 422);
      assert.match(err.message, /no compensation row/);
      return true;
    }
  );
});

test('findEffectiveComp matches a work_date on the effective_until boundary', () => {
  const s = scenario({ skipComp: true });
  ctx.db.prepare(`
    INSERT INTO compensation_rows
      (user_claimant_id, comp_type, amount_cents, hours_per_year,
       effective_from, effective_until)
    VALUES (?, 'salary', 10_400_000, 2080, '2025-01-01', '2025-03-31')
  `).run(s.ucId);

  // Entry on the close-out date itself should still match (until is inclusive).
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
    work_date: '2025-03-31', hours: 8,
  });

  const out = computeT661({ claimant: s.claimant, period: s.period });
  assert.equal(out.projects[0].totals.labour_cost_cents, 40_000);
});

// --- proxy mode: expense_lines filtering ------------------------------------

test('proxy mode: expense_lines excludes overhead-category rows', () => {
  const s = scenario({
    claimant: { sred_method: 'proxy' },
    comp: { comp_type: 'salary', amount_cents: 10_400_000 },
  });
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
    work_date: '2025-03-15', hours: 8,
  });
  insertExpense(ctx.db, s.projectId, s.ucId, s.periodId, {
    category: 'material', amount_cents: 50_000,
  });
  insertExpense(ctx.db, s.projectId, s.ucId, s.periodId, {
    category: 'overhead', amount_cents: 999_999,
  });

  const out = computeT661({ claimant: s.claimant, period: s.period });
  const lines = out.projects[0].expense_lines;
  // Only the material line — the overhead-category row is replaced by the
  // deemed 55%, so showing it here would mislead anyone diffing lines vs totals.
  assert.equal(lines.length, 1);
  assert.equal(lines[0].category, 'material');
  for (const line of lines) {
    assert.notEqual(line.category, 'overhead');
  }
});

test('traditional mode: expense_lines still includes overhead rows', () => {
  // Mirror of the proxy test — under traditional, overhead-category rows
  // contribute to totals and should remain visible in expense_lines.
  const s = scenario({
    claimant: { sred_method: 'traditional' },
    comp: { comp_type: 'salary', amount_cents: 10_400_000 },
  });
  insertExpense(ctx.db, s.projectId, s.ucId, s.periodId, {
    category: 'overhead', amount_cents: 12_345,
  });

  const out = computeT661({ claimant: s.claimant, period: s.period });
  const lines = out.projects[0].expense_lines;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].category, 'overhead');
});

// --- schema CHECKs ----------------------------------------------------------

test('schema rejects compensation_rows.hours_per_year = 0', () => {
  const s = scenario({ skipComp: true });
  assert.throws(
    () => ctx.db.prepare(`
      INSERT INTO compensation_rows
        (user_claimant_id, comp_type, amount_cents, hours_per_year, effective_from)
      VALUES (?, 'salary', 10_400_000, 0, '2025-01-01')
    `).run(s.ucId),
    err => {
      // better-sqlite3 surfaces CHECK failures as SqliteError with this code.
      assert.equal(err.code, 'SQLITE_CONSTRAINT_CHECK');
      return true;
    }
  );
});

test('schema rejects compensation_rows.hours_per_year < 0', () => {
  const s = scenario({ skipComp: true });
  assert.throws(
    () => ctx.db.prepare(`
      INSERT INTO compensation_rows
        (user_claimant_id, comp_type, amount_cents, hours_per_year, effective_from)
      VALUES (?, 'salary', 10_400_000, -1, '2025-01-01')
    `).run(s.ucId),
    err => {
      assert.equal(err.code, 'SQLITE_CONSTRAINT_CHECK');
      return true;
    }
  );
});

test('schema rejects labour_entries with malformed work_date', () => {
  const s = scenario({ comp: { comp_type: 'salary', amount_cents: 10_400_000 } });
  // GLOB '????-??-??' requires the YYYY-MM-DD shape; anything shorter,
  // missing dashes, or with the wrong width is rejected.
  for (const bad of ['2025-3-15', '15-03-2025', '2025/03/15', 'not-a-date', '']) {
    assert.throws(
      () => ctx.db.prepare(`
        INSERT INTO labour_entries
          (project_id, user_claimant_id, fiscal_period_id, work_date, hours, description, status)
        VALUES (?, ?, ?, ?, 8, 'x', 'approved')
      `).run(s.projectId, s.ucId, s.periodId, bad),
      err => {
        assert.equal(err.code, 'SQLITE_CONSTRAINT_CHECK');
        return true;
      },
      `expected ${JSON.stringify(bad)} to be rejected`
    );
  }
});

test('schema accepts a well-formed labour_entries.work_date', () => {
  const s = scenario({ comp: { comp_type: 'salary', amount_cents: 10_400_000 } });
  // Sanity check: the GLOB check shouldn't block valid YYYY-MM-DD strings.
  // (GLOB is shape-only; it doesn't validate month/day ranges.)
  insertLabourEntry(ctx.db, s.projectId, s.ucId, s.periodId, {
    work_date: '2025-03-15', hours: 8,
  });
  const out = computeT661({ claimant: s.claimant, period: s.period });
  assert.equal(out.projects[0].totals.labour_cost_cents, 40_000);
});
