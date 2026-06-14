-- Per-product pricing unit ("base_unit") + a managed unit list, so comparison
-- prices are computed in the right unit: Thunfisch per Stück, Milch per Liter,
-- Käse per kg. base_unit is the product's headline/anchor unit; the article view
-- still shows every observed unit's comparison price separately.

ALTER TABLE canonical_meta ADD COLUMN IF NOT EXISTS base_unit TEXT;

CREATE TABLE IF NOT EXISTS unit (
  name       TEXT PRIMARY KEY,            -- display + match key, e.g. 'Stück', 'kg'
  dimension  TEXT NOT NULL,               -- 'count' | 'mass' | 'volume'
  to_base    NUMERIC NOT NULL DEFAULT 1,  -- factor to the dimension base (mass→kg, volume→l, count→unit)
  sort_order INT NOT NULL DEFAULT 0,
  builtin    BOOLEAN NOT NULL DEFAULT FALSE
);

INSERT INTO unit (name, dimension, to_base, sort_order, builtin) VALUES
  ('Stück',   'count',  1,     10, TRUE),
  ('Packung', 'count',  1,     20, TRUE),
  ('Dose',    'count',  1,     30, TRUE),
  ('kg',      'mass',   1,     40, TRUE),
  ('g',       'mass',   0.001, 50, TRUE),
  ('100g',    'mass',   0.1,   60, TRUE),
  ('l',       'volume', 1,     70, TRUE),
  ('ml',      'volume', 0.001, 80, TRUE)
ON CONFLICT (name) DO NOTHING;
