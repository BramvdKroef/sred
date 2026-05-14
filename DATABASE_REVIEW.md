# Database schema review

_2026-05-14, against branch `worktree-agent-aa3875d963e912ad5`, commit `d533fc3`_

## Summary

The schema is in solid shape: nearly every `INTEGER` semantic FK carries a
`REFERENCES`, the major hot paths on `labour_entries` already have
single-column indexes for `project_id`, `fiscal_period_id`, and
`user_claimant_id`, and the audit-log immutability is enforced at the
trigger layer. The premise that "only `idx_pa_project` and `idx_uc_user`
exist" is out of date — migration 001 already creates ten indexes, and
migration 005 adds two more. The remaining gaps are concentrated in three
places: (a) **`expenses` and `evidence_items` are missing the equivalents
of the `labour_entries` covering set** (a `period_id`-only index on
expenses exists, but `project_id` and `user_claimant_id` on `expenses`
and `expense_id` / `labour_entry_id` on `evidence_items` are unindexed),
(b) **`audit_log` lacks an actor/timestamp index** for the actor-scoped
and date-range filters the admin UI exposes, and (c) **`compensation_rows`
has no index on `user_claimant_id`**, which is the inner-loop lookup in
`t661.js` (one query per labour entry).

- **9 suggested indexes** (5 high-impact, 4 nice-to-have).
- **6 suggested CHECK constraints**.
- **1 FK gap** (`audit_log.entity_id` is intentionally not an FK — it's
  polymorphic — but no other gap was found).

## Suggested indexes (ranked by likely impact)

High impact — t661 export and review-queue hot paths:

1. `CREATE INDEX idx_comp_uc ON compensation_rows(user_claimant_id);`
   `src/lib/t661.js:14` runs `findEffectiveComp` once **per labour
   entry** during a T661 compute. Without this index, every labour
   entry triggers a full scan of `compensation_rows`. For a claimant
   with N labour entries and M comp rows, the export goes from O(N log M)
   to O(N·M). This is the single biggest win on the export path.

2. `CREATE INDEX idx_expense_project ON expenses(project_id);`
   `src/routes/expenses.js:37` and `src/lib/t661.js:122` both filter on
   `expenses.project_id`. The expenses list query already filters on
   project plus period plus user_claimant on every request from the
   review queue. Currently `idx_expense_period` is the only expense
   index — `project_id`-only filters scan.

3. `CREATE INDEX idx_expense_uc ON expenses(user_claimant_id);`
   Same review-queue filter shape as labour, parallel to the existing
   `idx_labour_uc`. The non-admin path in `expenses.js:50` always
   joins through `user_claimants` and adds `uc.user_id = ?`; the planner
   needs to start from `expenses` filtered by `user_claimant_id` to make
   that join cheap.

4. `CREATE INDEX idx_evidence_period ON evidence_items(fiscal_period_id);`
   `src/routes/evidence.js:166` and `src/lib/t661.js:250`
   (`collectEvidenceManifest`) both filter on `ei.fiscal_period_id`. The
   T661 evidence bundle build does this for every export.

5. `CREATE INDEX idx_evidence_labour ON evidence_items(labour_entry_id);`
   and `CREATE INDEX idx_evidence_expense ON evidence_items(expense_id);`
   The evidence list filters by `labour_entry_id` or `expense_id` when
   the UI shows evidence attached to a specific labour/expense row.
   Both columns are nullable; consider partial indexes
   (`WHERE labour_entry_id IS NOT NULL`) to keep them tiny.

Medium impact — audit log:

6. `CREATE INDEX idx_audit_actor ON audit_log(actor_user_id);`
   `src/routes/audit-log.js:43` filters on `actor_user_id` directly. The
   existing `idx_audit_entity (entity_type, entity_id)` doesn't help this
   filter at all. Audit log is the table most likely to grow unboundedly
   over the life of the system.

7. `CREATE INDEX idx_audit_created ON audit_log(created_at);`
   `audit-log.js:44-45` filters on `created_at >= ?` / `<= ?` for date
   ranges, and `ORDER BY al.id DESC` is currently OK only because `id` is
   the PK. A composite `(entity_type, entity_id, id DESC)` would also
   speed the per-entity audit history view; the simpler single-column
   `created_at` is the bigger win for general filtering.

Low impact — narrow but cheap:

8. `CREATE INDEX idx_projects_claimant ON projects(claimant_id);`
   `claimants.js:148` ("list projects under a claimant"), `t661.js:57`
   ("projects for SR&ED export"), and several audit-log subqueries in
   `audit-log.js:24-31` all do `WHERE claimant_id = ?` on `projects`.
   Few projects per claimant typically, so the scan is cheap, but the
   index is free at write time given how rarely projects are created.

9. `CREATE INDEX idx_project_revisions_project ON project_revisions(project_id);`
   `projects.js:135` (project revisions list) and `t661.js:240`
   (snapshot per project) filter on `project_id`. Grows linearly with
   project edits.

Note on text search: `projects.js:33` does `WHERE p.title LIKE ?` with a
leading `%`. No B-tree index can speed up a leading-wildcard `LIKE`, so
adding an index won't help. The admin search uses `LIMIT 20` and the
project table is small, so this is fine as-is; if it ever needs to scale,
move to FTS5.

## Suggested CHECK constraints

These are all currently enforced in the application layer; pulling them
into the schema gives a defense-in-depth boundary if a future route or a
manual SQL fix bypasses validation.

- `CHECK (amount_cents > 0)` on `expenses` and `compensation_rows`.
  Both routes (`expenses.js:18-21`, `users.js:21-22`,
  `user-claimants.js:53-54`) reject `<= 0`, but the column itself
  accepts negatives and zero.
- `CHECK (expense_date GLOB '????-??-??')` on `expenses`. Mirrors the
  fix applied to `labour_entries.work_date` in migration 007. The
  `reportingAmount` path in `t661.js` doesn't read the date, but
  date-range filters on `e.expense_date >= ?` silently produce wrong
  results for malformed values.
- `CHECK (evidence_date GLOB '????-??-??')` on `evidence_items`. Same
  reasoning.
- `CHECK (fx_rate IS NULL OR fx_rate > 0)` on `expenses`. The route
  rejects `<= 0` (`expenses.js:25-26`), but only when a foreign-currency
  branch is taken. A direct SQL insert with `fx_rate = 0` on a
  same-currency row would survive, then explode at `reportingAmount`.
- `CHECK (status IN ('open', 'closed'))` already exists on
  `fiscal_periods`. The parallel attachment status on `user_claimants`
  is also constrained. Confirmed coverage: `users.status`,
  `users.role`, `claimants.sred_method`, `user_claimants.status`,
  `project_assignments.status`, `labour_entries.status`,
  `expenses.status`, `expenses.category`, `evidence_items.kind`,
  `compensation_rows.comp_type` are all `CHECK`-constrained.
  `projects.type` and `projects.status` also are. **No gap here**.
- `CHECK (end_date IS NULL OR end_date > start_date)` on `projects` and
  on `fiscal_periods`. `claimants.js:125` enforces it on period create
  (`start_date >= end_date → 400`), but a future PATCH on either
  start_date or end_date in isolation would not re-check.

## Foreign key gaps

- `audit_log.entity_id` is polymorphic (the entity_type column picks
  the target table) and so cannot have a single `REFERENCES`. This is
  intentional and documented through the `CLAIMANT_ENTITY_FILTERS`
  mapping in `audit-log.js`.
- Every other `INTEGER` column that points at another table carries a
  `REFERENCES`. Spot-checked: `revoked_by` (none — refresh tokens are
  rotated via `revoked_at` only), `manager_user_id`, `reviewed_by_user_id`,
  `uploaded_by_user_id`, `revised_by_user_id`, `generated_by_user_id`,
  `deactivated_with_user_id` — all reference `users(id)`.
- `webauthn_challenges.context` is `TEXT` and stores an `email_token` id
  as a string. It's documented as such (`-- e.g., email_token id for
  enrollment`) but isn't enforced; given it's only read locally during
  a 5-minute window and the challenge is rotated, this is acceptable.

## Naming consistency findings

- **Table names: mixed singular/plural.** `users`, `claimants`,
  `credentials`, `email_tokens`, `webauthn_challenges`, `fiscal_periods`,
  `user_claimants`, `compensation_rows`, `projects`, `project_revisions`,
  `project_assignments`, `labour_entries`, `expenses`, `evidence_items`,
  `t661_exports`, `refresh_tokens` are **plural**. `audit_log` is
  **singular**. Recommendation: rename `audit_log` → `audit_logs` in a
  future migration, or document the rule ("singular for append-only
  ledgers"). The audit-log code references the table name in only one
  place (the trigger names and INSERT), so the cost is low.
- **`_at` vs `_date`.** Used consistently. Timestamps end in `_at`:
  `created_at`, `updated_at`, `revoked_at`, `consumed_at`, `closed_at`,
  `expires_at`, `last_used_at`, `revised_at`, `generated_at`,
  `reviewed_at`. Dates end in `_date`: `start_date`, `end_date`,
  `work_date`, `expense_date`, `evidence_date`, `effective_from`,
  `effective_until`, `employment_start_date`. **Exceptions worth
  noting:** `effective_from` / `effective_until` don't follow the
  `_date` suffix even though they store dates; `employment_start_date`
  does. Minor — leaving them is fine, but a future cleanup could
  rename to `effective_from_date` for symmetry.
- **`_id` suffix.** Consistent throughout. Every FK column ends in
  `_id`. No stripped variants.
- **`*_json` suffix.** `before_json`, `after_json`, `totals_json`,
  `project_revisions_json`, `evidence_manifest_json` — consistent.
- **Singular-vs-plural FK target column.** `user_id` (refers to
  `users(id)`), `claimant_id` (refers to `claimants(id)`), etc. —
  consistently singular. Good.

## Migration safety

- **Idempotency.** Migrations are tracked in `_migrations(filename)`
  (PK), so each runs at most once. They are **not internally
  idempotent** — re-running `001_init.sql` against a populated DB would
  fail on the `CREATE TABLE`. The runner's PK lookup handles this
  correctly; the convention is fine as long as a migration is never
  manually re-issued.
- **Table-recreate migrations.** Three migrations rebuild a table:
  - `004` rebuilds `users` to widen the role enum. Small table, fast.
  - `007` rebuilds `compensation_rows` and `labour_entries`. The
    latter is the largest table in the system. **Risk on a
    50k-row labour table:** a single-pass `INSERT INTO ... SELECT ...`
    plus `CREATE INDEX ×3` is order of seconds, not minutes — well
    within an acceptable maintenance window for a daily app. The
    bigger concern is that the migration runs inside a single
    transaction (`db.transaction(() => db.exec(sql); …)`), so the
    intermediate `labour_entries_new` table doubles peak disk usage
    until commit. At 50k rows this is trivial; at 5M rows you'd want
    to plan the maintenance window. **Document this in the
    migrations README if one exists.**
  - `011` rebuilds `projects`. Project table is small (one row per
    SR&ED project, ~tens). No risk.
  - **All three correctly toggle `foreign_keys = OFF`** via the runner
    so inbound FK references survive the table swap, and the runner
    validates `PRAGMA foreign_key_check` after each migration.
- **Numbering.** `001` through `012` with no gaps. The runner sorts by
  filename, so a developer adding `005a_*.sql` between `005` and `006`
  would land in the right order. Best practice: keep the strict
  `NNN_*` convention. **The runner does not lock against concurrent
  invocations**, so two `npm run migrate` processes started together
  could both observe an empty `_migrations` row and both try to apply
  the same file. The second would fail loudly (duplicate PK on
  `_migrations.filename` or `CREATE TABLE` failure), which is the
  intended outcome but not a polished one. Low-priority.
- **`PRAGMA foreign_keys` toggle is process-wide.** The runner uses
  `db.pragma('foreign_keys = OFF')` outside the transaction, runs the
  migration, then `= ON`. If the migration throws inside the tx,
  better-sqlite3 rolls the tx back **but** `foreign_keys` stays OFF
  for the rest of that node process. In practice the runner exits on
  error (`process.exit(1)` on FK violation, uncaught throw on others),
  so this is benign — note for future maintainers.

## Transaction usage findings

Multi-table mutating routes use `db.transaction(...)` consistently:

- `users.js:152` — POST /api/users wraps the user insert plus N
  attachments (each an insert into `user_claimants` + an insert into
  `compensation_rows`). Correct.
- `users.js:222` — POST /api/users/:id/deactivate wraps the
  `users.status` update with the bulk `user_claimants` flip. Correct
  and necessary (otherwise a crash between the two leaves an
  inconsistent state).
- `users.js:251` — POST /api/users/:id/reactivate, symmetric. Correct.
- `projects.js:92` — PATCH /api/projects/:id wraps the projects update
  with the snapshot insert into `project_revisions`. Correct.
- `claimants.js:187` — POST /api/claimants/:id/projects wraps the
  project insert with its initial `project_revisions` snapshot.
  Correct.
- `refresh.js:43` — refresh-replay detection wraps the family-revoke
  with the audit insert. Correct.
- `labour.js:217` — bulk-approve wraps the bulk UPDATE. The audit
  inserts that follow are **outside** the transaction, which is
  acceptable (audit is best-effort by design) but worth noting; if
  audit failed mid-loop the DB would be approved but only partially
  audited.

**Cases where transactions are NOT used and probably should be:**

- `evidence.js:236` (POST /api/evidence) writes the file to disk
  (multer) and inserts the row in two phases. If the INSERT fails
  after the file is written, the catch block deletes the file — good.
  No real transaction need beyond that single INSERT.
- `exports.js:218` updates `t661_exports.bundle_path` after the zip
  stream closes. No multi-row mutation; fine.

## WAL and concurrency

- `src/db/index.js` enables `journal_mode = WAL` and `foreign_keys = ON`
  at process start. WAL is the right call for a read-heavy single-writer
  process (which is what better-sqlite3 in Node is — synchronous calls
  on a single event-loop thread).
- **There is only one DB connection** in the process (a module-scoped
  `new Database(...)`). Node's single-threaded event loop plus
  better-sqlite3's synchronous API means no concurrent statements
  execute against this connection: every `db.prepare(...).run()` runs
  to completion before the next request handler resumes.
- WAL still matters for **external readers** — the migration runner is
  a separate process invocation but starts a fresh connection. A
  long-running export bundle that holds the connection open won't
  block migrations, but that's not the architecture today (no parallel
  process).
- **No cross-connection assumptions in the code.** Every query is
  scoped to the single `db` import.
- One concurrency-relevant note: `mintEmailToken` and `mintRefreshToken`
  both do a `DELETE` for the same user's stale rows before the
  `INSERT`. Because both are sync calls in the same handler, no race
  exists; this is correct.

## Already in good shape

- **Append-only audit log enforced at the schema layer.** Triggers in
  migration 008 reject UPDATE and DELETE on `audit_log`. The app could
  not silently rewrite history even if a future route forgot the rule.
- **Composite index on the audit-log lookup pattern** —
  `(entity_type, entity_id)` matches the "show me history for this
  thing" filter exactly.
- **`UNIQUE (user_id, claimant_id)` on `user_claimants`** prevents
  duplicate attachments at the schema level, not just in the route.
- **`UNIQUE (claimant_id, start_date)` on `fiscal_periods`** prevents
  duplicate periods and is leveraged by the create handler
  (`claimants.js:135`) to surface a clean 400 on collision.
- **Hashed tokens, not raw.** `email_tokens.token_hash` and
  `refresh_tokens.token_hash` are SHA-256 hashes with `UNIQUE`
  constraints. A DB leak doesn't grant logins.
- **The labour-entries CHECK on `hours > 0 AND hours <= 24`** prevents
  the trivial "log a year of hours in one entry" exploit. Pair it with
  the suggested `amount_cents > 0` for symmetry.
- **`work_date GLOB '????-??-??'`** in migration 007 catches malformed
  dates before they reach `t661.js`'s year extraction (which would
  otherwise produce `NaN` and a cap miss).
- **`compensation_rows.effective_until`** lets a comp row be closed
  cleanly when an employee leaves or gets a raise mid-period, without
  rewriting history. The T661 calc correctly treats NULL as
  open-ended.
- **`foreign_keys = ON`** is set on the live connection, so the FK
  network actually enforces — many SQLite apps forget this and end up
  with dangling references.
- **`fiscal_year_end_month BETWEEN 1 AND 12`** and
  `fiscal_year_end_day BETWEEN 1 AND 31` on `claimants` — bounded
  ranges at the schema layer.
- **`is_overtime CHECK (is_overtime IN (0, 1))`** — boolean discipline
  for an INTEGER column.
