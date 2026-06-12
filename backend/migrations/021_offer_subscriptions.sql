-- Per-user offer subscriptions. A user can subscribe to:
--   kind='filiale' , ref=store_branch.id   → offers from that branch/shop
--   kind='artikel' , ref=canonical_name    → offers for that product anywhere
-- The actual notification (push/mail) + prospectus matching is still WIP; this
-- table just persists the subscription so the buttons are functional now.
CREATE TABLE IF NOT EXISTS offer_subscription (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('filiale', 'artikel')),
  ref        TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS ix_offer_sub_user ON offer_subscription(user_id);
CREATE INDEX IF NOT EXISTS ix_offer_sub_ref  ON offer_subscription(kind, ref);
