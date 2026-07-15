-- Store/shop contact details, filled automatically by the enrichment runner (OSM for the
-- physical address + website/phone, web-search for shop websites) instead of manual entry.
ALTER TABLE store_branch ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE store_branch ADD COLUMN IF NOT EXISTS phone TEXT;
