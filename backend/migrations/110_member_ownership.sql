-- Haushaltsmitglieder als das Zentrum des Personenmodells.
--
-- Bisher hing ein Bankkonto an einem LOGIN (`konto.user_id`). Das hat zwei stille Fehler:
--   * das Konto eines Kindes OHNE Account ist gar nicht abbildbar — es gibt keinen Login dafür
--   * `ON DELETE SET NULL`: wird der Nutzer gelöscht, verliert das Konto klanglos seinen Besitzer
-- Und es überspringt die Kette, die Martin beschrieben hat:
--   Benutzer  →  Mitglied  →  Bankkonto
-- Ein Mitglied ist die dauerhafte Person im Haushalt; ein Login ist nur eine Zugangsmöglichkeit,
-- die sie haben KANN. Deshalb wandert der Besitz vom Login auf das Mitglied.
--
-- Kardinalitäten (Martins Vorgabe):
--   Mitglied  ↔ Benutzerkonto   0..1 : 0..1
--   Mitglied  ↔ Bankkonto       n : m   (Gemeinschaftskonten gehören mehreren)
--
-- `konto.user_id` und `konto.is_shared` bleiben unangetastet: is_shared trägt an 41 Stellen im
-- Backend die Bedeutung „Haushaltskonto" und wird hier nicht umgedeutet.

-- ── 1) Ein Mitglied hat höchstens EIN Benutzerkonto, und umgekehrt ──────────────────────────
-- Partieller Index: beliebig viele Mitglieder ohne Login (Kinder, Haustiere, Gäste) sind erlaubt,
-- aber derselbe Login kann nicht zwei Personen sein.
CREATE UNIQUE INDEX IF NOT EXISTS family_member_user_uniq
  ON family_member (user_id) WHERE user_id IS NOT NULL;

-- ── 2) Ausscheiden statt löschen ────────────────────────────────────────────────────────────
-- ⚠️ Ein hartes DELETE nimmt heute die Verbrauchszuordnungen gleich mit (canonical_consumer und
-- artikel_consumer hängen mit ON DELETE CASCADE daran) und macht `einkauf.snapped_by` zu NULL.
-- Wer aus dem Haushalt ausscheidet, soll aber nicht rückwirkend nie existiert haben: das Mitglied
-- wird archiviert, verschwindet aus jeder Auswahl und behält seinen Besitz und seine Geschichte.
ALTER TABLE family_member ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- ── 3) Bankkonto-Besitz: n:m auf Mitglieder ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS konto_owner (
  konto_id         INT NOT NULL REFERENCES konto(id) ON DELETE CASCADE,
  family_member_id INT NOT NULL REFERENCES family_member(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (konto_id, family_member_id)
);
CREATE INDEX IF NOT EXISTS ix_konto_owner_member ON konto_owner (family_member_id);

-- ── 4) Bestehenden Besitz übernehmen, ohne zu raten ─────────────────────────────────────────
-- Nur dort, wo die Kette Login → Mitglied bereits eindeutig existiert. Wo `family_member.user_id`
-- nie gesetzt wurde (der Normalfall bis heute), entsteht KEINE Zuordnung — lieber leer als falsch;
-- die Oberfläche fragt danach.
INSERT INTO konto_owner (konto_id, family_member_id)
SELECT k.id, fm.id
FROM konto k
JOIN family_member fm ON fm.user_id = k.user_id
WHERE k.user_id IS NOT NULL AND k.is_shared = FALSE
ON CONFLICT DO NOTHING;

-- ── 5) Mehrmandanten-Verdrahtung (nur Demo) ─────────────────────────────────────────────────
-- Die Demo-Migrationen, die jeder Mandantentabelle household_id + RLS geben, sind längst gelaufen
-- und sehen eine später geborene Tabelle nie. Ohne diesen Block läge der Kontobesitz eines
-- Haushalts für alle anderen offen — und `assertRlsCoverage()` verweigert zu Recht den Start.
-- Auf dev / prod / self-hosted existiert `household` nicht; dort passiert hier nichts.
DO $$
BEGIN
  IF to_regclass('public.household') IS NULL THEN RETURN; END IF;

  ALTER TABLE konto_owner ADD COLUMN IF NOT EXISTS household_id BIGINT NOT NULL DEFAULT 1;
  ALTER TABLE konto_owner ALTER COLUMN household_id
    SET DEFAULT COALESCE(NULLIF(current_setting('app.current_household', true), '')::bigint, 1);

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'konto_owner_household_fk') THEN
    ALTER TABLE konto_owner ADD CONSTRAINT konto_owner_household_fk
      FOREIGN KEY (household_id) REFERENCES household(id);
  END IF;
  CREATE INDEX IF NOT EXISTS ix_konto_owner_household ON konto_owner (household_id);

  ALTER TABLE konto_owner ENABLE ROW LEVEL SECURITY;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'konto_owner' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON konto_owner
      USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
      WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vds_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON konto_owner TO vds_app;
  END IF;
END $$;
