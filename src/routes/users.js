import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { mintEmailToken, buildMagicLink } from '../auth/tokens.js';
import { sendMagicLink } from '../lib/email.js';

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
  validateCompensation(a.compensation);
}

function loadUserBundle(userId) {
  const user = db.prepare(
    `SELECT id, email, name, role, status, created_at FROM users WHERE id = ?`
  ).get(userId);
  if (!user) throw notFound('user not found');
  const attachments = db.prepare(`
    SELECT uc.id, uc.claimant_id, c.legal_name AS claimant_name,
           uc.title, uc.is_specified_employee, uc.status, uc.created_at
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
  return { ...user, attachments };
}

function insertAttachment(userId, a, actorUserId) {
  const ucInfo = db.prepare(`
    INSERT INTO user_claimants (user_id, claimant_id, title, is_specified_employee)
    VALUES (?, ?, ?, ?)
  `).run(userId, a.claimant_id, a.title ?? null, a.is_specified_employee ? 1 : 0);
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
  const { role, status, claimant_id } = req.query;
  const where = [];
  const params = [];
  if (role) {
    const roles = String(role).split(',').filter(Boolean);
    where.push(`u.role IN (${roles.map(() => '?').join(',')})`);
    params.push(...roles);
  }
  if (status)      { where.push('u.status = ?');       params.push(status); }
  if (claimant_id) { where.push('uc.claimant_id = ?'); params.push(Number(claimant_id)); }
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

    const tx = db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO users (email, name, role, status) VALUES (?, ?, ?, 'pending')`
      ).run(email, name, role);
      const userId = info.lastInsertRowid;
      for (const a of attachments) insertAttachment(userId, a, req.user.id);
      return userId;
    });

    const userId = tx();
    const fresh = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
    audit(req.user.id, 'create', 'user', userId, undefined, fresh);

    res.status(201).json(loadUserBundle(userId));
  } catch (e) { next(e); }
});

router.get('/:id', (req, res, next) => {
  try { res.json(loadUserBundle(Number(req.params.id))); }
  catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const before = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
    if (!before) throw notFound('user not found');

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

    const setClause = keys.map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE users SET ${setClause} WHERE id = ?`).run(...keys.map(k => updates[k]), userId);

    const after = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
    audit(req.user.id, 'update', 'user', userId, before, after);
    res.json(loadUserBundle(userId));
  } catch (e) { next(e); }
});

router.post('/:id/deactivate', (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const before = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
    if (!before) throw notFound('user not found');
    if (before.id === req.user.id) throw badRequest("you can't deactivate your own account");
    if (before.status === 'disabled') return res.json(before);

    const tx = db.transaction(() => {
      db.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(userId);
      db.prepare(`UPDATE user_claimants SET status = 'inactive' WHERE user_id = ?`).run(userId);
    });
    tx();

    const after = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
    audit(req.user.id, 'deactivate', 'user', userId, before, after);
    res.json(after);
  } catch (e) { next(e); }
});

router.post('/:id/reactivate', (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const before = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
    if (!before) throw notFound('user not found');
    if (before.status === 'active') return res.json(before);

    db.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).run(userId);

    const after = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
    audit(req.user.id, 'reactivate', 'user', userId, before, after);
    res.json(after);
  } catch (e) { next(e); }
});

router.post('/:id/invite', (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const user = db.prepare(`SELECT id, email, name, status FROM users WHERE id = ?`).get(userId);
    if (!user) throw notFound('user not found');
    if (user.status === 'disabled') throw badRequest('user is disabled');

    const purpose = user.status === 'pending' ? 'invite' : 'add_device';
    const { raw, expiresAt } = mintEmailToken(user.id, purpose);
    const magicLink = buildMagicLink(raw);
    sendMagicLink({ to: user.email, name: user.name, purpose, link: magicLink })
      .catch(err => console.warn('[invite] email send error:', err));

    audit(req.user.id, purpose, 'user', user.id);
    res.json({ user_id: user.id, purpose, magic_link: magicLink, expires_at: expiresAt });
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
