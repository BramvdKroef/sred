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
  toPdfCompare,
  buildCompareDiff,
} from '../../src/lib/format.js';

// PDF body collector — see format.test.js for rationale.
function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on('end',  () => resolve(Buffer.concat(chunks).toString('binary')));
    stream.on('error', reject);
  });
}

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
  // Header gained a t661_line column between `line` and `currency`.
  assert.match(lines[0], /scope,project_id,project_title,line,t661_line,currency/);
  assert.match(lines[0], /delta_cents/);
  assert.match(lines[0], /delta_pct/);
  // The data row for grand_total labour should have delta = 100.
  assert.ok(csv.includes(',100,200,100,'), 'grand_total labour row must include the 100→200 delta');
});

// ── T661 line-number annotation tests (compare formatters) ────────────────
//
// SRED_DOMAIN_REVIEW F2: every total category surfaces its corresponding T661
// form line. For the compare renderers we verify both the A and B columns
// are annotated (the row label is shared between them).
test('toMarkdownCompare: grand totals + per-project rows annotate each line with T661 number', () => {
  const a = makeTotals({
    periodId: 1, startDate: '2024-01-01', endDate: '2024-12-31',
    projects: [{
      id: 10, title: 'P1',
      labour_cost_cents: 100, materials_cents: 200,
      contract_expenditures_cents: 300, third_party_payments_cents: 400,
      overhead_cents: 500, total_cents: 1500,
    }],
  });
  const b = makeTotals({
    periodId: 2, startDate: '2025-01-01', endDate: '2025-12-31',
    projects: [{
      id: 10, title: 'P1',
      labour_cost_cents: 150, materials_cents: 250,
      contract_expenditures_cents: 350, third_party_payments_cents: 450,
      overhead_cents: 550, total_cents: 1750,
    }],
  });
  const diff = buildCompareDiff(a, b);
  const md = toMarkdownCompare(a, b, diff);
  assert.match(md, /line 305/i, 'labour line 305 missing');
  assert.match(md, /line 320/i, 'materials line 320 missing');
  assert.match(md, /line 340/i, 'contract line 340 missing');
  assert.match(md, /line 345/i, 'third-party line 345 missing');
  assert.match(md, /line 360/i, 'overhead line 360 missing');
  // Dollar amounts still rendered (regression guard).
  assert.ok(md.includes('1.00 CAD'), 'A-side labour dollar amount missing');
  assert.ok(md.includes('1.50 CAD'), 'B-side labour dollar amount missing');
});

test('toCsvCompare: each line row carries its T661 number in the t661_line column', () => {
  const a = makeTotals({
    periodId: 1, startDate: '2024-01-01', endDate: '2024-12-31',
    projects: [{
      id: 10, title: 'P1',
      labour_cost_cents: 100, materials_cents: 200,
      contract_expenditures_cents: 300, third_party_payments_cents: 400,
      overhead_cents: 500, total_cents: 1500,
    }],
  });
  const b = makeTotals({
    periodId: 2, startDate: '2025-01-01', endDate: '2025-12-31',
    projects: [{
      id: 10, title: 'P1',
      labour_cost_cents: 150, materials_cents: 250,
      contract_expenditures_cents: 350, third_party_payments_cents: 450,
      overhead_cents: 550, total_cents: 1750,
    }],
  });
  const diff = buildCompareDiff(a, b);
  const csv = toCsvCompare(a, b, diff);
  // The grand_total labour row: scope, '', '', line='labour', t661_line=305, ccy, a, b, delta, pct.
  assert.match(csv, /grand_total,,,labour,305,CAD,100,150,50,/,    'grand_total labour line 305 row missing');
  assert.match(csv, /grand_total,,,materials,320,CAD,200,250,50,/, 'grand_total materials line 320 row missing');
  assert.match(csv, /grand_total,,,contract,340,CAD,300,350,50,/,  'grand_total contract line 340 row missing');
  assert.match(csv, /grand_total,,,third_party_payment,345,CAD,400,450,50,/,
    'grand_total third_party_payment line 345 row missing');
  assert.match(csv, /grand_total,,,overhead,360,CAD,500,550,50,/,  'grand_total overhead line 360 row missing');
  // Total rollup has no T661 line — empty t661_line column.
  assert.match(csv, /grand_total,,,total,,CAD,1500,1750,250,/,     'grand_total total row missing or had unexpected line number');
  // Per-project rows also annotate.
  assert.match(csv, /project,10,P1,labour,305,CAD,100,150,50,/,    'project labour line 305 row missing');
});

test('toPdfCompare: PDF body contains the T661 line annotations for each category', async () => {
  const a = makeTotals({
    periodId: 1, startDate: '2024-01-01', endDate: '2024-12-31',
    projects: [{
      id: 10, title: 'P1',
      labour_cost_cents: 100, materials_cents: 200,
      contract_expenditures_cents: 300, third_party_payments_cents: 400,
      overhead_cents: 500, total_cents: 1500,
    }],
  });
  const b = makeTotals({
    periodId: 2, startDate: '2025-01-01', endDate: '2025-12-31',
    projects: [{
      id: 10, title: 'P1',
      labour_cost_cents: 150, materials_cents: 250,
      contract_expenditures_cents: 350, third_party_payments_cents: 450,
      overhead_cents: 550, total_cents: 1750,
    }],
  });
  const diff = buildCompareDiff(a, b);
  const body = await streamToString(toPdfCompare(a, b, diff));
  assert.ok(body.includes('line 305'), 'labour line 305 missing from compare PDF');
  assert.ok(body.includes('line 320'), 'materials line 320 missing from compare PDF');
  assert.ok(body.includes('line 340'), 'contract line 340 missing from compare PDF');
  assert.ok(body.includes('line 345'), 'third-party line 345 missing from compare PDF');
  assert.ok(body.includes('line 360'), 'overhead line 360 missing from compare PDF');
});
