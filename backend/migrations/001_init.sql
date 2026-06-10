-- Vorratsdatenspeicher initial schema.
-- Existing tables (einkauf, artikel, vorrat_status, einkaufsliste, verifikations_queue,
-- vorschlag_snooze, artikel_ausschluss) are created only IF NOT EXISTS so this migration
-- is safe on the live Einkaufszettelpuppe database and still bootstraps a fresh dev DB.

-- ── legacy tables (no-ops on the live DB) ────────────────────────────────
CREATE TABLE IF NOT EXISTS einkauf (
  id            SERIAL PRIMARY KEY,
  datum         DATE NOT NULL,
  filiale_id    INT,
  gesamt_betrag NUMERIC(10,2),
  telegram_user TEXT,
  roh_ladenname TEXT,
  bild_pfad     TEXT
);

CREATE TABLE IF NOT EXISTS artikel (
  id             SERIAL PRIMARY KEY,
  einkauf_id     INT REFERENCES einkauf(id) ON DELETE CASCADE,
  name           TEXT,
  menge          NUMERIC,
  einheit        TEXT,
  preis          NUMERIC(10,2),
  kategorie      TEXT,
  original_text  TEXT,
  ai_guess       TEXT,
  canonical_name TEXT
);

CREATE TABLE IF NOT EXISTS vorrat_status (
  canonical_name   TEXT PRIMARY KEY,
  einheit          TEXT,
  avg_daily        NUMERIC,
  last_qty         NUMERIC,
  last_bought      DATE,
  est_remaining    NUMERIC,
  days_until_empty NUMERIC,
  purchase_count   INT,
  updated_at       TIMESTAMP
);

CREATE TABLE IF NOT EXISTS einkaufsliste (
  canonical_name TEXT PRIMARY KEY,
  priority       INT DEFAULT 0,
  added_by       TEXT,
  added_at       TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS verifikations_queue (
  id                 SERIAL PRIMARY KEY,
  proposed_canonical TEXT,
  raw_patterns       TEXT,
  ai_examples        TEXT,
  confidence         TEXT,
  status             TEXT DEFAULT 'pending',
  created_at         TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vorschlag_snooze (
  canonical_name TEXT PRIMARY KEY,
  snooze_bis     DATE
);

CREATE TABLE IF NOT EXISTS artikel_ausschluss (
  canonical_name TEXT PRIMARY KEY
);

-- ── categories ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS category (
  id          SERIAL PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  parent_path TEXT,
  display     TEXT NOT NULL,
  display_en  TEXT,
  level       INT NOT NULL,
  sort_order  INT DEFAULT 0,
  emoji       TEXT,
  is_meta     BOOLEAN DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS ix_category_parent ON category(parent_path);

ALTER TABLE artikel ADD COLUMN IF NOT EXISTS category_path TEXT REFERENCES category(path) ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS ix_artikel_category ON artikel(category_path);
CREATE INDEX IF NOT EXISTS ix_artikel_canonical ON artikel(canonical_name);

-- ── canonical translations (EN) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS canonical_translation (
  canonical_name TEXT NOT NULL,
  lang           TEXT NOT NULL,
  translated     TEXT NOT NULL,
  source         TEXT,
  updated_at     TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (canonical_name, lang)
);

-- ── spending goals ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spending_goal (
  id            SERIAL PRIMARY KEY,
  category_path TEXT NOT NULL DEFAULT '',
  year          INT NOT NULL,
  month         INT NOT NULL,
  goal_eur      NUMERIC(10,2) NOT NULL,
  set_at        TIMESTAMP DEFAULT NOW(),
  set_by        INT,
  UNIQUE (category_path, year, month)
);
CREATE INDEX IF NOT EXISTS ix_goal_ym ON spending_goal(year, month);

-- ── users ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  is_admin       BOOLEAN DEFAULT FALSE,
  prefers_dark   BOOLEAN DEFAULT TRUE,
  preferred_lang TEXT DEFAULT 'de',
  created_at     TIMESTAMP DEFAULT NOW()
);

-- ── family members & consumer tags ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS family_member (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT,
  emoji      TEXT,
  user_id    INT REFERENCES users(id) ON DELETE SET NULL,
  sort_order INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS canonical_consumer (
  canonical_name   TEXT NOT NULL,
  family_member_id INT NOT NULL REFERENCES family_member(id) ON DELETE CASCADE,
  is_exclusive     BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (canonical_name, family_member_id)
);

CREATE TABLE IF NOT EXISTS artikel_consumer (
  artikel_id       INT NOT NULL REFERENCES artikel(id) ON DELETE CASCADE,
  family_member_id INT NOT NULL REFERENCES family_member(id) ON DELETE CASCADE,
  PRIMARY KEY (artikel_id, family_member_id)
);

-- ── app config ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW(),
  updated_by INT
);

-- ── notifications (bell) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification (
  id         SERIAL PRIMARY KEY,
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}',
  user_id    INT REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  read_at    TIMESTAMP,
  acted_at   TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_notification_user ON notification(user_id, read_at);

-- ── maintenance log ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS maintenance_event (
  id         SERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at   TIMESTAMP,
  status     TEXT DEFAULT 'running',
  summary    JSONB
);

-- ── seed: app config defaults ────────────────────────────────────────────
INSERT INTO app_config (key, value) VALUES
  ('ollama.url',         '"http://192.168.1.238:11434"'),
  ('ollama.model',       '"qwen2.5:14b"'),
  ('churner.enabled',    'true'),
  ('churner.cron',       '"0 3 * * *"'),
  ('churner.confidence', '0.85'),
  ('churner.batch_size', '30'),
  ('searxng.url',        '"http://192.168.1.238:8089"'),
  ('app.default_lang',   '"de"')
ON CONFLICT (key) DO NOTHING;

-- ── seed: family members ─────────────────────────────────────────────────
INSERT INTO family_member (name, color, emoji, sort_order) VALUES
  ('Martin',     '#10b981', '👨', 1),
  ('Mitglied 2', '#3b82f6', '👩', 2),
  ('Mitglied 3', '#f59e0b', '🧒', 3),
  ('Mitglied 4', '#ec4899', '👶', 4)
ON CONFLICT (name) DO NOTHING;

-- Auto-tag: "Martin Eier" belongs exclusively to Martin
INSERT INTO canonical_consumer (canonical_name, family_member_id, is_exclusive)
SELECT 'Martin Eier', id, TRUE FROM family_member WHERE name = 'Martin'
ON CONFLICT DO NOTHING;

-- ── seed: category tree ──────────────────────────────────────────────────
INSERT INTO category (path, parent_path, display, display_en, level, sort_order, emoji, is_meta) VALUES
-- roots
('Lebensmittel',                NULL, 'Lebensmittel',               'Groceries',            1,  10, '🛒', FALSE),
('Drogerie & Pflege',           NULL, 'Drogerie & Pflege',          'Drugstore & Care',     1,  20, '🧴', FALSE),
('Kind & Baby',                 NULL, 'Kind & Baby',                'Kids & Baby',          1,  30, '🧸', FALSE),
('Tier',                        NULL, 'Tier',                       'Pets',                 1,  40, '🐾', FALSE),
('Haushalt & Wohnen',           NULL, 'Haushalt & Wohnen',          'Home & Living',        1,  50, '🏠', FALSE),
('Kleidung & Schuhe',           NULL, 'Kleidung & Schuhe',          'Clothing & Shoes',     1,  60, '👕', FALSE),
('Hobby & Freizeit',            NULL, 'Hobby & Freizeit',           'Hobby & Leisure',      1,  70, '🎨', FALSE),
('Lieferdienste & Gastronomie', NULL, 'Lieferdienste & Gastronomie','Delivery & Dining',    1,  80, '🍕', FALSE),
('Sonstiges',                   NULL, 'Sonstiges',                  'Miscellaneous',        1,  90, '📦', FALSE),
('Meta',                        NULL, 'Meta',                       'Meta',                 1, 100, '🔁', TRUE),
-- Lebensmittel level 2
('Lebensmittel/Obst & Gemüse',          'Lebensmittel', 'Obst & Gemüse',          'Fruit & Vegetables',     2, 10, '🥦', FALSE),
('Lebensmittel/Fleisch, Wurst & Fisch', 'Lebensmittel', 'Fleisch, Wurst & Fisch', 'Meat, Sausage & Fish',   2, 20, '🥩', FALSE),
('Lebensmittel/Vegan & Vegetarisch',    'Lebensmittel', 'Vegan & Vegetarisch',    'Vegan & Vegetarian',     2, 30, '🌱', FALSE),
('Lebensmittel/Milch & Eier',           'Lebensmittel', 'Milch & Eier',           'Dairy & Eggs',           2, 40, '🥛', FALSE),
('Lebensmittel/Brot & Backwaren',       'Lebensmittel', 'Brot & Backwaren',       'Bread & Bakery',         2, 50, '🍞', FALSE),
('Lebensmittel/Schwäbische Teigwaren',  'Lebensmittel', 'Schwäbische Teigwaren',  'Swabian Pasta',          2, 60, '🥟', FALSE),
('Lebensmittel/Trockenwaren',           'Lebensmittel', 'Trockenwaren',           'Dry Goods',              2, 70, '🍝', FALSE),
('Lebensmittel/Tiefkühl',               'Lebensmittel', 'Tiefkühl',               'Frozen',                 2, 80, '❄️', FALSE),
('Lebensmittel/Süßwaren & Snacks',      'Lebensmittel', 'Süßwaren & Snacks',      'Sweets & Snacks',        2, 90, '🍫', FALSE),
('Lebensmittel/Getränke',               'Lebensmittel', 'Getränke',               'Beverages',              2, 100, '💧', FALSE),
('Lebensmittel/Soft Drinks',            'Lebensmittel', 'Soft Drinks',            'Soft Drinks',            2, 110, '🥤', FALSE),
('Lebensmittel/Alkohol',                'Lebensmittel', 'Alkohol',                'Alcohol',                2, 120, '🍺', FALSE),
('Lebensmittel/Würzen & Saucen',        'Lebensmittel', 'Würzen & Saucen',        'Spices & Sauces',        2, 130, '🧂', FALSE),
-- Lebensmittel level 3
('Lebensmittel/Obst & Gemüse/Obst',            'Lebensmittel/Obst & Gemüse', 'Obst',            'Fruit',         3, 10, NULL, FALSE),
('Lebensmittel/Obst & Gemüse/Gemüse',          'Lebensmittel/Obst & Gemüse', 'Gemüse',          'Vegetables',    3, 20, NULL, FALSE),
('Lebensmittel/Obst & Gemüse/Salat & Kräuter', 'Lebensmittel/Obst & Gemüse', 'Salat & Kräuter', 'Salad & Herbs', 3, 30, NULL, FALSE),
('Lebensmittel/Fleisch, Wurst & Fisch/Fleisch & Geflügel',  'Lebensmittel/Fleisch, Wurst & Fisch', 'Fleisch & Geflügel',  'Meat & Poultry',      3, 10, NULL, FALSE),
('Lebensmittel/Fleisch, Wurst & Fisch/Wurst & Aufschnitt',  'Lebensmittel/Fleisch, Wurst & Fisch', 'Wurst & Aufschnitt',  'Sausage & Cold Cuts', 3, 20, NULL, FALSE),
('Lebensmittel/Fleisch, Wurst & Fisch/Fisch',               'Lebensmittel/Fleisch, Wurst & Fisch', 'Fisch',               'Fish',                3, 30, NULL, FALSE),
('Lebensmittel/Vegan & Vegetarisch/Vegane Fleischalternativen',   'Lebensmittel/Vegan & Vegetarisch', 'Vegane Fleischalternativen',   'Vegan Meat Alternatives', 3, 10, NULL, FALSE),
('Lebensmittel/Vegan & Vegetarisch/Vegane Wurst & Brotaufstrich', 'Lebensmittel/Vegan & Vegetarisch', 'Vegane Wurst & Brotaufstrich', 'Vegan Sausage & Spreads', 3, 20, NULL, FALSE),
('Lebensmittel/Vegan & Vegetarisch/Käsealternativen',             'Lebensmittel/Vegan & Vegetarisch', 'Käsealternativen',             'Cheese Alternatives',     3, 30, NULL, FALSE),
('Lebensmittel/Milch & Eier/Milch & Pflanzendrinks', 'Lebensmittel/Milch & Eier', 'Milch & Pflanzendrinks', 'Milk & Plant Drinks', 3, 10, NULL, FALSE),
('Lebensmittel/Milch & Eier/Joghurt & Quark',        'Lebensmittel/Milch & Eier', 'Joghurt & Quark',        'Yogurt & Quark',      3, 20, NULL, FALSE),
('Lebensmittel/Milch & Eier/Käse',                   'Lebensmittel/Milch & Eier', 'Käse',                   'Cheese',              3, 30, NULL, FALSE),
('Lebensmittel/Milch & Eier/Sahne & Schmand',        'Lebensmittel/Milch & Eier', 'Sahne & Schmand',        'Cream & Sour Cream',  3, 40, NULL, FALSE),
('Lebensmittel/Milch & Eier/Butter',                 'Lebensmittel/Milch & Eier', 'Butter',                 'Butter',              3, 50, NULL, FALSE),
('Lebensmittel/Milch & Eier/Eier',                   'Lebensmittel/Milch & Eier', 'Eier',                   'Eggs',                3, 60, NULL, FALSE),
('Lebensmittel/Brot & Backwaren/Brot & Toast',      'Lebensmittel/Brot & Backwaren', 'Brot & Toast',      'Bread & Toast',   3, 10, NULL, FALSE),
('Lebensmittel/Brot & Backwaren/Brötchen & Laugen', 'Lebensmittel/Brot & Backwaren', 'Brötchen & Laugen', 'Rolls & Pretzels',3, 20, NULL, FALSE),
('Lebensmittel/Brot & Backwaren/Süßes Gebäck',      'Lebensmittel/Brot & Backwaren', 'Süßes Gebäck',      'Sweet Pastries',  3, 30, NULL, FALSE),
('Lebensmittel/Trockenwaren/Nudeln & Reis',              'Lebensmittel/Trockenwaren', 'Nudeln & Reis',              'Pasta & Rice',     3, 10, NULL, FALSE),
('Lebensmittel/Trockenwaren/Mehl & Backzutaten',         'Lebensmittel/Trockenwaren', 'Mehl & Backzutaten',         'Flour & Baking',   3, 20, NULL, FALSE),
('Lebensmittel/Trockenwaren/Müsli & Cerealien',          'Lebensmittel/Trockenwaren', 'Müsli & Cerealien',          'Muesli & Cereals', 3, 30, NULL, FALSE),
('Lebensmittel/Trockenwaren/Konserven & Hülsenfrüchte',  'Lebensmittel/Trockenwaren', 'Konserven & Hülsenfrüchte',  'Canned & Legumes', 3, 40, NULL, FALSE),
('Lebensmittel/Tiefkühl/TK-Gemüse & Pommes',   'Lebensmittel/Tiefkühl', 'TK-Gemüse & Pommes',   'Frozen Vegetables & Fries', 3, 10, NULL, FALSE),
('Lebensmittel/Tiefkühl/TK-Fertiggerichte',    'Lebensmittel/Tiefkühl', 'TK-Fertiggerichte',    'Frozen Meals',              3, 20, NULL, FALSE),
('Lebensmittel/Tiefkühl/TK-Eis',               'Lebensmittel/Tiefkühl', 'TK-Eis',               'Ice Cream',                 3, 30, NULL, FALSE),
('Lebensmittel/Süßwaren & Snacks/Schokolade & Süßes', 'Lebensmittel/Süßwaren & Snacks', 'Schokolade & Süßes', 'Chocolate & Sweets', 3, 10, NULL, FALSE),
('Lebensmittel/Süßwaren & Snacks/Salzige Snacks',     'Lebensmittel/Süßwaren & Snacks', 'Salzige Snacks',     'Salty Snacks',       3, 20, NULL, FALSE),
('Lebensmittel/Süßwaren & Snacks/Kekse & Riegel',     'Lebensmittel/Süßwaren & Snacks', 'Kekse & Riegel',     'Cookies & Bars',     3, 30, NULL, FALSE),
('Lebensmittel/Getränke/Wasser & Sprudel', 'Lebensmittel/Getränke', 'Wasser & Sprudel', 'Water & Sparkling', 3, 10, NULL, FALSE),
('Lebensmittel/Getränke/Kaffee & Tee',     'Lebensmittel/Getränke', 'Kaffee & Tee',     'Coffee & Tea',      3, 20, NULL, FALSE),
('Lebensmittel/Soft Drinks/Säfte & Smoothies', 'Lebensmittel/Soft Drinks', 'Säfte & Smoothies', 'Juices & Smoothies', 3, 10, NULL, FALSE),
('Lebensmittel/Soft Drinks/Limos & Cola',      'Lebensmittel/Soft Drinks', 'Limos & Cola',      'Sodas & Cola',       3, 20, NULL, FALSE),
('Lebensmittel/Soft Drinks/Energy Drinks',     'Lebensmittel/Soft Drinks', 'Energy Drinks',     'Energy Drinks',      3, 30, NULL, FALSE),
('Lebensmittel/Würzen & Saucen/Öl & Essig',    'Lebensmittel/Würzen & Saucen', 'Öl & Essig',    'Oil & Vinegar',  3, 10, NULL, FALSE),
('Lebensmittel/Würzen & Saucen/Gewürze',       'Lebensmittel/Würzen & Saucen', 'Gewürze',       'Spices',         3, 20, NULL, FALSE),
('Lebensmittel/Würzen & Saucen/Saucen & Dips', 'Lebensmittel/Würzen & Saucen', 'Saucen & Dips', 'Sauces & Dips',  3, 30, NULL, FALSE),
-- Drogerie & Pflege
('Drogerie & Pflege/Körperpflege',          'Drogerie & Pflege', 'Körperpflege',          'Personal Care',        2, 10, NULL, FALSE),
('Drogerie & Pflege/Mund & Zähne',          'Drogerie & Pflege', 'Mund & Zähne',          'Oral Care',            2, 20, NULL, FALSE),
('Drogerie & Pflege/Reinigung & Haushalt',  'Drogerie & Pflege', 'Reinigung & Haushalt',  'Cleaning & Household', 2, 30, NULL, FALSE),
('Drogerie & Pflege/Papierwaren',           'Drogerie & Pflege', 'Papierwaren',           'Paper Goods',          2, 40, NULL, FALSE),
('Drogerie & Pflege/Apotheke',              'Drogerie & Pflege', 'Apotheke',              'Pharmacy',             2, 50, NULL, FALSE),
-- Kind & Baby
('Kind & Baby/Windeln & Pflege', 'Kind & Baby', 'Windeln & Pflege', 'Diapers & Care',  2, 10, NULL, FALSE),
('Kind & Baby/Babykost',         'Kind & Baby', 'Babykost',         'Baby Food',       2, 20, NULL, FALSE),
('Kind & Baby/Kinderkleidung',   'Kind & Baby', 'Kinderkleidung',   'Kids'' Clothing', 2, 30, NULL, FALSE),
-- Tier
('Tier/Katzenbedarf',              'Tier',              'Katzenbedarf',   'Cat Supplies', 2, 10, '🐱', FALSE),
('Tier/Katzenbedarf/Katzenfutter', 'Tier/Katzenbedarf', 'Katzenfutter',   'Cat Food',     3, 10, NULL, FALSE),
('Tier/Katzenbedarf/Katzenstreu',  'Tier/Katzenbedarf', 'Katzenstreu',    'Cat Litter',   3, 20, NULL, FALSE),
('Tier/Hundebedarf',               'Tier',              'Hundebedarf',    'Dog Supplies', 2, 20, NULL, FALSE),
('Tier/Sonstiges Tier',            'Tier',              'Sonstiges Tier', 'Other Pets',   2, 30, NULL, FALSE),
-- Haushalt & Wohnen
('Haushalt & Wohnen/Küche & Geschirr',      'Haushalt & Wohnen', 'Küche & Geschirr',      'Kitchen & Tableware', 2, 10, NULL, FALSE),
('Haushalt & Wohnen/Werkzeug & Heimwerken', 'Haushalt & Wohnen', 'Werkzeug & Heimwerken', 'Tools & DIY',         2, 20, NULL, FALSE),
('Haushalt & Wohnen/Möbel & Deko',          'Haushalt & Wohnen', 'Möbel & Deko',          'Furniture & Decor',   2, 30, NULL, FALSE),
('Haushalt & Wohnen/Garten & Pflanzen',     'Haushalt & Wohnen', 'Garten & Pflanzen',     'Garden & Plants',     2, 40, NULL, FALSE),
-- Kleidung & Schuhe
('Kleidung & Schuhe/Erwachsene',  'Kleidung & Schuhe', 'Erwachsene',  'Adults',      2, 10, NULL, FALSE),
('Kleidung & Schuhe/Schuhe',      'Kleidung & Schuhe', 'Schuhe',      'Shoes',       2, 20, NULL, FALSE),
('Kleidung & Schuhe/Accessoires', 'Kleidung & Schuhe', 'Accessoires', 'Accessories', 2, 30, NULL, FALSE),
-- Hobby & Freizeit
('Hobby & Freizeit/Bastelbedarf',           'Hobby & Freizeit', 'Bastelbedarf',           'Craft Supplies',     2, 10, NULL, FALSE),
('Hobby & Freizeit/Bücher & Zeitschriften', 'Hobby & Freizeit', 'Bücher & Zeitschriften', 'Books & Magazines',  2, 20, NULL, FALSE),
('Hobby & Freizeit/Spiele & Sport',         'Hobby & Freizeit', 'Spiele & Sport',         'Games & Sports',     2, 30, NULL, FALSE),
-- Lieferdienste & Gastronomie
('Lieferdienste & Gastronomie/Lieferdienst',   'Lieferdienste & Gastronomie', 'Lieferdienst',   'Food Delivery', 2, 10, NULL, FALSE),
('Lieferdienste & Gastronomie/Restaurant',     'Lieferdienste & Gastronomie', 'Restaurant',     'Restaurant',    2, 20, NULL, FALSE),
('Lieferdienste & Gastronomie/Café & Bäckerei','Lieferdienste & Gastronomie', 'Café & Bäckerei','Café & Bakery', 2, 30, NULL, FALSE),
-- Sonstiges
('Sonstiges/Geschenke',       'Sonstiges', 'Geschenke',       'Gifts',           2, 10, NULL, FALSE),
('Sonstiges/Bürobedarf',      'Sonstiges', 'Bürobedarf',      'Office Supplies', 2, 20, NULL, FALSE),
('Sonstiges/Elektronik',      'Sonstiges', 'Elektronik',      'Electronics',     2, 30, NULL, FALSE),
('Sonstiges/Unkategorisiert', 'Sonstiges', 'Unkategorisiert', 'Uncategorized',   2, 40, NULL, FALSE),
-- Meta (excluded from spending stats)
('Meta/Pfand',  'Meta', 'Pfand',  'Deposit',  2, 10, NULL, TRUE),
('Meta/Rabatt', 'Meta', 'Rabatt', 'Discount', 2, 20, NULL, TRUE)
ON CONFLICT (path) DO NOTHING;
