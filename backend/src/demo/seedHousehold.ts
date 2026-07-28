import type { TransactionSql } from 'postgres';
import sql, { DEMO_MODE } from '../db.js';
import { ocrKey } from '../lib/canonicalAlias.js';
import { DEMO_SEED_RECEIPTS } from './seedReceipts.js';
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

/** Stable identity of a seeded position, so we can re-point it when the tree changes. */
const itemKey = (canonical: string | null, name: string, orig: string | null) =>
  `${canonical || name}|${orig || ''}`;

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
      display_en: null,
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
    const items = await tx`
      SELECT a.id, a.name, a.canonical_name, a.original_text
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE e.bild_pfad LIKE '/demo-receipts/%'`;
    const want = new Map<string, string | null>();
    for (const r of DEMO_SEED_RECEIPTS) {
      for (const it of r.items) want.set(itemKey(it.canonical, it.name, it.orig), it.cats[tree]);
    }
    for (const a of items) {
      const p = want.get(itemKey(a.canonical_name as string | null, a.name as string, a.original_text as string | null));
      if (p && known.has(p)) await tx`UPDATE artikel SET category_path = ${p} WHERE id = ${a.id}`;
    }
  });
}
