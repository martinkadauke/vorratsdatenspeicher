import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';
import { kontoScope } from '../auth/konto.js';
import { runOfferSearch, sendOfferDigests, isOfferSearchRunning, debugOfferSearch } from '../offers/index.js';
import { loadUnits, normalizeEinheit, comparisonGroups, type PriceLine } from '../lib/units.js';
import { PROGRESS_FRESH_MS } from '../maintenance/progress.js';

/** "0,99 €" / "1.299,00 €" → 0.99 / 1299.00. null if unparseable. */
function parsePrice(s: string | null): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[^\d.,]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function offerRoutes(app: FastifyInstance): void {
  /** Offers for the user's subscribed articles, enriched with the household's
   *  buy-rhythm ("when is it due again?") and a good-price flag vs. avg paid. */
  app.get('/api/offers/mine', async (req) => {
    const refs = (await sql`
      SELECT ref FROM offer_subscription WHERE user_id = ${req.user!.id} AND kind IN ('artikel', 'watch')
    `).map(r => r.ref as string);
    if (!refs.length) return { offers: [], pantry: {} };

    const offers = await sql`
      SELECT id, canonical_name, store, price, old_price, ref_price, valid_until, source_url, confidence, found_at, brand, image_url, unit, source, chain_slug
      FROM offer
      WHERE canonical_name IN ${sql(refs)} AND found_at > NOW() - INTERVAL '21 days'
      ORDER BY found_at DESC LIMIT 200
    `;

    // Per offered canonical: raw purchase lines (konto-scoped) → per-unit
    // comparison prices (€/kg, €/l, €/Stück …) + buy rhythm. Offers are matched
    // against the comparison price in the SAME unit (Grundpreis), so a €/kg offer
    // is judged against our €/kg history — not a mixed average.
    const offered = [...new Set(offers.map(o => o.canonical_name as string))];
    const units = await loadUnits();
    const lines = offered.length ? await sql`
      SELECT a.canonical_name, a.preis, a.menge, a.einheit, e.datum::text AS datum
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE a.canonical_name IN ${sql(offered)} ${kontoScope(req.user, sql`e.konto_id`)}
    ` : [];
    const metaRows = offered.length ? await sql`
      SELECT canonical_name, base_unit FROM canonical_meta WHERE canonical_name IN ${sql(offered)}
    ` : [];
    const baseUnit = new Map(metaRows.map(m => [m.canonical_name as string, (m.base_unit as string | null) ?? null]));

    // The comparison-group key for a unit name: mass→'kg', volume→'l', count→itself.
    const keyFor = (unitName: string | null | undefined): string | null => {
      if (!unitName) return null;
      const u = units.get(unitName);
      if (!u) return null;
      return u.dimension === 'mass' ? 'kg' : u.dimension === 'volume' ? 'l' : u.name;
    };

    interface Line { canonical_name: string; preis: string | null; menge: string | null; einheit: string | null; datum: string }
    const byCanon = new Map<string, Line[]>();
    for (const l of lines as unknown as Line[]) {
      const arr = byCanon.get(l.canonical_name) ?? [];
      arr.push(l);
      byCanon.set(l.canonical_name, arr);
    }

    const DAY = 86_400_000;
    const today = Date.now();
    type Group = ReturnType<typeof comparisonGroups>[number];
    const pantry: Record<string, {
      avg_paid: number | null; base_unit: string | null; groups: Group[];
      last_bought: string | null; interval_days: number | null; due_in_days: number | null;
      status: 'overdue' | 'soon' | 'ok' | null;
    }> = {};
    const groupsByCanon = new Map<string, Group[]>();

    for (const c of offered) {
      const rows = byCanon.get(c) ?? [];
      const groups = comparisonGroups(rows as unknown as PriceLine[], units);
      groupsByCanon.set(c, groups);
      const bu = baseUnit.get(c) ?? null;
      const buKey = keyFor(bu);
      const headline = (buKey ? groups.find(g => g.unit === buKey) : undefined) ?? groups[0] ?? null;
      const dateStrs = rows.map(r => r.datum).filter(Boolean).sort();
      const n = dateStrs.length;
      const firstStr = n ? dateStrs[0] : null;
      const lastStr = n ? dateStrs[n - 1] : null;
      let interval_days: number | null = null, due_in_days: number | null = null;
      let status: 'overdue' | 'soon' | 'ok' | null = null;
      if (n >= 2 && firstStr && lastStr && lastStr > firstStr) {
        interval_days = Math.round((Date.parse(lastStr) - Date.parse(firstStr)) / DAY / (n - 1));
        const daysSince = Math.round((today - Date.parse(lastStr)) / DAY);
        due_in_days = interval_days - daysSince;
        status = due_in_days <= 0 ? 'overdue' : due_in_days <= 7 ? 'soon' : 'ok';
      }
      pantry[c] = {
        avg_paid: headline?.avg ?? null, base_unit: bu, groups,
        last_bought: lastStr, interval_days, due_in_days, status,
      };
    }

    const enriched = offers.map(o => {
      const c = o.canonical_name as string;
      const groups = groupsByCanon.get(c) ?? [];
      const unitName = normalizeEinheit(o.unit as string | null);
      const u = unitName ? units.get(unitName) : undefined;
      // `price` is Marktguru's teaser (often per sub-portion); `ref_price` is the
      // real Grundpreis in `unit` (e.g. 11.10 €/kg) — prefer it. Normalise to the
      // group base (€/kg, €/l) by dividing out the unit's to_base factor.
      const raw = o.ref_price != null ? Number(o.ref_price) : parsePrice(o.price as string | null);
      const grundpreis = raw != null && Number.isFinite(raw) && u ? raw / u.to_base : (raw ?? null);
      const offerKey = u ? (u.dimension === 'mass' ? 'kg' : u.dimension === 'volume' ? 'l' : u.name) : null;
      const buKey = keyFor(baseUnit.get(c) ?? null);
      // Only judge an offer in the product's declared comparison unit (base_unit).
      // If the offer's unit differs (e.g. Marktguru gives Thunfisch per kg but we
      // track it per Stück) we can't convert reliably → no good-price flag.
      const targetKey = buKey ? (offerKey === buKey ? buKey : null) : offerKey;
      const grp = targetKey ? groups.find(g => g.unit === targetKey) : null;
      let good_price = false, discount_pct: number | null = null;
      if (grundpreis != null && grp && grp.n >= 2 && grp.avg > 0 && grundpreis <= grp.avg * 0.85) {
        good_price = true;
        discount_pct = Math.round((1 - grundpreis / grp.avg) * 100);
      }
      return {
        ...o, good_price, discount_pct,
        compare_unit: grp?.unit ?? null, avg_compare: grp?.avg ?? null,
        grundpreis: grundpreis != null ? Math.round(grundpreis * 100) / 100 : null,
        grundpreis_unit: offerKey,
      };
    });

    return { offers: enriched, pantry };
  });

  /** All recent offers (admin overview). */
  app.get('/api/offers', { preHandler: requireAdmin }, async () => {
    return sql`
      SELECT id, canonical_name, store, price, old_price, valid_until, source_url, confidence, found_at, brand, image_url, unit, source
      FROM offer WHERE found_at > NOW() - INTERVAL '21 days'
      ORDER BY found_at DESC LIMIT 200
    `;
  });

  /** Debug: see the raw SearXNG hits + LLM extraction for one product. */
  app.get('/api/offers/debug', { preHandler: requireAdmin }, async (req) => {
    const q = ((req.query as { q?: string }).q ?? '').trim();
    if (!q) return { error: 'q required' };
    return debugOfferSearch(q);
  });

  /** The user's current offers grouped by retailer chain (for the Läden view):
   *  how many of their subscribed products are on offer at each chain + the
   *  human-viewable prospectus link. */
  app.get('/api/offers/by-chain', async (req) => {
    const refs = (await sql`
      SELECT ref FROM offer_subscription WHERE user_id = ${req.user!.id} AND kind IN ('artikel', 'watch')
    `).map(r => r.ref as string);
    if (!refs.length) return [];
    return sql`
      SELECT chain_slug,
             MAX(store) AS store,
             COUNT(*)::int AS count,
             'https://www.marktguru.de/rp/' || chain_slug || '-prospekte' AS prospekt_url
      FROM offer
      WHERE canonical_name IN ${sql(refs)} AND found_at > NOW() - INTERVAL '21 days' AND chain_slug IS NOT NULL
      GROUP BY chain_slug
      ORDER BY count DESC`;
  });

  /** Ad-hoc "watch" products: things the user wants offer-checked even though they
   *  don't buy them (and so aren't in the artikel list). Stored as offer_subscription
   *  kind='watch'; the offer search and digest include them like artikel subs. */
  app.get('/api/offers/watches', async (req) =>
    (await sql`SELECT ref FROM offer_subscription WHERE user_id = ${req.user!.id} AND kind = 'watch' ORDER BY ref`)
      .map(r => r.ref as string));

  app.post('/api/offers/watches', async (req, reply) => {
    const name = String((req.body as { name?: string })?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    if (name.length > 80) return reply.code(400).send({ error: 'name too long' });
    await sql`
      INSERT INTO offer_subscription (user_id, kind, ref)
      VALUES (${req.user!.id}, 'watch', ${name})
      ON CONFLICT (user_id, kind, ref) DO NOTHING`;
    return { ok: true };
  });

  app.delete('/api/offers/watches', async (req, reply) => {
    const name = String((req.body as { name?: string })?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    await sql`DELETE FROM offer_subscription WHERE user_id = ${req.user!.id} AND kind = 'watch' AND ref = ${name}`;
    return { ok: true };
  });

  /** Whether an offer search is currently running (for the in-app refresh button).
   *  DB-backed so it's correct across replicas (the in-memory flag only reflects
   *  the replica that started the run). */
  app.get('/api/offers/status', async () => {
    const [ev] = await sql`SELECT status, progress FROM maintenance_event WHERE kind = 'offer_search.run' ORDER BY id DESC LIMIT 1`;
    const ts = (ev?.progress as { ts?: number } | null)?.ts ?? 0;
    const dbRunning = !!ev && ev.status === 'running' && ts >= Date.now() - PROGRESS_FRESH_MS;
    return { running: isOfferSearchRunning() || dbRunning };
  });

  /** Any user can refresh offers for the household's subscriptions from the app.
   *  Populates offers (no email digest — that's the nightly job's). Read-only
   *  accounts are blocked by the global write guard. */
  app.post('/api/offers/refresh', async (req, reply) => {
    if (isOfferSearchRunning()) return reply.code(409).send({ error: 'Angebotssuche läuft bereits' });
    // Wipe the caller's offers first so the re-search returns FRESH rows (prospekt
    // link, validity, chain) instead of being skipped by the cross-run de-dup.
    const refs = (await sql`
      SELECT ref FROM offer_subscription WHERE user_id = ${req.user!.id} AND kind IN ('artikel', 'watch')
    `).map(r => r.ref as string);
    if (refs.length) await sql`DELETE FROM offer WHERE canonical_name IN ${sql(refs)}`;
    void runOfferSearch().catch(err => req.log.error(`offer refresh failed: ${err.message}`));
    return { ok: true, started: true };
  });

  /** Run the offer web-search now (manual/testing); emails digests after. */
  app.post('/api/offers/search', { preHandler: requireAdmin }, async (_req, reply) => {
    if (isOfferSearchRunning()) return reply.code(409).send({ error: 'Angebotssuche läuft bereits' });
    void (async () => {
      await runOfferSearch();
      await sendOfferDigests();
    })().catch(err => _req.log.error(`offer search failed: ${err.message}`));
    return { ok: true, started: true };
  });
}
