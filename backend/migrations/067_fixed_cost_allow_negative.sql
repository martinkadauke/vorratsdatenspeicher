-- Fixkosten dürfen negativ sein: ein negativer Monatsbetrag ist eine
-- wiederkehrende Gutschrift/Einnahme. v_transactions signiert Fixkosten mit
-- (-monthly_eur), d.h. ein negativer Fixkosten wird zu einem positiven Zufluss —
-- semantisch korrekt. Der ursprüngliche CHECK (monthly_eur >= 0) fällt weg.
ALTER TABLE fixed_cost DROP CONSTRAINT IF EXISTS fixed_cost_monthly_eur_check;
