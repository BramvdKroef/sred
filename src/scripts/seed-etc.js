// Seed Extreme Technology Corporation as claimant #1, the FY2026 fiscal
// period, four ETC employees (Alice, Charlie, Bram, Dana) with
// compensation rows, and a few fixture projects that match their real
// lines of business (ET Grow for greenhouses, ET Fusion for ISPs/utilities,
// NWIC for rural ISP). Narratives are written as plausible SR&ED claims
// with technological advancement, uncertainty, and work-performed sections.
//
// Idempotent: creates anything missing, leaves existing rows alone.
// Designed to run after seed:admin on a fresh DB so that the IDs line up
// with what seed:data expects (admin user #1; employees #2-5;
// user_claimants #1-4 in Alice/Charlie/Bram/Dana order).

import { db } from '../db/index.js';

const CLAIMANT_ID = 1;
const CLAIMANT_NAME = 'Extreme Technology Corp';

const PROJECTS = [
  {
    title: 'ET Grow — Yield-forecast ML pipeline',
    field_of_science: 'Computer science / Machine learning',
    advancement_sought:
      'A yield-forecasting model that fuses greenhouse environmental telemetry with regional weather inputs ' +
      'to predict harvest dates within ±48 hours for novel cultivars where no prior production history exists.',
    uncertainties:
      'No published technique cleanly handles the cold-start problem of new cultivars while remaining robust ' +
      'to bursty missing-sensor data; existing ensemble approaches degrade non-linearly when more than 25% of ' +
      'training inputs are imputed.',
    work_performed:
      'Built a hybrid architecture (gradient-boosted trees over telemetry-derived features + RNN over weather ' +
      'sequences); iterated on imputation strategies (last-known, forward-filled, masked-attention); measured ' +
      'prediction error across three pilot greenhouses in the Niagara region.',
  },
  {
    title: 'ET Fusion — Streaming service-impact correlation engine',
    field_of_science: 'Computer science / Distributed systems',
    advancement_sought:
      'Sub-second correlation of ISP equipment events with customer-visible outages across a multi-tenant ' +
      'utility deployment, supporting both temporal and topological inference without an externally-maintained ' +
      'dependency graph.',
    uncertainties:
      'Existing event-correlation engines either require a manually-curated topology (brittle, costly) or use ' +
      'causality heuristics that produce too many false positives at scale. Whether streaming graph inference ' +
      'can converge fast enough to be operationally useful is unproven.',
    work_performed:
      'Designed a Flink-based pipeline that derives topology from packet-level metadata in a five-minute sliding ' +
      'window; prototyped a deduplication layer; measured precision/recall against a labelled incident corpus ' +
      'supplied by a partner utility.',
  },
  {
    title: 'NWIC — Adaptive shaping for rural wireless mesh',
    field_of_science: 'Engineering / Wireless networking',
    advancement_sought:
      'A bandwidth-shaping algorithm for rural fixed-wireless mesh nodes that maintains fairness across ' +
      'customers when the backhaul itself varies (atmospheric ducting, line-of-sight obstructions) and node ' +
      'count changes daily as new customers come online.',
    uncertainties:
      'Standard fair-queueing assumes a stable upstream capacity. Whether a token-bucket variant with online ' +
      'capacity estimation can converge under correlated churn is an open question — preliminary trials ' +
      'oscillated under high load.',
    work_performed:
      'Implemented two scheduler variants (drift-aware DRR and a deadline-based EDF hybrid); instrumented a ' +
      'small testbed in the Niagara region; ran A/B comparisons during peak evening hours.',
  },
  {
    title: 'Field tech mobile app — offline-first sync engine',
    field_of_science: 'Computer science / Software engineering',
    advancement_sought:
      'A conflict-free synchronisation layer for the field-technician mobile app that lets technicians work ' +
      'through full-day disconnections in cellular dead zones and merge inventory, work-order, and time-log ' +
      'changes deterministically when reconnected.',
    uncertainties:
      'Off-the-shelf CRDT libraries cover counters and last-writer-wins maps, but the hierarchical inventory ' +
      'and shared work-order semantics required here don\'t map onto any single published CRDT. Whether a ' +
      'composite scheme converges to operator-meaningful state after long partitions is an open question.',
    work_performed:
      'Prototyped two CRDT compositions (move-aware tree + delta-state ORMap); ran property-based tests for ' +
      'convergence across simulated 8-hour offline windows; profiled merge cost on mid-range Android devices.',
  },
];

const claimant = db.prepare('SELECT id, legal_name FROM claimants WHERE id = ?').get(CLAIMANT_ID);
if (!claimant) {
  db.prepare(`
    INSERT INTO claimants
      (id, legal_name, fiscal_year_end_month, fiscal_year_end_day, sred_method)
    VALUES (?, ?, 12, 31, 'proxy')
  `).run(CLAIMANT_ID, CLAIMANT_NAME);
  console.log(`created claimant ${CLAIMANT_ID}: "${CLAIMANT_NAME}"`);
} else if (claimant.legal_name !== CLAIMANT_NAME) {
  db.prepare('UPDATE claimants SET legal_name = ? WHERE id = ?').run(CLAIMANT_NAME, CLAIMANT_ID);
  console.log(`renamed claimant ${CLAIMANT_ID}: "${claimant.legal_name}" → "${CLAIMANT_NAME}"`);
} else {
  console.log(`claimant ${CLAIMANT_ID} already named "${CLAIMANT_NAME}"`);
}

// --- Fiscal period ----------------------------------------------------------

const period = db.prepare(
  `SELECT id FROM fiscal_periods WHERE claimant_id = ? AND start_date = ?`
).get(CLAIMANT_ID, '2026-01-01');
if (!period) {
  db.prepare(`
    INSERT INTO fiscal_periods (claimant_id, start_date, end_date, status)
    VALUES (?, '2026-01-01', '2026-12-31', 'open')
  `).run(CLAIMANT_ID);
  console.log(`created fiscal period 2026-01-01 → 2026-12-31`);
} else {
  console.log(`fiscal period 2026-01-01 → 2026-12-31 already exists`);
}

// --- Employees + user_claimants + compensation ------------------------------

const EMPLOYEES = [
  { email: 'alice@etcweb.com',   name: 'Alice Tremblay',  title: 'ML engineer',         specified: 0, comp: { type: 'salary', cents: 11_500_000 } },
  { email: 'charlie@etcweb.com', name: 'Charlie Nguyen',  title: 'Distributed systems', specified: 0, comp: { type: 'salary', cents: 13_200_000 } },
  { email: 'bram@etcweb.com',    name: 'Bram Employee',   title: 'Founding engineer',   specified: 1, comp: { type: 'salary', cents: 18_000_000 } },
  { email: 'dana@etcweb.com',    name: 'Dana Park',       title: 'Network engineer',    specified: 0, comp: { type: 'salary', cents: 12_400_000 } },
];

let empCreated = 0;
for (const e of EMPLOYEES) {
  let user = db.prepare(`SELECT id FROM users WHERE email = ?`).get(e.email);
  if (!user) {
    const info = db.prepare(
      `INSERT INTO users (email, name, role, status) VALUES (?, ?, 'employee', 'active')`
    ).run(e.email, e.name);
    user = { id: info.lastInsertRowid };
    empCreated++;
  }
  let uc = db.prepare(
    `SELECT id FROM user_claimants WHERE user_id = ? AND claimant_id = ?`
  ).get(user.id, CLAIMANT_ID);
  if (!uc) {
    const info = db.prepare(`
      INSERT INTO user_claimants (user_id, claimant_id, title, is_specified_employee)
      VALUES (?, ?, ?, ?)
    `).run(user.id, CLAIMANT_ID, e.title, e.specified);
    uc = { id: info.lastInsertRowid };
  }
  const hasComp = db.prepare(
    `SELECT 1 FROM compensation_rows WHERE user_claimant_id = ?`
  ).get(uc.id);
  if (!hasComp) {
    db.prepare(`
      INSERT INTO compensation_rows
        (user_claimant_id, comp_type, amount_cents, hours_per_year, effective_from)
      VALUES (?, ?, ?, 2080, '2026-01-01')
    `).run(uc.id, e.comp.type, e.comp.cents);
  }
}
console.log(`employees: ${empCreated} new, ${EMPLOYEES.length - empCreated} existing`);

// --- Projects ---------------------------------------------------------------

let created = 0, skipped = 0;
for (const p of PROJECTS) {
  const existing = db.prepare(
    'SELECT id FROM projects WHERE claimant_id = ? AND title = ?'
  ).get(CLAIMANT_ID, p.title);
  if (existing) {
    // Make sure existing fixture projects have the expected type and status.
    db.prepare(
      "UPDATE projects SET type = 'sred', status = 'development' WHERE id = ?"
    ).run(existing.id);
    console.log(`  skip (exists): ${p.title}`);
    skipped++;
    continue;
  }
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO projects
        (claimant_id, title, field_of_science, start_date, status, type,
         advancement_sought, uncertainties, work_performed)
      VALUES (?, ?, ?, '2026-01-01', 'development', 'sred', ?, ?, ?)
    `).run(CLAIMANT_ID, p.title, p.field_of_science, p.advancement_sought, p.uncertainties, p.work_performed);
    db.prepare(`
      INSERT INTO project_revisions
        (project_id, title, field_of_science, advancement_sought, uncertainties, work_performed, type, revised_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, 'sred', 1)
    `).run(info.lastInsertRowid, p.title, p.field_of_science, p.advancement_sought, p.uncertainties, p.work_performed);
  });
  tx();
  console.log(`  + created: ${p.title}`);
  created++;
}

console.log(`\n${created} created, ${skipped} skipped.`);
