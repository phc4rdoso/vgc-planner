-- When a gameplan was first saved to the account. Imports (Import JSON, adding a shared gameplan, bringing this
-- device's gameplans) always save new gameplans, so for them this is when they were imported. NULL for gameplans
-- saved before this column existed: their creation date was never recorded.
ALTER TABLE plans ADD COLUMN created_at INTEGER;
