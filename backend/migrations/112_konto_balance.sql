-- Kontostände: ein eingegebener Startwert, ab dem VDS vorwärts rechnet, plus eine Schwelle,
-- unter die ein Konto nicht fallen soll.
--
-- Warum ein Startwert und keine Berechnung von Null: VDS kennt die Konten erst ab dem ersten
-- CSV-Import. Ohne Anker wäre jede absolute Zahl erfunden — die Bewegungen stimmen, der Nullpunkt
-- nicht. Mit Anker ist der Rest reine Addition.
ALTER TABLE konto ADD COLUMN IF NOT EXISTS balance_start      NUMERIC(12,2);
ALTER TABLE konto ADD COLUMN IF NOT EXISTS balance_start_date DATE;

-- Schwelle + Warnzustand. Nur Admins dürfen den Wert setzen (in der Route geprüft).
ALTER TABLE konto ADD COLUMN IF NOT EXISTS low_threshold NUMERIC(12,2);

-- ⚠️ Der Zustand, nicht das Ereignis. Gewarnt wird EINMAL PRO UNTERSCHREITUNG: solange dieser
-- Zeitstempel steht, gilt die Unterschreitung als gemeldet; steigt das Konto wieder über die
-- Schwelle, wird er geleert und die nächste Unterschreitung warnt erneut. Pro Beleg zu warnen
-- hieße, bei einem Konto knapp unter der Grenze nach jedem Einkauf zu warnen — und genau so
-- gewöhnt man sich ab hinzusehen.
ALTER TABLE konto ADD COLUMN IF NOT EXISTS low_notified_at TIMESTAMPTZ;

COMMENT ON COLUMN konto.balance_start      IS 'Vom Nutzer eingegebener Kontostand am balance_start_date';
COMMENT ON COLUMN konto.low_threshold      IS 'Warnschwelle; NULL = keine Warnung';
COMMENT ON COLUMN konto.low_notified_at    IS 'Gesetzt beim Warnen, geleert beim Wiederüberschreiten (einmal pro Unterschreitung)';
