-- Read-only links to a gameplan. One link per gameplan; deleting the gameplan (or its team) ends the link.
-- The token is 256 random bits, so links can't be guessed or enumerated.
CREATE TABLE shares (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, plan_id),
  FOREIGN KEY (user_id, plan_id) REFERENCES plans (user_id, id) ON DELETE CASCADE
);
