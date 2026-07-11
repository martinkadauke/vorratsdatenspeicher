-- Explicit one-off marker for fixed_cost.
--
-- "One-off" = a single-month generated entry (from the Auszüge "generieren →
-- Fixkosten" flow or a bank-paired counterpart). It was previously DERIVED as
-- (end_date set AND start-month == end-month). That derivation mis-flagged a
-- genuinely RECURRING plan that merely got ended within its start month — e.g.
-- via the "Nicht mehr aktiv" button, which sets end_date to the prior month-end
-- — turning it into a phantom one-off and silently dropping it from the monthly
-- reconciliation meter.
--
-- Make it an explicit column instead: only the generate / bank-pairing flows set
-- it true.
ALTER TABLE fixed_cost ADD COLUMN IF NOT EXISTS one_off boolean NOT NULL DEFAULT false;

-- Backfill ONLY rows that carry the generate-flow signature: start on the 1st of a
-- month AND end on the last day of that SAME month (start_date = '<mon>-01', end_date
-- = last-of-month). A genuinely recurring plan that was merely ended within its start
-- month (e.g. via "Nicht mehr aktiv", which sets an arbitrary prior-month-end date and
-- almost never starts on the 1st) does NOT match, so it stays recurring — the whole
-- point of moving off the old date-derivation.
UPDATE fixed_cost
   SET one_off = true
 WHERE one_off = false
   AND end_date IS NOT NULL
   AND start_date = date_trunc('month', start_date)::date
   AND end_date = (date_trunc('month', start_date) + INTERVAL '1 month' - INTERVAL '1 day')::date;
