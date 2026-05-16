-- Closes SRED_DOMAIN_REVIEW.md P3 (F3): two narrative-quality fields that
-- audit defensibility for SR&ED claims demands but the schema didn't carry:
--
--   - `hypothesis` (TEXT NULL): the working hypothesis the team tested.
--     CRA's five-question framework (IC86-4R3) expects this as a distinct
--     element from `uncertainties` (which captures the open question).
--     Today, claimants conflate the two in the `uncertainties` free-text
--     blob; splitting them out lets the reviewer see the hypothesis cycle
--     explicitly and lets the narrative-quality helper stop demanding a
--     "hypothesis-shaped phrase" inside `uncertainties` when one exists.
--
--   - `uncertainty_identified_at` (TEXT NULL, ISO date): when the team
--     identified the technological uncertainty. Helps prove contemporaneity
--     to a CRA reviewer — i.e. that the SR&ED framing existed during the
--     claim period and isn't a post-hoc rationalisation. ISO date shape is
--     enforced with the same `GLOB '????-??-??'` pattern used elsewhere
--     (labour_entries.work_date, expenses.expense_date, evidence_items.evidence_date).
--
-- Both columns also land on `project_revisions` so each snapshot is
-- self-contained — a later narrative edit that adds or revises the
-- hypothesis must capture the prior values for the audit trail. The
-- snapshot mirror is the same pattern migration 003 used for `type`/`phase`.
--
-- Migration mechanics: both columns are nullable and additive, so SQLite
-- can apply them with `ALTER TABLE ... ADD COLUMN` even though the date
-- column carries a CHECK constraint (SQLite 3.25+ allows CHECK on
-- ALTER TABLE ADD COLUMN as long as the column is NULL-able or has a
-- non-NULL default). No table-recreate dance needed.

ALTER TABLE projects ADD COLUMN hypothesis TEXT;
ALTER TABLE projects ADD COLUMN uncertainty_identified_at TEXT
  CHECK (uncertainty_identified_at IS NULL OR uncertainty_identified_at GLOB '????-??-??');

ALTER TABLE project_revisions ADD COLUMN hypothesis TEXT;
ALTER TABLE project_revisions ADD COLUMN uncertainty_identified_at TEXT
  CHECK (uncertainty_identified_at IS NULL OR uncertainty_identified_at GLOB '????-??-??');
