import { Router } from 'express';
import { db } from '../db/index.js';
import { signSession } from '../auth/jwt.js';
import { requireAuth } from '../auth/middleware.js';
import { findValidEmailToken, consumeEmailToken, mintEmailToken, buildMagicLink } from '../auth/tokens.js';
import { startRegistration, finishRegistration, startLogin, finishLogin } from '../auth/webauthn.js';
import { mintRefreshToken, consumeRefreshToken, revokeRefreshToken } from '../auth/refresh.js';
import { sendMagicLink } from '../lib/email.js';
import { badRequest, unauthorized, notFound } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import {
  webauthnLimiter,
  recoveryShortLimiter,
  recoveryHourLimiter,
  refreshLimiter,
} from '../lib/rate-limit.js';

const router = Router();

// --- Registration -----------------------------------------------------------

router.post('/webauthn/register/start', webauthnLimiter, async (req, res, next) => {
  try {
    const { token } = req.body ?? {};
    let user;
    if (token) {
      // All three magic-link flows (initial invite, recovery, add-device)
      // funnel through this register endpoint.
      const tok = findValidEmailToken(token, ['invite', 'recovery', 'add_device']);
      user = { id: tok.user_id, email: tok.email, name: tok.name, role: tok.role };
    } else if (req.headers.authorization) {
      // add-device flow — require an existing session
      await new Promise((resolve, reject) =>
        requireAuth(req, res, err => (err ? reject(err) : resolve())));
      user = req.user;
    } else {
      throw unauthorized('token or session required');
    }
    const existing = db.prepare(`SELECT credential_id, transports FROM credentials WHERE user_id = ?`).all(user.id);
    const options = await startRegistration({ user, existingCredentials: existing });
    res.json(options);
  } catch (e) { next(e); }
});

router.post('/webauthn/register/finish', webauthnLimiter, async (req, res, next) => {
  try {
    const { token, attestation, label } = req.body ?? {};
    if (!attestation) throw badRequest('attestation required');
    let user;
    let consumeToken = false;
    let tokenRow;
    if (token) {
      tokenRow = findValidEmailToken(token, ['invite', 'recovery', 'add_device']);
      user = { id: tokenRow.user_id, email: tokenRow.email, name: tokenRow.name, role: tokenRow.role };
      consumeToken = true;
    } else if (req.headers.authorization) {
      await new Promise((resolve, reject) =>
        requireAuth(req, res, err => (err ? reject(err) : resolve())));
      user = req.user;
    } else {
      throw unauthorized('token or session required');
    }
    await finishRegistration({ user, response: attestation, label });
    if (consumeToken) {
      // consumeEmailToken returns 0 if the row was already consumed or
      // is gone (e.g. concurrent finish, replay). Refuse rather than
      // silently activating the user.
      if (consumeEmailToken(tokenRow.id) === 0) throw unauthorized('invalid token');
      db.prepare(`UPDATE users SET status = 'active' WHERE id = ? AND status = 'pending'`).run(user.id);
    }
    const fresh = db.prepare(`SELECT id, email, name, role, status FROM users WHERE id = ?`).get(user.id);
    const session = signSession(fresh);
    const refresh = mintRefreshToken(fresh.id);
    res.json({ user: fresh, token: session, refresh_token: refresh.raw, refresh_expires_at: refresh.expiresAt });
  } catch (e) { next(e); }
});

// --- Login ------------------------------------------------------------------

router.post('/webauthn/login/start', webauthnLimiter, async (req, res, next) => {
  try {
    const { email } = req.body ?? {};
    const user = email
      ? db.prepare(`SELECT id, email, name, role, status FROM users WHERE email = ?`).get(email)
      : null;
    // For unknown emails we still emit options without allowCredentials to avoid enumeration.
    const options = await startLogin({ user: user && user.status === 'active' ? user : null });
    res.json(options);
  } catch (e) { next(e); }
});

router.post('/webauthn/login/finish', webauthnLimiter, async (req, res, next) => {
  try {
    const { assertion } = req.body ?? {};
    if (!assertion) throw badRequest('assertion required');
    const user = await finishLogin({ response: assertion });
    const session = signSession(user);
    const refresh = mintRefreshToken(user.id);
    res.json({ user, token: session, refresh_token: refresh.raw, refresh_expires_at: refresh.expiresAt });
  } catch (e) { next(e); }
});

// --- Refresh ----------------------------------------------------------------

router.post('/auth/refresh', refreshLimiter, (req, res, next) => {
  try {
    const { refresh_token } = req.body ?? {};
    const user = consumeRefreshToken(refresh_token);  // also rotates (marks old revoked)
    const session = signSession(user);
    const next_ = mintRefreshToken(user.id);
    res.json({ token: session, refresh_token: next_.raw, refresh_expires_at: next_.expiresAt });
  } catch (e) { next(e); }
});

// --- Recovery (magic link) --------------------------------------------------

router.post('/recovery', recoveryShortLimiter, recoveryHourLimiter, (req, res, next) => {
  try {
    const { email } = req.body ?? {};
    if (!email) throw badRequest('email required');
    const user = db.prepare(`SELECT id, name, email, status FROM users WHERE email = ?`).get(email);
    if (user && user.status === 'active') {
      const { raw } = mintEmailToken(user.id, 'recovery');
      const link = buildMagicLink(raw);
      sendMagicLink({ to: user.email, name: user.name, purpose: 'recovery', link })
        .catch(err => (req.log ?? log).warn('recovery_email_error', { err: err.message }));
    }
    // Always 200 to avoid account enumeration.
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/logout', requireAuth, (req, res) => {
  // JWT is stateless; client discards. Refresh tokens are server-side state,
  // so revoke the one the client presents (and quietly accept absence).
  revokeRefreshToken(req.body?.refresh_token);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const attachments = db.prepare(
    `SELECT uc.id, uc.claimant_id, c.legal_name, uc.title, uc.is_specified_employee, uc.status
       FROM user_claimants uc JOIN claimants c ON c.id = uc.claimant_id
      WHERE uc.user_id = ?`
  ).all(req.user.id);
  res.json({ user: req.user, attachments });
});

router.get('/activity', requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit || 20), 100);
  const projectId = req.query.project_id ? Number(req.query.project_id) : null;
  // Optional claimant scope (header selector). All three feeds join through
  // projects, so the filter is `p.claimant_id = ?` in every sub-query.
  const claimantId = req.query.claimant_id ? Number(req.query.claimant_id) : null;
  const isAdmin = req.user.role === 'admin';
  // Admins can scope to a specific user; employees are auto-scoped to themselves.
  const targetUserId = isAdmin
    ? (req.query.user_id ? Number(req.query.user_id) : null)
    : req.user.id;

  const userFilter    = targetUserId ? 'AND uc.user_id = ?' : '';
  const userParam     = targetUserId ? [targetUserId] : [];
  const evUserFilter  = targetUserId ? 'AND ei.uploaded_by_user_id = ?' : '';
  const evUserParam   = targetUserId ? [targetUserId] : [];
  const projFilterLE  = projectId ? 'AND le.project_id = ?' : '';
  const projFilterEX  = projectId ? 'AND e.project_id = ?'  : '';
  const projFilterEV  = projectId ? 'AND ei.project_id = ?' : '';
  const projParam     = projectId ? [projectId] : [];
  const claimantFilter = claimantId ? 'AND p.claimant_id = ?' : '';
  const claimantParam  = claimantId ? [claimantId] : [];

  const labour = db.prepare(`
    SELECT 'labour' AS type, le.id, le.created_at, le.work_date AS event_date,
           le.project_id, p.title AS project_title,
           le.hours, le.description, le.status, le.is_overtime,
           u.name AS actor_name
      FROM labour_entries le
      JOIN user_claimants uc ON uc.id = le.user_claimant_id
      JOIN users u           ON u.id  = uc.user_id
      JOIN projects p        ON p.id  = le.project_id
     WHERE 1=1 ${userFilter} ${projFilterLE} ${claimantFilter}
     ORDER BY le.created_at DESC LIMIT ?
  `).all(...userParam, ...projParam, ...claimantParam, limit);

  const expenses = db.prepare(`
    SELECT 'expense' AS type, e.id, e.created_at, e.expense_date AS event_date,
           e.project_id, p.title AS project_title,
           e.amount_cents, e.currency, e.fx_rate, e.category, e.description, e.status,
           u.name AS actor_name
      FROM expenses e
      JOIN user_claimants uc ON uc.id = e.user_claimant_id
      JOIN users u           ON u.id  = uc.user_id
      JOIN projects p        ON p.id  = e.project_id
     WHERE 1=1 ${userFilter} ${projFilterEX} ${claimantFilter}
     ORDER BY e.created_at DESC LIMIT ?
  `).all(...userParam, ...projParam, ...claimantParam, limit);

  const evidence = db.prepare(`
    SELECT 'evidence' AS type, ei.id, ei.created_at, ei.evidence_date AS event_date,
           ei.project_id, p.title AS project_title,
           ei.kind AS evidence_kind, ei.caption,
           u.name AS actor_name
      FROM evidence_items ei
      JOIN users u    ON u.id = ei.uploaded_by_user_id
      JOIN projects p ON p.id = ei.project_id
     WHERE 1=1 ${evUserFilter} ${projFilterEV} ${claimantFilter}
     ORDER BY ei.created_at DESC LIMIT ?
  `).all(...evUserParam, ...projParam, ...claimantParam, limit);

  const items = [...labour, ...expenses, ...evidence]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit);
  res.json({ items });
});

router.get('/me/credentials', requireAuth, (req, res) => {
  const items = db.prepare(`
    SELECT id, label, transports, counter, created_at, last_used_at
      FROM credentials
     WHERE user_id = ?
     ORDER BY id
  `).all(req.user.id);
  res.json({ items: items.map(c => ({
    ...c,
    transports: c.transports ? JSON.parse(c.transports) : null,
  })) });
});

router.delete('/me/credentials/:id', requireAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cred = db.prepare(`SELECT * FROM credentials WHERE id = ? AND user_id = ?`).get(id, req.user.id);
    if (!cred) throw notFound('credential not found');
    const count = db.prepare(`SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?`).get(req.user.id).n;
    if (count <= 1) throw badRequest("can't remove your only passkey; register another first");
    db.prepare(`DELETE FROM credentials WHERE id = ?`).run(id);
    res.status(204).end();
  } catch (e) { next(e); }
});

router.get('/me/projects', requireAuth, (req, res) => {
  const items = db.prepare(`
    SELECT p.*, uc.id AS user_claimant_id, uc.claimant_id, c.legal_name AS claimant_name
      FROM projects p
      JOIN project_assignments pa ON pa.project_id = p.id AND pa.status = 'active'
      JOIN user_claimants uc ON uc.id = pa.user_claimant_id AND uc.status = 'active'
      JOIN claimants c ON c.id = uc.claimant_id
     WHERE uc.user_id = ?
     ORDER BY p.id
  `).all(req.user.id);
  res.json({ items });
});

// Fiscal periods for every claimant the caller is attached to. Drives the
// period selector on the employee My-activity tab. The /api/claimants/:id
// router is admin-only, so non-admin callers couldn't otherwise list
// periods; this is the scoped read for them.
router.get('/me/periods', requireAuth, (req, res) => {
  const items = db.prepare(`
    SELECT fp.*, c.legal_name AS claimant_name
      FROM fiscal_periods fp
      JOIN claimants c ON c.id = fp.claimant_id
      JOIN user_claimants uc ON uc.claimant_id = c.id AND uc.status = 'active'
     WHERE uc.user_id = ?
     GROUP BY fp.id
     ORDER BY c.legal_name, fp.start_date DESC
  `).all(req.user.id);
  res.json({ items });
});

export default router;
