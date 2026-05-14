// Verifies the append-only triggers on audit_log (migration 008).
// INSERT still works; UPDATE and DELETE must abort.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { setupTempDb, teardownTempDb, insertUser } from '../helpers/db.js';

let ctx;

before(async () => {
  ctx = await setupTempDb();
});

after(() => {
  teardownTempDb(ctx);
});

test('audit_log rejects UPDATE and DELETE', () => {
  const { db } = ctx;
  const actorId = insertUser(db, { role: 'admin' });

  const info = db.prepare(`
    INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(actorId, 'create', 'user', actorId, '{}');
  const rowId = info.lastInsertRowid;

  assert.throws(
    () => db.prepare(`UPDATE audit_log SET action = 'tampered' WHERE id = ?`).run(rowId),
    /append-only/,
  );
  assert.throws(
    () => db.prepare(`DELETE FROM audit_log WHERE id = ?`).run(rowId),
    /append-only/,
  );
});
