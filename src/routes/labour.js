import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import {
  getProject, getLabourEntry, findOpenPeriod, resolveUserClaimant,
  isOwnerOrAdmin, assertEditable,
} from '../lib/route-helpers.js';

const router = Router();
router.use(requireAuth);

// --- routes ----------------------------------------------------------------

router.get('/', (req, res, next) => {
  try {
    const { project_id, period_id, user_claimant_id, status, from, to, claimant_id } = req.query;
    const where = [];
    const params = [];
    if (project_id)       { where.push('le.project_id = ?');        params.push(Number(project_id)); }
    if (period_id)        { where.push('le.fiscal_period_id = ?');  params.push(Number(period_id)); }
    if (user_claimant_id) { where.push('le.user_claimant_id = ?');  params.push(Number(user_claimant_id)); }
    if (status)           { where.push('le.status = ?');            params.push(status); }
    if (from)             { where.push('le.work_date >= ?');        params.push(from); }
    if (to)               { where.push('le.work_date <= ?');        params.push(to); }
    if (claimant_id)      { where.push('p.claimant_id = ?');        params.push(Number(claimant_id)); }

    if (req.user.role !== 'admin') {
      where.push('uc.user_id = ?');
      params.push(req.user.id);
    }

    const sql = `
      SELECT le.*, fp.status AS period_status,
             p.title AS project_title,
             u.name  AS user_name,
             u.email AS user_email,
             c.legal_name AS claimant_name
        FROM labour_entries le
        JOIN user_claimants uc      ON uc.id = le.user_claimant_id
        JOIN users u                ON u.id  = uc.user_id
        JOIN projects p             ON p.id  = le.project_id
        LEFT JOIN fiscal_periods fp ON fp.id = le.fiscal_period_id
        LEFT JOIN claimants c       ON c.id  = p.claimant_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY le.work_date DESC, le.id DESC
    `;
    res.json({ items: db.prepare(sql).all(...params) });
  } catch (e) { next(e); }
});

router.post('/', (req, res, next) => {
  try {
    const { project_id, work_date, hours, description, user_claimant_id, is_overtime } = req.body ?? {};
    if (!Number.isInteger(project_id)) throw badRequest('project_id required');
    if (!work_date) throw badRequest('work_date required');
    if (typeof hours !== 'number' || hours <= 0 || hours > 24)
      throw badRequest('hours must be a number in (0, 24]');
    if (!description || typeof description !== 'string') throw badRequest('description required');
    if (is_overtime !== undefined && typeof is_overtime !== 'boolean')
      throw badRequest('is_overtime must be boolean');

    const project = getProject(project_id);
    const uc = resolveUserClaimant({ user: req.user, project, requestedUcId: user_claimant_id });
    const period = findOpenPeriod(project.claimant_id, work_date);

    // Admin-logged entries are pre-approved (the admin is also the reviewer).
    const isAdmin = req.user.role === 'admin';
    const initialStatus = isAdmin ? 'approved' : 'pending';
    const info = db.prepare(`
      INSERT INTO labour_entries
        (project_id, user_claimant_id, fiscal_period_id, work_date, hours, description, is_overtime,
         status, reviewed_by_user_id, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${isAdmin ? "datetime('now')" : 'NULL'})
    `).run(
      project.id, uc.id, period.id, work_date, hours, description, is_overtime ? 1 : 0,
      initialStatus, isAdmin ? req.user.id : null,
    );

    const entry = getLabourEntry(info.lastInsertRowid);
    audit(req.user.id, 'create', 'labour_entry', entry.id, undefined, entry);
    res.status(201).json(entry);
  } catch (e) { next(e); }
});

router.get('/:id', (req, res, next) => {
  try {
    const entry = getLabourEntry(req.params.id);
    if (!isOwnerOrAdmin(req.user, entry.user_claimant_id)) throw forbidden();
    res.json(entry);
  } catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const before = getLabourEntry(req.params.id);
    if (!isOwnerOrAdmin(req.user, before.user_claimant_id)) throw forbidden();
    assertEditable(before);

    const { work_date, hours, description, is_overtime } = req.body ?? {};
    const updates = {};
    if (work_date !== undefined) updates.work_date = work_date;
    if (hours !== undefined) {
      if (typeof hours !== 'number' || hours <= 0 || hours > 24)
        throw badRequest('hours must be a number in (0, 24]');
      updates.hours = hours;
    }
    if (description !== undefined) {
      if (!description) throw badRequest('description cannot be empty');
      updates.description = description;
    }
    if (is_overtime !== undefined) {
      if (typeof is_overtime !== 'boolean') throw badRequest('is_overtime must be boolean');
      updates.is_overtime = is_overtime ? 1 : 0;
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) return res.json(before);

    // If work_date changed, re-infer the fiscal period.
    let newPeriodId = before.fiscal_period_id;
    if (updates.work_date && updates.work_date !== before.work_date) {
      const project = getProject(before.project_id);
      newPeriodId = findOpenPeriod(project.claimant_id, updates.work_date).id;
    }

    // Edits to a rejected entry move it back to pending and clear review fields.
    const clearReview = before.status === 'rejected';

    const setParts = keys.map(k => `${k} = ?`);
    setParts.push(`fiscal_period_id = ?`);
    setParts.push(`updated_at = datetime('now')`);
    if (clearReview) {
      setParts.push(`status = 'pending'`, `reviewed_by_user_id = NULL`,
                    `reviewed_at = NULL`, `rejection_reason = NULL`);
    }
    const values = [...keys.map(k => updates[k]), newPeriodId, before.id];
    db.prepare(`UPDATE labour_entries SET ${setParts.join(', ')} WHERE id = ?`).run(...values);

    const after = getLabourEntry(before.id);
    audit(req.user.id, 'update', 'labour_entry', before.id, before, after);
    res.json(after);
  } catch (e) { next(e); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const before = getLabourEntry(req.params.id);
    if (!isOwnerOrAdmin(req.user, before.user_claimant_id)) throw forbidden();
    assertEditable(before);
    db.prepare(`DELETE FROM labour_entries WHERE id = ?`).run(before.id);
    audit(req.user.id, 'delete', 'labour_entry', before.id, before, undefined);
    res.status(204).end();
  } catch (e) { next(e); }
});

router.post('/:id/approve', requireAdmin, (req, res, next) => {
  try {
    const before = getLabourEntry(req.params.id);
    db.prepare(`
      UPDATE labour_entries
         SET status = 'approved',
             reviewed_by_user_id = ?,
             reviewed_at = datetime('now'),
             rejection_reason = NULL,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(req.user.id, before.id);
    const after = getLabourEntry(before.id);
    audit(req.user.id, 'approve', 'labour_entry', before.id, before, after);
    res.json(after);
  } catch (e) { next(e); }
});

router.post('/:id/reject', requireAdmin, (req, res, next) => {
  try {
    const { reason } = req.body ?? {};
    if (!reason || typeof reason !== 'string') throw badRequest('reason required');
    const before = getLabourEntry(req.params.id);
    db.prepare(`
      UPDATE labour_entries
         SET status = 'rejected',
             reviewed_by_user_id = ?,
             reviewed_at = datetime('now'),
             rejection_reason = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(req.user.id, reason, before.id);
    const after = getLabourEntry(before.id);
    audit(req.user.id, 'reject', 'labour_entry', before.id, before, after);
    res.json(after);
  } catch (e) { next(e); }
});

router.post('/bulk-approve', requireAdmin, (req, res, next) => {
  try {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) throw badRequest('ids array required');
    if (!ids.every(Number.isInteger)) throw badRequest('ids must all be integers');

    const placeholders = ids.map(() => '?').join(',');
    const beforeRows = db.prepare(
      `SELECT * FROM labour_entries WHERE id IN (${placeholders})`
    ).all(...ids);

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE labour_entries
           SET status = 'approved',
               reviewed_by_user_id = ?,
               reviewed_at = datetime('now'),
               rejection_reason = NULL,
               updated_at = datetime('now')
         WHERE id IN (${placeholders})
      `).run(req.user.id, ...ids);
    });
    tx();

    for (const before of beforeRows) {
      const after = getLabourEntry(before.id);
      audit(req.user.id, 'approve', 'labour_entry', before.id, before, after);
    }
    res.json({ approved: beforeRows.length });
  } catch (e) { next(e); }
});

export default router;
