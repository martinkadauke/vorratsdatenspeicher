-- Richer offer rows for the Marktguru API source (brand, old price, image, etc.).
-- The web-search path still works; these columns are nullable / defaulted.
ALTER TABLE offer ADD COLUMN IF NOT EXISTS brand     TEXT;
ALTER TABLE offer ADD COLUMN IF NOT EXISTS old_price TEXT;
ALTER TABLE offer ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE offer ADD COLUMN IF NOT EXISTS unit      TEXT;
ALTER TABLE offer ADD COLUMN IF NOT EXISTS source    TEXT NOT NULL DEFAULT 'web';
