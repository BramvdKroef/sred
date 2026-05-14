-- Drop projects.phase (it duplicated `status` as a lifecycle marker), and
-- rename projects.status values to use the clearer phase wording:
--   planned   → concept
--   active    → development
--   completed → complete
--
-- project_revisions.phase is also dropped (it was a shadow snapshot column).
-- The migration runner toggles foreign_keys = OFF around this file.

CREATE TABLE projects_new (
  id                  INTEGER PRIMARY KEY,
  claimant_id         INTEGER NOT NULL REFERENCES claimants(id),
  title               TEXT NOT NULL,
  field_of_science    TEXT,
  start_date          TEXT NOT NULL,
  end_date            TEXT,
  status              TEXT NOT NULL CHECK (status IN ('concept', 'development', 'complete')),
  advancement_sought  TEXT,
  uncertainties       TEXT,
  work_performed      TEXT,
  type                TEXT NOT NULL DEFAULT 'sred' CHECK (type IN ('sred', 'internal')),
  manager_user_id     INTEGER REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO projects_new
  (id, claimant_id, title, field_of_science, start_date, end_date, status,
   advancement_sought, uncertainties, work_performed, type, manager_user_id,
   created_at, updated_at)
SELECT id, claimant_id, title, field_of_science, start_date, end_date,
       CASE status WHEN 'planned'   THEN 'concept'
                   WHEN 'active'    THEN 'development'
                   WHEN 'completed' THEN 'complete'
                   ELSE status END,
       advancement_sought, uncertainties, work_performed, type, manager_user_id,
       created_at, updated_at
  FROM projects;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

-- project_revisions.phase had no CHECK constraint, so a plain DROP COLUMN works.
ALTER TABLE project_revisions DROP COLUMN phase;
