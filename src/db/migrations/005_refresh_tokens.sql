-- Long-lived refresh tokens. The token itself is a base64url random
-- string; only its SHA-256 is stored here, so a DB leak doesn't grant
-- logins. Tokens rotate on every use: a successful refresh marks the
-- presented row as revoked and mints a new one.

CREATE TABLE refresh_tokens (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT,
  revoked_at    TEXT
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
