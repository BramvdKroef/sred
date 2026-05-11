-- 1) Add 'manager' to users.role enum. SQLite needs a table recreate to
-- widen a CHECK constraint. Outgoing FKs from users: none. Inbound
-- references (credentials.user_id, etc.) survive the swap because the
-- ids and the table name are preserved.

CREATE TABLE users_new (
  id         INTEGER PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'employee')),
  status     TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO users_new (id, email, name, role, status, created_at)
  SELECT id, email, name, role, status, created_at FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- 2) Project manager assignment (nullable; managers and admins are
-- valid candidates — enforced in application code).
ALTER TABLE projects          ADD COLUMN manager_user_id INTEGER REFERENCES users(id);
ALTER TABLE project_revisions ADD COLUMN manager_user_id INTEGER REFERENCES users(id);
