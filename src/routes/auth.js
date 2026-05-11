import { Router } from 'express';
import { db } from '../db/index.js';
import { signSession } from '../auth/jwt.js';
import { requireAuth } from '../auth/middleware.js';
import { findValidEmailToken, consumeEmailToken, mintEmailToken, buildMagicLink } from '../auth/tokens.js';
import { startRegistration, finishRegistration, startLogin, finishLogin } from '../auth/webauthn.js';
import { sendMagicLink } from '../lib/email.js';
import { badRequest, unauthorized } from '../lib/errors.js';

const router = Router();

// --- Registration -----------------------------------------------------------

router.post('/webauthn/register/start', async (req, res, next) => {
  try {
    const { token } = req.body ?? {};
    let user;
    if (token) {
      const tok = findValidEmailToken(token);
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

router.post('/webauthn/register/finish', async (req, res, next) => {
  try {
    const { token, attestation, label } = req.body ?? {};
    if (!attestation) throw badRequest('attestation required');
    let user;
    let consumeToken = false;
    let tokenRow;
    if (token) {
      tokenRow = findValidEmailToken(token);
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
      consumeEmailToken(tokenRow.id);
      db.prepare(`UPDATE users SET status = 'active' WHERE id = ? AND status = 'pending'`).run(user.id);
    }
    const fresh = db.prepare(`SELECT id, email, name, role, status FROM users WHERE id = ?`).get(user.id);
    const session = signSession(fresh);
    res.json({ user: fresh, token: session });
  } catch (e) { next(e); }
});

// --- Login ------------------------------------------------------------------

router.post('/webauthn/login/start', async (req, res, next) => {
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

router.post('/webauthn/login/finish', async (req, res, next) => {
  try {
    const { assertion } = req.body ?? {};
    if (!assertion) throw badRequest('assertion required');
    const user = await finishLogin({ response: assertion });
    const session = signSession(user);
    res.json({ user, token: session });
  } catch (e) { next(e); }
});

// --- Recovery (magic link) --------------------------------------------------

router.post('/recovery', (req, res, next) => {
  try {
    const { email } = req.body ?? {};
    if (!email) throw badRequest('email required');
    const user = db.prepare(`SELECT id, name, email, status FROM users WHERE email = ?`).get(email);
    if (user && user.status === 'active') {
      const { raw } = mintEmailToken(user.id, 'recovery');
      const link = buildMagicLink(raw);
      sendMagicLink({ to: user.email, name: user.name, purpose: 'recovery', link })
        .catch(err => console.warn('[recovery] email send error:', err));
    }
    // Always 200 to avoid account enumeration.
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/logout', requireAuth, (_req, res) => {
  // JWT is stateless; client discards. We could blocklist here if needed.
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

export default router;
