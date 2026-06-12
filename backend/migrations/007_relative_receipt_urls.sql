-- Convert absolute receipt photo URLs to relative paths.
-- Old: bild_pfad = 'https://vds.giziko.online/receipts/foo.jpg'
-- New: bild_pfad = '/receipts/foo.jpg'
--
-- Relative URLs load from the same origin the user is on (dev/stage/prod),
-- which then routes via NPM to the backend's fastify-static handler — no
-- cross-host TLS, no env-specific hardcoded host, and the rotate endpoint
-- works regardless of which env is serving.

UPDATE einkauf
SET bild_pfad = REGEXP_REPLACE(bild_pfad, '^https?://[^/]+/receipts/', '/receipts/')
WHERE bild_pfad LIKE 'http%://%/receipts/%';
