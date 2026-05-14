-- Closes the three high-impact gaps from DATABASE_REVIEW.md:
--
--   1. Indexes for the labour-cost inner loop (compensation_rows by
--      user_claimant_id), the review-queue filters on expenses (project
--      and user_claimant), the evidence-bundle build (evidence_items by
--      period and by labour/expense FK), and the audit-log filters
--      (actor and created_at).
--   2. Schema-level CHECK constraints on expenses.amount_cents,
--      compensation_rows.amount_cents, expenses.fx_rate, and the
--      `?GLOB '????-??-??'` shape for expenses.expense_date and
--      evidence_items.evidence_date — mirroring the labour_entries.work_date
--      treatment from migration 007.
--
-- Adding/tightening CHECK constraints in SQLite requires the table-recreate
-- dance. migrate.js toggles `foreign_keys = OFF` for the duration of each
-- migration so inbound references survive the swap.
--
-- audit_log is intentionally left alone: migration 008 attached append-only
-- triggers that would also reject the INSERT INTO ... SELECT used by the
-- recreate dance, and audit_log is already append-only at the schema layer,
-- so additional CHECKs would buy very little. We only add new indexes on it.
--
-- labour_entries already carries `CHECK (hours > 0 AND hours <= 24)` and
-- `CHECK (work_date GLOB '????-??-??')` from migration 007, so no rebuild
-- is needed there.

-- compensation_rows ----------------------------------------------------------
--
-- Add CHECK (amount_cents > 0). Preserves the existing CHECKs (comp_type,
-- hours_per_year) and the effective_until column added in migration 007.

CREATE TABLE compensation_rows_new (
  id                INTEGER PRIMARY KEY,
  user_claimant_id  INTEGER NOT NULL REFERENCES user_claimants(id),
  comp_type         TEXT NOT NULL CHECK (comp_type IN ('salary', 'hourly')),
  amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
  hours_per_year    INTEGER NOT NULL DEFAULT 2080 CHECK (hours_per_year > 0),
  effective_from    TEXT NOT NULL,
  effective_until   TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO compensation_rows_new
  (id, user_claimant_id, comp_type, amount_cents, hours_per_year,
   effective_from, effective_until, created_at)
  SELECT id, user_claimant_id, comp_type, amount_cents, hours_per_year,
         effective_from, effective_until, created_at
    FROM compensation_rows;

DROP TABLE compensation_rows;
ALTER TABLE compensation_rows_new RENAME TO compensation_rows;

CREATE INDEX idx_comp_uc ON compensation_rows(user_claimant_id);

-- expenses -------------------------------------------------------------------
--
-- Add CHECK (amount_cents > 0), CHECK (expense_date GLOB '????-??-??'),
-- and CHECK (fx_rate IS NULL OR fx_rate > 0). Preserves the existing
-- CHECKs on category and status.

CREATE TABLE expenses_new (
  id                    INTEGER PRIMARY KEY,
  project_id            INTEGER NOT NULL REFERENCES projects(id),
  user_claimant_id      INTEGER NOT NULL REFERENCES user_claimants(id),
  fiscal_period_id      INTEGER NOT NULL REFERENCES fiscal_periods(id),
  expense_date          TEXT NOT NULL CHECK (expense_date GLOB '????-??-??'),
  category              TEXT NOT NULL
                          CHECK (category IN ('material', 'contract', 'third_party_payment', 'overhead')),
  amount_cents          INTEGER NOT NULL CHECK (amount_cents > 0),
  currency              TEXT NOT NULL DEFAULT 'CAD',
  fx_rate               REAL CHECK (fx_rate IS NULL OR fx_rate > 0),
  description           TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by_user_id   INTEGER REFERENCES users(id),
  reviewed_at           TEXT,
  rejection_reason      TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO expenses_new
  (id, project_id, user_claimant_id, fiscal_period_id, expense_date, category,
   amount_cents, currency, fx_rate, description, status, reviewed_by_user_id,
   reviewed_at, rejection_reason, created_at, updated_at)
  SELECT id, project_id, user_claimant_id, fiscal_period_id, expense_date, category,
         amount_cents, currency, fx_rate, description, status, reviewed_by_user_id,
         reviewed_at, rejection_reason, created_at, updated_at
    FROM expenses;

DROP TABLE expenses;
ALTER TABLE expenses_new RENAME TO expenses;

CREATE INDEX idx_expense_period  ON expenses(fiscal_period_id);
CREATE INDEX idx_expense_project ON expenses(project_id);
CREATE INDEX idx_expense_uc      ON expenses(user_claimant_id);

-- evidence_items -------------------------------------------------------------
--
-- Add CHECK (evidence_date GLOB '????-??-??'). Preserves the existing
-- CHECK on kind and the polymorphic labour/expense FK pair.

CREATE TABLE evidence_items_new (
  id                   INTEGER PRIMARY KEY,
  project_id           INTEGER NOT NULL REFERENCES projects(id),
  fiscal_period_id     INTEGER NOT NULL REFERENCES fiscal_periods(id),
  uploaded_by_user_id  INTEGER NOT NULL REFERENCES users(id),
  labour_entry_id      INTEGER REFERENCES labour_entries(id),
  expense_id           INTEGER REFERENCES expenses(id),
  kind                 TEXT NOT NULL CHECK (kind IN ('file', 'link', 'note')),
  caption              TEXT NOT NULL,
  evidence_date        TEXT NOT NULL CHECK (evidence_date GLOB '????-??-??'),
  file_path            TEXT,
  file_size            INTEGER,
  file_mime            TEXT,
  url                  TEXT,
  note_text            TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO evidence_items_new
  (id, project_id, fiscal_period_id, uploaded_by_user_id, labour_entry_id,
   expense_id, kind, caption, evidence_date, file_path, file_size, file_mime,
   url, note_text, created_at)
  SELECT id, project_id, fiscal_period_id, uploaded_by_user_id, labour_entry_id,
         expense_id, kind, caption, evidence_date, file_path, file_size, file_mime,
         url, note_text, created_at
    FROM evidence_items;

DROP TABLE evidence_items;
ALTER TABLE evidence_items_new RENAME TO evidence_items;

CREATE INDEX idx_evidence_project ON evidence_items(project_id);
CREATE INDEX idx_evidence_period  ON evidence_items(fiscal_period_id);
-- Partial indexes on the polymorphic FKs: most rows have only one of the two
-- populated, so partial keeps the index footprint tight.
CREATE INDEX idx_evidence_labour  ON evidence_items(labour_entry_id)
  WHERE labour_entry_id IS NOT NULL;
CREATE INDEX idx_evidence_expense ON evidence_items(expense_id)
  WHERE expense_id IS NOT NULL;

-- audit_log ------------------------------------------------------------------
--
-- Append-only triggers from migration 008 prevent a table recreate without
-- temporarily dropping them. Per DATABASE_REVIEW.md the high-value adds here
-- are the actor and created_at indexes — CHECK additions on audit_log itself
-- are low value (the table is already append-only).

CREATE INDEX idx_audit_actor   ON audit_log(actor_user_id);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
