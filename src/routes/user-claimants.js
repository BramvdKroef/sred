import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { badRequest } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { getUserClaimant } from '../lib/route-helpers.js';

const router = Router();
router.use(requireAuth, requireAdmin);

router.patch('/:id', (req, res, next) => {
  try {
    const before = getUserClaimant(req.params.id);
    const { title, is_specified_employee, status } = req.body ?? {};

    const updates = {};
    if (title !== undefined) updates.title = title;
    if (is_specified_employee !== undefined) {
      if (typeof is_specified_employee !== 'boolean')
        throw badRequest('is_specified_employee must be boolean');
      updates.is_specified_employee = is_specified_employee ? 1 : 0;
    }
    if (status !== undefined) {
      if (!['active', 'inactive'].includes(status))
        throw badRequest('status must be active|inactive');
      updates.status = status;
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) return res.json(before);

    const setClause = keys.map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE user_claimants SET ${setClause} WHERE id = ?`)
      .run(...keys.map(k => updates[k]), before.id);

    const after = db.prepare(`SELECT * FROM user_claimants WHERE id = ?`).get(before.id);
    audit(req.user.id, 'update', 'user_claimant', before.id, before, after);
    res.json(after);
  } catch (e) { next(e); }
});

router.post('/:id/compensation', (req, res, next) => {
  try {
    const uc = getUserClaimant(req.params.id);
    const { comp_type, amount_cents, hours_per_year, effective_from } = req.body ?? {};
    if (!['salary', 'hourly'].includes(comp_type))
      throw badRequest('comp_type must be salary|hourly');
    if (!Number.isInteger(amount_cents) || amount_cents <= 0)
      throw badRequest('amount_cents must be a positive integer');
    if (hours_per_year !== undefined &&
        (!Number.isInteger(hours_per_year) || hours_per_year <= 0))
      throw badRequest('hours_per_year must be a positive integer');
    if (!effective_from) throw badRequest('effective_from required');

    const info = db.prepare(`
      INSERT INTO compensation_rows
        (user_claimant_id, comp_type, amount_cents, hours_per_year, effective_from)
      VALUES (?, ?, ?, ?, ?)
    `).run(uc.id, comp_type, amount_cents, hours_per_year ?? 2080, effective_from);

    const row = db.prepare(`SELECT * FROM compensation_rows WHERE id = ?`).get(info.lastInsertRowid);
    audit(req.user.id, 'create', 'compensation_row', row.id, undefined, row);
    res.status(201).json(row);
  } catch (e) { next(e); }
});

export default router;
