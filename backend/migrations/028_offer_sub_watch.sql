-- Allow ad-hoc "watch" subscriptions (products the user wants offer-checked but
-- doesn't buy, e.g. "Ben & Jerry's"). Extends the kind CHECK from filiale/artikel.
ALTER TABLE offer_subscription DROP CONSTRAINT IF EXISTS offer_subscription_kind_check;
ALTER TABLE offer_subscription ADD CONSTRAINT offer_subscription_kind_check
  CHECK (kind IN ('filiale', 'artikel', 'watch'));
