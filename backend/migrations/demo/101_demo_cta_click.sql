-- Demo-only: interest signal from the two self-host CTAs ("Jetzt holen" / "Auf GitHub ansehen").
--
-- The operator's question is narrow — "does a demo visitor actually like this?" — and a COUNT
-- answers it completely. So nothing identifying is stored or mailed: no e-mail address, no
-- household name, no IP, no user agent. household_id is kept for ONE purpose, deduplication
-- (below), and never leaves this table.
--
-- Keeping identity out of the notification is not merely politer, it is why this needs no consent
-- flow and no Datenschutzerklärung change: an aggregate click count is not personal data, whereas
-- "this identified person clicked at 14:03" would be — collected for a purpose the count already
-- serves, which is exactly what data minimisation forbids.
--
-- Deliberately in migrations/demo/: the CTAs only render under DEMO_MODE
-- (components/InstallButton.tsx), so a self-hoster has no buttons and needs no table.
CREATE TABLE IF NOT EXISTS demo_cta_click (
  id           SERIAL PRIMARY KEY,
  target       TEXT NOT NULL CHECK (target IN ('install', 'github')),
  -- Dedup key only. Never sent anywhere, and it dies with the household on the nightly sweep.
  household_id BIGINT,
  -- The calendar day the dedup is scoped to, as a PLAIN column rather than an expression index
  -- over created_at. An index on `(created_at AT TIME ZONE 'Europe/Berlin')::date` would need
  -- that expression to be immutable, which is a bet not worth making inside a migration that
  -- must not fail halfway. CURRENT_DATE is the household's own day because the app pins the
  -- session TimeZone to Europe/Berlin (see db.ts PG_TZ) — the two changes depend on each other.
  day          DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per household per target per day: the dedup that stops a bored visitor turning the
-- operator's inbox into a denial-of-service by holding a button down. Partial on purpose — a
-- NULL household_id (should not happen, but the route fails open rather than 500 the CTA) is
-- exempt from the constraint instead of colliding with every other NULL.
CREATE UNIQUE INDEX IF NOT EXISTS ux_demo_cta_click_daily
  ON demo_cta_click (household_id, target, day)
  WHERE household_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_demo_cta_click_created ON demo_cta_click (created_at DESC);
