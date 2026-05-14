// Unit tests for src/lib/format.js — single-period formatters.
//
// Focus: the overtime-aware labour worksheet rendering. We build a minimal
// in-memory totals payload (no DB needed) so the test exercises the formatter
// rather than the calc engine. (The calc engine itself is covered in
// tests/lib/t661.test.js — including that the labour cost is unaffected by
// the overtime flag.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toMarkdown, toCsv } from '../../src/lib/format.js';

// Build a totals payload that mimics the shape produced by `computeT661`.
// Only the fields the formatter consumes are populated.
function makeTotals({ worksheet, projectOvertimeHours, projectRegularHours }) {
  const labourCostCents = 40_000;
  return {
    claimant: {
      id: 1,
      legal_name: 'Test Co',
      business_number: '123',
      reporting_currency: 'CAD',
      sred_method: 'traditional',
    },
    fiscal_period: { id: 1, start_date: '2025-01-01', end_date: '2025-12-31', status: 'open' },
    projects: [
      {
        id: 10,
        title: 'P1',
        field_of_science: 'cs',
        start_date: '2025-01-01',
        end_date: null,
        status: 'development',
        narrative: { advancement_sought: '', uncertainties: '', work_performed: '' },
        totals: {
          labour_cost_cents: labourCostCents,
          labour_hours_total:    (projectRegularHours ?? 0) + (projectOvertimeHours ?? 0),
          labour_hours_regular:  projectRegularHours ?? 0,
          labour_hours_overtime: projectOvertimeHours ?? 0,
          materials_cents: 0,
          contract_expenditures_cents: 0,
          third_party_payments_cents: 0,
          overhead_cents: 0,
          total_cents: labourCostCents,
        },
        labour_worksheet: worksheet,
        expense_lines: [],
      },
    ],
    grand_total: {
      labour_cost_cents: labourCostCents,
      materials_cents: 0,
      contract_expenditures_cents: 0,
      third_party_payments_cents: 0,
      overhead_cents: 0,
      total_cents: labourCostCents,
    },
    generated_at: '2025-05-14T00:00:00.000Z',
  };
}

test('toMarkdown: labour worksheet includes Overtime column when any row has OT hours', () => {
  const totals = makeTotals({
    projectRegularHours: 6, projectOvertimeHours: 2,
    worksheet: [{
      user_claimant_id: 1, user_id: 1,
      employee_name: 'Alice', employee_email: 'a@example.com',
      is_specified_employee: false,
      total_hours: 8, regular_hours: 6, overtime_hours: 2,
      labour_cost_cents: 40_000, cap_applied: false,
    }],
  });
  const md = toMarkdown(totals);
  // Header advertises the new columns.
  assert.match(md, /\| Employee \| Specified \| Hours \| Regular \| Overtime \| Cost \| Cap applied \|/);
  // Body row contains the regular and overtime hour values.
  assert.match(md, /\| Alice \|[^|]*\| 8\.00 \| 6\.00 \| 2\.00 \|/);
});

test('toMarkdown: labour worksheet omits Overtime column when no row has OT hours', () => {
  const totals = makeTotals({
    projectRegularHours: 8, projectOvertimeHours: 0,
    worksheet: [{
      user_claimant_id: 1, user_id: 1,
      employee_name: 'Alice', employee_email: 'a@example.com',
      is_specified_employee: false,
      total_hours: 8, regular_hours: 8, overtime_hours: 0,
      labour_cost_cents: 40_000, cap_applied: false,
    }],
  });
  const md = toMarkdown(totals);
  // Legacy 5-column header (no Regular / Overtime).
  assert.match(md, /\| Employee \| Specified \| Hours \| Cost \| Cap applied \|/);
  assert.ok(!/\| Regular \|/.test(md), 'Regular column must not appear when no overtime');
  assert.ok(!/\| Overtime \|/.test(md), 'Overtime column must not appear when no overtime');
});

test('toMarkdown: mixed worksheet — adding the OT columns is per-project, not per-row', () => {
  // A project where only one row has OT — both rows should appear under the
  // 7-column header (the other row reports overtime=0).
  const totals = makeTotals({
    projectRegularHours: 10, projectOvertimeHours: 2,
    worksheet: [
      {
        user_claimant_id: 1, user_id: 1, employee_name: 'Alice', employee_email: 'a@example.com',
        is_specified_employee: false,
        total_hours: 8, regular_hours: 6, overtime_hours: 2,
        labour_cost_cents: 40_000, cap_applied: false,
      },
      {
        user_claimant_id: 2, user_id: 2, employee_name: 'Bob', employee_email: 'b@example.com',
        is_specified_employee: false,
        total_hours: 4, regular_hours: 4, overtime_hours: 0,
        labour_cost_cents: 20_000, cap_applied: false,
      },
    ],
  });
  const md = toMarkdown(totals);
  assert.match(md, /\| Employee \| Specified \| Hours \| Regular \| Overtime \| Cost \| Cap applied \|/);
  // Alice has 2.00 OT, Bob has 0.00 OT.
  assert.match(md, /\| Alice \|[^|]*\| 8\.00 \| 6\.00 \| 2\.00 \|/);
  assert.match(md, /\| Bob \|[^|]*\| 4\.00 \| 4\.00 \| 0\.00 \|/);
});

test('toCsv: emits labour_regular_hours / labour_overtime_hours rows when OT > 0', () => {
  const totals = makeTotals({
    projectRegularHours: 6, projectOvertimeHours: 2,
    worksheet: [{
      user_claimant_id: 1, user_id: 1, employee_name: 'Alice', employee_email: 'a@example.com',
      is_specified_employee: false,
      total_hours: 8, regular_hours: 6, overtime_hours: 2,
      labour_cost_cents: 40_000, cap_applied: false,
    }],
  });
  const csv = toCsv(totals);
  const lines = csv.split('\n');
  // Hours-bucket rows present and immediately follow the labour cost row.
  assert.ok(lines.some(l => l.startsWith('labour_regular_hours,10,P1,,6')),
    `expected labour_regular_hours row, got:\n${csv}`);
  assert.ok(lines.some(l => l.startsWith('labour_overtime_hours,10,P1,,2')),
    `expected labour_overtime_hours row, got:\n${csv}`);
});

test('toCsv: no hours-bucket rows when the project has no overtime', () => {
  const totals = makeTotals({
    projectRegularHours: 8, projectOvertimeHours: 0,
    worksheet: [{
      user_claimant_id: 1, user_id: 1, employee_name: 'Alice', employee_email: 'a@example.com',
      is_specified_employee: false,
      total_hours: 8, regular_hours: 8, overtime_hours: 0,
      labour_cost_cents: 40_000, cap_applied: false,
    }],
  });
  const csv = toCsv(totals);
  assert.ok(!/labour_regular_hours/.test(csv), 'must not emit labour_regular_hours when OT = 0');
  assert.ok(!/labour_overtime_hours/.test(csv), 'must not emit labour_overtime_hours when OT = 0');
});
