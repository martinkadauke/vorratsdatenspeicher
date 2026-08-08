-- Einladung eines Haushaltsmitglieds, das seinen Zugang SELBST anlegt.
--
-- Warum nicht die vorhandene `auth_token`-Einladung? Die setzt voraus, dass der Admin den Nutzer
-- vorher anlegt (`auth_token.user_id NOT NULL`) — also fremde E-Mail-Adresse kennen, fremdes
-- Passwort vergeben, fremdes Konto erzeugen. Genau das wollte Martin nicht. Hier existiert vorher
-- nur das MITGLIED; der Eingeladene wird daraus sein eigener Nutzer.
--
-- Zwei Faktoren, absichtlich über zwei Kanäle:
--   * der TOKEN steckt im Link (per WhatsApp o. ä. geteilt)
--   * der CODE steht auf dem Bildschirm des Admins und wird mündlich weitergegeben
-- Wer nur den Link abfängt, kommt nicht rein.
CREATE TABLE IF NOT EXISTS member_invite (
  id               SERIAL PRIMARY KEY,
  family_member_id INT NOT NULL REFERENCES family_member(id) ON DELETE CASCADE,
  token            TEXT NOT NULL UNIQUE,          -- im Link; lang und zufällig
  code             TEXT NOT NULL,                 -- 4 Ziffern, für den zweiten Kanal
  make_admin       BOOLEAN NOT NULL DEFAULT FALSE,
  -- ⚠️ Fehlversuche gehören in die DATENBANK, nicht in eine Variable im Prozess: mehrere Repliken
  -- teilen sich keinen Speicher, und ein Neustart würde den Zähler zurücksetzen — bei vier Ziffern
  -- ist genau das der Unterschied zwischen „fünf Versuche" und „beliebig viele".
  attempts         INT NOT NULL DEFAULT 0,
  expires_at       TIMESTAMPTZ NOT NULL,
  used_at          TIMESTAMPTZ,
  created_by       INT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_member_invite_token ON member_invite (token);
-- Eine offene Einladung pro Mitglied — sonst kursieren zwei Links für dieselbe Person und niemand
-- weiß, welcher gilt.
CREATE UNIQUE INDEX IF NOT EXISTS member_invite_open_uniq
  ON member_invite (family_member_id) WHERE used_at IS NULL;

-- ── Mehrmandanten-Verdrahtung (nur Demo) ────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.household') IS NULL THEN RETURN; END IF;

  ALTER TABLE member_invite ADD COLUMN IF NOT EXISTS household_id BIGINT NOT NULL DEFAULT 1;
  ALTER TABLE member_invite ALTER COLUMN household_id
    SET DEFAULT COALESCE(NULLIF(current_setting('app.current_household', true), '')::bigint, 1);

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'member_invite_household_fk') THEN
    ALTER TABLE member_invite ADD CONSTRAINT member_invite_household_fk
      FOREIGN KEY (household_id) REFERENCES household(id);
  END IF;
  CREATE INDEX IF NOT EXISTS ix_member_invite_household ON member_invite (household_id);

  ALTER TABLE member_invite ENABLE ROW LEVEL SECURITY;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'member_invite' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON member_invite
      USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
      WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vds_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON member_invite TO vds_app;
  END IF;
END $$;
