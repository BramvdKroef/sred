import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';

const router = Router();
router.use(requireAuth, requireAdmin);

// When `claimant_id` is supplied we filter rows to those whose `entity_type` +
// `entity_id` is attributable to that claimant. The mapping below joins each
// entity type back to its claimant. Types not listed (notably `user` and
// `refresh_token`) are claimant-agnostic and therefore excluded when scoped.
//
// Each entry is a parameterised SQL fragment that, given `?` = claimant_id,
// yields the set of entity_id values for that entity_type that belong to the
// claimant. We assemble these into a single big `(entity_type='x' AND
// entity_id IN (...)) OR ...` clause.
//
// `evidence_item` joins through projects (its FK). `compensation_row` joins
// through user_claimants. `project_assignment` joins through projects. The
// `claimant` row itself is matched directly.
const CLAIMANT_ENTITY_FILTERS = {
  claimant:           `SELECT id FROM claimants WHERE id = ?`,
  fiscal_period:      `SELECT id FROM fiscal_periods WHERE claimant_id = ?`,
  project:            `SELECT id FROM projects WHERE claimant_id = ?`,
  project_assignment: `SELECT pa.id FROM project_assignments pa JOIN projects p ON p.id = pa.project_id WHERE p.claimant_id = ?`,
  user_claimant:      `SELECT id FROM user_claimants WHERE claimant_id = ?`,
  compensation_row:   `SELECT cr.id FROM compensation_rows cr JOIN user_claimants uc ON uc.id = cr.user_claimant_id WHERE uc.claimant_id = ?`,
  labour_entry:       `SELECT le.id FROM labour_entries le JOIN projects p ON p.id = le.project_id WHERE p.claimant_id = ?`,
  expense:            `SELECT e.id FROM expenses e JOIN projects p ON p.id = e.project_id WHERE p.claimant_id = ?`,
  evidence_item:      `SELECT ei.id FROM evidence_items ei JOIN projects p ON p.id = ei.project_id WHERE p.claimant_id = ?`,
  t661_export:        `SELECT id FROM t661_exports WHERE claimant_id = ?`,
};

router.get('/', (req, res) => {
  const { entity_type, entity_id, action, actor_user_id, from, to, claimant_id } = req.query;
  const limit = Math.min(Number(req.query.limit || 100), 500);

  const where = [];
  const params = [];
  if (entity_type)   { where.push('al.entity_type = ?');   params.push(entity_type); }
  if (entity_id)     { where.push('al.entity_id = ?');     params.push(Number(entity_id)); }
  if (action)        { where.push('al.action = ?');        params.push(action); }
  if (actor_user_id) { where.push('al.actor_user_id = ?'); params.push(Number(actor_user_id)); }
  if (from)          { where.push('al.created_at >= ?');   params.push(from); }
  if (to)            { where.push('al.created_at <= ?');   params.push(to); }

  if (claimant_id) {
    const cid = Number(claimant_id);
    // Build one disjunct per entity_type. The IN-subquery resolves the
    // claimant's owned entity_ids at query time, so dropping an entity (or
    // attaching a new one) is reflected on the next fetch with no cache to
    // invalidate. Entity types not present in the mapping (`user`,
    // `refresh_token`) are silently excluded — they're claimant-agnostic.
    const disjuncts = Object.entries(CLAIMANT_ENTITY_FILTERS).map(
      ([type, sub]) => {
        params.push(type, cid);
        return `(al.entity_type = ? AND al.entity_id IN (${sub}))`;
      }
    );
    where.push(`(${disjuncts.join(' OR ')})`);
  }

  const sql = `
    SELECT al.id, al.actor_user_id, al.action, al.entity_type, al.entity_id,
           al.before_json, al.after_json, al.created_at,
           u.name AS actor_name
      FROM audit_log al
      LEFT JOIN users u ON u.id = al.actor_user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY al.id DESC
     LIMIT ?
  `;
  const items = db.prepare(sql).all(...params, limit);

  // Distinct values for filter dropdowns (cheap on this size of table).
  const entityTypes = db.prepare(`SELECT DISTINCT entity_type FROM audit_log ORDER BY entity_type`).all().map(r => r.entity_type);
  const actions     = db.prepare(`SELECT DISTINCT action      FROM audit_log ORDER BY action`).all().map(r => r.action);

  res.json({ items, facets: { entity_types: entityTypes, actions } });
});

export default router;
