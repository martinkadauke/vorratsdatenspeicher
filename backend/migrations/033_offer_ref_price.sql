-- Marktguru's `price` is the eye-catching advertised price (often for a sub-
-- portion, e.g. 1.11 € "per 100 g"); `referencePrice` is the normalised
-- Grundpreis in `unit` (e.g. 11.10 €/kg). Store it so offer comparison and
-- display use the real €/kg, not the teaser price.
ALTER TABLE offer ADD COLUMN IF NOT EXISTS ref_price NUMERIC;
