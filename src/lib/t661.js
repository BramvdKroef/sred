import { db } from '../db/index.js';
import { specifiedEmployeeCapCents } from './wage-caps.js';
import { notFound, unprocessable } from './errors.js';

// Proxy method: deemed overhead is 55% of eligible salary/wages for SR&ED work.
// Source: CRA T4088 §2.6 / ITA s.37(1)(d). The rate is set by regulation —
// historically adjustable; verify when filing across years.
const PROXY_OVERHEAD_RATE = 0.55;

// Find the compensation row in effect on `workDate` for a given user_claimant.
// `effective_until` is an optional close-date; a NULL value means the row is
// still open-ended (the most common case).
function findEffectiveComp(userClaimantId, workDate) {
  return db.prepare(`
    SELECT * FROM compensation_rows
     WHERE user_claimant_id = ?
       AND effective_from <= ?
       AND (effective_until IS NULL OR effective_until >= ?)
     ORDER BY effective_from DESC, id DESC
     LIMIT 1
  `).get(userClaimantId, workDate, workDate);
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
  // amount_cents is in `expense.currency`. fx_rate converts to the claimant's
  // `reporting_currency` (almost always CAD in practice). Null fx_rate = 1:1,
  // which is the right default when currency == reporting_currency (the
  // expenses route refuses to persist a foreign-currency row without a rate).
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
          // Reportorial breakdown only: T4088 treats overtime hours at the
          // same hourly rate as regular hours for SR&ED labour cost, so
          // labour_cost_cents is computed identically for both. The split
          // exists purely so the worksheet can show OT separately when
          // present (e.g., for T661 line 305 vs 306 reporting).
          regular_hours: 0,
          overtime_hours: 0,
          labour_cost_cents: 0,
          cap_applied: false,
        };
        perUc.set(uc.id, row);
      }
      row.total_hours += entry.hours;
      if (entry.is_overtime) row.overtime_hours += entry.hours;
      else                   row.regular_hours  += entry.hours;
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
        // Migration 014: pass overhead sub-classification + allocation basis
        // through to the formatter so the T661 export can surface the CRA
        // sub-bucketing (SRED_DOMAIN_REVIEW F5). Null on non-overhead rows
        // by schema CHECK.
        overhead_subcategory: e.overhead_subcategory ?? null,
        allocation_basis:     e.allocation_basis ?? null,
        // Migration 015 P3: material disposition (320 vs 325), contract
        // arm's-length flag, and fx-rate source attribution. Each is null
        // for rows where the category doesn't apply (schema CHECKs ensure
        // this). The formatter uses these to print the CRA sub-bucketing
        // in `categoryLabel`.
        material_disposition: e.material_disposition ?? null,
        contract_arms_length: e.contract_arms_length ?? null,
        amount_cents: e.amount_cents,
        currency: e.currency,
        fx_rate: e.fx_rate,
        fx_rate_source: e.fx_rate_source ?? null,
        reporting_amount_cents: rep,
        description: e.description,
      };
    });

    // Per-project hours breakdown — sum of the per-employee rows. Carried on
    // `totals` so consumers don't have to re-walk `labour_worksheet` to learn
    // the project-level OT split.
    const labourHoursBreakdown = Array.from(perUc.values()).reduce(
      (acc, r) => ({
        total:    acc.total    + r.total_hours,
        regular:  acc.regular  + r.regular_hours,
        overtime: acc.overtime + r.overtime_hours,
      }),
      { total: 0, regular: 0, overtime: 0 },
    );

    const overhead = claimant.sred_method === 'proxy'
      ? Math.round(PROXY_OVERHEAD_RATE * projectLabourCents)
      : overheadExpenses;

    // Under the proxy method, overhead-category expenses are replaced by the
    // deemed 55% of labour and so don't contribute to totals. Filter them out
    // of `expense_lines` too — otherwise a consumer diffing the lines against
    // the totals sees a phantom delta.
    const visibleExpenseLines = claimant.sred_method === 'proxy'
      ? expenseLines.filter(line => line.category !== 'overhead')
      : expenseLines;

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
        // Migration 016 (SRED_DOMAIN_REVIEW P3): the working hypothesis and
        // the date the uncertainty was identified. Both are nullable — older
        // projects predate the fields and will surface as `null` to the
        // formatter, which renders them as "(unset)".
        hypothesis: project.hypothesis ?? null,
        uncertainty_identified_at: project.uncertainty_identified_at ?? null,
      },
      totals: {
        labour_cost_cents: projectLabourCents,
        labour_hours_total:    labourHoursBreakdown.total,
        labour_hours_regular:  labourHoursBreakdown.regular,
        labour_hours_overtime: labourHoursBreakdown.overtime,
        materials_cents: materials,
        contract_expenditures_cents: contracts,
        third_party_payments_cents: thirdParty,
        overhead_cents: overhead,
        total_cents: projectLabourCents + materials + contracts + thirdParty + overhead,
      },
      labour_worksheet: Array.from(perUc.values()),
      expense_lines: visibleExpenseLines,
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
