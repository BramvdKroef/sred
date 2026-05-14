// Unit tests for the comparative formatters in src/lib/format.js
// (`toMarkdownCompare`, `toCsvCompare`, `buildCompareDiff`).
//
// Strategy: construct two minimal `computeT661`-shaped totals payloads in
// memory, run them through `buildCompareDiff`, and assert the renderers
// emit both period headers, a "Δ" column, and the per-project missing-side
// notation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toMarkdownCompare,
  toCsvCompare,
  buildCompareDiff,
} from '../../src/lib/format.js';

// Build a totals payload that mimics what `computeT661` produces, minus
// labour_worksheet / expense_lines (the compare formatters don't reach into
// those — they operate on `grand_total` and the per-project `totals`).
function makeTotals({ periodId, startDate, endDate, status = 'open', projects }) {
  const grand = {
    labour_cost_cents: 0, materials_cents: 0, contract_expenditures_cents: 0,
    third_party_payments_cents: 0, overhead_cents: 0, total_cents: 0,
  };
  const projectPayloads = projects.map(p => {
    for (const k of Object.keys(grand)) grand[k] += p[k] ?? 0;
    return {
      id: p.id,
      title: p.title,
      field_of_science: 'cs',
      start_date: startDate,
      end_date: endDate,
      status: 'development',
      narrative: { advancement_sought: '', uncertainties: '', work_performed: '' },
      totals: {
        labour_cost_cents:           p.labour_cost_cents ?? 0,
        materials_cents:             p.materials_cents ?? 0,
        contract_expenditures_cents: p.contract_expenditures_cents ?? 0,
        third_party_payments_cents:  p.third_party_payments_cents ?? 0,
        overhead_cents:              p.overhead_cents ?? 0,
        total_cents:                 p.total_cents ?? 0,
      },
      labour_worksheet: [],
      expense_lines: [],
    };
  });
  return {
    claimant: {
      id: 1, legal_name: 'Test Co', business_number: '123', reporting_currency: 'CAD',
      sred_method: 'traditional',
    },
    fiscal_period: { id: periodId, start_date: startDate, end_date: endDate, status },
    projects: projectPayloads,
    grand_total: grand,
    generated_at: '2025-05-14T00:00:00.000Z',
  };
}

test('buildCompareDiff: per-field grand_total deltas are arithmetic', () => {
  const a = makeTotals({
    periodId: 1, startDate: '2024-01-01', endDate: '2024-12-31',
    projects: [{ id: 10, title: 'P1', labour_cost_cents: 100, total_cents: 100 }],
  });
  const b = makeTotals({
    periodId: 2, startDate: '2025-01-01', endDate: '2025-12-31',
    projects: [{ id: 10, title: 'P1', labour_cost_cents: 250, total_cents: 250 }],
  });
  const diff = buildCompareDiff(a, b);
  assert.equal(diff.grand_total.labour_cost_cents.delta_cents, 150);
  assert.equal(diff.grand_total.labour_cost_cents.delta_pct, 150); // 150/100 * 100
  assert.equal(diff.grand_total.total_cents.delta_cents, 150);
});

test('buildCompareDiff: delta_pct is null when side A is 0', () => {
  const a = makeTotals({
    periodId: 1, startDate: '2024-01-01', endDate: '2024-12-31',
    projects: [{ id: 10, title: 'P1' }], // all zeros
  });
  const b = makeTotals({
    periodId: 2, startDate: '2025-01-01', endDate: '2025-12-31',
    projects: [{ id: 10, title: 'P1', materials_cents: 500, total_cents: 500 }],
  });
  const diff = buildCompareDiff(a, b);
  assert.equal(diff.grand_total.materials_cents.delta_cents, 500);
  assert.equal(diff.grand_total.materials_cents.delta_pct, null);
});

test('buildCompareDiff: a project missing from B has missing_from=b, diff=null', () => {
  const a = makeTotals({
    periodId: 1, startDate: '2024-01-01', endDate: '2024-12-31',
    projects: [
      { id: 10, title: 'P1', labour_cost_cents: 100, total_cents: 100 },
      { id: 20, title: 'Discontinued', labour_cost_cents: 80, total_cents: 80 },
    ],
  });
  const b = makeTotals({
    periodId: 2, startDate: '2025-01-01', endDate: '2025-12-31',
    projects: [{ id: 10, title: 'P1', labour_cost_cents: 150, total_cents: 150 }],
  });
  const diff = buildCompareDiff(a, b);
  const disc = diff.projects.find(p => p.project_id === 20);
  assert.ok(disc, 'discontinued project must be in the union');
  assert.equal(disc.missing_from, 'b');
  assert.equal(disc.b, null);
  assert.equal(disc.diff, null);
  assert.equal(disc.a.labour_cost_cents, 80);
});

test('buildCompareDiff: a project missing from A has missing_from=a', () => {
  const a = makeTotals({
    periodId: 1, startDate: '2024-01-01', endDate: '2024-12-31',
    projects: [{ id: 10, title: 'P1', labour_cost_cents: 100, total_cents: 100 }],
  });
  const b = makeTotals({
    periodId: 2, startDate: '2025-01-01', endDate: '2025-12-31',
    projects: [
      { id: 10, title: 'P1', labour_cost_cents: 150, total_cents: 150 },
      { id: 30, title: 'New Project', labour_cost_cents: 40, total_cents: 40 },
    ],
  });
  const diff = buildCompareDiff(a, b);
  const newp = diff.projects.find(p => p.project_id === 30);
  assert.ok(newp, 'new project must be in the union');
  assert.equal(newp.missing_from, 'a');
  assert.equal(newp.a, null);
  assert.equal(newp.b.labour_cost_cents, 40);
});

test('toMarkdownCompare: includes both period headers and a Δ column', () => {
  const a = makeTotals({
    periodId: 1, startDate: '2024-01-01', endDate: '2024-12-31',
    projects: [{ id: 10, title: 'Continuity Project', labour_cost_cents: 100, total_cents: 100 }],
  });
  const b = makeTotals({
    periodId: 2, startDate: '2025-01-01', endDate: '2025-12-31',
    projects: [{ id: 10, title: 'Continuity Project', labour_cost_cents: 200, total_cents: 200 }],
  });
  const diff = buildCompareDiff(a, b);
  const md = toMarkdownCompare(a, b, diff);

  // Both period date ranges should appear in the header block.
  assert.ok(md.includes('2024-01-01 → 2024-12-31'), 'period A label missing');
  assert.ok(md.includes('2025-01-01 → 2025-12-31'), 'period B label missing');
  // Header row uses the literal "Δ" column.
  assert.ok(md.includes(' Δ '), 'Δ column header missing');
  // Continuity project section appears.
  assert.ok(md.includes('Continuity Project'), 'project title missing from markdown');
});

test('toMarkdownCompare: missing-from project gets a callout line', () => {
  const a = makeTotals({
    periodId: 1, startDate: '2024-01-01', endDate: '2024-12-31',
    projects: [
      { id: 10, title: 'Kept', labour_cost_cents: 100, total_cents: 100 },
      { id: 20, title: 'Discontinued', labour_cost_cents: 80, total_cents: 80 },
    ],
  });
  const b = makeTotals({
    periodId: 2, startDate: '2025-01-01', endDate: '2025-12-31',
    projects: [{ id: 10, title: 'Kept', labour_cost_cents: 150, total_cents: 150 }],
  });
  const diff = buildCompareDiff(a, b);
  const md = toMarkdownCompare(a, b, diff);
  assert.ok(md.includes('Discontinued'), 'missing project title missing');
  assert.match(md, /Missing from period B/i);
});

test('toCsvCompare: header row mentions both period date ranges and delta columns', () => {
  const a = makeTotals({
    periodId: 1, startDate: '2024-01-01', endDate: '2024-12-31',
    projects: [{ id: 10, title: 'P1', labour_cost_cents: 100, total_cents: 100 }],
  });
  const b = makeTotals({
    periodId: 2, startDate: '2025-01-01', endDate: '2025-12-31',
    projects: [{ id: 10, title: 'P1', labour_cost_cents: 200, total_cents: 200 }],
  });
  const diff = buildCompareDiff(a, b);
  const csv = toCsvCompare(a, b, diff);
  const lines = csv.split('\n');
  assert.match(lines[0], /scope,project_id,project_title,line,currency/);
  assert.match(lines[0], /delta_cents/);
  assert.match(lines[0], /delta_pct/);
  // The data row for grand_total labour should have delta = 100.
  assert.ok(csv.includes(',100,200,100,'), 'grand_total labour row must include the 100→200 delta');
});
