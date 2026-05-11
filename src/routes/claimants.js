import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

const router = Router();
router.use(requireAuth, requireAdmin);

function getClaimantOrThrow(id) {
  const c = db.prepare(`SELECT * FROM claimants WHERE id = ?`).get(id);
  if (!c) throw notFound('claimant not found');
  return c;
}

router.get('/', (_req, res) => {
  const items = db.prepare(`SELECT * FROM claimants ORDER BY id`).all();
  res.json({ items });
});

router.post('/', (req, res, next) => {
  try {
    const {
      legal_name,
      business_number,
      fiscal_year_end_month,
      fiscal_year_end_day,
      reporting_currency = 'CAD',
      sred_method,
    } = req.body ?? {};

    if (!legal_name || typeof legal_name !== 'string') throw badRequest('legal_name required');
    if (!Number.isInteger(fiscal_year_end_month) || fiscal_year_end_month < 1 || fiscal_year_end_month > 12)
      throw badRequest('fiscal_year_end_month must be an integer 1-12');
    if (!Number.isInteger(fiscal_year_end_day) || fiscal_year_end_day < 1 || fiscal_year_end_day > 31)
      throw badRequest('fiscal_year_end_day must be an integer 1-31');
    if (!['proxy', 'traditional'].includes(sred_method))
      throw badRequest('sred_method must be "proxy" or "traditional"');

    const info = db.prepare(`
      INSERT INTO claimants
        (legal_name, business_number, fiscal_year_end_month, fiscal_year_end_day,
         reporting_currency, sred_method)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      legal_name,
      business_number ?? null,
      fiscal_year_end_month,
      fiscal_year_end_day,
      reporting_currency,
      sred_method,
    );

    const created = getClaimantOrThrow(info.lastInsertRowid);
    audit(req.user.id, 'create', 'claimant', created.id, undefined, created);
    res.status(201).json(created);
  } catch (e) { next(e); }
});

router.get('/:id', (req, res, next) => {
  try {
    res.json(getClaimantOrThrow(req.params.id));
  } catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const before = getClaimantOrThrow(req.params.id);
    const { legal_name, business_number, reporting_currency, sred_method } = req.body ?? {};

    if (sred_method !== undefined && sred_method !== before.sred_method) {
      throw badRequest('sred_method is locked once set');
    }

    const updates = {};
    if (legal_name !== undefined) updates.legal_name = legal_name;
    if (business_number !== undefined) updates.business_number = business_number;
    if (reporting_currency !== undefined) updates.reporting_currency = reporting_currency;

    const keys = Object.keys(updates);
    if (keys.length === 0) return res.json(before);

    const setClause = keys.map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE claimants SET ${setClause} WHERE id = ?`)
      .run(...keys.map(k => updates[k]), before.id);

    const after = getClaimantOrThrow(before.id);
    audit(req.user.id, 'update', 'claimant', before.id, before, after);
    res.json(after);
  } catch (e) { next(e); }
});

// Nested: list fiscal periods under a claimant
router.get('/:id/periods', (req, res, next) => {
  try {
    const claimant = getClaimantOrThrow(req.params.id);
    const items = db.prepare(
      `SELECT * FROM fiscal_periods WHERE claimant_id = ? ORDER BY start_date DESC`
    ).all(claimant.id);
    res.json({ items });
  } catch (e) { next(e); }
});

// Nested: create a fiscal period under a claimant
router.post('/:id/periods', (req, res, next) => {
  try {
    const claimant = getClaimantOrThrow(req.params.id);
    const { start_date, end_date } = req.body ?? {};
    if (!start_date) throw badRequest('start_date required');
    if (!end_date) throw badRequest('end_date required');
    if (start_date >= end_date) throw badRequest('start_date must be before end_date');

    try {
      const info = db.prepare(`
        INSERT INTO fiscal_periods (claimant_id, start_date, end_date)
        VALUES (?, ?, ?)
      `).run(claimant.id, start_date, end_date);
      const period = db.prepare(`SELECT * FROM fiscal_periods WHERE id = ?`).get(info.lastInsertRowid);
      audit(req.user.id, 'create', 'fiscal_period', period.id, undefined, period);
      res.status(201).json(period);
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw badRequest(`a period starting on ${start_date} already exists for this claimant`);
      }
      throw err;
    }
  } catch (e) { next(e); }
});

// Nested: list projects under a claimant
router.get('/:id/projects', (req, res, next) => {
  try {
    const claimant = getClaimantOrThrow(req.params.id);
    const items = db.prepare(`SELECT * FROM projects WHERE claimant_id = ? ORDER BY id DESC`)
      .all(claimant.id);
    res.json({ items });
  } catch (e) { next(e); }
});

// Nested: create a project under a claimant
router.post('/:id/projects', (req, res, next) => {
  try {
    const claimant = getClaimantOrThrow(req.params.id);
    const {
      title,
      field_of_science,
      start_date,
      end_date,
      status,
      type = 'sred',
      phase = 'concept',
      advancement_sought,
      uncertainties,
      work_performed,
    } = req.body ?? {};

    if (!title || typeof title !== 'string') throw badRequest('title required');
    if (!start_date) throw badRequest('start_date required');
    if (!['planned', 'active', 'completed'].includes(status))
      throw badRequest('status must be planned|active|completed');
    if (!['sred', 'internal'].includes(type))
      throw badRequest('type must be sred|internal');
    if (!['concept', 'development', 'complete'].includes(phase))
      throw badRequest('phase must be concept|development|complete');

    const tx = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO projects
          (claimant_id, title, field_of_science, start_date, end_date, status,
           type, phase, advancement_sought, uncertainties, work_performed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        claimant.id,
        title,
        field_of_science ?? null,
        start_date,
        end_date ?? null,
        status,
        type,
        phase,
        advancement_sought ?? null,
        uncertainties ?? null,
        work_performed ?? null,
      );
      const projectId = info.lastInsertRowid;
      db.prepare(`
        INSERT INTO project_revisions
          (project_id, title, field_of_science, advancement_sought, uncertainties,
           work_performed, type, phase, revised_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId,
        title,
        field_of_science ?? null,
        advancement_sought ?? null,
        uncertainties ?? null,
        work_performed ?? null,
        type,
        phase,
        req.user.id,
      );
      return projectId;
    });

    const projectId = tx();
    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId);
    audit(req.user.id, 'create', 'project', project.id, undefined, project);
    res.status(201).json(project);
  } catch (e) { next(e); }
});

export default router;
