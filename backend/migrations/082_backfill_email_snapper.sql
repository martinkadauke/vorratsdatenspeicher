-- Attribute legacy e-mail + upload receipts to a household member (snapped_by_member_id).
--
-- The manual "Aufgenommen von" picker is only for AMBIGUOUS receipts (till/cash scans,
-- quelle zettel/bar) — an e-mail invoice or a dropped invoice PDF is NOT ambiguous:
--   * e-mail invoices belong to the mailbox that pulled them → attribute to that inbox
--     owner's member (imported_email.user_id is the inbox owner). Precise, per-receipt.
--   * legacy dropped invoices (quelle='upload') have no inbox link → default them to the
--     primary mailbox owner (the admin who manages invoices); re-assignable later.
-- Idempotent (only fills NULLs) and env-safe (no-ops where the source rows don't exist).

UPDATE einkauf e
   SET snapped_by_member_id = fm.id
  FROM imported_email ie
  JOIN family_member fm ON fm.id = (
    SELECT id FROM family_member WHERE user_id = ie.user_id ORDER BY sort_order, id LIMIT 1)
 WHERE e.quelle = 'email'
   AND e.id = ie.einkauf_id
   AND e.snapped_by_member_id IS NULL;

UPDATE einkauf e
   SET snapped_by_member_id = (
     SELECT fm.id FROM family_member fm
      WHERE fm.user_id = (SELECT user_id FROM user_mailbox WHERE enabled ORDER BY user_id LIMIT 1)
      ORDER BY fm.sort_order, fm.id LIMIT 1)
 WHERE e.quelle = 'upload'
   AND e.snapped_by_member_id IS NULL
   AND EXISTS (SELECT 1 FROM user_mailbox WHERE enabled);
