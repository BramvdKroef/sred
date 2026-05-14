-- Track which user_claimants rows were bulk-flipped to 'inactive' by a
-- `POST /api/users/:id/deactivate` call (vs. independently deactivated for
-- other reasons — e.g., the employee left one of the claimants while still
-- working for another). `reactivate` consults this column to flip back only
-- those attachments it itself disabled, then clears the marker.
--
-- Nullable: the column is NULL whenever the attachment was not deactivated
-- as part of a user-level deactivate (which is the steady state for active
-- attachments and for ones disabled independently).
--
-- References users(id) — the value is the same as the row's user_id in
-- practice, but having it as a separate column keeps the "this row was
-- deactivated together with user X" semantics explicit and makes future
-- variations (e.g., admin-initiated deactivate that targets a different
-- user) trivially representable.

ALTER TABLE user_claimants ADD COLUMN deactivated_with_user_id INTEGER
  REFERENCES users(id);
