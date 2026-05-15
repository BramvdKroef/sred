import { Router } from 'express';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { mutateAndAudit, createAndAudit } from '../lib/route-helpers.js';
import { mintEmailToken, buildMagicLink } from '../auth/tokens.js';
import { sendMagicLink } from '../lib/email.js';
import { inviteLimiter } from '../lib/rate-limit.js';

const router = Router();
router.use(requireAuth, requireAdmin);

const VALID_ROLES = ['admin', 'manager', 'employee'];
const VALID_COMP_TYPES = ['salary', 'hourly'];

function validateCompensation(c) {
  if (!c || typeof c !== 'object') throw badRequest('compensation required');
  if (!VALID_COMP_TYPES.includes(c.comp_type))
    throw badRequest('compensation.comp_type must be salary|hourly');
  if (!Number.isInteger(c.amount_cents) || c.amount_cents <= 0)
    throw badRequest('compensation.amount_cents must be a positive integer');
  if (c.hours_per_year !== undefined &&
      (!Number.isInteger(c.hours_per_year) || c.hours_per_year <= 0))
    throw badRequest('compensation.hours_per_year must be a positive integer');
  if (!c.effective_from || typeof c.effective_from !== 'string')
    throw badRequest('compensation.effective_from required');
}

function validateAttachment(a) {
  if (!a || typeof a !== 'object') throw badRequest('attachment must be an object');
  if (!Number.isInteger(a.claimant_id)) throw badRequest('attachment.claimant_id required');
  const claimant = db.prepare(`SELECT id FROM claimants WHERE id = ?`).get(a.claimant_id);
  if (!claimant) throw badRequest(`claimant ${a.claimant_id} not found`);
  if (a.employment_start_date !== undefined && a.employment_start_date !== null &&
      typeof a.employment_start_date !== 'string')
    throw badRequest('attachment.employment_start_date must be a string (YYYY-MM-DD) or null');
  validateCompensation(a.compensation);
}

// Tight loader for mutateAndAudit/createAndAudit. The list/detail responses
// use the heavier `loadUserBundle` below; the audit payload only ever needs
// the raw `users` row.
function loadUserRow(id) {
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
  if (!row) throw notFound('user not found');
  return row;
}

function loadUserBundle(userId) {
  const user = db.prepare(
    `SELECT id, email, name, role, status, created_at FROM users WHERE id = ?`
  ).get(userId);
  if (!user) throw notFound('user not found');
  const attachments = db.prepare(`
    SELECT uc.id, uc.claimant_id, c.legal_name AS claimant_name,
           uc.title, uc.is_specified_employee, uc.employment_start_date,
           uc.status, uc.created_at
      FROM user_claimants uc
      JOIN claimants c ON c.id = uc.claimant_id
     WHERE uc.user_id = ?
     ORDER BY uc.id
  `).all(userId);
  for (const a of attachments) {
    a.compensation_history = db.prepare(`
      SELECT id, comp_type, amount_cents, hours_per_year, effective_from, created_at
        FROM compensation_rows
       WHERE user_claimant_id = ?
       ORDER BY effective_from DESC, id DESC
    `).all(a.id);
  }
  const projects = db.prepare(`
    SELECT DISTINCT p.id, p.title, p.claimant_id, c.legal_name AS claimant_name,
           p.type, p.status
      FROM projects p
      JOIN project_assignments pa ON pa.project_id = p.id AND pa.status = 'active'
      JOIN user_claimants uc      ON uc.id = pa.user_claimant_id AND uc.status = 'active'
      JOIN claimants c            ON c.id = p.claimant_id
     WHERE uc.user_id = ?
     ORDER BY p.title
  `).all(userId);
  return { ...user, attachments, projects };
}

function insertAttachment(userId, a, actorUserId) {
  const ucInfo = db.prepare(`
    INSERT INTO user_claimants
      (user_id, claimant_id, title, is_specified_employee, employment_start_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    userId,
    a.claimant_id,
    a.title ?? null,
    a.is_specified_employee ? 1 : 0,
    a.employment_start_date ?? null,
  );
  const ucId = ucInfo.lastInsertRowid;

  db.prepare(`
    INSERT INTO compensation_rows
      (user_claimant_id, comp_type, amount_cents, hours_per_year, effective_from)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    ucId,
    a.compensation.comp_type,
    a.compensation.amount_cents,
    a.compensation.hours_per_year ?? 2080,
    a.compensation.effective_from,
  );

  const created = db.prepare(`SELECT * FROM user_claimants WHERE id = ?`).get(ucId);
  audit(actorUserId, 'create', 'user_claimant', ucId, undefined, created);
  return created;
}

// --- /api/users -------------------------------------------------------------

router.get('/', (req, res) => {
  const { role, status, claimant_id, q } = req.query;
  const where = [];
  const params = [];
  if (role) {
    const roles = String(role).split(',').filter(Boolean);
    where.push(`u.role IN (${roles.map(() => '?').join(',')})`);
    params.push(...roles);
  }
  if (status)      { where.push('u.status = ?');       params.push(status); }
  if (claimant_id) { where.push('uc.claimant_id = ?'); params.push(Number(claimant_id)); }
  if (q && String(q).trim()) {
    where.push('(u.name LIKE ? OR u.email LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const join = claimant_id ? 'JOIN user_claimants uc ON uc.user_id = u.id' : '';
  const ucFields = claimant_id
    ? ', uc.id AS user_claimant_id, uc.title AS uc_title, uc.is_specified_employee, uc.status AS attachment_status'
    : '';
  const sql = `
    SELECT DISTINCT u.id, u.email, u.name, u.role, u.status, u.created_at${ucFields}
      FROM users u ${join}
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY
       CASE u.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
       u.id
  `;
  const items = db.prepare(sql).all(...params);
  res.json({ items });
});

router.post('/', (req, res, next) => {
  try {
    const { email, name, role, attachments = [] } = req.body ?? {};
    if (!email || typeof email !== 'string' || !email.includes('@')) throw badRequest('email required');
    if (!name || typeof name !== 'string') throw badRequest('name required');
    if (!VALID_ROLES.includes(role)) throw badRequest('role must be admin|employee');
    if (!Array.isArray(attachments)) throw badRequest('attachments must be an array');
    for (const a of attachments) validateAttachment(a);

    const existing = db.prepare(`SELECT id, status FROM users WHERE email = ?`).get(email);
    if (existing) throw conflict('email already exists', { user_id: existing.id, status: existing.status });

    const { after } = createAndAudit({
      loader: loadUserRow,
      entityType: 'user',
      actorUserId: req.user.id,
      action: 'create',
      write: () => {
        // User + attachments + per-attachment compensation rows all land in
        // one transaction; the per-attachment audit rows are written by
        // `insertAttachment` inside the tx as before.
        const tx = db.transaction(() => {
          const info = db.prepare(
            `INSERT INTO users (email, name, role, status) VALUES (?, ?, ?, 'pending')`
          ).run(email, name, role);
          const newUserId = info.lastInsertRowid;
          for (const a of attachments) insertAttachment(newUserId, a, req.user.id);
          return newUserId;
        });
        return tx();
      },
    });

    res.status(201).json(loadUserBundle(after.id));
  } catch (e) { next(e); }
});

router.get('/:id', (req, res, next) => {
  try { res.json(loadUserBundle(Number(req.params.id))); }
  catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    // Pre-flight load so we can validate body fields, short-circuit no-op
    // PATCH, and surface 404 before mutateAndAudit writes an audit row.
    loadUserRow(userId);

    const { name, role, status } = req.body ?? {};
    const updates = {};
    if (name !== undefined) {
      if (!name) throw badRequest('name cannot be empty');
      updates.name = name;
    }
    if (role !== undefined) {
      if (!VALID_ROLES.includes(role)) throw badRequest('role must be admin|employee');
      updates.role = role;
    }
    if (status !== undefined) {
      if (!['pending', 'active', 'disabled'].includes(status))
        throw badRequest('status must be pending|active|disabled');
      updates.status = status;
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) return res.json(loadUserBundle(userId));

    mutateAndAudit({
      loader: loadUserRow,
      entityType: 'user',
      id: userId,
      actorUserId: req.user.id,
      action: 'update',
      write: (before) => {
        const setClause = keys.map(k => `${k} = ?`).join(', ');
        db.prepare(`UPDATE users SET ${setClause} WHERE id = ?`)
          .run(...keys.map(k => updates[k]), before.id);
      },
    });
    res.json(loadUserBundle(userId));
  } catch (e) { next(e); }
});

router.post('/:id/deactivate', (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    // Pre-flight short-circuit for no-op deactivate (already disabled) AND
    // the self-deactivate guard. Both happen before mutateAndAudit so no
    // audit row is written if we early-return / reject.
    const current = loadUserRow(userId);
    if (current.id === req.user.id) throw badRequest("you can't deactivate your own account");
    if (current.status === 'disabled') return res.json(current);

    const { after } = mutateAndAudit({
      loader: loadUserRow,
      entityType: 'user',
      id: userId,
      actorUserId: req.user.id,
      action: 'deactivate',
      write: (before) => {
        // Bulk-flip every currently-active attachment AND tag it with this
        // user_id so reactivate can later distinguish "deactivated together
        // with the user" from "deactivated independently for some other
        // reason" (e.g. the employee left one claimant while still active
        // on another). Already-inactive rows are left alone — they keep
        // whatever provenance they had, including a NULL marker.
        const tx = db.transaction(() => {
          db.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(before.id);
          db.prepare(`
            UPDATE user_claimants
               SET status = 'inactive',
                   deactivated_with_user_id = ?
             WHERE user_id = ? AND status = 'active'
          `).run(before.id, before.id);
        });
        tx();
      },
    });
    res.json(after);
  } catch (e) { next(e); }
});

router.post('/:id/reactivate', (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    // Pre-flight short-circuit for no-op reactivate. Avoids writing an
    // audit row when the user is already active.
    const current = loadUserRow(userId);
    if (current.status === 'active') return res.json(current);

    const { after } = mutateAndAudit({
      loader: loadUserRow,
      entityType: 'user',
      id: userId,
      actorUserId: req.user.id,
      action: 'reactivate',
      write: (before) => {
        // Symmetric to deactivate: flip back only the user_claimants rows
        // that were taken inactive by the same user-level deactivate
        // (identified by `deactivated_with_user_id = userId`), and clear
        // the marker. Rows that had been independently set to inactive
        // (no marker) keep their state — the admin can re-activate them
        // individually if desired.
        const tx = db.transaction(() => {
          db.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).run(before.id);
          db.prepare(`
            UPDATE user_claimants
               SET status = 'active',
                   deactivated_with_user_id = NULL
             WHERE user_id = ? AND deactivated_with_user_id = ?
          `).run(before.id, before.id);
        });
        tx();
      },
    });
    res.json(after);
  } catch (e) { next(e); }
});

router.post('/:id/invite', inviteLimiter, async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    // An admin can't mint an enrollment / add-device link for themselves —
    // that bypasses any second-admin oversight on their own account and
    // also makes self-recovery look indistinguishable from peer enrollment
    // in the audit log. If the actor is locked out of their own passkey,
    // the dedicated recovery flow exists for exactly this case.
    if (req.user.id === userId)
      throw badRequest('cannot invite yourself; use the recovery flow');
    const user = db.prepare(`SELECT id, email, name, role, status FROM users WHERE id = ?`).get(userId);
    if (!user) throw notFound('user not found');
    if (user.status === 'disabled') throw badRequest('user is disabled');

    const purpose = user.status === 'pending' ? 'invite' : 'add_device';
    const { raw, expiresAt } = mintEmailToken(user.id, purpose);
    const magicLink = buildMagicLink(raw);

    // Capture target identity in the audit row so the log shows who was
    // invited rather than just the user id (the id alone is useless if the
    // user row is later renamed or its email changes). Written before the
    // SMTP attempt so a transient send failure still leaves a trail.
    audit(req.user.id, purpose, 'user', user.id, undefined, {
      email: user.email, role: user.role,
    });

    // Honest delivery reporting:
    //  - SMTP disabled (host empty): treat as expected dev mode. The link is
    //    logged to stderr by sendMagicLink; return delivered:false without
    //    awaiting (no remote call to wait on).
    //  - SMTP configured: await the send, bounded by SEND_TIMEOUT_MS so a
    //    black-holed mail host can't stall the request. Report the resolved
    //    delivered flag and a short `error` description on failure. The
    //    raw magic link is NEVER echoed back (V-06 still applies); on
    //    failure the admin sees the error and can retry.
    const response = {
      user_id: user.id,
      purpose,
      expires_at: expiresAt,
      delivered: false,
    };

    if (!config.smtp.host) {
      sendMagicLink({ to: user.email, name: user.name, purpose, link: magicLink })
        .catch(err => console.warn('[invite] email send error:', err));
    } else {
      const result = await sendMagicLink({
        to: user.email, name: user.name, purpose, link: magicLink,
      });
      response.delivered = result.delivered === true;
      if (!response.delivered) {
        // `reason` is one of: smtp_disabled | timeout | send_failed.
        // `error` carries the underlying message for the admin UI.
        response.error = result.error || result.reason || 'send_failed';
      }
    }

    res.json(response);
  } catch (e) { next(e); }
});

router.post('/:id/attachments', (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const user = db.prepare(`SELECT id FROM users WHERE id = ?`).get(userId);
    if (!user) throw notFound('user not found');

    const a = req.body ?? {};
    validateAttachment(a);

    const existing = db.prepare(
      `SELECT id FROM user_claimants WHERE user_id = ? AND claimant_id = ?`
    ).get(userId, a.claimant_id);
    if (existing) throw conflict('user already attached to this claimant', { user_claimant_id: existing.id });

    const created = insertAttachment(userId, a, req.user.id);
    res.status(201).json(created);
  } catch (e) { next(e); }
});

export default router;
