-- A per-account emoji, shown as the profile avatar in the header. Resolved at
-- request time: users.emoji → the linked family member's emoji → 🤖 for admins.
ALTER TABLE users ADD COLUMN IF NOT EXISTS emoji TEXT;
