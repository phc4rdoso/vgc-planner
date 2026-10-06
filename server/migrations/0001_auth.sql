-- Accounts come from Discord or Google sign-in: no passwords or e-mail addresses are stored.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- Set once the first-login welcome tour has been closed.
  onboarded_at INTEGER,
  UNIQUE (provider, provider_id)
);

-- Only a SHA-256 hash of each session token is stored, so a leaked database can't be used to sign in.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE INDEX sessions_by_user ON sessions (user_id);
