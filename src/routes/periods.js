import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { getPeriod, mutateAndAudit } from '../lib/route-helpers.js';

const router = Router();
router.use(requireAuth, requireAdmin);

router.post('/:id/close', (req, res, next) => {
  try {
    // Short-circuit no-op closes BEFORE writing an audit row.
    const current = getPeriod(req.params.id);
    if (current.status === 'closed') return res.json(current);

    const { after } = mutateAndAudit({
      loader: getPeriod,
      entityType: 'fiscal_period',
      id: req.params.id,
      actorUserId: req.user.id,
      action: 'close_period',
      write: (before) => {
        db.prepare(`
          UPDATE fiscal_periods SET status = 'closed', closed_at = datetime('now') WHERE id = ?
        `).run(before.id);
      },
    });
    res.json(after);
  } catch (e) { next(e); }
});

router.post('/:id/reopen', (req, res, next) => {
  try {
    // Short-circuit no-op reopens BEFORE writing an audit row.
    const current = getPeriod(req.params.id);
    if (current.status === 'open') return res.json(current);

    const { after } = mutateAndAudit({
      loader: getPeriod,
      entityType: 'fiscal_period',
      id: req.params.id,
      actorUserId: req.user.id,
      action: 'reopen_period',
      write: (before) => {
        db.prepare(`
          UPDATE fiscal_periods SET status = 'open', closed_at = NULL WHERE id = ?
        `).run(before.id);
      },
    });
    res.json(after);
  } catch (e) { next(e); }
});

export default router;
