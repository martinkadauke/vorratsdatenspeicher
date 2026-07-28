import type { TransactionSql } from 'postgres';
import sql, { DEMO_MODE } from '../db.js';
import { ocrKey } from '../lib/canonicalAlias.js';
import { DEMO_SEED_RECEIPTS } from './seedReceipts.js';
import { DEMO_SEED_ICONS } from './seedIcons.js';
import { DEMO_TREES, type DemoTreeKey } from './seedTrees.js';

/** Granularity the intro wizard offers. Defaults to 'medium' until the user picks.
 *
 *  ⚠️ The wizard — and the `categories.detail` config it mirrors — speaks GERMAN
 *  ('grob' | 'mittel' | 'fein', see Onboarding.tsx DETAILS and config.ts). The curated trees
 *  are keyed in English. Translate here and keep storing the German value, because the
 *  category-designer prompt reads it. Getting this wrong is silent: every granularity would
 *  fall back to DEFAULT_TREE and all three buttons would install the same tree. */
export const DEFAULT_TREE: DemoTreeKey = 'medium';
const TREE_ALIASES: Record<'grob' | 'mittel' | 'fein' | DemoTreeKey, DemoTreeKey> = {
  grob: 'simple', mittel: 'medium', fein: 'complex',
  simple: 'simple', medium: 'medium', complex: 'complex',
};
export function asTreeKey(v: unknown): DemoTreeKey {
  return (typeof v === 'string'
    ? TREE_ALIASES[v.trim().toLowerCase() as keyof typeof TREE_ALIASES]
    : undefined) ?? DEFAULT_TREE;
}

/** Stable identity of a seeded position, so we can re-point it when the tree changes.
 *
 *  ⚠️ Deliberately the RAW OCR text, NOT canonical_name and not name. Both of those change:
 *  correcting a wrong canonical is exactly what seedReceipts.ts gets opened for, and both are
 *  in routes/articles.ts PATCHABLE so the visitor can edit them too. original_text is neither —
 *  it is the provenance field nothing ever rewrites. Keying on a mutable field strands every
 *  household seeded by an OLDER deploy: on the next wizard click installTree() replaces the
 *  whole tree, the renamed rows match nothing here, and they keep a category_path that no
 *  longer exists in `category`. routes/spending.ts:110-125 still credits that spend to the
 *  parent via pathChain() but builds `nodes` only from rows that DO exist, so the money shows
 *  up on a parent with no leaf to drill into. Falls back to `name` when a position has no OCR
 *  text, mirroring how seedDemoHousehold derives ocr_key below. */
const itemKey = (name: string, orig: string | null) => orig || name;

/** seedIcons.ts is a GENERATED harvest, keyed by the canonical name each seeded position
 *  carried AT HARVEST TIME. routes/icons.ts resolves a picture with a plain
 *  `WHERE canonical_name IN (...)` — exact equality, no trim, no fuzzy match — so every
 *  canonical renamed in seedReceipts.ts orphans its image (the position falls back to the grey
 *  placeholder) AND leaves a dead canonical_meta row behind on every single signup. Re-key here
 *  rather than hand-editing a generated file: harvest name → the canonical it is now called.
 *  Keep this table in step whenever a `canonical` in seedReceipts.ts changes. */
const ICON_RENAMES: Record<string, string> = {
  'Bio Eier': 'Freilandeier',                             // same Kaufland egg carton, husbandry label corrected
  'Preisvorteil ': 'Preisvorteil',                         // canonical lost its stray trailing space
  'Sonnenblumensamen': 'Sonnenblume (Pflanze)',            // BAUHAUS sold the potted plant, not a seed packet
  'Tomatensauce Basilikum': 'Basilikum (Kräuterpflanze)',  // BAUHAUS "GREENBAR Basilikum" is a herb pot, not sauce
};

/** Every canonical the seeded positions actually reference. An icon for anything else is a row
 *  written into each new household that nothing will ever join to — e.g. 'Joghurt' after its
 *  position merged into 'Griechischer Joghurt', which brought its own harvested image. */
const SEEDED_CANONICALS = new Set(
  DEMO_SEED_RECEIPTS.flatMap(r => r.items.map(it => it.canonical || it.name)),
);

/** Install one of the three curated trees for a household (replacing any non-meta
 *  categories) and return the paths it contains. Meta/* is system-owned and untouched. */
async function installTree(tx: TransactionSql, householdId: number, tree: DemoTreeKey): Promise<Set<string>> {
  await tx`DELETE FROM category WHERE household_id = ${householdId} AND is_meta = FALSE`;
  const rows = DEMO_TREES[tree].map((c, i) => {
    const parts = c.path.split('/');
    return {
      path: c.path,
      parent_path: parts.length > 1 ? parts.slice(0, -1).join('/') : null,
      display: parts[parts.length - 1],
      // The curated trees are German, but the household-1 template rows we replace below carry
      // English — without c.en an EN visitor would see a fully German tree, because every
      // consumer (categories/trends/spending/statsAsk) falls back to `display` on NULL.
      display_en: c.en ?? null,
      level: parts.length,
      sort_order: i,
      emoji: c.emoji ?? null,
      is_meta: false,
      household_id: householdId,
    };
  });
  // Parents precede children in the generated data, so a single insert keeps the order.
  await tx`INSERT INTO category ${tx(rows)} ON CONFLICT DO NOTHING`;
  // Meta/Pfand + Meta/Rabatt are system categories: they survive the DELETE above (is_meta)
  // and are NOT part of the curated trees — but seeded Pfand/Rabatt positions point at them,
  // so they must be in the accepted set or those positions land uncategorised.
  const meta = (await tx`SELECT path FROM category WHERE household_id = ${householdId} AND is_meta = TRUE`)
    .map(r => r.path as string);
  return new Set([...rows.map(r => r.path), ...meta]);
}

/** Give a brand-new DEMO household finished receipts so the app has something to show the
 *  second the user lands — Belege, Artikel, Vorrat, Statistik and Finanzen are all empty and
 *  useless otherwise.
 *
 *  Everything here is PRE-COMPUTED: no OCR, no recategorize, not a single AI token. Demo
 *  households are throwaway (swept nightly) and anyone on the internet can create one, so
 *  visitors must never be able to burn API credit just by looking around. Each position
 *  carries a ready-made category for all three granularities (see seedReceipts.ts).
 *
 *  Runs inside the signup transaction on `adminSql`, which carries no app.current_household
 *  GUC — so `household_id` MUST be passed explicitly on every row or the column default
 *  silently resolves to household 1. */
export async function seedDemoHousehold(
  tx: TransactionSql, householdId: number, kontoId: number | null, tree: DemoTreeKey = DEFAULT_TREE,
): Promise<void> {
  if (!DEMO_MODE) return;
  const known = await installTree(tx, householdId, tree);

  // Product images. canonical_meta is per-household, and the job that normally fills it
  // (runIconFetch) is a scheduled churner run that a 24h-throwaway household never sees —
  // without this the seeded receipts would show a grey placeholder on every row of a page the
  // visitor reaches seconds after signing up. Pre-harvested URLs, so no SearXNG call either.
  // Re-keyed through ICON_RENAMES and filtered to the canonicals the receipts actually use, so
  // renaming a canonical can neither strand its picture nor leave a dead row behind. The Map
  // also dedupes: a rename that lands on a name the harvest already carries would otherwise put
  // two rows with the same primary key into one INSERT.
  const icons = new Map<string, string>();
  for (const i of DEMO_SEED_ICONS) {
    const name = ICON_RENAMES[i.name] ?? i.name;
    if (SEEDED_CANONICALS.has(name) && !icons.has(name)) icons.set(name, i.url);
  }
  if (icons.size) {
    await tx`INSERT INTO canonical_meta ${tx([...icons].map(([name, url]) => ({
      canonical_name: name, icon_url: url, source: 'demo-seed',
      updated_at: new Date(), updated_by: null, household_id: householdId,
    })))} ON CONFLICT DO NOTHING`;
  }

  // Dates are relative to signup (a fixed date would age badly) but CLAMPED to the first of
  // the current month: signing up on the 3rd would otherwise push most receipts into last
  // month, and Finanzen/Statistik — which open on the current month — would look empty,
  // the exact opposite of the point. Local-time parts, not UTC (a DATE column has no zone).
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  for (const r of DEMO_SEED_RECEIPTS) {
    const back = new Date(now.getFullYear(), now.getMonth(), now.getDate() - r.daysAgo);
    const datum = ymd(back < firstOfMonth ? firstOfMonth : back);

    // branch_id is intentionally omitted: the BEFORE-INSERT trigger link_store_branch()
    // derives it from roh_ladenname + household_id and creates the store_branch row.
    const [e] = await tx`
      INSERT INTO einkauf (datum, roh_ladenname, gesamt_betrag, quelle, konto_id, bild_pfad, geprueft, household_id)
      VALUES (${datum}, ${r.store}, ${r.total}, 'zettel', ${kontoId}, ${r.image}, TRUE, ${householdId})
      RETURNING id`;

    // One multi-row INSERT per receipt rather than one per item: signup holds an
    // RLS-bypassing OWNER connection (a small pool shared by every authenticated demo
    // request), so 80+ sequential round-trips per signup is real contention.
    const rows = r.items.map(it => ({
      einkauf_id: e.id as number,
      name: it.name,
      canonical_name: it.canonical,
      category_path: it.cats[tree] && known.has(it.cats[tree]!) ? it.cats[tree] : null,
      menge: it.menge,
      einheit: it.einheit,
      preis: it.preis,
      ai_guess: it.guess,
      original_text: it.orig,
      sort_order: it.sort,
      ocr_key: ocrKey(it.orig ?? it.name),
      household_id: householdId,
    }));
    if (rows.length) await tx`INSERT INTO artikel ${tx(rows)}`;
  }
}

/** The intro wizard's granularity choice: swap the household's tree and re-point the seeded
 *  positions to their pre-computed category for that tree. Deterministic and free — the
 *  three trees share an identical level-1+2 spine, so a product just moves to a coarser or
 *  finer leaf. Only the seeded receipts are touched; anything the user scanned themselves
 *  keeps whatever the real AI decided for it.
 *
 *  Runs on the request's tenant connection, so RLS already scopes it to this household. */
export async function applyDemoTree(householdId: number, tree: DemoTreeKey): Promise<void> {
  if (!DEMO_MODE) return;
  await sql.begin(async tx => {
    const known = await installTree(tx as TransactionSql, householdId, tree);
    // Identity → wanted category, pre-filtered to what the tree we just installed actually
    // contains: same guard as the seeding path, so a path the tree lacks leaves the position
    // on its current category instead of blanking it.
    const want = new Map<string, string>();
    // A few seeded positions legitimately share one raw OCR text — the two "Double Choc Cookie"
    // lines, and LIDL's Preisvorteil/Rabatt pair, both booked as "manuell hinzugefügt". Today
    // every such group wants the same path, so the Map simply dedupes them. If a later edit ever
    // gives them different paths the identity is ambiguous, and picking one would silently move
    // the other position's money: drop the key and leave both rows on the category they have.
    const ambiguous = new Set<string>();
    for (const r of DEMO_SEED_RECEIPTS) {
      for (const it of r.items) {
        const p = it.cats[tree];
        if (!p || !known.has(p)) continue;
        const k = itemKey(it.name, it.orig);
        const prev = want.get(k);
        if (prev === undefined) want.set(k, p);
        else if (prev !== p) ambiguous.add(k);
      }
    }
    for (const k of ambiguous) want.delete(k);
    if (!want.size) return;
    // Grouped by target path: a couple of dozen paths cover all ~80 positions, so this is a
    // handful of set-based UPDATEs instead of one round-trip per position — it runs on the
    // request path while the visitor waits in the intro wizard. Deliberately built from
    // `= ANY(<text array>)`, the shape this codebase already runs in production
    // (spending.ts, finances.ts, demoSweep.ts), rather than a single multi-argument unnest():
    // routes/demo.ts has ALREADY committed household.categories_detail on adminSql before
    // calling us, and it swallows a throw from here and still answers {ok:true}. A statement
    // that failed to parse would therefore roll back installTree() as well and leave the
    // household claiming a granularity whose tree was never installed — with no error the
    // visitor can see. Not a place to be clever with SQL nobody else in the backend uses.
    const byPath = new Map<string, string[]>();
    for (const [key, path] of want) {
      const keys = byPath.get(path);
      if (keys) keys.push(key); else byPath.set(path, [key]);
    }
    // The bild_pfad filter keeps us strictly on the seeded receipts: whatever the visitor
    // scanned themselves keeps the category the real AI gave it. The join key is itemKey()
    // spelled in SQL — NULLIF because JS `||` also falls through on ''.
    for (const [path, keys] of byPath) {
      await tx`
        UPDATE artikel a SET category_path = ${path}
        FROM einkauf e
        WHERE e.id = a.einkauf_id
          AND e.bild_pfad LIKE '/demo-receipts/%'
          AND COALESCE(NULLIF(a.original_text, ''), a.name) = ANY(${keys})`;
    }
  });
}
