-- "Diese Kategorie hat ein Mensch gewählt."
--
-- Bis hierher gab es dieses Wissen nicht. `artikel.user_corrected` wird gesetzt, wenn jemand den
-- NAMEN korrigiert — eine reine Kategorie-Änderung setzte gar nichts. Damit war "der Vollauf soll
-- Handkorrekturen in Ruhe lassen" nicht implementierbar: das einzige verfügbare Flag hätte 1109
-- von 2810 Artikeln geschützt, bei denen nie ein Mensch die Kategorie angefasst hat.
--
-- ⚠️ Der Vollauf überspringt künftig genau die Zeilen mit diesem Flag — aber NUR solange ihr Pfad
-- im Katalog noch existiert. Eine Entscheidung, die auf eine gelöschte Kategorie zeigt, bewahrt
-- nichts mehr; dort gibt es keine Absicht mehr zu schützen.
ALTER TABLE artikel ADD COLUMN IF NOT EXISTS category_user_set BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS ix_artikel_cat_user_set ON artikel(category_user_set) WHERE category_user_set;

COMMENT ON COLUMN artikel.category_user_set IS
  'Ein Mensch hat category_path gesetzt — der Vollauf der Neukategorisierung überspringt diese Zeile';
