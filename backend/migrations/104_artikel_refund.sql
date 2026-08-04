-- Refunds (Erstattungen) as negative positions linked to the original purchase.
--
-- A refund is booked as ONE negative artikel position on the ORIGINAL receipt (einkauf),
-- flagged is_refund and pointing at the exact position it refunds via refund_for_artikel_id.
--
-- Two levels of effect, on purpose:
--  • SPEND (Statistik/Budget/Beleg-Netto, all position-based SUM(preis)): the negative position
--    nets automatically → a full refund brings the receipt net to 0. einkauf.gesamt_betrag (the
--    paid GROSS total, anchor for bank reconciliation) is deliberately NEVER touched.
--  • PRODUCT stats (Warenstamm count, Ø-price, Vorrat): BOTH the refund position AND the original
--    position it refunds are excluded — so a fully-returned item vanishes from product statistics
--    (no phantom second MacBook, no halved average price). See lib/refund.ts (excludeRefunded()).

ALTER TABLE artikel
  ADD COLUMN IF NOT EXISTS is_refund BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS refund_for_artikel_id INT REFERENCES artikel(id) ON DELETE SET NULL;

-- Fast lookup of "is this original position refunded?" (the NOT EXISTS in excludeRefunded()).
CREATE INDEX IF NOT EXISTS idx_artikel_refund_for ON artikel(refund_for_artikel_id)
  WHERE refund_for_artikel_id IS NOT NULL;
