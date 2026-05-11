import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

const router = Router();
router.use(requireAuth, requireAdmin);

const SNAPSHOT_FIELDS = ['title', 'field_of_science', 'advancement_sought', 'uncertainties', 'work_performed', 'type', 'phase'];
const EDITABLE_FIELDS = [...SNAPSHOT_FIELDS, 'start_date', 'end_date', 'status'];
const VALID_TYPES  = ['sred', 'internal'];
const VALID_PHASES = ['concept', 'development', 'complete'];

function getProjectOrThrow(id) {
  const p = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id);
  if (!p) throw notFound('project not found');
  return p;
}

router.get('/:id', (req, res, next) => {
  try {
    const project = getProjectOrThrow(req.params.id);
    const assignments = db.prepare(`
      SELECT pa.id, pa.user_claimant_id, pa.status, u.id AS user_id, u.email, u.name
        FROM project_assignments pa
        JOIN user_claimants uc ON uc.id = pa.user_claimant_id
        JOIN users u           ON u.id = uc.user_id
       WHERE pa.project_id = ?
       ORDER BY pa.id
    `).all(project.id);
    res.json({ ...project, assignments });
  } catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const before = getProjectOrThrow(req.params.id);

    const updates = {};
    for (const k of EDITABLE_FIELDS) {
      if (req.body && k in req.body) updates[k] = req.body[k];
    }

    if (updates.status !== undefined && !['planned', 'active', 'completed'].includes(updates.status)) {
      throw badRequest('status must be planned|active|completed');
    }
    if (updates.type !== undefined && !VALID_TYPES.includes(updates.type)) {
      throw badRequest(`type must be ${VALID_TYPES.join('|')}`);
    }
    if (updates.phase !== undefined && !VALID_PHASES.includes(updates.phase)) {
      throw badRequest(`phase must be ${VALID_PHASES.join('|')}`);
    }
    if (updates.title !== undefined && !updates.title) {
      throw badRequest('title cannot be empty');
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) return res.json(before);

    const snapshotNeeded = SNAPSHOT_FIELDS.some(k => k in updates && updates[k] !== before[k]);

    const tx = db.transaction(() => {
      const setClause = keys.map(k => `${k} = ?`).join(', ') + `, updated_at = datetime('now')`;
      db.prepare(`UPDATE projects SET ${setClause} WHERE id = ?`)
        .run(...keys.map(k => updates[k]), before.id);

      if (snapshotNeeded) {
        const merged = { ...before, ...updates };
        db.prepare(`
          INSERT INTO project_revisions
            (project_id, title, field_of_science, advancement_sought, uncertainties,
             work_performed, type, phase, revised_by_user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          before.id,
          merged.title,
          merged.field_of_science,
          merged.advancement_sought,
          merged.uncertainties,
          merged.work_performed,
          merged.type,
          merged.phase,
          req.user.id,
        );
      }
    });
    tx();

    const after = getProjectOrThrow(before.id);
    audit(req.user.id, 'update', 'project', before.id, before, after);
    res.json(after);
  } catch (e) { next(e); }
});

router.get('/:id/revisions', (req, res, next) => {
  try {
    const project = getProjectOrThrow(req.params.id);
    const items = db.prepare(
      `SELECT * FROM project_revisions WHERE project_id = ? ORDER BY id DESC`
    ).all(project.id);
    res.json({ items });
  } catch (e) { next(e); }
});

router.post('/:id/assignments', (req, res, next) => {
  try {
    const project = getProjectOrThrow(req.params.id);
    const { user_claimant_id } = req.body ?? {};
    if (!Number.isInteger(user_claimant_id)) throw badRequest('user_claimant_id required');

    const uc = db.prepare(`SELECT * FROM user_claimants WHERE id = ?`).get(user_claimant_id);
    if (!uc) throw notFound('user_claimant not found');
    if (uc.claimant_id !== project.claimant_id) {
      throw badRequest("user_claimant does not belong to this project's claimant");
    }

    const existing = db.prepare(
      `SELECT * FROM project_assignments WHERE project_id = ? AND user_claimant_id = ?`
    ).get(project.id, user_claimant_id);

    if (existing) {
      if (existing.status === 'inactive') {
        db.prepare(`UPDATE project_assignments SET status = 'active' WHERE id = ?`).run(existing.id);
        const reactivated = db.prepare(`SELECT * FROM project_assignments WHERE id = ?`).get(existing.id);
        audit(req.user.id, 'update', 'project_assignment', existing.id, existing, reactivated);
        return res.json(reactivated);
      }
      return res.json(existing);
    }

    const info = db.prepare(
      `INSERT INTO project_assignments (project_id, user_claimant_id) VALUES (?, ?)`
    ).run(project.id, user_claimant_id);
    const assignment = db.prepare(`SELECT * FROM project_assignments WHERE id = ?`).get(info.lastInsertRowid);
    audit(req.user.id, 'create', 'project_assignment', assignment.id, undefined, assignment);
    res.status(201).json(assignment);
  } catch (e) { next(e); }
});

router.delete('/:id/assignments/:user_claimant_id', (req, res, next) => {
  try {
    const project = getProjectOrThrow(req.params.id);
    const ucId = Number(req.params.user_claimant_id);
    const before = db.prepare(
      `SELECT * FROM project_assignments WHERE project_id = ? AND user_claimant_id = ?`
    ).get(project.id, ucId);
    if (!before) throw notFound('assignment not found');
    if (before.status === 'inactive') return res.status(204).end();

    db.prepare(`UPDATE project_assignments SET status = 'inactive' WHERE id = ?`).run(before.id);
    const after = db.prepare(`SELECT * FROM project_assignments WHERE id = ?`).get(before.id);
    audit(req.user.id, 'update', 'project_assignment', before.id, before, after);
    res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
