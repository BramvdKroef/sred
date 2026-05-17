import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { badRequest, forbidden, HttpError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import {
  getProject, getLabourEntry, findOpenPeriod, resolveUserClaimant,
  isOwnerOrAdmin, assertEditable, mutateAndAudit, createAndAudit,
} from '../lib/route-helpers.js';
import { parseCsvWithHeader } from '../lib/csv.js';

const router = Router();
router.use(requireAuth);

// --- routes ----------------------------------------------------------------

router.get('/', (req, res, next) => {
  try {
    const { project_id, period_id, user_claimant_id, claimant_id, status, from, to } = req.query;
    const where = [];
    const params = [];
    if (project_id)       { where.push('le.project_id = ?');        params.push(Number(project_id)); }
    if (period_id)        { where.push('le.fiscal_period_id = ?');  params.push(Number(period_id)); }
    if (user_claimant_id) { where.push('le.user_claimant_id = ?');  params.push(Number(user_claimant_id)); }
    // `claimant_id` scopes via the user_claimants join (the review queue's
    // active-claimant filter). The join is already present below for the
    // user_name columns, so this is just an extra WHERE term.
    if (claimant_id)      { where.push('uc.claimant_id = ?');       params.push(Number(claimant_id)); }
    if (status)           { where.push('le.status = ?');            params.push(status); }
    if (from)             { where.push('le.work_date >= ?');        params.push(from); }
    if (to)               { where.push('le.work_date <= ?');        params.push(to); }

    if (req.user.role !== 'admin') {
      // Scope to the caller's OWN entries, and only those reached through an
      // ACTIVE attachment. If admin later flips uc.status to 'inactive', the
      // employee loses both list visibility and mutation rights (the latter
      // via isOwnerOrAdmin in route-helpers.js). Keeps GET/PATCH consistent.
      where.push('uc.user_id = ?');
      where.push("uc.status = 'active'");
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

    const { after } = createAndAudit({
      loader: getLabourEntry,
      entityType: 'labour_entry',
      actorUserId: req.user.id,
      action: 'create',
      write: () => {
        const info = db.prepare(`
          INSERT INTO labour_entries
            (project_id, user_claimant_id, fiscal_period_id, work_date, hours, description, is_overtime,
             status, reviewed_by_user_id, reviewed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${isAdmin ? "datetime('now')" : 'NULL'})
        `).run(
          project.id, uc.id, period.id, work_date, hours, description, is_overtime ? 1 : 0,
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
    const entry = getLabourEntry(req.params.id);
    if (!isOwnerOrAdmin(req.user, entry.user_claimant_id)) throw forbidden();
    // Mirror the list endpoint by exposing the parent period's status as a
    // derived field. The admin inline-edit affordance in the activity-feed
    // expansion needs this to decide whether to render the edit form (a
    // closed period locks the entry — same rule the server's assertEditable
    // already enforces).
    const period = db.prepare(`SELECT status FROM fiscal_periods WHERE id = ?`).get(entry.fiscal_period_id);
    res.json({ ...entry, period_status: period?.status ?? null });
  } catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    // Pre-flight load: validation + ownership + editability + body parse all
    // happen before mutateAndAudit so we can short-circuit no-op PATCH
    // without spending an audit row.
    const current = getLabourEntry(req.params.id);
    if (!isOwnerOrAdmin(req.user, current.user_claimant_id)) throw forbidden();
    assertEditable(current, { user: req.user });

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
    if (keys.length === 0) return res.json(current);

    const { after } = mutateAndAudit({
      loader: getLabourEntry,
      entityType: 'labour_entry',
      id: req.params.id,
      actorUserId: req.user.id,
      action: 'update',
      write: (before) => {
        // If work_date changed, re-infer the fiscal period.
        let newPeriodId = before.fiscal_period_id;
        if (updates.work_date && updates.work_date !== before.work_date) {
          const project = getProject(before.project_id);
          newPeriodId = findOpenPeriod(project.claimant_id, updates.work_date).id;
        }

        // Edits to a rejected entry move it back to pending and clear review
        // fields. Admin edits to their own auto-approved entry follow the
        // same pattern: revert to pending so the change has to be re-
        // approved deliberately. (assertEditable already restricts who can
        // reach this branch — only the approving admin themselves.)
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
        db.prepare(`UPDATE labour_entries SET ${setParts.join(', ')} WHERE id = ?`).run(...values);
      },
    });
    res.json(after);
  } catch (e) { next(e); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const before = getLabourEntry(req.params.id);
    if (!isOwnerOrAdmin(req.user, before.user_claimant_id)) throw forbidden();
    assertEditable(before, { user: req.user });
    db.prepare(`DELETE FROM labour_entries WHERE id = ?`).run(before.id);
    audit(req.user.id, 'delete', 'labour_entry', before.id, before, undefined);
    res.status(204).end();
  } catch (e) { next(e); }
});

router.post('/:id/approve', requireAdmin, (req, res, next) => {
  try {
    const { after } = mutateAndAudit({
      loader: getLabourEntry,
      entityType: 'labour_entry',
      id: req.params.id,
      actorUserId: req.user.id,
      action: 'approve',
      write: (before) => {
        db.prepare(`
          UPDATE labour_entries
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
      loader: getLabourEntry,
      entityType: 'labour_entry',
      id: req.params.id,
      actorUserId: req.user.id,
      action: 'reject',
      write: (before) => {
        db.prepare(`
          UPDATE labour_entries
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

// --- CSV bulk import -------------------------------------------------------
//
// Admin paste-a-spreadsheet bulk import. Body: { csv: "<raw csv string>" }
// with a required header row of: date,user_claimant_id,project_id,hours,
// description (any column order, header names must match exactly).
//
// All-or-nothing: if any row fails validation, NO rows are inserted and
// the response is 400 with { code: 'csv_invalid', rows: [{ row, reason }] }.
// On success returns { imported, skipped, errors } (skipped/errors kept in
// the shape so the client can render the same UI in the future when we add
// partial-success / dup-skip behaviour).

const CSV_REQUIRED_COLUMNS = ['date', 'user_claimant_id', 'project_id', 'hours', 'description'];

// Mounted separately under /api/labour-logs in routes/index.js so the path
// matches the spec (`POST /api/labour-logs/import`) without colliding with
// the labour-router's `/:id` shape.
export const labourImportRouter = Router();
labourImportRouter.use(requireAuth);

labourImportRouter.post('/import', requireAdmin, (req, res, next) => {
  try {
    const { csv } = req.body ?? {};
    if (typeof csv !== 'string' || csv.trim() === '') {
      throw badRequest('csv body field required (non-empty string)');
    }

    const parsed = parseCsvWithHeader(csv);
    if (!parsed || parsed.rows.length === 0) {
      throw badRequest('csv must include a header row and at least one data row');
    }

    const missing = CSV_REQUIRED_COLUMNS.filter(c => !parsed.header.includes(c));
    if (missing.length) {
      throw badRequest(`csv missing required column(s): ${missing.join(', ')}`);
    }

    // Pre-validate every row before opening a transaction. Collect all
    // per-row errors so the client can show them in one pass.
    const errors = [];
    const prepared = [];
    parsed.rows.forEach((row, idx) => {
      // Human-readable row number: +1 because the header is row 1, and
      // row[0] is the first data row.
      const rowNum = idx + 2;
      try {
        prepared.push(validateImportRow(row, rowNum));
      } catch (e) {
        errors.push({ row: rowNum, reason: e.message });
      }
    });

    if (errors.length) {
      // `rows` lives at top-level per the public spec; `details` mirrors it
      // so the standard fetch.js error-shape (`err.details`) carries the
      // per-row list to the client without a bespoke parsing path.
      return res.status(400).json({
        error: { code: 'csv_invalid', message: 'csv has invalid rows', rows: errors, details: { rows: errors } },
      });
    }

    // Single transaction: insert all rows + one audit row per insert.
    // If any insert fails (FK / CHECK), the whole transaction rolls back
    // and no audit_log rows survive. Rows are pre-approved (the actor is
    // an admin, matching the single-entry POST handler's auto-approve).
    const actorId = req.user.id;
    const insertStmt = db.prepare(`
      INSERT INTO labour_entries
        (project_id, user_claimant_id, fiscal_period_id, work_date, hours,
         description, is_overtime, status, reviewed_by_user_id, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'approved', ?, datetime('now'))
    `);

    const tx = db.transaction(() => {
      for (const p of prepared) {
        const info = insertStmt.run(
          p.project.id, p.uc.id, p.period.id, p.work_date, p.hours,
          p.description, actorId,
        );
        const after = getLabourEntry(info.lastInsertRowid);
        audit(actorId, 'create', 'labour_entry', after.id, undefined, after);
      }
    });
    try {
      tx();
    } catch (e) {
      // Surface row-level DB CHECK / FK failures as csv_invalid so the
      // client can render them in the same per-row format. This is the
      // race-condition safety net (e.g. period closed between validation
      // and insert); the all-or-nothing contract still holds.
      if (e instanceof HttpError) throw e;
      throw badRequest(`csv import failed: ${e.message}`);
    }

    res.status(201).json({ imported: prepared.length, skipped: 0, errors: [] });
  } catch (e) { next(e); }
});

// Validate a single CSV row dict. Throws Error('reason …') on failure.
// On success returns the resolved { project, uc, period, work_date, hours,
// description } ready for INSERT.
function validateImportRow(row, _rowNum) {
  const dateRaw  = (row.date ?? '').trim();
  const ucRaw    = (row.user_claimant_id ?? '').trim();
  const projRaw  = (row.project_id ?? '').trim();
  const hoursRaw = (row.hours ?? '').trim();
  const descRaw  = (row.description ?? '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
    throw new Error('date must be ISO YYYY-MM-DD');
  }
  // Reject obvious non-dates like 2025-13-40 — the schema CHECK uses GLOB
  // which only validates shape, not calendar validity.
  const parsedDate = new Date(dateRaw + 'T00:00:00Z');
  if (Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== dateRaw) {
    throw new Error('date must be a valid calendar date');
  }

  const ucId   = Number(ucRaw);
  const projId = Number(projRaw);
  if (!Number.isInteger(ucId)   || ucId   < 1) throw new Error('user_claimant_id must be a positive integer');
  if (!Number.isInteger(projId) || projId < 1) throw new Error('project_id must be a positive integer');

  if (hoursRaw === '') throw new Error('hours required');
  const hours = Number(hoursRaw);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    throw new Error('hours must be a positive number ≤24');
  }
  // At most 2 decimal places (spreadsheet-friendly precision). Reject
  // values that round-trip differently — that's the simplest cross-locale
  // check that catches things like "0.005" or "3.1415".
  const hundredths = Math.round(hours * 100);
  if (Math.abs(hundredths / 100 - hours) > 1e-9) {
    throw new Error('hours may have at most 2 decimal places');
  }

  if (descRaw === '') throw new Error('description required');

  // FK + cross-tenant checks — same logic as the single-row POST handler.
  const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projId);
  if (!project) throw new Error(`project ${projId} not found`);
  const uc = db.prepare(`SELECT * FROM user_claimants WHERE id = ?`).get(ucId);
  if (!uc) throw new Error(`user_claimant ${ucId} not found`);
  if (uc.claimant_id !== project.claimant_id) {
    throw new Error("user_claimant does not belong to this project's claimant");
  }
  if (uc.status !== 'active') {
    throw new Error('user_claimant attachment is inactive');
  }
  const period = db.prepare(`
    SELECT * FROM fiscal_periods
     WHERE claimant_id = ? AND status = 'open' AND ? BETWEEN start_date AND end_date
     LIMIT 1
  `).get(project.claimant_id, dateRaw);
  if (!period) {
    throw new Error(`no open fiscal period covers ${dateRaw} for claimant ${project.claimant_id}`);
  }

  return { project, uc, period, work_date: dateRaw, hours, description: descRaw };
}

export default router;
