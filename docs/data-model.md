# Data Model

SQLite schema. All `*_at` / `*_date` columns are ISO-8601 text. Monetary values are `INTEGER` cents. Booleans are `INTEGER` (0/1).

## Entity overview

```
users ──< credentials
users ──< email_tokens
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
  role          TEXT NOT NULL CHECK (role IN ('admin', 'employee')),
  status        TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE credentials (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  credential_id  BLOB NOT NULL UNIQUE,
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
  id                     INTEGER PRIMARY KEY,
  user_id                INTEGER NOT NULL REFERENCES users(id),
  claimant_id            INTEGER NOT NULL REFERENCES claimants(id),
  title                  TEXT,
  is_specified_employee  INTEGER NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, claimant_id)
);
-- The "person × claimant" attachment row. All entries below reference this,
-- not the bare user_id, so per-claimant data partitioning is automatic.

CREATE TABLE compensation_rows (
  id                INTEGER PRIMARY KEY,
  user_claimant_id  INTEGER NOT NULL REFERENCES user_claimants(id),
  comp_type         TEXT NOT NULL CHECK (comp_type IN ('salary', 'hourly')),
  amount_cents      INTEGER NOT NULL,    -- annual salary OR hourly rate, in cents
  hours_per_year    INTEGER NOT NULL DEFAULT 2080,  -- used for salary → hourly conversion
  effective_from    TEXT NOT NULL,
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
  status              TEXT NOT NULL CHECK (status IN ('planned', 'active', 'completed')),
  -- T661 Part 2 narrative (current version)
  advancement_sought  TEXT,
  uncertainties       TEXT,
  work_performed      TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE project_revisions (
  id                  INTEGER PRIMARY KEY,
  project_id          INTEGER NOT NULL REFERENCES projects(id),
  title               TEXT NOT NULL,
  field_of_science    TEXT,
  advancement_sought  TEXT,
  uncertainties       TEXT,
  work_performed      TEXT,
  revised_by_user_id  INTEGER REFERENCES users(id),
  revised_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One row snapshotted on each narrative change. The version "as filed" for a
-- given t661_export is captured in t661_exports.project_revisions_json.

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
  work_date            TEXT NOT NULL,
  hours                REAL NOT NULL CHECK (hours > 0 AND hours <= 24),
  description          TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by_user_id  INTEGER REFERENCES users(id),
  reviewed_at          TEXT,
  rejection_reason     TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  entity_type    TEXT NOT NULL,       -- labour_entry | expense | project | ...
  entity_id      INTEGER NOT NULL,
  before_json    TEXT,
  after_json     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
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
```

## Design notes

- **`user_claimants` is the load-bearing join.** All employee-scoped rows (labour, expenses, assignments, comp) reference it instead of `users.id`. This keeps per-claimant data partitioning automatic, supports the unified-view requirement (one person, many attachments), and makes "leave a claimant" a single row to deactivate.
- **`fiscal_period_id` is denormalized onto labour/evidence/expense rows.** Derivable from `work_date` + the project's claimant, but cached on the row so that period rollups and immutability checks are a single index hit.
- **Closed-period writes are blocked in application code**, not via SQL trigger — simpler to test and to override during admin recovery.
- **`t661_exports` is the canonical snapshot.** A reopened period can mutate the live rows, but anything filed is in `totals_json` / `project_revisions_json` and stays bit-identical.
- **Evidence is polymorphic with two nullable FKs.** Cleaner than a separate `expense_receipts` table for the v1 scale; if expense receipts grow special metadata (vendor, invoice number) split later.
- **Wage cap and overhead method live in code**, not the DB — cap is a per-year constant table inside the app; overhead method is `claimants.sred_method` set once.
- **Retention** is enforced in the delete paths (block hard delete of labour/evidence/expense within 6 years of the containing fiscal year's end). A periodic cleanup job is out of scope for v1; rows accumulate.
