import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import {
  getProject, getClaimant, getExpense, findOpenPeriod, resolveUserClaimant,
  isOwnerOrAdmin, assertEditable,
} from '../lib/route-helpers.js';

const router = Router();
router.use(requireAuth);

const VALID_CATEGORIES = ['material', 'contract', 'third_party_payment', 'overhead'];

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

// --- routes ----------------------------------------------------------------

router.get('/', (req, res, next) => {
  try {
    const { project_id, period_id, user_claimant_id, status, category, from, to } = req.query;
    const where = [];
    const params = [];
    if (project_id)       { where.push('e.project_id = ?');       params.push(Number(project_id)); }
    if (period_id)        { where.push('e.fiscal_period_id = ?'); params.push(Number(period_id)); }
    if (user_claimant_id) { where.push('e.user_claimant_id = ?'); params.push(Number(user_claimant_id)); }
    if (status)           { where.push('e.status = ?');           params.push(status); }
    if (category)         { where.push('e.category = ?');         params.push(category); }
    if (from)             { where.push('e.expense_date >= ?');    params.push(from); }
    if (to)               { where.push('e.expense_date <= ?');    params.push(to); }

    if (req.user.role !== 'admin') {
      where.push('uc.user_id = ?');
      params.push(req.user.id);
    }

    const sql = `
      SELECT e.*, fp.status AS period_status,
             p.title AS project_title,
             u.name  AS user_name,
             u.email AS user_email
        FROM expenses e
        JOIN user_claimants uc ON uc.id = e.user_claimant_id
        JOIN users u           ON u.id  = uc.user_id
        JOIN projects p        ON p.id  = e.project_id
        LEFT JOIN fiscal_periods fp ON fp.id = e.fiscal_period_id
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
    } = req.body ?? {};

    if (!Number.isInteger(project_id)) throw badRequest('project_id required');
    if (!expense_date) throw badRequest('expense_date required');
    if (!VALID_CATEGORIES.includes(category))
      throw badRequest(`category must be ${VALID_CATEGORIES.join('|')}`);
    validateAmount(amount_cents);
    if (!description || typeof description !== 'string') throw badRequest('description required');

    const project = getProject(project_id);
    const claimant = getClaimant(project.claimant_id);
    validateFxAgainstClaimant(currency, fx_rate, claimant);

    const uc = resolveUserClaimant({ user: req.user, project, requestedUcId: user_claimant_id });
    const period = findOpenPeriod(project.claimant_id, expense_date);

    const isAdmin = req.user.role === 'admin';
    const initialStatus = isAdmin ? 'approved' : 'pending';
    const info = db.prepare(`
      INSERT INTO expenses
        (project_id, user_claimant_id, fiscal_period_id, expense_date, category,
         amount_cents, currency, fx_rate, description,
         status, reviewed_by_user_id, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${isAdmin ? "datetime('now')" : 'NULL'})
    `).run(
      project.id, uc.id, period.id, expense_date, category,
      amount_cents, currency, fx_rate ?? null, description,
      initialStatus, isAdmin ? req.user.id : null,
    );
    const expense = getExpense(info.lastInsertRowid);
    audit(req.user.id, 'create', 'expense', expense.id, undefined, expense);
    res.status(201).json(expense);
  } catch (e) { next(e); }
});

router.get('/:id', (req, res, next) => {
  try {
    const e = getExpense(req.params.id);
    if (!isOwnerOrAdmin(req.user, e.user_claimant_id)) throw forbidden();
    res.json(e);
  } catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const before = getExpense(req.params.id);
    if (!isOwnerOrAdmin(req.user, before.user_claimant_id)) throw forbidden();
    assertEditable(before);

    const { expense_date, category, amount_cents, currency, fx_rate, description } = req.body ?? {};
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

    const keys = Object.keys(updates);
    if (keys.length === 0) return res.json(before);

    // Re-validate fx vs reporting currency against merged state.
    const merged = { ...before, ...updates };
    const project = getProject(before.project_id);
    const claimant = getClaimant(project.claimant_id);
    validateFxAgainstClaimant(merged.currency, merged.fx_rate, claimant);

    // Re-infer period if expense_date changed.
    let newPeriodId = before.fiscal_period_id;
    if (updates.expense_date && updates.expense_date !== before.expense_date) {
      newPeriodId = findOpenPeriod(claimant.id, updates.expense_date).id;
    }

    const clearReview = before.status === 'rejected';

    const setParts = keys.map(k => `${k} = ?`);
    setParts.push(`fiscal_period_id = ?`);
    setParts.push(`updated_at = datetime('now')`);
    if (clearReview) {
      setParts.push(`status = 'pending'`, `reviewed_by_user_id = NULL`,
                    `reviewed_at = NULL`, `rejection_reason = NULL`);
    }
    const values = [...keys.map(k => updates[k]), newPeriodId, before.id];
    db.prepare(`UPDATE expenses SET ${setParts.join(', ')} WHERE id = ?`).run(...values);

    const after = getExpense(before.id);
    audit(req.user.id, 'update', 'expense', before.id, before, after);
    res.json(after);
  } catch (e) { next(e); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const before = getExpense(req.params.id);
    if (!isOwnerOrAdmin(req.user, before.user_claimant_id)) throw forbidden();
    assertEditable(before);
    db.prepare(`DELETE FROM expenses WHERE id = ?`).run(before.id);
    audit(req.user.id, 'delete', 'expense', before.id, before, undefined);
    res.status(204).end();
  } catch (e) { next(e); }
});

router.post('/:id/approve', requireAdmin, (req, res, next) => {
  try {
    const before = getExpense(req.params.id);
    db.prepare(`
      UPDATE expenses
         SET status = 'approved',
             reviewed_by_user_id = ?,
             reviewed_at = datetime('now'),
             rejection_reason = NULL,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(req.user.id, before.id);
    const after = getExpense(before.id);
    audit(req.user.id, 'approve', 'expense', before.id, before, after);
    res.json(after);
  } catch (e) { next(e); }
});

router.post('/:id/reject', requireAdmin, (req, res, next) => {
  try {
    const { reason } = req.body ?? {};
    if (!reason || typeof reason !== 'string') throw badRequest('reason required');
    const before = getExpense(req.params.id);
    db.prepare(`
      UPDATE expenses
         SET status = 'rejected',
             reviewed_by_user_id = ?,
             reviewed_at = datetime('now'),
             rejection_reason = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(req.user.id, reason, before.id);
    const after = getExpense(before.id);
    audit(req.user.id, 'reject', 'expense', before.id, before, after);
    res.json(after);
  } catch (e) { next(e); }
});

export default router;
