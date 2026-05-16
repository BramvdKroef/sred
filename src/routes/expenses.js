import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import {
  getProject, getClaimant, getExpense, findOpenPeriod, resolveUserClaimant,
  isOwnerOrAdmin, assertEditable, mutateAndAudit, createAndAudit,
} from '../lib/route-helpers.js';

const router = Router();
router.use(requireAuth);

const VALID_CATEGORIES = ['material', 'contract', 'third_party_payment', 'overhead'];

// Traditional-method overhead bucket — required when category='overhead' so the
// T661 export can surface the right CRA sub-classification (SRED_DOMAIN_REVIEW
// F5). Schema-level CHECK at migration 014 mirrors this list.
const VALID_OVERHEAD_SUBCATEGORIES = ['rent', 'utilities', 'maintenance', 'supporting_salaries', 'other'];

// Migration 015 / SRED_DOMAIN_REVIEW P3:
//
//   - material_disposition: T661 line 320 vs 325 split — required when
//     category='material'. The schema CHECK keeps it null on non-material
//     rows; the route enforces presence here so a bare 'material' POST
//     fails 400 (not SQLITE_CONSTRAINT).
//   - contract_arms_length: 1/0 flag for arm's-length vs non-arm's-length
//     SR&ED contracts — required when category='contract'. CRA caps NAL
//     contract eligibility at the contractor's allowable cost; surfacing
//     the flag is the first hop to enforcing that downstream.
//   - fx_rate_source: free-text attribution required whenever fx_rate is
//     populated. Audit-defensibility (cf. SRED_DOMAIN_REVIEW F4) — the
//     tax preparer needs to know which rate was used.
const VALID_MATERIAL_DISPOSITIONS = ['consumed', 'transformed'];

// --- helpers ---------------------------------------------------------------

function validateAmount(amount_cents) {
  if (!Number.isInteger(amount_cents) || amount_cents <= 0)
    throw badRequest('amount_cents must be a positive integer');
}

function validateFxAgainstClaimant(currency, fx_rate, claimant) {
  if (currency && currency !== claimant.reporting_currency) {
    if (typeof fx_rate !== 'number' || fx_rate <= 0)
      throw badRequest(`fx_rate (to ${claimant.reporting_currency}) required when currency != reporting currency`);
  }
}

// Migration 015 / P3.3 — whenever fx_rate is populated, fx_rate_source must
// be a non-empty string. Documenting which CRA-acceptable rate was used
// (e.g. "Bank of Canada noon rate, 2026-03-15") so the conversion is
// defensible at audit. Called on the merged-state row from both POST and
// PATCH so toggling fx_rate on/off resolves consistently.
function validateFxRateSource(fx_rate, fx_rate_source) {
  if (fx_rate == null) {
    // No fx_rate → fx_rate_source must be absent/null. Mirrors the overhead
    // pattern: if you didn't convert, you don't get to attach a source.
    if (fx_rate_source != null && fx_rate_source !== '')
      throw badRequest(`fx_rate_source must be null when fx_rate is null`);
    return;
  }
  if (typeof fx_rate_source !== 'string' || !fx_rate_source.trim())
    throw badRequest(`fx_rate_source required when fx_rate is set (e.g. "Bank of Canada noon rate, 2026-03-15")`);
}

// Migration 015 / P3.1 — `material_disposition` is required when
// category='material' and must be null otherwise. Schema CHECK enforces
// the null-when-not-material half; this validator gives a clean 400 for
// the required-when-material half.
function validateMaterialDisposition(category, material_disposition) {
  if (category === 'material') {
    if (!material_disposition)
      throw badRequest(`material_disposition required when category='material' (one of ${VALID_MATERIAL_DISPOSITIONS.join('|')})`);
    if (!VALID_MATERIAL_DISPOSITIONS.includes(material_disposition))
      throw badRequest(`material_disposition must be ${VALID_MATERIAL_DISPOSITIONS.join('|')}`);
  } else {
    if (material_disposition != null)
      throw badRequest(`material_disposition must be null when category != 'material'`);
  }
}

// Migration 015 / P3.2 — `contract_arms_length` (1 or 0) required when
// category='contract', null otherwise. We accept booleans and coerce
// liberally on the way in: callers may send `true`/`false`, `1`/`0`, or
// the string equivalents. Anything else is a 400. This mirrors how the
// existing `is_overtime` field is parsed in /api/labour (best-effort
// truthiness check on the wire) — keep the API tolerant of the two
// reasonable serialisations.
function coerceArmsLengthFlag(v) {
  if (v === true || v === 1 || v === '1') return 1;
  if (v === false || v === 0 || v === '0') return 0;
  return null;
}

function validateContractArmsLength(category, contract_arms_length) {
  if (category === 'contract') {
    if (contract_arms_length !== 0 && contract_arms_length !== 1)
      throw badRequest(`contract_arms_length required when category='contract' (1 = arm's length, 0 = non-arm's-length)`);
  } else {
    if (contract_arms_length != null)
      throw badRequest(`contract_arms_length must be null when category != 'contract'`);
  }
}

// Cross-field validator for overhead subcategory + basis. Called from both
// POST (with the full row) and PATCH (with the merged-after-update row) so
// the two paths can't drift. The CRA requirement is per-row: every overhead
// expense needs a typed bucket and a human-readable allocation note.
//
// For non-overhead categories both fields must be absent/null. The schema
// CHECK at migration 014 also enforces this — duplicating in the route
// gives a clean 400 (vs an opaque SQLITE_CONSTRAINT message) before we
// reach the INSERT/UPDATE.
function validateOverheadFields(category, overhead_subcategory, allocation_basis) {
  if (category === 'overhead') {
    if (!overhead_subcategory)
      throw badRequest(`overhead_subcategory required when category='overhead' (one of ${VALID_OVERHEAD_SUBCATEGORIES.join('|')})`);
    if (!VALID_OVERHEAD_SUBCATEGORIES.includes(overhead_subcategory))
      throw badRequest(`overhead_subcategory must be ${VALID_OVERHEAD_SUBCATEGORIES.join('|')}`);
    if (typeof allocation_basis !== 'string' || !allocation_basis.trim())
      throw badRequest(`allocation_basis required when category='overhead' (free-text methodology, e.g. "30% of total floor area")`);
  } else {
    if (overhead_subcategory != null)
      throw badRequest(`overhead_subcategory must be null when category != 'overhead'`);
    if (allocation_basis != null)
      throw badRequest(`allocation_basis must be null when category != 'overhead'`);
  }
}

// --- routes ----------------------------------------------------------------

router.get('/', (req, res, next) => {
  try {
    const { project_id, period_id, user_claimant_id, claimant_id, status, category, from, to } = req.query;
    const where = [];
    const params = [];
    if (project_id)       { where.push('e.project_id = ?');       params.push(Number(project_id)); }
    if (period_id)        { where.push('e.fiscal_period_id = ?'); params.push(Number(period_id)); }
    if (user_claimant_id) { where.push('e.user_claimant_id = ?'); params.push(Number(user_claimant_id)); }
    // `claimant_id` scopes via the user_claimants join (the review queue's
    // active-claimant filter). The join is already present below for the
    // user_name columns, so this is just an extra WHERE term.
    if (claimant_id)      { where.push('uc.claimant_id = ?');     params.push(Number(claimant_id)); }
    if (status)           { where.push('e.status = ?');           params.push(status); }
    if (category)         { where.push('e.category = ?');         params.push(category); }
    if (from)             { where.push('e.expense_date >= ?');    params.push(from); }
    if (to)               { where.push('e.expense_date <= ?');    params.push(to); }

    if (req.user.role !== 'admin') {
      // Scope to the caller's OWN expenses, and only those reached through an
      // ACTIVE attachment. Mirrors the labour list filter and is consistent
      // with the PATCH path's isOwnerOrAdmin gate (route-helpers.js).
      where.push('uc.user_id = ?');
      where.push("uc.status = 'active'");
      params.push(req.user.id);
    }

    const sql = `
      SELECT e.*, fp.status AS period_status,
             p.title AS project_title,
             u.name  AS user_name,
             u.email AS user_email,
             c.legal_name AS claimant_name
        FROM expenses e
        JOIN user_claimants uc      ON uc.id = e.user_claimant_id
        JOIN users u                ON u.id  = uc.user_id
        JOIN projects p             ON p.id  = e.project_id
        LEFT JOIN fiscal_periods fp ON fp.id = e.fiscal_period_id
        LEFT JOIN claimants c       ON c.id  = p.claimant_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY e.expense_date DESC, e.id DESC
    `;
    res.json({ items: db.prepare(sql).all(...params) });
  } catch (e) { next(e); }
});

router.post('/', (req, res, next) => {
  try {
    const {
      project_id, expense_date, category, amount_cents,
      currency = 'CAD', fx_rate, description, user_claimant_id,
      overhead_subcategory, allocation_basis,
      material_disposition, fx_rate_source,
    } = req.body ?? {};
    // P3.2: arms-length flag is a tri-state on the wire (true/false/null);
    // coerce to {0,1,null} early so the rest of the path sees only the
    // canonical form. An unknown shape (e.g. "yes", 2) reads as null and
    // trips the require-when-contract validator below with a useful 400.
    const contract_arms_length = req.body?.contract_arms_length === undefined
      ? null
      : coerceArmsLengthFlag(req.body.contract_arms_length);

    if (!Number.isInteger(project_id)) throw badRequest('project_id required');
    if (!expense_date) throw badRequest('expense_date required');
    if (!VALID_CATEGORIES.includes(category))
      throw badRequest(`category must be ${VALID_CATEGORIES.join('|')}`);
    validateAmount(amount_cents);
    if (!description || typeof description !== 'string') throw badRequest('description required');
    validateOverheadFields(category, overhead_subcategory, allocation_basis);
    validateMaterialDisposition(category, material_disposition);
    validateContractArmsLength(category, contract_arms_length);
    validateFxRateSource(fx_rate, fx_rate_source);

    const project = getProject(project_id);
    const claimant = getClaimant(project.claimant_id);
    validateFxAgainstClaimant(currency, fx_rate, claimant);

    const uc = resolveUserClaimant({ user: req.user, project, requestedUcId: user_claimant_id });
    const period = findOpenPeriod(project.claimant_id, expense_date);

    const isAdmin = req.user.role === 'admin';
    const initialStatus = isAdmin ? 'approved' : 'pending';

    const { after } = createAndAudit({
      loader: getExpense,
      entityType: 'expense',
      actorUserId: req.user.id,
      action: 'create',
      write: () => {
        const info = db.prepare(`
          INSERT INTO expenses
            (project_id, user_claimant_id, fiscal_period_id, expense_date, category,
             amount_cents, currency, fx_rate, fx_rate_source, description,
             overhead_subcategory, allocation_basis,
             material_disposition, contract_arms_length,
             status, reviewed_by_user_id, reviewed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${isAdmin ? "datetime('now')" : 'NULL'})
        `).run(
          project.id, uc.id, period.id, expense_date, category,
          amount_cents, currency, fx_rate ?? null,
          fx_rate != null ? fx_rate_source : null,
          description,
          category === 'overhead' ? overhead_subcategory : null,
          category === 'overhead' ? allocation_basis     : null,
          category === 'material' ? material_disposition : null,
          category === 'contract' ? contract_arms_length : null,
          initialStatus, isAdmin ? req.user.id : null,
        );
        return info.lastInsertRowid;
      },
    });
    res.status(201).json(after);
  } catch (e) { next(e); }
});

router.get('/:id', (req, res, next) => {
  try {
    const e = getExpense(req.params.id);
    if (!isOwnerOrAdmin(req.user, e.user_claimant_id)) throw forbidden();
    // Mirror the list endpoint by exposing the parent period's status as a
    // derived field. The admin inline-edit affordance in the activity-feed
    // expansion needs this to decide whether to render the edit form (a
    // closed period locks the entry — same rule the server's assertEditable
    // already enforces).
    const period = db.prepare(`SELECT status FROM fiscal_periods WHERE id = ?`).get(e.fiscal_period_id);
    res.json({ ...e, period_status: period?.status ?? null });
  } catch (e2) { next(e2); }
});

router.patch('/:id', (req, res, next) => {
  try {
    // Pre-flight load: validation + ownership + editability + body parse all
    // happen before mutateAndAudit so we can short-circuit no-op PATCH
    // without spending an audit row.
    const current = getExpense(req.params.id);
    if (!isOwnerOrAdmin(req.user, current.user_claimant_id)) throw forbidden();
    assertEditable(current, { user: req.user });

    const { expense_date, category, amount_cents, currency, fx_rate, description,
            overhead_subcategory, allocation_basis,
            material_disposition, fx_rate_source } = req.body ?? {};
    const updates = {};
    if (expense_date !== undefined) updates.expense_date = expense_date;
    if (category !== undefined) {
      if (!VALID_CATEGORIES.includes(category))
        throw badRequest(`category must be ${VALID_CATEGORIES.join('|')}`);
      updates.category = category;
    }
    if (amount_cents !== undefined) { validateAmount(amount_cents); updates.amount_cents = amount_cents; }
    if (currency !== undefined) updates.currency = currency;
    if (fx_rate !== undefined) updates.fx_rate = fx_rate;
    if (fx_rate_source !== undefined) updates.fx_rate_source = fx_rate_source;
    if (description !== undefined) {
      if (!description) throw badRequest('description cannot be empty');
      updates.description = description;
    }
    // Overhead fields: pass through; the cross-field validator below runs on
    // the merged state so toggling category↔overhead is handled in one
    // place. Treating `undefined` as "not supplied" and `null` as "explicit
    // clear" — both surface to the merged-state check correctly because we
    // only stash explicit-set updates here.
    if (overhead_subcategory !== undefined) updates.overhead_subcategory = overhead_subcategory;
    if (allocation_basis !== undefined) updates.allocation_basis = allocation_basis;
    // Migration 015 P3 fields. Same pass-through pattern as the overhead
    // fields — the validators run on the merged row below.
    if (material_disposition !== undefined) updates.material_disposition = material_disposition;
    if (req.body?.contract_arms_length !== undefined) {
      updates.contract_arms_length = req.body.contract_arms_length === null
        ? null
        : coerceArmsLengthFlag(req.body.contract_arms_length);
    }

    // Cross-field auto-null + validation: when category changes we auto-
    // clear the now-stale category-specific fields so the schema CHECKs
    // don't trip on data that the caller didn't think to clear. Conversely,
    // when category changes *to* a category that requires its companion
    // field, the validators below catch a missing one with a 400.
    if (updates.category && updates.category !== 'overhead') {
      if (updates.overhead_subcategory === undefined && current.overhead_subcategory !== null)
        updates.overhead_subcategory = null;
      if (updates.allocation_basis === undefined && current.allocation_basis !== null)
        updates.allocation_basis = null;
    }
    if (updates.category && updates.category !== 'material') {
      if (updates.material_disposition === undefined && current.material_disposition !== null)
        updates.material_disposition = null;
    }
    if (updates.category && updates.category !== 'contract') {
      if (updates.contract_arms_length === undefined && current.contract_arms_length !== null)
        updates.contract_arms_length = null;
    }
    // P3.3 auto-clear: when the merged row drops `fx_rate` to null (either
    // because the PATCH cleared it explicitly or it was already null), the
    // accompanying `fx_rate_source` must also be null. Auto-null here so a
    // caller that PATCHes fx_rate→null doesn't also have to remember to
    // null out fx_rate_source. Must happen before `keys` is captured.
    const fxRateAfterPatch = updates.fx_rate !== undefined ? updates.fx_rate : current.fx_rate;
    if (fxRateAfterPatch == null && updates.fx_rate_source === undefined &&
        current.fx_rate_source != null) {
      updates.fx_rate_source = null;
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) return res.json(current);

    // Re-validate fx vs reporting currency against merged state. We need the
    // project + claimant here (and again inside the writer for period re-
    // inference); keeping them outside also means body-shape errors surface
    // before any audit row is written.
    const merged = { ...current, ...updates };
    const project = getProject(current.project_id);
    const claimant = getClaimant(project.claimant_id);
    validateFxAgainstClaimant(merged.currency, merged.fx_rate, claimant);
    validateOverheadFields(merged.category, merged.overhead_subcategory, merged.allocation_basis);
    // Migration 015 PATCH semantics: we only enforce the "required when
    // category=X" rules on the new fields when the caller actually touches
    // the relevant slice — i.e. category is changing, or the field itself
    // is in the PATCH body. Otherwise we let an unrelated edit pass on a
    // grandfathered pre-015 row (the migration explicitly preserves the
    // null-on-existing-rows pattern). The "must be null when category !=
    // X" half is always enforced via the schema CHECKs and the auto-null
    // logic above, so a stale field can never sneak through.
    if (updates.category !== undefined || updates.material_disposition !== undefined) {
      validateMaterialDisposition(merged.category, merged.material_disposition);
    } else if (merged.category !== 'material' && merged.material_disposition != null) {
      // Defensive: if the merged row has stale data for some reason, surface it.
      throw badRequest(`material_disposition must be null when category != 'material'`);
    }
    if (updates.category !== undefined || updates.contract_arms_length !== undefined) {
      validateContractArmsLength(merged.category, merged.contract_arms_length);
    } else if (merged.category !== 'contract' && merged.contract_arms_length != null) {
      throw badRequest(`contract_arms_length must be null when category != 'contract'`);
    }
    // fx_rate_source: enforce on writes that touch fx_rate or fx_rate_source.
    // For a pure description edit on a grandfathered row with fx_rate set
    // but fx_rate_source null, we don't force the back-fill here.
    if (updates.fx_rate !== undefined || updates.fx_rate_source !== undefined) {
      validateFxRateSource(merged.fx_rate, merged.fx_rate_source);
    } else if (merged.fx_rate == null && merged.fx_rate_source != null) {
      throw badRequest(`fx_rate_source must be null when fx_rate is null`);
    }

    const { after } = mutateAndAudit({
      loader: getExpense,
      entityType: 'expense',
      id: req.params.id,
      actorUserId: req.user.id,
      action: 'update',
      write: (before) => {
        // Re-infer period if expense_date changed.
        let newPeriodId = before.fiscal_period_id;
        if (updates.expense_date && updates.expense_date !== before.expense_date) {
          newPeriodId = findOpenPeriod(claimant.id, updates.expense_date).id;
        }

        // Admin self-edits of their own auto-approved entry follow the
        // rejected-edit precedent: revert to pending so the change is
        // re-approved deliberately. (assertEditable already restricts who
        // can reach this branch.)
        const clearReview =
          before.status === 'rejected' ||
          (before.status === 'approved' && req.user.role === 'admin' &&
           before.reviewed_by_user_id === req.user.id);

        const setParts = keys.map(k => `${k} = ?`);
        setParts.push(`fiscal_period_id = ?`);
        setParts.push(`updated_at = datetime('now')`);
        if (clearReview) {
          setParts.push(`status = 'pending'`, `reviewed_by_user_id = NULL`,
                        `reviewed_at = NULL`, `rejection_reason = NULL`);
        }
        const values = [...keys.map(k => updates[k]), newPeriodId, before.id];
        db.prepare(`UPDATE expenses SET ${setParts.join(', ')} WHERE id = ?`).run(...values);
      },
    });
    res.json(after);
  } catch (e) { next(e); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const before = getExpense(req.params.id);
    if (!isOwnerOrAdmin(req.user, before.user_claimant_id)) throw forbidden();
    assertEditable(before, { user: req.user });
    db.prepare(`DELETE FROM expenses WHERE id = ?`).run(before.id);
    audit(req.user.id, 'delete', 'expense', before.id, before, undefined);
    res.status(204).end();
  } catch (e) { next(e); }
});

router.post('/:id/approve', requireAdmin, (req, res, next) => {
  try {
    const { after } = mutateAndAudit({
      loader: getExpense,
      entityType: 'expense',
      id: req.params.id,
      actorUserId: req.user.id,
      action: 'approve',
      write: (before) => {
        db.prepare(`
          UPDATE expenses
             SET status = 'approved',
                 reviewed_by_user_id = ?,
                 reviewed_at = datetime('now'),
                 rejection_reason = NULL,
                 updated_at = datetime('now')
           WHERE id = ?
        `).run(req.user.id, before.id);
      },
    });
    res.json(after);
  } catch (e) { next(e); }
});

router.post('/:id/reject', requireAdmin, (req, res, next) => {
  try {
    const { reason } = req.body ?? {};
    if (!reason || typeof reason !== 'string') throw badRequest('reason required');
    const { after } = mutateAndAudit({
      loader: getExpense,
      entityType: 'expense',
      id: req.params.id,
      actorUserId: req.user.id,
      action: 'reject',
      write: (before) => {
        db.prepare(`
          UPDATE expenses
             SET status = 'rejected',
                 reviewed_by_user_id = ?,
                 reviewed_at = datetime('now'),
                 rejection_reason = ?,
                 updated_at = datetime('now')
           WHERE id = ?
        `).run(req.user.id, reason, before.id);
      },
    });
    res.json(after);
  } catch (e) { next(e); }
});

export default router;
