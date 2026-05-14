-- audit_log is intended as an append-only record. The HTTP layer only
-- exposes GET, but anyone with direct SQLite access (a sysadmin, an
-- attacker who steals the DB file, or a future route that gets added)
-- could otherwise UPDATE or DELETE rows. These triggers refuse both
-- so the only legitimate path is INSERT.

CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
