-- Flag a labour entry as overtime. v1 treats it as a reporting marker
-- only — the hourly rate used by the T661 calculation is unchanged.
-- (1.5x cost is a downstream conversation between admin and payroll;
-- adding a multiplier here would change historical totals.)

ALTER TABLE labour_entries ADD COLUMN is_overtime INTEGER NOT NULL DEFAULT 0
  CHECK (is_overtime IN (0, 1));
