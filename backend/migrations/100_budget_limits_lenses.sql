-- 100_budget_limits_lenses.sql — Variable Kosten: category LIMITS + overlapping LENSES.
--
-- Numbered 100, not 098: core and demo migrations share ONE number space (migrations/demo/
-- took 086-094, core resumed at 095, demo then took 098 + 099). db.ts merges both folders
-- into a single basename-sorted list, so 098 here would sort AHEAD of the demo 098 that was
-- applied weeks earlier — harmless, since tracking is per-basename, but misleading to read.
--
-- The redesign in one paragraph: a per-category "tracker" is DERIVED from the category
-- spend tree that already exists (see /api/spending/tree) — every category therefore
-- always shows up with its real spend, and there is nothing to create, reset or re-attach
-- when the category tree changes. The only STORED part is an optional LIMIT: a budget row
-- keyed to ONE category path. A category without a limit shows its spend and the words
-- "kein Ziel" — never 0,00, which would read as "instantly over budget".
--
-- A LENS is the other half: a budget over SEVERAL categories and/or over single articles
-- ("Energydrinks" = three canonicals living in three different categories). Lenses overlap
-- the category tree ON PURPOSE, so they get their own block and are EXCLUDED from the
-- variable-cost total. That total is untouched by this migration: it stays the month's
-- true spend with every receipt line counted ONCE, plus one-off costs — never the sum of
-- (overlapping) budget actuals.
--
-- ⚠️ NOT demo-only. This file runs on the owner's real dev database, on prod, and on every
-- self-hosted install that already holds live household data. Everything below is additive
-- and idempotent; nothing is dropped or rewritten, and every budget that exists today keeps
-- producing the exact same number it produces now.

-- ── 1) A limit is now OPTIONAL ──────────────────────────────────────────────
-- A lens may exist purely to OBSERVE a group ("what do I actually spend on Energydrinks?")
-- without ever committing to a goal. Dropping a NOT NULL rewrites no rows and is a no-op
-- when re-applied, so no guard is needed.
ALTER TABLE budget ALTER COLUMN monthly_target DROP NOT NULL;

-- ── 2) Discriminator: limit vs lens ─────────────────────────────────────────
-- Existing rows are CLASSIFIED, never deleted:
--     exactly 1 category path  →  'category'  (a limit on that one tree node)
--     0 or 2+ category paths   →  'lens'      (an overlapping group)
--
-- Why this rule cannot mis-file the owner's real budgets:
--  * It reads ONLY budget_category — the very data the month view already prefix-matches
--    on. It never guesses from the label, so no naming ("Essen", "Obst") can fool it.
--  * A 1-path budget's actual today IS the subtree spend of that one category node
--    (prefix match on category_path), i.e. bit-for-bit the number a category limit shows.
--    Re-labelling it a limit changes the storage, not the arithmetic.
--  * A 2+-path budget cannot be pinned to a single tree node without inventing one; it is
--    by definition an overlapping group. As a lens it is rendered exactly like the row it
--    is today: own block, own actual, own target.
--  * The 068-era CRUD refuses to store a budget with zero categories, so the 0 case should
--    not exist in real data. It is folded into 'lens' anyway because there is no path to
--    key a limit to — the defensive branch can only ever mis-file a row that is already
--    broken, and it mis-files it into the harmless, non-authoritative bucket.
--
-- The backfill is deliberately written as "WHERE kind IS NULL" instead of leaning on a
-- column DEFAULT: re-applying this file must never RE-classify rows the user has since
-- typed by hand (a single-category LENS would otherwise silently become a category limit).
ALTER TABLE budget ADD COLUMN IF NOT EXISTS kind TEXT;
UPDATE budget b
   SET kind = CASE WHEN (SELECT COUNT(*) FROM budget_category bc WHERE bc.budget_id = b.id) = 1
                   THEN 'category' ELSE 'lens' END
 WHERE b.kind IS NULL;
-- (Migrations run on the OWNER connection, which bypasses RLS — on the multi-tenant demo
--  this classifies every household's rows, not just household 1.)
--
-- DEFAULT 'lens', not 'category'. The default is reachable by exactly one writer: the OLD
-- backend, whose POST/PATCH /api/budgets never sends `kind`, talking to an already-migrated
-- database. That happens for real — a Swarm rolling update keeps the old task serving after
-- the new one has committed this file, and the documented auto-rollback puts the old image
-- back after a post-migrate boot crash. Such a writer can store ANY number of
-- budget_category rows, and nothing in the schema ties kind='category' to exactly one of
-- them, so the default has to be the bucket that stays harmless when the row is malformed:
--   * 'category' + 3 paths → the month view emits the SAME limit on three tree nodes (one
--     row per path, no dedupe by budget id) and suppresses all three from "Unbudgetiert";
--     the UI cannot repair it either, since `kind` is immutable and a limit refuses to save
--     with ≠1 category. Delete + recreate would be the only way out.
--   * 'category' + 0 paths → dropped by the limit query's INNER JOIN: invisible in the tree,
--     in the lenses and in orphanLimits, i.e. impossible to ever see or fix.
-- A lens has none of those failure modes: it overlaps the tree by design, is excluded from
-- the variable-cost total, suppresses nothing, and renders whatever membership it happens to
-- have. Same argument the 0-path branch above already makes — an ambiguous row belongs in
-- the non-authoritative bucket.
ALTER TABLE budget ALTER COLUMN kind SET DEFAULT 'lens';
ALTER TABLE budget ALTER COLUMN kind SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_kind_chk') THEN
    ALTER TABLE budget ADD CONSTRAINT budget_kind_chk CHECK (kind IN ('category', 'lens'));
  END IF;
END $$;
-- Deliberately NO trigger enforcing "kind='category' ⇒ exactly one budget_category row":
-- every writer, old and new, edits the membership by DELETING all rows and re-INSERTing
-- them inside one transaction, so a row-level trigger would fire on the empty intermediate
-- state and reject a perfectly legal edit. The invariant is upheld by the API (POST/PATCH
-- refuse ≠1 category for a limit) and, for the writer that predates it, by the 'lens'
-- default above, which makes a violation harmless instead of unrepairable.

-- ── 3) Article membership for lenses ────────────────────────────────────────
-- Deliberately NO foreign key to canonical_meta — this mirrors budget_category's missing
-- FK to category (068). Canonical names live as free text on artikel and get renamed or
-- merged by the churner; an FK would either block that rename or cascade the user's lens
-- away behind their back. A membership that points at a name nobody buys any more is
-- simply worth 0 € and stays visible/editable.
CREATE TABLE IF NOT EXISTS budget_article (
  budget_id      INT  NOT NULL REFERENCES budget(id) ON DELETE CASCADE,
  canonical_name TEXT NOT NULL,
  PRIMARY KEY (budget_id, canonical_name)
);
CREATE INDEX IF NOT EXISTS ix_budget_article_canonical ON budget_article(canonical_name);

-- ── 4) Reverse lookup index ─────────────────────────────────────────────────
-- The month view now walks the OTHER way round — for each category node in the tree, find
-- the limit keyed to it — and the PK (budget_id, category_path) cannot serve a lookup that
-- leads with category_path.
CREATE INDEX IF NOT EXISTS ix_budget_category_path ON budget_category(category_path);

-- Same read-only surface the analytics role got for budget/budget_category in 068.
GRANT SELECT ON budget_article TO analytics;

-- ── 4b) Carry the OLD per-month category goals over into limits ──────────────
-- The Statistik page owned a second, parallel goal store: spending_goal(category_path,
-- year, month, goal_eur), written by its inline ✏️ cell. That page is gone and its two
-- readers (/api/goals, /api/spending/tree's goalMap) now have no caller, so without this
-- block every goal the user ever set would still exist in the database and yet be
-- invisible, uneditable and undeletable — the category would simply read "kein Ziel".
--
-- Rules, chosen so this can only ever ADD something the user asked for:
--  * MOST RECENT goal per path wins (DISTINCT ON … ORDER BY year DESC, month DESC). A goal
--    is per-month in the old model and standing in the new one; the last value the user
--    typed is the only defensible standing value.
--  * Only paths the catalogue still knows (JOIN category) — a goal on a path a redesign
--    removed would land in the "Ziele ohne Kategorie" block with nothing to re-point it to.
--  * category_path = '' (the old household-wide TOTAL goal) is skipped: the tree's total
--    node is not a category and carries no limit. Those rows stay in spending_goal, so the
--    figure is recoverable, and nothing about them changes.
--  * Skipped entirely when a household-wide limit already claims the path, so the user's
--    NEW goal always wins over the old one and re-running this file is a no-op.
-- spending_goal itself is left completely untouched — no row is deleted or rewritten.
DO $$
DECLARE r RECORD; new_id INT;
BEGIN
  IF to_regclass('public.spending_goal') IS NULL THEN RETURN; END IF;
  -- Multi-tenant (demo) installs are skipped ON PURPOSE. Migrations run on the OWNER
  -- connection, which bypasses RLS and has no app.current_household GUC set, so every
  -- budget row created here would take household_id's constant default of 1 — i.e. one
  -- tenant's goals would surface as household #1's limits. The demo is a throwaway
  -- sandbox; a cross-tenant leak to fix a data-continuity problem is a bad trade.
  IF to_regclass('public.household') IS NOT NULL THEN RETURN; END IF;

  FOR r IN
    SELECT DISTINCT ON (g.category_path)
           g.category_path, g.goal_eur, c.display,
           -- spending_goal.set_by carries no FK (001), budget.created_by does — resolve it
           -- through users so a goal set by a since-deleted account still migrates.
           (SELECT u.id FROM users u WHERE u.id = g.set_by) AS set_by
      FROM spending_goal g
      JOIN category c ON c.path = g.category_path
     WHERE g.category_path <> ''
       AND NOT EXISTS (
             SELECT 1 FROM budget bu JOIN budget_category bc ON bc.budget_id = bu.id
              WHERE bu.active AND bu.kind = 'category'
                AND bu.konto_id IS NULL AND bc.category_path = g.category_path)
     ORDER BY g.category_path, g.year DESC, g.month DESC
  LOOP
    INSERT INTO budget (label, monthly_target, konto_id, kind, active, created_by)
    VALUES (r.display, r.goal_eur, NULL, 'category', TRUE, r.set_by)
    RETURNING id INTO new_id;
    INSERT INTO budget_category (budget_id, category_path) VALUES (new_id, r.category_path);
  END LOOP;
END $$;

-- ── 5) Multi-tenant (demo) wiring for the ONE new table ─────────────────────
-- The demo migrations that give every tenant table its household_id + RLS policy
-- (migrations/demo/086, 089, 093) have already run and are tracked, so they will never see
-- a table born later in a CORE migration. Without this block one household's lens article
-- list would be readable by every other household on the public demo.
-- Guarded on the household registry existing, so dev / prod / self-hosted installs — which
-- have no `household` table at all — skip the whole block and stay byte-identical.
DO $$
BEGIN
  IF to_regclass('public.household') IS NULL THEN RETURN; END IF;

  -- Constant default first (fast default, exactly as 086 does), then the GUC-aware default
  -- from 093 so a tenant-connection INSERT that omits household_id lands in the REQUEST's
  -- household instead of silently defaulting to #1 and failing the RLS WITH CHECK.
  ALTER TABLE budget_article ADD COLUMN IF NOT EXISTS household_id BIGINT NOT NULL DEFAULT 1;
  ALTER TABLE budget_article ALTER COLUMN household_id
    SET DEFAULT COALESCE(NULLIF(current_setting('app.current_household', true), '')::bigint, 1);

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_article_household_fk') THEN
    ALTER TABLE budget_article ADD CONSTRAINT budget_article_household_fk
      FOREIGN KEY (household_id) REFERENCES household(id);
  END IF;
  CREATE INDEX IF NOT EXISTS ix_budget_article_household ON budget_article (household_id);

  ALTER TABLE budget_article ENABLE ROW LEVEL SECURITY;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'budget_article' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON budget_article
      USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
      WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);
  END IF;

  -- 089 set ALTER DEFAULT PRIVILEGES for vds_app, which already covers owner-created
  -- tables; the explicit grant is belt and braces in case the default privileges were
  -- attached to a different creating role.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vds_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON budget_article TO vds_app;
  END IF;
END $$;
