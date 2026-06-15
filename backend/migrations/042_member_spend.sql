-- Per-family-member spending, for the Analytics "wer verbraucht am meisten" view.
-- Mirrors buildShareResolver() in routes/spending.ts: an item's price is split
-- evenly across the members tagged on it. Item-level tags (artikel_consumer) win;
-- otherwise the canonical-level tags (canonical_consumer) apply.

CREATE OR REPLACE VIEW v_artikel_consumer AS
  SELECT ac.artikel_id, ac.family_member_id
  FROM artikel_consumer ac
  UNION
  SELECT a.id, cc.family_member_id
  FROM artikel a
  JOIN canonical_consumer cc ON cc.canonical_name = a.canonical_name
  WHERE NOT EXISTS (SELECT 1 FROM artikel_consumer ac2 WHERE ac2.artikel_id = a.id);

CREATE OR REPLACE VIEW v_member_spend AS
  SELECT
    e.datum,
    e.konto_id,
    a.category_path,
    a.canonical_name,
    vac.family_member_id,
    fm.name                       AS family_member,
    (a.preis / cnt.n)::numeric(12,2) AS amount      -- positive spend share
  FROM v_artikel_consumer vac
  JOIN artikel a       ON a.id = vac.artikel_id
  JOIN einkauf e       ON e.id = a.einkauf_id
  JOIN family_member fm ON fm.id = vac.family_member_id
  JOIN LATERAL (SELECT COUNT(*)::int AS n FROM v_artikel_consumer x WHERE x.artikel_id = a.id) cnt ON cnt.n > 0
  WHERE a.preis IS NOT NULL;

GRANT SELECT ON v_artikel_consumer, v_member_spend TO analytics;
