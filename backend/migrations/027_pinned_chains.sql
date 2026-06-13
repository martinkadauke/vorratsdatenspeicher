-- Per-user "Deine Läden": the retailer chains a user pinned in the Angebote view.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pinned_chains TEXT[] NOT NULL DEFAULT '{}';
