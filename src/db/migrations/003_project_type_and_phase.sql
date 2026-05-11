-- Project classification fields. Stored values are lowercase enum strings;
-- the UI maps them to display labels (SR&ED, Internal, Concept, etc.).
-- Type 'sred' is the only kind that rolls up into a T661 export.

ALTER TABLE projects ADD COLUMN type  TEXT NOT NULL DEFAULT 'sred'
  CHECK (type IN ('sred', 'internal'));
ALTER TABLE projects ADD COLUMN phase TEXT NOT NULL DEFAULT 'concept'
  CHECK (phase IN ('concept', 'development', 'complete'));

-- Mirror onto project_revisions so each snapshot is self-contained.
ALTER TABLE project_revisions ADD COLUMN type  TEXT NOT NULL DEFAULT 'sred';
ALTER TABLE project_revisions ADD COLUMN phase TEXT NOT NULL DEFAULT 'concept';
