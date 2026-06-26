-- The Filiale category-order editor saved warengruppen by writing JSON.stringify()
-- into a jsonb column. postgres.js then re-encoded that string, so the value landed
-- as a jsonb STRING (e.g. "[[\"a\"]]") instead of a jsonb ARRAY. On read it came back
-- as a string, the editor's Array.isArray() check failed, and the saved order showed
-- as empty ("disappeared"). The write now uses sql.json(); this unwraps the existing
-- double-encoded string values back into real jsonb arrays. Idempotent (only touches
-- string-typed values).
UPDATE store_branch
SET warengruppen = (warengruppen #>> '{}')::jsonb
WHERE warengruppen IS NOT NULL
  AND jsonb_typeof(warengruppen) = 'string';
