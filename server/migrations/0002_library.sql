-- Each user's teams and gameplans. Ids come from the app (UUIDs) and are scoped per user, so one account can never
-- reach another's rows by guessing or reusing an id. `data` is the validated JSON of the record; `version` grows on
-- every write and lets two devices notice they are editing the same thing.
CREATE TABLE teams (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE plans (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, team_id) REFERENCES teams (user_id, id) ON DELETE CASCADE
);

CREATE INDEX plans_by_team ON plans (user_id, team_id);
