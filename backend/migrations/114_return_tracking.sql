-- Eine Rücksendung von der Anmeldung bis zur bestätigten Erstattung verfolgen.
--
-- Martins Ablauf (10.11.2026): Amazon-Mail „Ihre Rücksendung von …" = angemeldet. Er scannt den
-- DHL-Einlieferungszettel = abgegeben, die Position geht automatisch auf 0. Die Erstattung bestätigt
-- dann die Bankgutschrift im CSV — oder, wenn Amazon als Guthaben erstattet, Amazons
-- Erstattungsmail, weil Guthaben nie auf dem Konto ankommt.
--
-- Die Anmeldung ist bereits eine Zeile in refund_email (status refund_suggested). Diese Spalten
-- halten fest, was danach geschieht. Bewusst KEINE eigene Tabelle: eine Rücksendung IST genau eine
-- Erstattungszeile, und die Buchung (refundReconcile) arbeitet schon auf dieser Zeile.
ALTER TABLE refund_email
  ADD COLUMN IF NOT EXISTS dropoff_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dropoff_einkauf_id INTEGER REFERENCES einkauf(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS confirmed_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmed_by       TEXT;

COMMENT ON COLUMN refund_email.dropoff_at IS
  'Rücksendung abgegeben — aus dem gescannten Einlieferungszettel oder Amazons Abgabebestätigung';
COMMENT ON COLUMN refund_email.dropoff_einkauf_id IS
  'Der gescannte Einlieferungszettel (ein 0-€-Beleg mit quelle = retoure), der diese Rücksendung abschloss';
COMMENT ON COLUMN refund_email.confirmed_by IS
  '''bank'' = Gutschrift im Bank-CSV, ''mail'' = Erstattungsmail bei Amazon-Guthaben';

-- Die Daten des Zettels selbst (Träger, Empfänger, Sendungsnummern, Uhrzeit) und — falls die
-- Zuordnung nicht eindeutig war — die Rücksendungen, zwischen denen der Nutzer wählen soll.
ALTER TABLE einkauf ADD COLUMN IF NOT EXISTS retoure_info JSONB;

CREATE INDEX IF NOT EXISTS ix_refund_email_open_return
  ON refund_email(order_ref) WHERE dropoff_at IS NULL OR confirmed_at IS NULL;
