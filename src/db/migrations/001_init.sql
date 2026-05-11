-- Auth ------------------------------------------------------------------------

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
  transports     TEXT,
  label          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at   TEXT
);

CREATE INDEX idx_credentials_user ON credentials(user_id);

CREATE TABLE email_tokens (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL UNIQUE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('invite', 'recovery', 'add_device')),
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX idx_email_tokens_hash ON email_tokens(token_hash);

-- WebAuthn ceremonies need short-term challenge storage between start/finish.
CREATE TABLE webauthn_challenges (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id),
  challenge   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  context     TEXT,                                  -- e.g., email_token id for enrollment
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);

-- Claimants and fiscal periods ------------------------------------------------

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

-- Employee attachment + compensation history ----------------------------------

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

CREATE INDEX idx_uc_user ON user_claimants(user_id);

CREATE TABLE compensation_rows (
  id                INTEGER PRIMARY KEY,
  user_claimant_id  INTEGER NOT NULL REFERENCES user_claimants(id),
  comp_type         TEXT NOT NULL CHECK (comp_type IN ('salary', 'hourly')),
  amount_cents      INTEGER NOT NULL,
  hours_per_year    INTEGER NOT NULL DEFAULT 2080,
  effective_from    TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Projects + narrative versioning ---------------------------------------------

CREATE TABLE projects (
  id                  INTEGER PRIMARY KEY,
  claimant_id         INTEGER NOT NULL REFERENCES claimants(id),
  title               TEXT NOT NULL,
  field_of_science    TEXT,
  start_date          TEXT NOT NULL,
  end_date            TEXT,
  status              TEXT NOT NULL CHECK (status IN ('planned', 'active', 'completed')),
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

CREATE TABLE project_assignments (
  id                INTEGER PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  user_claimant_id  INTEGER NOT NULL REFERENCES user_claimants(id),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, user_claimant_id)
);

CREATE INDEX idx_pa_project ON project_assignments(project_id);

-- Labour, expenses, evidence --------------------------------------------------

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

CREATE INDEX idx_labour_period   ON labour_entries(fiscal_period_id);
CREATE INDEX idx_labour_project  ON labour_entries(project_id);
CREATE INDEX idx_labour_uc       ON labour_entries(user_claimant_id);

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
  fx_rate               REAL,
  description           TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by_user_id   INTEGER REFERENCES users(id),
  reviewed_at           TEXT,
  rejection_reason      TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_expense_period ON expenses(fiscal_period_id);

CREATE TABLE evidence_items (
  id                   INTEGER PRIMARY KEY,
  project_id           INTEGER NOT NULL REFERENCES projects(id),
  fiscal_period_id     INTEGER NOT NULL REFERENCES fiscal_periods(id),
  uploaded_by_user_id  INTEGER NOT NULL REFERENCES users(id),
  labour_entry_id      INTEGER REFERENCES labour_entries(id),
  expense_id           INTEGER REFERENCES expenses(id),
  kind                 TEXT NOT NULL CHECK (kind IN ('file', 'link', 'note')),
  caption              TEXT NOT NULL,
  evidence_date        TEXT NOT NULL,
  file_path            TEXT,
  file_size            INTEGER,
  file_mime            TEXT,
  url                  TEXT,
  note_text            TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_evidence_project ON evidence_items(project_id);

-- Audit + exports -------------------------------------------------------------

CREATE TABLE audit_log (
  id             INTEGER PRIMARY KEY,
  actor_user_id  INTEGER REFERENCES users(id),
  action         TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_id      INTEGER NOT NULL,
  before_json    TEXT,
  after_json     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);

CREATE TABLE t661_exports (
  id                       INTEGER PRIMARY KEY,
  claimant_id              INTEGER NOT NULL REFERENCES claimants(id),
  fiscal_period_id         INTEGER NOT NULL REFERENCES fiscal_periods(id),
  generated_by_user_id     INTEGER REFERENCES users(id),
  is_draft                 INTEGER NOT NULL DEFAULT 0,
  totals_json              TEXT NOT NULL,
  project_revisions_json   TEXT NOT NULL,
  evidence_manifest_json   TEXT,
  bundle_path              TEXT,
  generated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
