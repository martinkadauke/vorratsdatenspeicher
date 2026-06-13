import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';
import { runOfferSearch, sendOfferDigests, isOfferSearchRunning, debugOfferSearch } from '../offers/index.js';

export function offerRoutes(app: FastifyInstance): void {
  /** Offers found for the things the current user subscribed to. */
  app.get('/api/offers/mine', async (req) => {
    const refs = (await sql`
      SELECT ref FROM offer_subscription WHERE user_id = ${req.user!.id} AND kind = 'artikel'
    `).map(r => r.ref as string);
    if (!refs.length) return [];
    return sql`
      SELECT id, canonical_name, store, price, old_price, valid_until, source_url, confidence, found_at, brand, image_url, unit, source
      FROM offer
      WHERE canonical_name IN ${sql(refs)} AND found_at > NOW() - INTERVAL '21 days'
      ORDER BY found_at DESC LIMIT 100
    `;
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
