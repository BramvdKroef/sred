-- Closes SRED_DOMAIN_REVIEW.md P3 items on `expenses`:
--
--   1. Materials consumed vs transformed split.
--      CRA splits T661 line 320 (materials consumed in SR&ED) from line 325
--      (materials transformed into something subsequently sold or leased).
--      The schema previously had a single `material` category covering both;
--      this column captures the disposition. [CRA, T4088 lines 320/325;
--      ITA s.37(8)(a)(ii)(A) / (B)]
--
--   2. Contract arm's-length vs non-arm's-length.
--      Eligibility / allowable amount differs: NAL contracts are limited to
--      the contractor's allowable cost basis, not the full contract amount.
--      An int flag is enough here (1 = arm's length, 0 = non-arm's-length),
--      with the underlying counterparty record (TODO future) carrying the
--      reasoning. [CRA, *Contract Expenditures for SR&ED Performed on
--      Behalf of a Claimant Policy*; T4088 line 340]
--
--   3. FX-rate source attribution.
--      Audit-defensibility: an `fx_rate` on its own is opaque. A free-text
--      `fx_rate_source` field captures *which* rate was used so the tax
--      preparer can defend the conversion on audit. Typical value:
--      "Bank of Canada noon rate, 2026-03-15". [CRA, Income Tax Folio
--      S5-F4-C1, Income Tax Conversion of Foreign Currency]
--
-- All three columns are nullable at the schema layer; route-layer
-- validators in src/routes/expenses.js enforce the "required when …" rules
-- with clean 400s. The schema CHECKs cover the "must not be present when
-- not applicable" half so a stray field on the wrong row can't slip
-- through if a writer bypasses the route.
--
-- Existing rows: all current expense rows end up with
--   material_disposition = NULL on materials (admin can back-fill via the
--   inline-edit form), contract_arms_length = NULL on contracts,
--   fx_rate_source = NULL on rows that have an fx_rate. Same
--   grandfathering pattern as migration 014.
--
-- Adding new CHECK constraints (especially cross-column ones) requires the
-- SQLite recreate dance — ALTER TABLE can't add multi-column CHECKs.
-- Mirrors migrations 013 and 014. Preserves every existing CHECK on
-- expense_date, category, amount_cents, fx_rate, status,
-- overhead_subcategory, and the (category='overhead' OR subcat/basis IS
-- NULL) cross-column guard from migration 014.

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
  -- P3.1: materials disposition for T661 line 320 vs 325 split.
  material_disposition  TEXT
                          CHECK (material_disposition IS NULL OR
                                 material_disposition IN ('consumed', 'transformed')),
  -- P3.2: 1 = arm's-length, 0 = non-arm's-length. Null when not a contract.
  contract_arms_length  INTEGER
                          CHECK (contract_arms_length IS NULL OR
                                 contract_arms_length IN (0, 1)),
  -- P3.3: free-text attribution of the fx_rate source. Schema is permissive
  -- (any text); the route requires a non-empty string when fx_rate IS NOT
  -- NULL. We don't enforce the "must accompany fx_rate" rule at the column
  -- level so existing rows can be migrated forward with NULL and back-filled
  -- through the admin edit form — the same grandfathering pattern as the
  -- overhead fields in migration 014.
  fx_rate_source        TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  -- Cross-column guard from migration 014 (preserved verbatim): non-overhead
  -- rows MUST NOT carry an overhead subcategory or allocation basis.
  CHECK ((category = 'overhead') OR
         (overhead_subcategory IS NULL AND allocation_basis IS NULL)),
  -- P3.1 cross-column: only material rows may carry a disposition. Mirrors
  -- the overhead pattern — guarantees the T661 formatter never sees a
  -- "consumed" flag on a contract row.
  CHECK ((category = 'material') OR material_disposition IS NULL),
  -- P3.2 cross-column: only contract rows may carry the arm's-length flag.
  CHECK ((category = 'contract') OR contract_arms_length IS NULL)
);

INSERT INTO expenses_new
  (id, project_id, user_claimant_id, fiscal_period_id, expense_date, category,
   amount_cents, currency, fx_rate, description, status, reviewed_by_user_id,
   reviewed_at, rejection_reason, overhead_subcategory, allocation_basis,
   created_at, updated_at)
  SELECT id, project_id, user_claimant_id, fiscal_period_id, expense_date, category,
         amount_cents, currency, fx_rate, description, status, reviewed_by_user_id,
         reviewed_at, rejection_reason, overhead_subcategory, allocation_basis,
         created_at, updated_at
    FROM expenses;

DROP TABLE expenses;
ALTER TABLE expenses_new RENAME TO expenses;

CREATE INDEX idx_expense_period  ON expenses(fiscal_period_id);
CREATE INDEX idx_expense_project ON expenses(project_id);
CREATE INDEX idx_expense_uc      ON expenses(user_claimant_id);
