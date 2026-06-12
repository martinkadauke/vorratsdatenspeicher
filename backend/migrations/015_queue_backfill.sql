-- Backfill artikel_id for queue entries created before migration 014.
-- Match on the same key the churner uses when applying a decision:
-- COALESCE(NULLIF(ai_guess,''), name) = ai_examples. Pick the newest match.
UPDATE verifikations_queue q
SET artikel_id = (
  SELECT a.id FROM artikel a
  WHERE COALESCE(NULLIF(a.ai_guess, ''), a.name) = q.ai_examples
  ORDER BY a.id DESC
  LIMIT 1
)
WHERE q.artikel_id IS NULL AND q.ai_examples IS NOT NULL;
