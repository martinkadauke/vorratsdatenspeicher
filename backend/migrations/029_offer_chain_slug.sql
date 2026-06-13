-- The Marktguru retailer slug (advertiser.uniqueName, e.g. "lidl") so we can link
-- to the human-viewable prospectus at marktguru.de/rp/<slug>-prospekte.
ALTER TABLE offer ADD COLUMN IF NOT EXISTS chain_slug TEXT;
