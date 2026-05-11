import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/', (req, res) => {
  const { entity_type, entity_id, action, actor_user_id, from, to } = req.query;
  const limit = Math.min(Number(req.query.limit || 100), 500);

  const where = [];
  const params = [];
  if (entity_type)   { where.push('al.entity_type = ?');   params.push(entity_type); }
  if (entity_id)     { where.push('al.entity_id = ?');     params.push(Number(entity_id)); }
  if (action)        { where.push('al.action = ?');        params.push(action); }
  if (actor_user_id) { where.push('al.actor_user_id = ?'); params.push(Number(actor_user_id)); }
  if (from)          { where.push('al.created_at >= ?');   params.push(from); }
  if (to)            { where.push('al.created_at <= ?');   params.push(to); }

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
