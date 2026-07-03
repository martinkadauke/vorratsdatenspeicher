-- vorrat_status was the OLD externally-fed (n8n-era) pre-computed stock table.
-- Since migration 037 every stock number is computed in-app (estimateVorrat),
-- but /api/shopping-list still READ this unmaintained table — feeding the list
-- stale/missing "days left" values while pantry + suggestions computed live.
-- The last reader/writer is gone as of this migration's commit → drop it, so
-- one estimator is the single source of truth.
DROP TABLE IF EXISTS vorrat_status;
