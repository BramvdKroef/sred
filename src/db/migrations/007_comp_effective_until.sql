-- Tighten two long-standing data-quality gaps and add an end-date column on
-- compensation rows.
--
-- 1) `compensation_rows.effective_until` (nullable): a terminated employee or
--    a comp row that was replaced for a closed period can now be bounded on
--    both sides. NULL = still in effect. The T661 calc treats NULL as
--    open-ended.
-- 2) `CHECK (hours_per_year > 0)` on compensation_rows — the hourly cost calc
--    divides by this value, so zero would explode at compute time.
-- 3) `CHECK (work_date GLOB '????-??-??')` on labour_entries — a malformed
--    work_date falls through to a NaN cap-year lookup. Validate at the
--    schema level using SQLite's GLOB pattern matching. (GLOB uses `?` for
--    a single-character wildcard, not `_`.)
--
-- Items (2) and (3) tighten existing CHECK constraints, which in SQLite
-- requires the table-recreate dance (the surrounding `migrate.js` toggles
-- foreign_keys OFF for the duration of each migration so inbound refs survive
-- the swap).

-- compensation_rows ----------------------------------------------------------

CREATE TABLE compensation_rows_new (
  id                INTEGER PRIMARY KEY,
  user_claimant_id  INTEGER NOT NULL REFERENCES user_claimants(id),
  comp_type         TEXT NOT NULL CHECK (comp_type IN ('salary', 'hourly')),
  amount_cents      INTEGER NOT NULL,
  hours_per_year    INTEGER NOT NULL DEFAULT 2080 CHECK (hours_per_year > 0),
  effective_from    TEXT NOT NULL,
  effective_until   TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO compensation_rows_new
  (id, user_claimant_id, comp_type, amount_cents, hours_per_year, effective_from, created_at)
  SELECT id, user_claimant_id, comp_type, amount_cents, hours_per_year, effective_from, created_at
    FROM compensation_rows;

DROP TABLE compensation_rows;
ALTER TABLE compensation_rows_new RENAME TO compensation_rows;

-- labour_entries -------------------------------------------------------------

CREATE TABLE labour_entries_new (
  id                   INTEGER PRIMARY KEY,
  project_id           INTEGER NOT NULL REFERENCES projects(id),
  user_claimant_id     INTEGER NOT NULL REFERENCES user_claimants(id),
  fiscal_period_id     INTEGER NOT NULL REFERENCES fiscal_periods(id),
  work_date            TEXT NOT NULL CHECK (work_date GLOB '????-??-??'),
  hours                REAL NOT NULL CHECK (hours > 0 AND hours <= 24),
  description          TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by_user_id  INTEGER REFERENCES users(id),
  reviewed_at          TEXT,
  rejection_reason     TEXT,
  is_overtime          INTEGER NOT NULL DEFAULT 0 CHECK (is_overtime IN (0, 1)),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO labour_entries_new
  (id, project_id, user_claimant_id, fiscal_period_id, work_date, hours,
   description, status, reviewed_by_user_id, reviewed_at, rejection_reason,
   is_overtime, created_at, updated_at)
  SELECT id, project_id, user_claimant_id, fiscal_period_id, work_date, hours,
         description, status, reviewed_by_user_id, reviewed_at, rejection_reason,
         is_overtime, created_at, updated_at
    FROM labour_entries;

DROP TABLE labour_entries;
ALTER TABLE labour_entries_new RENAME TO labour_entries;

CREATE INDEX idx_labour_period   ON labour_entries(fiscal_period_id);
CREATE INDEX idx_labour_project  ON labour_entries(project_id);
CREATE INDEX idx_labour_uc       ON labour_entries(user_claimant_id);
