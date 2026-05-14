// Fixture data for the ETC demo: project assignments, ~6-8 weeks of
// labour entries, expenses, and evidence (notes, links, and a few files
// written to UPLOADS_DIR).
//
// Idempotent: bails out if any of the ETC projects already have labour
// entries. To reseed, delete those rows first or drop the DB.

import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.js';
import { config } from '../config.js';

// Deterministic PRNG so the fixtures are reproducible.
function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260511);
const pick = arr => arr[Math.floor(rand() * arr.length)];

const projId = (titlePrefix) =>
  db.prepare(`SELECT id FROM projects WHERE title LIKE ?`).get(`${titlePrefix}%`)?.id;

const ET_GROW   = projId('ET Grow');
const ET_FUSION = projId('ET Fusion');
const NWIC      = projId('NWIC');
const FIELD     = projId('Field tech');
const ALL_PROJECTS = [ET_GROW, ET_FUSION, NWIC, FIELD];
if (!ALL_PROJECTS.every(Boolean)) {
  console.error('ETC projects not found. Run "npm run seed:etc" first.');
  process.exit(1);
}

const CLAIMANT_ID = 1;

// Idempotency: bail out before doing any further lookups if labour already
// exists on the ETC projects.
const existing = db.prepare(
  `SELECT COUNT(*) AS n FROM labour_entries WHERE project_id IN (?, ?, ?, ?)`
).get(...ALL_PROJECTS).n;
if (existing > 0) {
  console.log(`Already seeded (${existing} labour entries on ETC projects). Skipping.`);
  process.exit(0);
}

// --- Fiscal period ----------------------------------------------------------
// Pick the earliest fiscal period for the ETC claimant. seed:etc creates one.
const periodRow = db.prepare(
  `SELECT id FROM fiscal_periods WHERE claimant_id = ? ORDER BY start_date LIMIT 1`
).get(CLAIMANT_ID);
if (!periodRow) {
  console.error('No fiscal period found for claimant #1. Run "npm run seed:etc" first.');
  process.exit(1);
}
const PERIOD_ID = periodRow.id;

// --- Admin user -------------------------------------------------------------
// Don't assume id=1; look up the earliest active admin instead.
const adminRow = db.prepare(
  `SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1`
).get();
if (!adminRow) {
  console.error('No active admin user found. Run "npm run seed:admin" first.');
  process.exit(1);
}
const ADMIN_USER_ID = adminRow.id;

// --- Employee user_claimants (looked up by email) ---------------------------
// These emails must match what seed:etc inserts. If any are missing (e.g. a
// user was deleted through the UI), exit with a useful error rather than a
// cryptic FK violation later.
const EMPLOYEE_EMAILS = {
  ALICE:   'alice@etcweb.com',
  CHARLIE: 'charlie@etcweb.com',
  BRAM:    'bram@etcweb.com',
  DANA:    'dana@etcweb.com',
};

const userByEmail = db.prepare(`SELECT id FROM users WHERE email = ?`);
const ucByUser = db.prepare(
  `SELECT id FROM user_claimants WHERE user_id = ? AND claimant_id = ?`
);

const UC = {};
const USER_IDS = {};
const missing = [];
for (const [key, email] of Object.entries(EMPLOYEE_EMAILS)) {
  const u = userByEmail.get(email);
  if (!u) { missing.push(`${key} (${email}) — no user row`); continue; }
  const uc = ucByUser.get(u.id, CLAIMANT_ID);
  if (!uc) { missing.push(`${key} (${email}) — user exists but no user_claimants row for claimant ${CLAIMANT_ID}`); continue; }
  UC[key] = uc.id;
  USER_IDS[key] = u.id;
}
if (missing.length) {
  console.error('Required employee(s) missing — run "npm run seed:etc" or recreate via the UI:');
  for (const m of missing) console.error(`  - ${m}`);
  process.exit(1);
}

// active users who can plausibly upload evidence (active employees)
const UPLOADERS = { ALICE: USER_IDS.ALICE, BRAM_E: USER_IDS.BRAM };

// --- Project assignments ----------------------------------------------------

const ASSIGNMENTS = [
  [ET_GROW,   [UC.ALICE,   UC.BRAM]],
  [ET_FUSION, [UC.CHARLIE, UC.BRAM]],
  [NWIC,      [UC.DANA,    UC.ALICE]],
  [FIELD,     [UC.CHARLIE, UC.DANA]],
];

const insAssign = db.prepare(
  `INSERT OR IGNORE INTO project_assignments (project_id, user_claimant_id) VALUES (?, ?)`
);
let assignCount = 0;
for (const [pid, ucs] of ASSIGNMENTS) {
  for (const ucId of ucs) {
    const r = insAssign.run(pid, ucId);
    if (r.changes) assignCount++;
  }
}
console.log(`assigned employees to projects: ${assignCount} new rows`);

// --- Labour-entry descriptions per project ----------------------------------

const DESCRIPTIONS = {
  [ET_GROW]: [
    'Feature engineering on greenhouse telemetry — humidity moving averages',
    'Backtested ensemble model against 2024 cucumber-yield data',
    'Investigated masked-attention for imputation under bursty sensor loss',
    'Pair programming on the training loop; captured baseline accuracy',
    'Reviewed cultivar metadata schema; documented edge cases for cold-start',
    'Set up MLflow experiment tracking; ran first 30 experiments',
    'Compared GBDT vs RNN on weather-only features',
    'Investigated per-tunnel temperature drift; logged data inconsistencies',
    'Wrote up cold-start cultivar problem for technical lead',
    'Cross-validated forecasts against partner growers in Beamsville',
  ],
  [ET_FUSION]: [
    'Flink job for topology inference — 5min sliding window prototype',
    'Profiled deduplication layer at 10K events/sec; found memory leak',
    'Wrote integration test against partner utility incident corpus',
    'Pair debug: false-positive analysis on cascading PoE failures',
    'Sketched alternative causality heuristic — temporal-only baseline',
    'Implemented Kafka source connector with at-least-once semantics',
    'Reproduced operational outage from Mar 2025 against current pipeline',
    'Documented topology-inference design tradeoffs for arch review',
    'Tuned watermarking strategy for late-arriving events',
  ],
  [NWIC]: [
    'Tested drift-aware DRR scheduler against synthetic peak-hour load',
    'Captured Niagara region peak-hour traffic for replay analysis',
    'Implemented online capacity estimator using EWMA over RTT',
    'Field visit to Smithville test site — measured signal stability',
    'Compared EDF hybrid vs DRR fairness metrics',
    'Reviewed customer complaint logs to find oscillation cases',
    'Wrote A/B test harness for scheduler comparison',
    'Investigated TCP unfairness during atmospheric ducting events',
  ],
  [FIELD]: [
    'Property-based tests for CRDT convergence over 8h offline windows',
    'Profiled merge cost on Pixel 6a — found O(n²) hotspot',
    'Designed conflict resolution UI mockups for hierarchical inventory',
    'Code review on tree-CRDT move semantics',
    'Reproduced inventory merge bug from customer report',
    'Wrote IndexedDB persistence layer with delta-state ORMap',
    'Spike: WASM-compiled merge function for hot path',
    'Investigated battery impact of background sync',
  ],
};

const REJECTION_REASONS = [
  'Description too vague — please specify which experiment run.',
  'Looks like this duplicates last week\'s entry; combine and resubmit.',
  'Hours seem high for the described work; can you break it down?',
];

// --- Labour insert ----------------------------------------------------------

const insLabour = db.prepare(`
  INSERT INTO labour_entries
    (project_id, user_claimant_id, fiscal_period_id, work_date, hours, description,
     status, reviewed_by_user_id, reviewed_at, rejection_reason)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const localDate = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const today = new Date();
today.setHours(12, 0, 0, 0);
const thisMonday = new Date(today);
{
  const dow = today.getDay();
  thisMonday.setDate(today.getDate() + (dow === 0 ? -6 : 1 - dow));
}

const NUM_WEEKS_BACK = 7;
let labourCount = 0;

for (let weekOffset = 0; weekOffset < NUM_WEEKS_BACK; weekOffset++) {
  for (let dow = 0; dow < 7; dow++) {
    const d = new Date(thisMonday);
    d.setDate(thisMonday.getDate() - weekOffset * 7 + dow);
    if (d > today) continue;   // no future dates

    const dateStr = localDate(d);
    const isWeekend = dow === 5 || dow === 6;
    const isThisWeek = weekOffset === 0;

    for (const [pid, ucs] of ASSIGNMENTS) {
      for (const ucId of ucs) {
        // probability of working today on this project
        const p = isThisWeek
          ? (isWeekend ? 0.05 : 0.85)            // this week is busy — chart-pop
          : (isWeekend ? 0.08 : 0.55);
        if (rand() > p) continue;

        const hours = isWeekend
          ? Math.round((1 + rand() * 3) * 4) / 4
          : Math.round((2 + rand() * 5) * 4) / 4;

        const desc = pick(DESCRIPTIONS[pid]);

        // Status mix: older weeks mostly approved; recent days mostly pending.
        let status;
        if (isThisWeek)         status = rand() < 0.7 ? 'pending'  : 'approved';
        else if (weekOffset === 1) status = rand() < 0.4 ? 'pending'  : 'approved';
        else                    status = rand() < 0.92 ? 'approved' : pick(['pending', 'rejected']);

        const reviewedAt = status !== 'pending'
          ? localDate(new Date(d.getTime() + 86400000 * 2)) + ' 12:00:00'
          : null;
        const reviewedBy = status !== 'pending' ? ADMIN_USER_ID : null;
        const rejectReason = status === 'rejected' ? pick(REJECTION_REASONS) : null;

        insLabour.run(pid, ucId, PERIOD_ID, dateStr, hours, desc,
                      status, reviewedBy, reviewedAt, rejectReason);
        labourCount++;
      }
    }
  }
}
console.log(`inserted ${labourCount} labour entries`);

// --- Expenses ---------------------------------------------------------------

const EXPENSES = [
  // [project,   uc,         date,         category,            cents, currency, fx,    description,                                                          status]
  [ET_GROW,    UC.ALICE,   '2026-02-15', 'material',            12500, 'CAD', null, 'Greenhouse soil-moisture sensor kit (Atlas Scientific)',               'approved'],
  [ET_GROW,    UC.BRAM,    '2026-03-22', 'material',            84000, 'CAD', null, 'GPU compute credits for ML training (RunPod, Mar)',                    'approved'],
  [ET_GROW,    UC.ALICE,   '2026-04-08', 'contract',           350000, 'CAD', null, 'Dr. Patel — agronomy consulting (Q1 invoice)',                         'approved'],
  [ET_FUSION,  UC.CHARLIE, '2026-02-28', 'contract',           480000, 'USD', 1.36, 'Acme Streaming Inc — Flink/streaming systems consulting (Feb)',        'approved'],
  [ET_FUSION,  UC.BRAM,    '2026-03-12', 'material',            22000, 'CAD', null, 'Test cluster — 3x Hetzner AX102 dedicated nodes (Mar)',                'approved'],
  [ET_FUSION,  UC.CHARLIE, '2026-04-20', 'third_party_payment',150000, 'CAD', null, 'University of Waterloo — incident corpus license (FY26)',              'approved'],
  [NWIC,       UC.DANA,    '2026-01-30', 'material',            65000, 'CAD', null, '8x Ubiquiti AirFiber 24 radios for Smithville testbed',                'approved'],
  [NWIC,       UC.ALICE,   '2026-03-05', 'material',            14200, 'CAD', null, 'Spectrum analyzer rental (Feb)',                                       'approved'],
  [NWIC,       UC.DANA,    '2026-04-15', 'third_party_payment', 95000, 'CAD', null, 'CRC certification — new firmware revision',                            'pending'],
  [FIELD,      UC.CHARLIE, '2026-02-10', 'material',            42000, 'CAD', null, '6x mid-range Android test devices',                                    'approved'],
  [FIELD,      UC.DANA,    '2026-03-25', 'contract',           280000, 'CAD', null, 'Mobile-UX consultant — offline-first workshop',                        'approved'],
  [FIELD,      UC.CHARLIE, '2026-04-30', 'contract',           145000, 'CAD', null, 'CRDT specialist code review',                                          'pending'],
];

const insExpense = db.prepare(`
  INSERT INTO expenses
    (project_id, user_claimant_id, fiscal_period_id, expense_date, category,
     amount_cents, currency, fx_rate, description, status, reviewed_by_user_id, reviewed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let expenseCount = 0;
for (const [pid, ucId, date, cat, cents, curr, fx, desc, status] of EXPENSES) {
  const reviewedAt = status === 'approved' ? `${date} 12:00:00` : null;
  const reviewedBy = status === 'approved' ? ADMIN_USER_ID : null;
  insExpense.run(pid, ucId, PERIOD_ID, date, cat, cents, curr, fx, desc, status, reviewedBy, reviewedAt);
  expenseCount++;
}
console.log(`inserted ${expenseCount} expenses`);

// --- Evidence ---------------------------------------------------------------

const insEvidence = db.prepare(`
  INSERT INTO evidence_items
    (project_id, fiscal_period_id, uploaded_by_user_id, labour_entry_id, expense_id,
     kind, caption, evidence_date, file_path, file_size, file_mime, url, note_text)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const NOTES_AND_LINKS = [
  [ET_GROW,   UPLOADERS.ALICE,  'note', 'Baseline MAE @ 2.3 days',                      '2026-03-15', null,
   'Initial ensemble reaches 2.3-day MAE on the 2024 holdout. Target is ±48h, currently ±55h. Next: investigate weather-feature noise.'],
  [ET_GROW,   UPLOADERS.BRAM_E, 'link', 'Internal commit — feature engineering',         '2026-04-02', 'https://git.etcweb.com/et-grow/-/commit/feat-humidity-moving-avg-3f8a2b1c', null],
  [ET_FUSION, UPLOADERS.BRAM_E, 'note', 'Memory leak hypothesis',                        '2026-03-25', null,
   'Dedup layer leaks ~30MB/hr at 10K events/sec. Suspect: TtlMap.evict() not called on partition rebalance. Reproduced in local test cluster.'],
  [ET_FUSION, UPLOADERS.BRAM_E, 'link', 'Flink Jira ticket on watermark behaviour',      '2026-04-12', 'https://issues.apache.org/jira/browse/FLINK-30142', null],
  [NWIC,      UPLOADERS.ALICE,  'note', 'Atmospheric ducting case study',                '2026-03-08', null,
   'Ducting event Mar 4 caused 47% throughput drop for 3 cells. Standard DRR oscillated 5x in 30s; drift-aware variant held within 8% of fair share. pcap captured for offline replay.'],
  [NWIC,      UPLOADERS.ALICE,  'link', 'Customer outage report — pre-fix',              '2026-04-22', 'https://wiki.etcweb.com/nwic/incidents/2026-04-21-smithville-mesh-outage', null],
  [FIELD,     UPLOADERS.BRAM_E, 'note', 'Battery measurement methodology',               '2026-04-05', null,
   'Used Battery Historian on Pixel 6a baseline. Background sync = +6% drain over 8h vs control. Need to investigate radio wake patterns.'],
  [FIELD,     UPLOADERS.BRAM_E, 'link', 'CRDT research paper used as reference',         '2026-04-18', 'https://martin.kleppmann.com/2020/04/27/move-operation-in-crdt.html', null],
];

let evidenceCount = 0;
for (const [pid, userId, kind, caption, date, url, note] of NOTES_AND_LINKS) {
  insEvidence.run(pid, PERIOD_ID, userId, null, null, kind, caption, date, null, null, null, url, note);
  evidenceCount++;
}

// Files written to UPLOADS_DIR
const FIXTURE_FILES = [
  [ET_GROW,   UPLOADERS.ALICE,  'Pilot greenhouse layout',                    '2026-02-22', 'fixture-pilot-greenhouse-layout.txt',
   'Pilot Greenhouse #3 — Beamsville\n\n40m × 12m hydroponic, 6 tunnels.\nSensors deployed: temp (12), humidity (12), CO2 (4), PAR (8).\nTelemetry @ 30s intervals via LoRaWAN gateway.\nDataset coverage: Jan 8 → Mar 22, 2026 (uninterrupted).\n'],
  [ET_FUSION, UPLOADERS.BRAM_E, 'Latency benchmark — 10K events/sec',          '2026-04-10', 'fixture-fusion-bench-10k.txt',
   'Benchmark run: 2026-04-10\nCluster: 3× Hetzner AX102 (16 cores, 64GB)\nLoad: 10,000 events/sec synthetic\np50: 47ms   p95: 184ms   p99: 412ms\nMemory: 4.2GB stable\nNotes: dedup layer steady up to 8h; see leak hypothesis note.\n'],
  [NWIC,      UPLOADERS.ALICE,  'Smithville site visit notes',                 '2026-03-15', 'fixture-smithville-site-visit.txt',
   'Site visit Mar 8-9 — Smithville testbed (rural mesh)\n  - Tower A: 24GHz dish alignment (good LoS to Tower B)\n  - Tower B: standalone 6m mast, batteries on south side\n  - 4 customer endpoints: range 0.8-2.4km from nearest tower\nWeather during visit: clear, 8°C, low humidity.\n'],
];

fs.mkdirSync(config.uploadsDir, { recursive: true });
for (const [pid, userId, caption, date, fileName, contents] of FIXTURE_FILES) {
  const fullPath = path.join(config.uploadsDir, fileName);
  fs.writeFileSync(fullPath, contents);
  const size = fs.statSync(fullPath).size;
  insEvidence.run(pid, PERIOD_ID, userId, null, null, 'file', caption, date,
                  fileName, size, 'text/plain', null, null);
  evidenceCount++;
}
console.log(`inserted ${evidenceCount} evidence items (${FIXTURE_FILES.length} with files written)`);

console.log('\ndone.');
