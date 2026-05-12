import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { computeT661, snapshotProjectRevisions, collectEvidenceManifest } from '../lib/t661.js';
import { toMarkdown, toCsv, toPdf } from '../lib/format.js';
import { getT661Export } from '../lib/route-helpers.js';

const router = Router();
router.use(requireAuth, requireAdmin);

const BUNDLES_DIR = path.join(config.uploadsDir, '..', 'data', 'bundles');
fs.mkdirSync(BUNDLES_DIR, { recursive: true });

// --- routes ----------------------------------------------------------------

router.get('/', (req, res) => {
  const { claimant_id } = req.query;
  const where = [];
  const params = [];
  if (claimant_id) { where.push('claimant_id = ?'); params.push(Number(claimant_id)); }
  const sql = `
    SELECT id, claimant_id, fiscal_period_id, generated_by_user_id, is_draft,
           bundle_path, generated_at
      FROM t661_exports
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY id DESC
  `;
  res.json({ items: db.prepare(sql).all(...params) });
});

router.post('/t661', (req, res, next) => {
  try {
    const { claimant_id, fiscal_period_id, draft = false } = req.body ?? {};
    if (!Number.isInteger(claimant_id)) throw badRequest('claimant_id required');
    if (!Number.isInteger(fiscal_period_id)) throw badRequest('fiscal_period_id required');

    const claimant = db.prepare(`SELECT * FROM claimants WHERE id = ?`).get(claimant_id);
    if (!claimant) throw notFound('claimant not found');
    const period = db.prepare(`SELECT * FROM fiscal_periods WHERE id = ?`).get(fiscal_period_id);
    if (!period) throw notFound('fiscal period not found');
    if (period.claimant_id !== claimant.id)
      throw badRequest('fiscal period does not belong to claimant');

    const totals = computeT661({ claimant, period });
    const revisions = snapshotProjectRevisions(claimant.id);
    const evidenceManifest = collectEvidenceManifest(claimant.id, period.id);

    const info = db.prepare(`
      INSERT INTO t661_exports
        (claimant_id, fiscal_period_id, generated_by_user_id, is_draft,
         totals_json, project_revisions_json, evidence_manifest_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      claimant.id,
      period.id,
      req.user.id,
      draft ? 1 : 0,
      JSON.stringify(totals),
      JSON.stringify(revisions),
      JSON.stringify(evidenceManifest.map(e => e.id)),
    );

    const exportRow = getExportOrThrow(info.lastInsertRowid);
    audit(req.user.id, 'export_t661', 't661_export', exportRow.id, undefined,
      { claimant_id, fiscal_period_id, is_draft: draft, total_cents: totals.grand_total.total_cents });

    res.status(201).json({ ...exportRow, totals });
  } catch (e) { next(e); }
});

router.get('/:id', (req, res, next) => {
  try {
    const row = getExportOrThrow(req.params.id);
    res.json({
      ...row,
      totals: JSON.parse(row.totals_json),
      project_revisions: JSON.parse(row.project_revisions_json),
      evidence_manifest: JSON.parse(row.evidence_manifest_json ?? '[]'),
    });
  } catch (e) { next(e); }
});

router.get('/:id/download', (req, res, next) => {
  try {
    const row = getExportOrThrow(req.params.id);
    const totals = JSON.parse(row.totals_json);
    const format = (req.query.format ?? 'json').toLowerCase();
    const baseName = `t661-${row.claimant_id}-${row.fiscal_period_id}-${row.id}`;

    if (format === 'json') {
      res.setHeader('content-disposition', `attachment; filename="${baseName}.json"`);
      res.setHeader('content-type', 'application/json');
      res.send(JSON.stringify(totals, null, 2));
    } else if (format === 'csv') {
      res.setHeader('content-disposition', `attachment; filename="${baseName}.csv"`);
      res.setHeader('content-type', 'text/csv');
      res.send(toCsv(totals));
    } else if (format === 'md' || format === 'markdown') {
      res.setHeader('content-disposition', `attachment; filename="${baseName}.md"`);
      res.setHeader('content-type', 'text/markdown');
      res.send(toMarkdown(totals));
    } else if (format === 'pdf') {
      res.setHeader('content-disposition', `attachment; filename="${baseName}.pdf"`);
      res.setHeader('content-type', 'application/pdf');
      toPdf(totals).pipe(res);
    } else {
      throw badRequest('format must be json|csv|md|pdf');
    }
  } catch (e) { next(e); }
});

router.post('/:id/evidence-package', (req, res, next) => {
  try {
    const row = getExportOrThrow(req.params.id);
    if (row.bundle_path) {
      throw conflict('evidence package already built', { bundle_path: row.bundle_path });
    }
    const totals = JSON.parse(row.totals_json);
    const evidenceIds = JSON.parse(row.evidence_manifest_json ?? '[]');
    const evidence = evidenceIds.length
      ? db.prepare(
          `SELECT * FROM evidence_items WHERE id IN (${evidenceIds.map(() => '?').join(',')})`
        ).all(...evidenceIds)
      : [];

    const bundleName = `t661-bundle-${row.claimant_id}-${row.fiscal_period_id}-${row.id}.zip`;
    const bundlePath = path.join(BUNDLES_DIR, bundleName);

    const output = fs.createWriteStream(bundlePath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      db.prepare(`UPDATE t661_exports SET bundle_path = ? WHERE id = ?`).run(bundlePath, row.id);
      audit(req.user.id, 'export_bundle', 't661_export', row.id, undefined,
        { bundle_path: bundlePath, size_bytes: archive.pointer() });
      res.status(201).json({
        bundle_path: bundlePath,
        size_bytes: archive.pointer(),
        evidence_count: evidence.length,
      });
    });
    archive.on('error', err => next(err));
    archive.pipe(output);

    archive.append(JSON.stringify(totals, null, 2), { name: 'export.json' });
    archive.append(toMarkdown(totals), { name: 'summary.md' });

    // Evidence manifest CSV
    const manifestRows = [['id', 'project_id', 'kind', 'caption', 'evidence_date', 'file_path', 'url', 'note_text']];
    for (const e of evidence) {
      manifestRows.push([
        e.id, e.project_id, e.kind, e.caption, e.evidence_date,
        e.file_path ?? '', e.url ?? '', (e.note_text ?? '').replace(/\n/g, ' '),
      ]);
    }
    const csv = manifestRows.map(r => r.map(v => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\n');
    archive.append(csv, { name: 'manifest.csv' });

    // File-kind evidence: include actual files
    for (const e of evidence) {
      if (e.kind === 'file' && e.file_path) {
        const filePath = path.join(config.uploadsDir, path.basename(e.file_path));
        if (fs.existsSync(filePath)) {
          archive.file(filePath, { name: `evidence/${e.id}-${e.file_path}` });
        }
      }
    }

    archive.finalize();
  } catch (e) { next(e); }
});

router.get('/:id/evidence-package', (req, res, next) => {
  try {
    const row = getExportOrThrow(req.params.id);
    if (!row.bundle_path) throw notFound('no bundle built yet; POST first');
    if (!fs.existsSync(row.bundle_path)) throw notFound('bundle file missing on disk');
    res.download(row.bundle_path);
  } catch (e) { next(e); }
});

export default router;
