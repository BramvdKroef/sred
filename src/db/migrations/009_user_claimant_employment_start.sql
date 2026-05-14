-- UC-A3 step 1 lists "name, email, employment start date" as the basic
-- onboarding fields. We previously inferred the start date from the first
-- compensation row's `effective_from`, but the two are semantically distinct:
-- a comp row can be backdated or replaced without changing when the person
-- actually started working under this claimant. Add an explicit nullable
-- column so the Admin can record it on the initial Add-employee form.
--
-- Nullable so existing rows continue to load — older attachments simply have
-- no recorded start date.

ALTER TABLE user_claimants ADD COLUMN employment_start_date TEXT;
