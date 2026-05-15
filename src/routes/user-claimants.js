import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { badRequest } from '../lib/errors.js';
import { getUserClaimant, mutateAndAudit, createAndAudit } from '../lib/route-helpers.js';

const router = Router();
router.use(requireAuth, requireAdmin);

router.patch('/:id', (req, res, next) => {
  try {
    // Pre-flight load so we can validate body fields and short-circuit no-op
    // PATCH before writing an audit row.
    const current = getUserClaimant(req.params.id);
    const { title, is_specified_employee, status, employment_start_date } = req.body ?? {};

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
    if (employment_start_date !== undefined) {
      if (employment_start_date !== null && typeof employment_start_date !== 'string')
        throw badRequest('employment_start_date must be a string (YYYY-MM-DD) or null');
      updates.employment_start_date = employment_start_date;
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) return res.json(current);

    const { after } = mutateAndAudit({
      loader: getUserClaimant,
      entityType: 'user_claimant',
      id: req.params.id,
      actorUserId: req.user.id,
      action: 'update',
      write: (before) => {
        const setClause = keys.map(k => `${k} = ?`).join(', ');
        db.prepare(`UPDATE user_claimants SET ${setClause} WHERE id = ?`)
          .run(...keys.map(k => updates[k]), before.id);
      },
    });
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

    const { after } = createAndAudit({
      loader: (id) => db.prepare(`SELECT * FROM compensation_rows WHERE id = ?`).get(id),
      entityType: 'compensation_row',
      actorUserId: req.user.id,
      action: 'create',
      write: () => {
        const info = db.prepare(`
          INSERT INTO compensation_rows
            (user_claimant_id, comp_type, amount_cents, hours_per_year, effective_from)
          VALUES (?, ?, ?, ?, ?)
        `).run(uc.id, comp_type, amount_cents, hours_per_year ?? 2080, effective_from);
        return info.lastInsertRowid;
      },
    });
    res.status(201).json(after);
  } catch (e) { next(e); }
});

export default router;
