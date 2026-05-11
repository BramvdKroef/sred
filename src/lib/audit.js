import { db } from '../db/index.js';

export function audit(actorUserId, action, entityType, entityId, before, after) {
  db.prepare(`
    INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    actorUserId ?? null,
    action,
    entityType,
    entityId,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
  );
}
