import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { requireAuth } from '../auth/middleware.js';
import { badRequest, notFound, forbidden } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { randomToken } from '../lib/random.js';
import { getEvidence, findOpenPeriod } from '../lib/route-helpers.js';

const router = Router();
router.use(requireAuth);

fs.mkdirSync(config.uploadsDir, { recursive: true });

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, config.uploadsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 10);
      cb(null, `${randomToken(16)}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// --- helpers ---------------------------------------------------------------

// Evidence ownership: uploader-or-admin (distinct from labour/expense, which
// scope via user_claimants).
function canSee(user, evidence) {
  return user.role === 'admin' || evidence.uploaded_by_user_id === user.id;
}

// Reject link URLs that aren't http/https/mailto — `javascript:`, `data:`,
// and `vbscript:` would otherwise survive client-side esc() and be clickable
// script execution in an admin's session.
function validateLinkUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { throw badRequest('url is malformed'); }
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
    throw badRequest('url must use http, https, or mailto scheme');
  }
  return parsed.href;
}

function assertAttached(user, claimantId) {
  if (user.role === 'admin') return;
  const uc = db.prepare(
    `SELECT id FROM user_claimants WHERE user_id = ? AND claimant_id = ? AND status = 'active'`
  ).get(user.id, claimantId);
  if (!uc) throw forbidden('you are not attached to this claimant');
}

// --- routes ----------------------------------------------------------------

router.get('/', (req, res, next) => {
  try {
    const { project_id, period_id, labour_entry_id, expense_id } = req.query;
    const where = [];
    const params = [];
    if (project_id)      { where.push('ei.project_id = ?');       params.push(Number(project_id)); }
    if (period_id)       { where.push('ei.fiscal_period_id = ?'); params.push(Number(period_id)); }
    if (labour_entry_id) { where.push('ei.labour_entry_id = ?');  params.push(Number(labour_entry_id)); }
    if (expense_id)      { where.push('ei.expense_id = ?');       params.push(Number(expense_id)); }
    if (req.user.role !== 'admin') {
      where.push('ei.uploaded_by_user_id = ?');
      params.push(req.user.id);
    }
    const sql = `
      SELECT ei.* FROM evidence_items ei
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY ei.evidence_date DESC, ei.id DESC
    `;
    res.json({ items: db.prepare(sql).all(...params) });
  } catch (e) { next(e); }
});

router.post('/', upload.single('file'), (req, res, next) => {
  try {
    const body = req.body ?? {};
    const projectId      = Number(body.project_id);
    const kind           = body.kind;
    const caption        = body.caption;
    const evidenceDate   = body.evidence_date;
    const labourEntryId  = body.labour_entry_id ? Number(body.labour_entry_id) : null;
    const expenseId      = body.expense_id ? Number(body.expense_id) : null;
    const linkUrl        = body.url;
    const noteText       = body.note_text;

    if (!Number.isInteger(projectId)) throw badRequest('project_id required');
    if (!['file', 'link', 'note'].includes(kind)) throw badRequest('kind must be file|link|note');
    if (!caption) throw badRequest('caption required');
    if (!evidenceDate) throw badRequest('evidence_date required');
    if (labourEntryId && expenseId) throw badRequest('attach to a labour entry OR an expense, not both');

    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId);
    if (!project) throw notFound('project not found');
    assertAttached(req.user, project.claimant_id);

    // Derive fiscal_period_id: from parent labour entry / expense if linked, else infer from date.
    let fiscalPeriodId;
    if (labourEntryId) {
      const le = db.prepare(`SELECT * FROM labour_entries WHERE id = ?`).get(labourEntryId);
      if (!le) throw notFound('labour_entry not found');
      if (le.project_id !== project.id) throw badRequest('labour_entry is not on this project');
      fiscalPeriodId = le.fiscal_period_id;
    } else if (expenseId) {
      const ex = db.prepare(`SELECT * FROM expenses WHERE id = ?`).get(expenseId);
      if (!ex) throw notFound('expense not found');
      if (ex.project_id !== project.id) throw badRequest('expense is not on this project');
      fiscalPeriodId = ex.fiscal_period_id;
    } else {
      fiscalPeriodId = findOpenPeriod(project.claimant_id, evidenceDate).id;
    }

    let filePath = null, fileSize = null, fileMime = null, urlVal = null, noteVal = null;
    if (kind === 'file') {
      if (!req.file) throw badRequest('multipart file upload required when kind=file');
      filePath = req.file.filename;
      fileSize = req.file.size;
      fileMime = req.file.mimetype;
    } else if (kind === 'link') {
      if (!linkUrl) throw badRequest('url required when kind=link');
      urlVal = validateLinkUrl(linkUrl);
    } else {
      if (!noteText) throw badRequest('note_text required when kind=note');
      noteVal = noteText;
    }

    const info = db.prepare(`
      INSERT INTO evidence_items
        (project_id, fiscal_period_id, uploaded_by_user_id, labour_entry_id, expense_id,
         kind, caption, evidence_date, file_path, file_size, file_mime, url, note_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      project.id, fiscalPeriodId, req.user.id,
      labourEntryId, expenseId,
      kind, caption, evidenceDate,
      filePath, fileSize, fileMime, urlVal, noteVal,
    );

    const created = getEvidence(info.lastInsertRowid);
    audit(req.user.id, 'create', 'evidence_item', created.id, undefined, created);
    res.status(201).json(created);
  } catch (e) {
    // Clean up the uploaded file if validation rejected the request.
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    next(e);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    const e = getEvidence(req.params.id);
    if (!canSee(req.user, e)) throw forbidden();
    res.json(e);
  } catch (e) { next(e); }
});

router.get('/:id/download', (req, res, next) => {
  try {
    const evidence = getEvidence(req.params.id);
    if (!canSee(req.user, evidence)) throw forbidden();
    if (evidence.kind !== 'file' || !evidence.file_path) {
      throw badRequest('evidence is not a file');
    }
    const filePath = path.join(config.uploadsDir, path.basename(evidence.file_path));
    res.download(filePath, evidence.file_path);
  } catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const before = getEvidence(req.params.id);
    if (!canSee(req.user, before)) throw forbidden();
    const period = db.prepare(`SELECT status FROM fiscal_periods WHERE id = ?`).get(before.fiscal_period_id);
    if (period?.status === 'closed') throw badRequest('fiscal period is closed');

    const { caption, evidence_date, url, note_text } = req.body ?? {};
    const updates = {};
    if (caption !== undefined) {
      if (!caption) throw badRequest('caption cannot be empty');
      updates.caption = caption;
    }
    if (evidence_date !== undefined) updates.evidence_date = evidence_date;
    if (before.kind === 'link' && url !== undefined) {
      if (!url) throw badRequest('url cannot be empty');
      updates.url = validateLinkUrl(url);
    }
    if (before.kind === 'note' && note_text !== undefined) {
      if (!note_text) throw badRequest('note_text cannot be empty');
      updates.note_text = note_text;
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) return res.json(before);

    // Re-bucket the fiscal period if evidence_date moves.
    let newPeriodId = before.fiscal_period_id;
    if (updates.evidence_date && updates.evidence_date !== before.evidence_date) {
      const proj = db.prepare(`SELECT claimant_id FROM projects WHERE id = ?`).get(before.project_id);
      newPeriodId = findOpenPeriod(proj.claimant_id, updates.evidence_date).id;
    }

    const setParts = keys.map(k => `${k} = ?`);
    setParts.push('fiscal_period_id = ?');
    const values = [...keys.map(k => updates[k]), newPeriodId, before.id];
    db.prepare(`UPDATE evidence_items SET ${setParts.join(', ')} WHERE id = ?`).run(...values);

    const after = getEvidence(before.id);
    audit(req.user.id, 'update', 'evidence_item', before.id, before, after);
    res.json(after);
  } catch (e) { next(e); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const before = getEvidence(req.params.id);
    if (!canSee(req.user, before)) throw forbidden();

    // Retention: closing a fiscal period locks all its evidence. Open periods are mutable.
    // (Strict 6-year clock lives in the closed-period state; reopen by admin is the only way back.)
    const period = db.prepare(`SELECT status FROM fiscal_periods WHERE id = ?`).get(before.fiscal_period_id);
    if (period?.status === 'closed') {
      throw badRequest('fiscal period is closed; evidence is retained');
    }

    db.prepare(`DELETE FROM evidence_items WHERE id = ?`).run(before.id);
    if (before.kind === 'file' && before.file_path) {
      fs.unlink(path.join(config.uploadsDir, path.basename(before.file_path)), () => {});
    }
    audit(req.user.id, 'delete', 'evidence_item', before.id, before, undefined);
    res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
