import { db } from '../db/index.js';
import { specifiedEmployeeCapCents } from './wage-caps.js';
import { notFound, unprocessable } from './errors.js';

// Find the compensation row in effect on `workDate` for a given user_claimant.
function findEffectiveComp(userClaimantId, workDate) {
  return db.prepare(`
    SELECT * FROM compensation_rows
     WHERE user_claimant_id = ? AND effective_from <= ?
     ORDER BY effective_from DESC, id DESC
     LIMIT 1
  `).get(userClaimantId, workDate);
}

// Effective hourly rate (in cents) for a labour entry, with the specified-employee cap applied.
// Returns { hourly_cents, cap_applied, annual_base_cents, effective_annual_cents }.
function effectiveHourly({ comp, isSpecified, workDate }) {
  const yearlyHours = comp.hours_per_year || 2080;
  const annualBase = comp.comp_type === 'salary'
    ? comp.amount_cents
    : comp.amount_cents * yearlyHours;
  const year = Number(workDate.slice(0, 4));
  const cap = isSpecified ? specifiedEmployeeCapCents(year) : null;
  const effectiveAnnual = cap !== null && annualBase > cap ? cap : annualBase;
  return {
    hourly_cents: effectiveAnnual / yearlyHours,
    cap_applied: cap !== null && annualBase > cap,
    annual_base_cents: annualBase,
    effective_annual_cents: effectiveAnnual,
  };
}

function reportingAmount(expense) {
  // amount_cents is in `currency`; multiply by fx_rate to convert. Null fx_rate = 1:1.
  return Math.round(expense.amount_cents * (expense.fx_rate ?? 1));
}

export function computeT661({ claimant, period }) {
  if (claimant.id !== period.claimant_id) {
    throw unprocessable('fiscal period does not belong to claimant');
  }

  // Only type='sred' projects roll up into a T661. Internal projects are
  // tracked for hygiene but excluded here.
  const projects = db.prepare(
    `SELECT * FROM projects WHERE claimant_id = ? AND type = 'sred' ORDER BY id`
  ).all(claimant.id);

  const projectSnapshots = projects.map(project => {
    // -- Labour worksheet (per user_claimant) --
    const labourEntries = db.prepare(`
      SELECT * FROM labour_entries
       WHERE project_id = ? AND fiscal_period_id = ? AND status = 'approved'
       ORDER BY work_date
    `).all(project.id, period.id);

    const perUc = new Map();
    let projectLabourCents = 0;

    for (const entry of labourEntries) {
      const comp = findEffectiveComp(entry.user_claimant_id, entry.work_date);
      if (!comp) {
        throw unprocessable(
          `no compensation row for user_claimant ${entry.user_claimant_id} on or before ${entry.work_date} (labour entry ${entry.id})`
        );
      }
      const uc = db.prepare(`
        SELECT uc.*, u.name AS user_name, u.email AS user_email
          FROM user_claimants uc JOIN users u ON u.id = uc.user_id
         WHERE uc.id = ?
      `).get(entry.user_claimant_id);

      const rate = effectiveHourly({
        comp,
        isSpecified: !!uc.is_specified_employee,
        workDate: entry.work_date,
      });
      const lineCents = Math.round(entry.hours * rate.hourly_cents);
      projectLabourCents += lineCents;

      let row = perUc.get(uc.id);
      if (!row) {
        row = {
          user_claimant_id: uc.id,
          user_id: uc.user_id,
          employee_name: uc.user_name,
          employee_email: uc.user_email,
          is_specified_employee: !!uc.is_specified_employee,
          total_hours: 0,
          labour_cost_cents: 0,
          cap_applied: false,
        };
        perUc.set(uc.id, row);
      }
      row.total_hours += entry.hours;
      row.labour_cost_cents += lineCents;
      row.cap_applied = row.cap_applied || rate.cap_applied;
    }

    // -- Expenses (per category) --
    const expenses = db.prepare(`
      SELECT * FROM expenses
       WHERE project_id = ? AND fiscal_period_id = ? AND status = 'approved'
       ORDER BY expense_date, id
    `).all(project.id, period.id);

    let materials = 0, contracts = 0, thirdParty = 0, overheadExpenses = 0;
    const expenseLines = expenses.map(e => {
      const rep = reportingAmount(e);
      if      (e.category === 'material')              materials += rep;
      else if (e.category === 'contract')              contracts += rep;
      else if (e.category === 'third_party_payment')   thirdParty += rep;
      else if (e.category === 'overhead')              overheadExpenses += rep;
      return {
        id: e.id,
        expense_date: e.expense_date,
        category: e.category,
        amount_cents: e.amount_cents,
        currency: e.currency,
        fx_rate: e.fx_rate,
        reporting_amount_cents: rep,
        description: e.description,
      };
    });

    const overhead = claimant.sred_method === 'proxy'
      ? Math.round(0.55 * projectLabourCents)
      : overheadExpenses;

    return {
      id: project.id,
      title: project.title,
      field_of_science: project.field_of_science,
      start_date: project.start_date,
      end_date: project.end_date,
      status: project.status,
      narrative: {
        advancement_sought: project.advancement_sought,
        uncertainties: project.uncertainties,
        work_performed: project.work_performed,
      },
      totals: {
        labour_cost_cents: projectLabourCents,
        materials_cents: materials,
        contract_expenditures_cents: contracts,
        third_party_payments_cents: thirdParty,
        overhead_cents: overhead,
        total_cents: projectLabourCents + materials + contracts + thirdParty + overhead,
      },
      labour_worksheet: Array.from(perUc.values()),
      expense_lines: expenseLines,
    };
  });

  // Grand totals — sum project totals.
  const grand = projectSnapshots.reduce((acc, p) => ({
    labour_cost_cents:           acc.labour_cost_cents          + p.totals.labour_cost_cents,
    materials_cents:             acc.materials_cents            + p.totals.materials_cents,
    contract_expenditures_cents: acc.contract_expenditures_cents + p.totals.contract_expenditures_cents,
    third_party_payments_cents:  acc.third_party_payments_cents + p.totals.third_party_payments_cents,
    overhead_cents:              acc.overhead_cents             + p.totals.overhead_cents,
    total_cents:                 acc.total_cents                + p.totals.total_cents,
  }), {
    labour_cost_cents: 0, materials_cents: 0, contract_expenditures_cents: 0,
    third_party_payments_cents: 0, overhead_cents: 0, total_cents: 0,
  });

  return {
    claimant: {
      id: claimant.id,
      legal_name: claimant.legal_name,
      business_number: claimant.business_number,
      reporting_currency: claimant.reporting_currency,
      sred_method: claimant.sred_method,
    },
    fiscal_period: {
      id: period.id,
      start_date: period.start_date,
      end_date: period.end_date,
      status: period.status,
    },
    projects: projectSnapshots,
    grand_total: grand,
    generated_at: new Date().toISOString(),
  };
}

// Latest project_revisions row per project — captured at export time so a later
// narrative edit doesn't rewrite history.
export function snapshotProjectRevisions(claimantId) {
  const projects = db.prepare(
    `SELECT id FROM projects WHERE claimant_id = ?`
  ).all(claimantId);
  const snapshot = {};
  for (const { id } of projects) {
    const rev = db.prepare(`
      SELECT * FROM project_revisions WHERE project_id = ?
       ORDER BY id DESC LIMIT 1
    `).get(id);
    snapshot[id] = rev || null;
  }
  return snapshot;
}

export function collectEvidenceManifest(claimantId, periodId) {
  return db.prepare(`
    SELECT ei.* FROM evidence_items ei
      JOIN projects p ON p.id = ei.project_id
     WHERE p.claimant_id = ? AND ei.fiscal_period_id = ?
     ORDER BY ei.id
  `).all(claimantId, periodId);
}
