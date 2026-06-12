-- Trim stray whitespace from canonical names so "Bananen" and "Bananen "
-- collapse into one (same icon, same group). Merge collisions on the tables
-- that key by canonical_name before renaming the rest.

-- artikel: no PK on canonical_name, just trim.
UPDATE artikel SET canonical_name = TRIM(canonical_name)
WHERE canonical_name IS NOT NULL AND canonical_name <> TRIM(canonical_name);

-- canonical_meta (PK canonical_name): drop untrimmed dupes, then rename.
DELETE FROM canonical_meta m WHERE m.canonical_name <> TRIM(m.canonical_name)
  AND EXISTS (SELECT 1 FROM canonical_meta m2 WHERE m2.canonical_name = TRIM(m.canonical_name));
UPDATE canonical_meta SET canonical_name = TRIM(canonical_name)
WHERE canonical_name <> TRIM(canonical_name);

-- canonical_consumer (PK canonical_name + family_member_id)
DELETE FROM canonical_consumer c WHERE c.canonical_name <> TRIM(c.canonical_name)
  AND EXISTS (SELECT 1 FROM canonical_consumer c2
              WHERE c2.canonical_name = TRIM(c.canonical_name) AND c2.family_member_id = c.family_member_id);
UPDATE canonical_consumer SET canonical_name = TRIM(canonical_name)
WHERE canonical_name <> TRIM(canonical_name);

-- canonical_translation (PK canonical_name + lang)
DELETE FROM canonical_translation t WHERE t.canonical_name <> TRIM(t.canonical_name)
  AND EXISTS (SELECT 1 FROM canonical_translation t2
              WHERE t2.canonical_name = TRIM(t.canonical_name) AND t2.lang = t.lang);
UPDATE canonical_translation SET canonical_name = TRIM(canonical_name)
WHERE canonical_name <> TRIM(canonical_name);
