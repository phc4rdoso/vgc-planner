-- The account's profile picture: one of the names in src/domain/avatars.ts (a file in public/avatars).
-- Picked at random when the account is created; accounts from before this get one on their next visit.
ALTER TABLE users ADD COLUMN avatar TEXT;
