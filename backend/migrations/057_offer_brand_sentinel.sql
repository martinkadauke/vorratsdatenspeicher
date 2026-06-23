-- Marktguru returns a sentinel brand ("thisisnobrand123") for brand-less products,
-- which we stored verbatim and which leaked into offer emails ("Bananen
-- thisisnobrand123"). Ingestion now nulls it; clear the existing rows too.
UPDATE offer SET brand = NULL WHERE brand ~* '^thisisnobrand';
