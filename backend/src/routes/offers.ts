import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';
import { kontoScope } from '../auth/konto.js';
import { runOfferSearch, sendOfferDigests, isOfferSearchRunning, debugOfferSearch } from '../offers/index.js';

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
      SELECT id, canonical_name, store, price, old_price, valid_until, source_url, confidence, found_at, brand, image_url, unit, source, chain_slug
      FROM offer
      WHERE canonical_name IN ${sql(refs)} AND found_at > NOW() - INTERVAL '21 days'
      ORDER BY found_at DESC LIMIT 200
    `;

    // Per offered canonical: avg paid price + purchase rhythm (konto-scoped to the user).
    const offered = [...new Set(offers.map(o => o.canonical_name as string))];
    const hist = offered.length ? await sql`
      SELECT a.canonical_name,
             ROUND(AVG(a.preis) FILTER (WHERE a.preis > 0), 2)::float8 AS avg_paid,
             COUNT(*)::int AS n,
             MIN(e.datum)::text AS first_bought,
             MAX(e.datum)::text AS last_bought
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE a.canonical_name IN ${sql(offered)} ${kontoScope(req.user, sql`e.konto_id`)}
      GROUP BY a.canonical_name
    ` : [];

    const DAY = 86_400_000;
    const today = Date.now();
    const pantry: Record<string, {
      avg_paid: number | null; last_bought: string | null;
      interval_days: number | null; due_in_days: number | null;
      status: 'overdue' | 'soon' | 'ok' | null;
    }> = {};
    for (const h of hist) {
      const first = h.first_bought ? Date.parse(h.first_bought as string) : null;
      const last = h.last_bought ? Date.parse(h.last_bought as string) : null;
      const n = h.n as number;
      let interval_days: number | null = null, due_in_days: number | null = null;
      let status: 'overdue' | 'soon' | 'ok' | null = null;
      if (n >= 2 && first != null && last != null && last > first) {
        interval_days = Math.round((last - first) / DAY / (n - 1));
        const daysSince = Math.round((today - last) / DAY);
        due_in_days = interval_days - daysSince;
        status = due_in_days <= 0 ? 'overdue' : due_in_days <= 7 ? 'soon' : 'ok';
      }
      pantry[h.canonical_name as string] = { avg_paid: h.avg_paid as number | null, last_bought: h.last_bought as string | null, interval_days, due_in_days, status };
    }

    const enriched = offers.map(o => {
      const p = parsePrice(o.price as string | null);
      const avg = pantry[o.canonical_name as string]?.avg_paid ?? null;
      let good_price = false, discount_pct: number | null = null;
      if (p != null && avg != null && avg > 0 && p <= avg * 0.85) {
        good_price = true;
        discount_pct = Math.round((1 - p / avg) * 100);
      }
      return { ...o, good_price, discount_pct };
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

  /** Whether an offer search is currently running (for the in-app refresh button). */
  app.get('/api/offers/status', async () => ({ running: isOfferSearchRunning() }));

  /** Any user can refresh offers for the household's subscriptions from the app.
   *  Populates offers (no email digest — that's the nightly job's). Read-only
   *  accounts are blocked by the global write guard. */
  app.post('/api/offers/refresh', async (req, reply) => {
    if (isOfferSearchRunning()) return reply.code(409).send({ error: 'Angebotssuche läuft bereits' });
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
