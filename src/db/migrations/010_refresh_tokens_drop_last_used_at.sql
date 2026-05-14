-- Drop refresh_tokens.last_used_at — it was set in the same UPDATE that
-- revoked the row on rotation, so it carried no information that
-- revoked_at didn't already carry. No SELECT in the codebase reads it.
-- (The `credentials` table has a separate, still-used last_used_at — that
-- one is unrelated and untouched.)

ALTER TABLE refresh_tokens DROP COLUMN last_used_at;
