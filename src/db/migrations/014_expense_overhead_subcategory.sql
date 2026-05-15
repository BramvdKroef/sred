-- Closes SRED_DOMAIN_REVIEW.md F5: traditional-method overhead was a single
-- bucket. Under the traditional method, CRA expects overhead expenses to be
-- categorised (salary support, rent, utilities, maintenance, other) and the
-- allocation basis documented per row (e.g. "30% of total floor area" —
-- whatever methodology the claimant uses to apportion a mixed-use cost to
-- SR&ED). [CRA, Traditional and Proxy Methods Policy §3, T4088 line 360 area]
--
-- We add two columns on `expenses`:
--   - overhead_subcategory: enum (rent, utilities, maintenance,
--     supporting_salaries, other), required when category='overhead'.
--   - allocation_basis: free-text methodology note, required when
--     category='overhead'.
--
-- Both columns must be NULL for non-overhead categories — enforced by a
-- whole-row CHECK so a stray subcategory on a material row can't slip
-- through if the route validator is bypassed.
--
-- The CHECK allows overhead rows to have NULL subcategory/basis at the
-- schema level — the "must be present" rule lives in the routes layer
-- (POST/PATCH on /api/expenses), so an overhead row without subcat fails
-- with a 400, not a SQLite CHECK violation. This matches the existing
-- split for other "required at the API but nullable at the column" fields
-- (e.g. fx_rate, which the route requires when currency differs).
--
-- Existing rows: all current overhead expenses end up with NULL subcategory
-- and NULL basis. That's fine — they're grandfathered; the API only
-- enforces presence on new POST/PATCH. If a tax preparer needs to
-- back-fill, the admin edit form will surface the fields on any overhead
-- row (subcategory shown empty, basis empty) and a PATCH will demand them.

-- Adding new CHECK constraints requires the SQLite recreate dance (mirrors
-- migration 013). Preserves all existing CHECKs on category, status,
-- amount_cents, expense_date, fx_rate.

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
  overhead_subcategory  TEXT
                          CHECK (overhead_subcategory IS NULL OR
                                 overhead_subcategory IN ('rent', 'utilities', 'maintenance',
                                                          'supporting_salaries', 'other')),
  allocation_basis      TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  -- Non-overhead rows MUST NOT carry a subcategory or basis. This protects
  -- the T661 export — without the guard, a "material" row could carry an
  -- overhead subcategory and confuse the formatter.
  CHECK ((category = 'overhead') OR
         (overhead_subcategory IS NULL AND allocation_basis IS NULL))
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
