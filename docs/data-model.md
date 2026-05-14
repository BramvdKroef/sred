# Data Model

SQLite schema. All `*_at` / `*_date` columns are ISO-8601 text. Monetary values are `INTEGER` cents. Booleans are `INTEGER` (0/1).

The DDL below reflects the schema after applying every migration in `src/db/migrations/` (001-012). Where a column or constraint was added later, the originating migration number is noted in a trailing comment.

## Entity overview

```
users ──< credentials
users ──< email_tokens
users ──< refresh_tokens
users ──< webauthn_challenges
users ──< user_claimants >── claimants
                ├──< compensation_rows
                └──< project_assignments >── projects
                                              ├── project_revisions (history)
                                              ├──< labour_entries
                                              ├──< evidence_items
                                              └──< expenses
claimants ──< fiscal_periods
claimants ──< t661_exports
```

Every domain table that participates in a claim also carries `fiscal_period_id` so the period is the partition key for rollups and immutability.

## Tables

### Auth (see `auth.md` for full rationale)

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'employee')),  -- mig 004
  status        TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The `manager` role is a target for projects.manager_user_id; it does not
-- grant API privileges beyond `employee` today.

CREATE TABLE credentials (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  credential_id  BLOB NOT NULL UNIQUE,    -- stored as TEXT base64url since mig 002
  public_key     BLOB NOT NULL,
  counter        INTEGER NOT NULL DEFAULT 0,
  transports     TEXT,        -- JSON array
  label          TEXT,        -- "MacBook Touch ID", "iPhone", ...
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at   TEXT
);

CREATE TABLE email_tokens (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL UNIQUE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('invite', 'recovery', 'add_device')),
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);

-- WebAuthn ceremonies need short-term challenge storage between
-- start/finish. Rows have a 5-minute TTL and are opportunistically reaped
-- on every insert.                                            -- mig 001
CREATE TABLE webauthn_challenges (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id),   -- nullable for discoverable login
  challenge   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  context     TEXT,                            -- e.g., email_token id for enrollment
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);

-- Long-lived refresh tokens. Only sha256(raw_token) is stored, so a DB
-- leak does not grant logins. Rotate on every use: a successful refresh
-- marks the presented row as revoked and mints a new one. Replay of an
-- already-revoked row triggers V-03 family revocation + audit.
-- mig 005 (created), mig 010 (dropped `last_used_at` — redundant with
-- revoked_at after rotation).
CREATE TABLE refresh_tokens (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at    TEXT
);
```

### Claimants and fiscal periods

```sql
CREATE TABLE claimants (
  id                       INTEGER PRIMARY KEY,
  legal_name               TEXT NOT NULL,
  business_number          TEXT,
  fiscal_year_end_month    INTEGER NOT NULL CHECK (fiscal_year_end_month BETWEEN 1 AND 12),
  fiscal_year_end_day      INTEGER NOT NULL CHECK (fiscal_year_end_day BETWEEN 1 AND 31),
  reporting_currency       TEXT NOT NULL DEFAULT 'CAD',
  sred_method              TEXT NOT NULL CHECK (sred_method IN ('proxy', 'traditional')),
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
-- sred_method is locked at creation (enforced in application code, not DDL).

CREATE TABLE fiscal_periods (
  id          INTEGER PRIMARY KEY,
  claimant_id INTEGER NOT NULL REFERENCES claimants(id),
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (claimant_id, start_date)
);
```

### Employee attachment + compensation history

```sql
CREATE TABLE user_claimants (
  id                       INTEGER PRIMARY KEY,
  user_id                  INTEGER NOT NULL REFERENCES users(id),
  claimant_id              INTEGER NOT NULL REFERENCES claimants(id),
  title                    TEXT,
  is_specified_employee    INTEGER NOT NULL DEFAULT 0,
  status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  employment_start_date    TEXT,                                       -- mig 009
  deactivated_with_user_id INTEGER REFERENCES users(id),               -- mig 012
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, claimant_id)
);
-- The "person × claimant" attachment row. All entries below reference this,
-- not the bare user_id, so per-claimant data partitioning is automatic.
-- `deactivated_with_user_id` records that this row was bulk-flipped to
-- inactive by POST /api/users/:id/deactivate, so `reactivate` can flip
-- back exactly the rows it itself disabled.

CREATE TABLE compensation_rows (
  id                INTEGER PRIMARY KEY,
  user_claimant_id  INTEGER NOT NULL REFERENCES user_claimants(id),
  comp_type         TEXT NOT NULL CHECK (comp_type IN ('salary', 'hourly')),
  amount_cents      INTEGER NOT NULL,    -- annual salary OR hourly rate, in cents
  hours_per_year    INTEGER NOT NULL DEFAULT 2080 CHECK (hours_per_year > 0),  -- mig 007
  effective_from    TEXT NOT NULL,
  effective_until   TEXT,                -- nullable; NULL = open-ended    mig 007
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Look up the comp row whose effective_from is the latest <= labour entry's work_date.
```

### Projects + narrative versioning

```sql
CREATE TABLE projects (
  id                  INTEGER PRIMARY KEY,
  claimant_id         INTEGER NOT NULL REFERENCES claimants(id),
  title               TEXT NOT NULL,
  field_of_science    TEXT,
  start_date          TEXT NOT NULL,
  end_date            TEXT,
  status              TEXT NOT NULL CHECK (status IN ('concept', 'development', 'complete')),  -- renamed mig 011
  -- T661 Part 2 narrative (current version)
  advancement_sought  TEXT,
  uncertainties       TEXT,
  work_performed      TEXT,
  type                TEXT NOT NULL DEFAULT 'sred'
                        CHECK (type IN ('sred', 'internal')),     -- mig 003
  manager_user_id     INTEGER REFERENCES users(id),               -- mig 004
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Only `type='sred'` projects roll up into T661 exports.
-- `status` was originally planned|active|completed (mig 001); migration 011
-- renamed to concept|development|complete and dropped the parallel `phase`
-- column that had been added by mig 003.

CREATE TABLE project_revisions (
  id                  INTEGER PRIMARY KEY,
  project_id          INTEGER NOT NULL REFERENCES projects(id),
  title               TEXT NOT NULL,
  field_of_science    TEXT,
  advancement_sought  TEXT,
  uncertainties       TEXT,
  work_performed      TEXT,
  type                TEXT NOT NULL DEFAULT 'sred',               -- mig 003
  manager_user_id     INTEGER REFERENCES users(id),               -- mig 004
  revised_by_user_id  INTEGER REFERENCES users(id),
  revised_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One row snapshotted on each narrative change. The version "as filed" for a
-- given t661_export is captured in t661_exports.project_revisions_json.
-- (The `phase` column briefly added by mig 003 was dropped by mig 011.)

CREATE TABLE project_assignments (
  id                INTEGER PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  user_claimant_id  INTEGER NOT NULL REFERENCES user_claimants(id),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, user_claimant_id)
);
```

### Labour, evidence, expenses

```sql
CREATE TABLE labour_entries (
  id                   INTEGER PRIMARY KEY,
  project_id           INTEGER NOT NULL REFERENCES projects(id),
  user_claimant_id     INTEGER NOT NULL REFERENCES user_claimants(id),
  fiscal_period_id     INTEGER NOT NULL REFERENCES fiscal_periods(id),
  work_date            TEXT NOT NULL CHECK (work_date GLOB '????-??-??'),  -- mig 007
  hours                REAL NOT NULL CHECK (hours > 0 AND hours <= 24),
  description          TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by_user_id  INTEGER REFERENCES users(id),
  reviewed_at          TEXT,
  rejection_reason     TEXT,
  is_overtime          INTEGER NOT NULL DEFAULT 0
                         CHECK (is_overtime IN (0, 1)),                    -- mig 006
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
-- `is_overtime` is a reporting marker only; the T661 hourly-cost calc
-- does NOT apply an overtime multiplier (v1 keeps historical totals
-- bit-stable across the flag).

CREATE TABLE expenses (
  id                    INTEGER PRIMARY KEY,
  project_id            INTEGER NOT NULL REFERENCES projects(id),
  user_claimant_id      INTEGER NOT NULL REFERENCES user_claimants(id),
  fiscal_period_id      INTEGER NOT NULL REFERENCES fiscal_periods(id),
  expense_date          TEXT NOT NULL,
  category              TEXT NOT NULL
                          CHECK (category IN ('material', 'contract', 'third_party_payment', 'overhead')),
  amount_cents          INTEGER NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'CAD',
  fx_rate               REAL,         -- → reporting currency; null when currency matches
  description           TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by_user_id   INTEGER REFERENCES users(id),
  reviewed_at           TEXT,
  rejection_reason      TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE evidence_items (
  id                   INTEGER PRIMARY KEY,
  project_id           INTEGER NOT NULL REFERENCES projects(id),
  fiscal_period_id     INTEGER NOT NULL REFERENCES fiscal_periods(id),
  uploaded_by_user_id  INTEGER NOT NULL REFERENCES users(id),
  -- Optional links — evidence may stand alone, back a labour entry, or back an expense receipt
  labour_entry_id      INTEGER REFERENCES labour_entries(id),
  expense_id           INTEGER REFERENCES expenses(id),
  kind                 TEXT NOT NULL CHECK (kind IN ('file', 'link', 'note')),
  caption              TEXT NOT NULL,
  evidence_date        TEXT NOT NULL,
  file_path            TEXT,    -- when kind = file
  file_size            INTEGER,
  file_mime            TEXT,
  url                  TEXT,    -- when kind = link
  note_text            TEXT,    -- when kind = note
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Audit log

```sql
CREATE TABLE audit_log (
  id             INTEGER PRIMARY KEY,
  actor_user_id  INTEGER REFERENCES users(id),
  action         TEXT NOT NULL,       -- create | update | approve | reject | close_period | export | ...
  entity_type    TEXT NOT NULL,       -- labour_entry | expense | project | refresh_token | ...
  entity_id      INTEGER NOT NULL,
  before_json    TEXT,
  after_json     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only enforcement at the DB level (mig 008). UPDATE and DELETE
-- against audit_log raise SQLITE_ABORT regardless of who issued them
-- (HTTP layer, sysadmin, future code path).
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
```

### T661 export snapshots

```sql
CREATE TABLE t661_exports (
  id                       INTEGER PRIMARY KEY,
  claimant_id              INTEGER NOT NULL REFERENCES claimants(id),
  fiscal_period_id         INTEGER NOT NULL REFERENCES fiscal_periods(id),
  generated_by_user_id     INTEGER REFERENCES users(id),
  is_draft                 INTEGER NOT NULL DEFAULT 0,
  totals_json              TEXT NOT NULL,   -- per-project + per-line totals at generation time
  project_revisions_json   TEXT NOT NULL,   -- narratives as exported (so reopen+edit doesn't rewrite history)
  evidence_manifest_json   TEXT,            -- list of evidence_item ids included in the bundle
  bundle_path              TEXT,            -- on-disk zip when an evidence package was produced
  generated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Indexes (minimum useful set)

```sql
CREATE INDEX idx_labour_period      ON labour_entries(fiscal_period_id);
CREATE INDEX idx_labour_project     ON labour_entries(project_id);
CREATE INDEX idx_labour_uc          ON labour_entries(user_claimant_id);
CREATE INDEX idx_expense_period     ON expenses(fiscal_period_id);
CREATE INDEX idx_evidence_project   ON evidence_items(project_id);
CREATE INDEX idx_uc_user            ON user_claimants(user_id);
CREATE INDEX idx_pa_project         ON project_assignments(project_id);
CREATE INDEX idx_email_tokens_hash  ON email_tokens(token_hash);
CREATE INDEX idx_credentials_user   ON credentials(user_id);
CREATE INDEX idx_audit_entity       ON audit_log(entity_type, entity_id);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);  -- mig 005
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash); -- mig 005
```

The `idx_labour_*` indexes are recreated by mig 007 after its table-rebuild (same names, same columns).

## Design notes

- **`user_claimants` is the load-bearing join.** All employee-scoped rows (labour, expenses, assignments, comp) reference it instead of `users.id`. This keeps per-claimant data partitioning automatic, supports the unified-view requirement (one person, many attachments), and makes "leave a claimant" a single row to deactivate.
- **`fiscal_period_id` is denormalized onto labour/evidence/expense rows.** Derivable from `work_date` + the project's claimant, but cached on the row so that period rollups and immutability checks are a single index hit.
- **Closed-period writes are blocked in application code**, not via SQL trigger — simpler to test and to override during admin recovery.
- **`t661_exports` is the canonical snapshot.** A reopened period can mutate the live rows, but anything filed is in `totals_json` / `project_revisions_json` and stays bit-identical.
- **Evidence is polymorphic with two nullable FKs.** Cleaner than a separate `expense_receipts` table for the v1 scale; if expense receipts grow special metadata (vendor, invoice number) split later.
- **Wage cap and overhead method live in code**, not the DB — cap is a per-year constant table inside the app (`src/lib/wage-caps.js`); overhead method is `claimants.sred_method` set once.
- **Retention: closed-period lock.** Deletion of labour, evidence, and expense rows is blocked while the containing `fiscal_periods.status='closed'`. There is no separate 6-year clock — retention rides on the admin's discipline about closing periods (and the requirement that an export be generated before a period is closed). Reopening a period via `POST /api/periods/:id/reopen` is the only way to re-enable mutation, and is itself written to `audit_log`.
- **Append-only audit log.** Migration 008 installs BEFORE UPDATE and BEFORE DELETE triggers that abort any non-INSERT against `audit_log`, including direct SQLite access — so refresh-replay handling and other multi-write transactions can rely on the audit row sticking.
