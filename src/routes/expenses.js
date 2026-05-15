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
    } = req.body ?? {};

    if (!Number.isInteger(project_id)) throw badRequest('project_id required');
    if (!expense_date) throw badRequest('expense_date required');
    if (!VALID_CATEGORIES.includes(category))
      throw badRequest(`category must be ${VALID_CATEGORIES.join('|')}`);
    validateAmount(amount_cents);
    if (!description || typeof description !== 'string') throw badRequest('description required');
    validateOverheadFields(category, overhead_subcategory, allocation_basis);

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
             amount_cents, currency, fx_rate, description,
             overhead_subcategory, allocation_basis,
             status, reviewed_by_user_id, reviewed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${isAdmin ? "datetime('now')" : 'NULL'})
        `).run(
          project.id, uc.id, period.id, expense_date, category,
          amount_cents, currency, fx_rate ?? null, description,
          category === 'overhead' ? overhead_subcategory : null,
          category === 'overhead' ? allocation_basis     : null,
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
            overhead_subcategory, allocation_basis } = req.body ?? {};
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

    // Cross-field auto-null + validation: when category changes away from
    // overhead and the caller didn't supply explicit nulls for the overhead
    // fields, clear them automatically so the schema CHECK doesn't trip on
    // stale data. Conversely, when category changes to 'overhead' we
    // require both fields below (via validateOverheadFields on the merged
    // row). Must happen before `keys` is captured so the auto-null entries
    // are written to the UPDATE.
    if (updates.category && updates.category !== 'overhead') {
      if (updates.overhead_subcategory === undefined && current.overhead_subcategory !== null)
        updates.overhead_subcategory = null;
      if (updates.allocation_basis === undefined && current.allocation_basis !== null)
        updates.allocation_basis = null;
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
