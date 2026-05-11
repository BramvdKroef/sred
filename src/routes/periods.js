import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

const router = Router();
router.use(requireAuth, requireAdmin);

function getPeriodOrThrow(id) {
  const p = db.prepare(`SELECT * FROM fiscal_periods WHERE id = ?`).get(id);
  if (!p) throw notFound('fiscal period not found');
  return p;
}

router.post('/:id/close', (req, res, next) => {
  try {
    const before = getPeriodOrThrow(req.params.id);
    if (before.status === 'closed') return res.json(before);
    db.prepare(`
      UPDATE fiscal_periods SET status = 'closed', closed_at = datetime('now') WHERE id = ?
    `).run(before.id);
    const after = getPeriodOrThrow(before.id);
    audit(req.user.id, 'close_period', 'fiscal_period', before.id, before, after);
    res.json(after);
  } catch (e) { next(e); }
});

router.post('/:id/reopen', (req, res, next) => {
  try {
    const before = getPeriodOrThrow(req.params.id);
    if (before.status === 'open') return res.json(before);
    db.prepare(`
      UPDATE fiscal_periods SET status = 'open', closed_at = NULL WHERE id = ?
    `).run(before.id);
    const after = getPeriodOrThrow(before.id);
    audit(req.user.id, 'reopen_period', 'fiscal_period', before.id, before, after);
    res.json(after);
  } catch (e) { next(e); }
});

export default router;
