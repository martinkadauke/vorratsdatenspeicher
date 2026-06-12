-- Offers found for subscribed products via web search (SearXNG) + LLM extraction.
-- Each row is "product X is on offer at store Y for price Z (per source URL)".
CREATE TABLE IF NOT EXISTS offer (
  id             SERIAL PRIMARY KEY,
  canonical_name TEXT NOT NULL,            -- the subscribed product this offer is for
  store          TEXT,                     -- chain/store the offer is at
  price          TEXT,                     -- price as found ("0,99 €")
  valid_until    TEXT,                     -- as found, free text (web dates are messy)
  source_url     TEXT,                     -- where it was found (always cited)
  confidence     NUMERIC,
  found_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified       BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS ix_offer_canon ON offer(canonical_name, found_at DESC);
CREATE INDEX IF NOT EXISTS ix_offer_found ON offer(found_at DESC);
