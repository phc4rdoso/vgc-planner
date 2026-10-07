-- 1 once the user has picked their own display name in the app: signing in again then keeps it instead of
-- taking the name from Discord / Google.
ALTER TABLE users ADD COLUMN name_custom INTEGER NOT NULL DEFAULT 0;
