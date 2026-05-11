import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { badRequest, notFound, forbidden, unprocessable } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

const router = Router();
router.use(requireAuth);

const VALID_CATEGORIES = ['material', 'contract', 'third_party_payment', 'overhead'];

// --- helpers ---------------------------------------------------------------

function getProjectOrThrow(id) {
  const p = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id);
  if (!p) throw notFound('project not found');
  return p;
}

function getClaimantOrThrow(id) {
  const c = db.prepare(`SELECT * FROM claimants WHERE id = ?`).get(id);
  if (!c) throw notFound('claimant not found');
  return c;
}

function findOpenPeriod(claimantId, date) {
  const period = db.prepare(`
    SELECT * FROM fiscal_periods
     WHERE claimant_id = ? AND status = 'open' AND ? BETWEEN start_date AND end_date
     LIMIT 1
  `).get(claimantId, date);
  if (!period) throw unprocessable(`no open fiscal period covers ${date} for claimant ${claimantId}`);
  return period;
}

function resolveUserClaimant({ user, project, requestedUcId }) {
  if (user.role === 'admin') {
    if (!Number.isInteger(requestedUcId)) throw badRequest('admin must specify user_claimant_id');
    const uc = db.prepare(`SELECT * FROM user_claimants WHERE id = ?`).get(requestedUcId);
    if (!uc) throw notFound('user_claimant not found');
    if (uc.claimant_id !== project.claimant_id) throw badRequest("user_claimant does not belong to this project's claimant");
    if (uc.status !== 'active') throw badRequest('user_claimant attachment is inactive');
    return uc;
  }
  const uc = db.prepare(
    `SELECT * FROM user_claimants WHERE user_id = ? AND claimant_id = ?`
  ).get(user.id, project.claimant_id);
  if (!uc) throw forbidden('you are not attached to this claimant');
  if (uc.status !== 'active') throw forbidden('your attachment to this claimant is inactive');
  return uc;
}

function getExpenseOrThrow(id) {
  const e = db.prepare(`SELECT * FROM expenses WHERE id = ?`).get(id);
  if (!e) throw notFound('expense not found');
  return e;
}

function canSee(user, expense) {
  if (user.role === 'admin') return true;
  const uc = db.prepare(`SELECT user_id FROM user_claimants WHERE id = ?`).get(expense.user_claimant_id);
  return uc && uc.user_id === user.id;
}

function assertEditable(expense) {
  if (expense.status === 'approved') throw badRequest('expense is approved and locked; reject it first');
  const period = db.prepare(`SELECT status FROM fiscal_periods WHERE id = ?`).get(expense.fiscal_period_id);
  if (period?.status === 'closed') throw badRequest('fiscal period is closed');
}

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
      SELECT e.* FROM expenses e
        JOIN user_claimants uc ON uc.id = e.user_claimant_id
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

    const project = getProjectOrThrow(project_id);
    const claimant = getClaimantOrThrow(project.claimant_id);
    validateFxAgainstClaimant(currency, fx_rate, claimant);

    const uc = resolveUserClaimant({ user: req.user, project, requestedUcId: user_claimant_id });
    const period = findOpenPeriod(project.claimant_id, expense_date);

    const info = db.prepare(`
      INSERT INTO expenses
        (project_id, user_claimant_id, fiscal_period_id, expense_date, category,
         amount_cents, currency, fx_rate, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      project.id, uc.id, period.id, expense_date, category,
      amount_cents, currency, fx_rate ?? null, description,
    );
    const expense = getExpenseOrThrow(info.lastInsertRowid);
    audit(req.user.id, 'create', 'expense', expense.id, undefined, expense);
    res.status(201).json(expense);
  } catch (e) { next(e); }
});

router.get('/:id', (req, res, next) => {
  try {
    const e = getExpenseOrThrow(req.params.id);
    if (!canSee(req.user, e)) throw forbidden();
    res.json(e);
  } catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const before = getExpenseOrThrow(req.params.id);
    if (!canSee(req.user, before)) throw forbidden();
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
    const project = getProjectOrThrow(before.project_id);
    const claimant = getClaimantOrThrow(project.claimant_id);
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

    const after = getExpenseOrThrow(before.id);
    audit(req.user.id, 'update', 'expense', before.id, before, after);
    res.json(after);
  } catch (e) { next(e); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const before = getExpenseOrThrow(req.params.id);
    if (!canSee(req.user, before)) throw forbidden();
    assertEditable(before);
    db.prepare(`DELETE FROM expenses WHERE id = ?`).run(before.id);
    audit(req.user.id, 'delete', 'expense', before.id, before, undefined);
    res.status(204).end();
  } catch (e) { next(e); }
});

router.post('/:id/approve', requireAdmin, (req, res, next) => {
  try {
    const before = getExpenseOrThrow(req.params.id);
    db.prepare(`
      UPDATE expenses
         SET status = 'approved',
             reviewed_by_user_id = ?,
             reviewed_at = datetime('now'),
             rejection_reason = NULL,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(req.user.id, before.id);
    const after = getExpenseOrThrow(before.id);
    audit(req.user.id, 'approve', 'expense', before.id, before, after);
    res.json(after);
  } catch (e) { next(e); }
});

router.post('/:id/reject', requireAdmin, (req, res, next) => {
  try {
    const { reason } = req.body ?? {};
    if (!reason || typeof reason !== 'string') throw badRequest('reason required');
    const before = getExpenseOrThrow(req.params.id);
    db.prepare(`
      UPDATE expenses
         SET status = 'rejected',
             reviewed_by_user_id = ?,
             reviewed_at = datetime('now'),
             rejection_reason = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(req.user.id, reason, before.id);
    const after = getExpenseOrThrow(before.id);
    audit(req.user.id, 'reject', 'expense', before.id, before, after);
    res.json(after);
  } catch (e) { next(e); }
});

export default router;
