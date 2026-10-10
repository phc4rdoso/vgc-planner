-- The newest "What's new" item this user has been shown (ids increase with each item); NULL until the first one.
ALTER TABLE users ADD COLUMN news_seen INTEGER;
