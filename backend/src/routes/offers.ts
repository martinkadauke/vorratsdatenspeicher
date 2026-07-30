import type { FastifyInstance } from 'fastify';
import sql, { DEMO_MODE, withHousehold } from '../db.js';
import { requireAdmin, requireOperator } from '../auth/plugin.js';
import { kontoScope } from '../auth/konto.js';
import { runOfferSearch, sendOfferDigests, isOfferSearchRunning, debugOfferSearch } from '../offers/index.js';
import { loadUnits, normalizeEinheit, comparisonGroups, unitGroup, unitGroupOf, type PriceLine } from '../lib/units.js';
import { estimateVorrat, type VorratLine, type VorratOverride } from '../lib/vorrat.js';
import { PROGRESS_FRESH_MS } from '../maintenance/progress.js';
import { haversineKm } from '../lib/geo.js';
import { getConfig } from '../config.js';
import { householdGeo } from '../lib/household.js';
import {
  claimDemoAi, claimDemoAiUnits, aiLimitMessage, aiBurstLimitMessage, watchLimitMessage,
  DEMO_AI_PRODUCTS_PER_UNIT, DEMO_MAX_WATCHES,
} from '../demo/limits.js';

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
      SELECT id, canonical_name, store, price, old_price, ref_price, valid_until, valid_from::text, valid_to::text, source_url, confidence, found_at, brand, image_url, unit, source, chain_slug
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
      WHERE a.canonical_name IN ${sql(offered)} ${kontoScope(req.user, sql`e`)}
    ` : [];
    const metaRows = offered.length ? await sql`
      SELECT canonical_name, base_unit, consumption_per_week::float8 AS consumption_per_week, expected_price::float8 AS expected_price FROM canonical_meta WHERE canonical_name IN ${sql(offered)}
    ` : [];
    const baseUnit = new Map(metaRows.map(m => [m.canonical_name as string, (m.base_unit as string | null) ?? null]));
    const cpwMap = new Map(metaRows.map(m => [m.canonical_name as string, (m.consumption_per_week as number | null) ?? null]));
    const expMap = new Map(metaRows.map(m => [m.canonical_name as string, (m.expected_price as number | null) ?? null]));
    // Manual stock overrides — same input the pantry feeds estimateVorrat(), so the
    // offers "due" signal matches what the pantry/suggestions show.
    const overrideRows = offered.length ? await sql`
      SELECT canonical_name, menge::float8 AS menge, gesetzt_am::text AS gesetzt_am
      FROM vorrat_override WHERE canonical_name IN ${sql(offered)}
    ` : [];
    const overrideMap = new Map<string, VorratOverride>(
      overrideRows.map(o => [o.canonical_name as string, { menge: o.menge as number, gesetzt_am: o.gesetzt_am as string }]),
    );

    // Comparison-group key — central unitGroup (ALL count units = one family).
    const keyFor = (unitName: string | null | undefined): string | null => unitGroupOf(units, unitName ?? null);

    interface Line { canonical_name: string; preis: string | null; menge: string | null; einheit: string | null; datum: string }
    const byCanon = new Map<string, Line[]>();
    for (const l of lines as unknown as Line[]) {
      const arr = byCanon.get(l.canonical_name) ?? [];
      arr.push(l);
      byCanon.set(l.canonical_name, arr);
    }

    type Group = ReturnType<typeof comparisonGroups>[number];
    const pantry: Record<string, {
      avg_paid: number | null; base_unit: string | null; groups: Group[];
      last_bought: string | null; interval_days: number | null; due_in_days: number | null;
      status: 'overdue' | 'soon' | 'ok' | null; typ_qty: number | null;
      weekly_consumption: number | null; consumption_unit: string | null;
    }> = {};
    const groupsByCanon = new Map<string, Group[]>();

    for (const c of offered) {
      const rows = byCanon.get(c) ?? [];
      const groups = comparisonGroups(rows as unknown as PriceLine[], units);
      groupsByCanon.set(c, groups);
      const bu = baseUnit.get(c) ?? null;
      const buKey = keyFor(bu);
      const headline = (buKey ? groups.find(g => g.unit === buKey) : undefined) ?? groups[0] ?? null;
      // Unified consumption/replenishment model — the SAME estimateVorrat() the
      // pantry, shopping suggestions and alerts use (quantity-weighted rate +
      // optional manual override, not a plain date-interval). "Due" = when we'll
      // run out; the rhythm = how long a typical buy lasts at that rate.
      const est = estimateVorrat(rows as unknown as VorratLine[], bu, units, overrideMap.get(c) ?? null, cpwMap.get(c) ?? null, expMap.get(c) ?? null);
      const rate = est.rate_per_day;
      const weekly_consumption = rate != null ? Math.round(rate * 7 * 100) / 100 : null;
      const due_in_days = est.days_until_empty != null ? Math.round(est.days_until_empty) : null;
      const status: 'overdue' | 'soon' | 'ok' | null =
        due_in_days == null ? null : due_in_days <= 0 ? 'overdue' : due_in_days <= 7 ? 'soon' : 'ok';
      const interval_days = rate != null && rate > 0 && est.typ_qty != null && est.typ_qty > 0
        ? Math.round(est.typ_qty / rate) : null;
      pantry[c] = {
        avg_paid: headline?.avg ?? null, base_unit: bu, groups,
        last_bought: est.last_bought, interval_days, due_in_days, status, typ_qty: est.typ_qty,
        weekly_consumption, consumption_unit: est.base_unit,
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
      const offerKey = unitGroup(u);
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

    // Nearest physical branch per chain (from the household) → "nächste Filiale".
    // Chain-level offers join store_branch by the normalized chain key
    // (chain_key == offer.chain_slug for the common chains; tolerate slug suffixes).
    const slugs = [...new Set(offers.map(o => o.chain_slug as string | null).filter((s): s is string => !!s))];
    const hLat = await getConfig('household.lat');
    const hLon = await getConfig('household.lon');
    const chains: Record<string, { branch_id: number; name: string; address: string | null; distance_km: number }> = {};
    if (hLat != null && hLon != null && slugs.length) {
      const branches = await sql`
        SELECT chain_key, id, name, address, lat, lon FROM store_branch
        WHERE kind = 'filiale' AND lat IS NOT NULL AND lon IS NOT NULL
      `;
      for (const slug of slugs) {
        let best: { branch_id: number; name: string; address: string | null; distance_km: number } | null = null;
        for (const b of branches) {
          const ck = b.chain_key as string;
          if (!(ck === slug || slug.startsWith(ck) || ck.startsWith(slug))) continue;
          const d = haversineKm(hLat, hLon, Number(b.lat), Number(b.lon));
          if (!best || d < best.distance_km) {
            best = { branch_id: b.id as number, name: b.name as string, address: (b.address as string | null) ?? null, distance_km: Math.round(d * 10) / 10 };
          }
        }
        if (best) chains[slug] = best;
      }
    }

    return { offers: enriched, pantry, chains };
  });

  /** All recent offers (admin overview). */
  app.get('/api/offers', { preHandler: requireAdmin }, async () => {
    return sql`
      SELECT id, canonical_name, store, price, old_price, valid_until, source_url, confidence, found_at, brand, image_url, unit, source
      FROM offer WHERE found_at > NOW() - INTERVAL '21 days'
      ORDER BY found_at DESC LIMIT 200
    `;
  });

  /** Debug: see the raw SearXNG hits + LLM extraction for one product.
   *  requireOperator, not requireAdmin: an operator tool with no frontend caller that sends a
   *  caller-supplied `q` to the operator's PRIVATE SearXNG instance and returns the raw hit list
   *  plus the unparsed LLM output — i.e. an outbound-fetch and prompt channel into the operator's
   *  LAN, echoed verbatim, one demo signup away. Free off-demo (is_admin). */
  app.get('/api/offers/debug', { preHandler: requireOperator }, async (req, reply) => {
    const q = ((req.query as { q?: string }).q ?? '').trim();
    if (!q) return { error: 'q required' };
    // Charge kept behind the guard swap: the demo super-admin is quota-exempt (household 1), so
    // this costs the operator nothing and still bounds the call if the guard is ever loosened.
    if (DEMO_MODE) {
      const claim = await claimDemoAi(req.user?.household_id);
      if (!claim.ok) return reply.code(429).send({ error: aiLimitMessage(claim.max) });
    }
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
    // Demo only: a watch is not just a row, it is one more product EVERY later offer run walks
    // (offers/index.ts loops over DISTINCT ref) — i.e. an unbounded watch list is an unbounded
    // fan-out sitting behind a single claimed AI unit. Bound it per HOUSEHOLD, not per user: the
    // search runs in household scope, so two accounts in one household would otherwise multiply
    // a per-user bound. The COUNT is RLS-scoped (089_household_rls.sql:173) and only runs here.
    // Benign race: parallel inserts can land a row or two over the bound — irrelevant, this is an
    // order-of-magnitude guard, and the per-product charge on /refresh is the real cap.
    if (DEMO_MODE) {
      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM offer_subscription WHERE kind = 'watch'`;
      if (n >= DEMO_MAX_WATCHES) return reply.code(429).send({ error: watchLimitMessage(DEMO_MAX_WATCHES) });
    }
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
    // Pre-flight so an empty result is never silent: the search needs BOTH subscribed/watched
    // products AND a household address (for the ZIP Marktguru requires). Report why if not.
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM offer_subscription WHERE kind IN ('artikel', 'watch')`;
    if (!n) return { ok: false, reason: 'no_products' as const };
    const geo = await householdGeo();
    if (!geo.address) return { ok: false, reason: 'no_address' as const };
    // Demo only: one refresh is a BURST whose SIZE the visitor controls. The search loops over
    // every subscribed/watched product and each one can cost an LLM call — offers/index.ts only
    // takes the free Marktguru path `if (zip)`, and the ZIP is parsed out of the household's own
    // onboarding address, so an address like "Berlin" (truthy, but no 5-digit number) sends every
    // single product down the SearXNG+LLM fallback. The product list itself is visitor-grown
    // (watches here, /api/subscriptions, one watch per shopping-list item via
    // /api/shopping-list/compare). A flat unit per RUN would therefore bound clicks and not spend:
    // 5000 products = 5000 LLM calls for one unit. Charge one unit per DEMO_AI_PRODUCTS_PER_UNIT
    // products, reusing the count the pre-flight above already read. Claimed BEFORE the wipe
    // below, so a refused run never deletes the offers it isn't going to re-fetch.
    if (DEMO_MODE) {
      const units = Math.ceil(n / DEMO_AI_PRODUCTS_PER_UNIT);
      const claim = await claimDemoAiUnits(req.user?.household_id, units);
      // A run bigger than the whole bucket can never succeed — say so, instead of a generic
      // "limit reached" that suggests waiting for a counter that will never move.
      if (!claim.ok) return reply.code(429).send({
        error: units > claim.max ? aiBurstLimitMessage(units, claim.max) : aiLimitMessage(claim.max),
      });
    }
    // Wipe the caller's offers first so the re-search returns FRESH rows (prospekt
    // link, validity, chain) instead of being skipped by the cross-run de-dup.
    const refs = (await sql`
      SELECT ref FROM offer_subscription WHERE user_id = ${req.user!.id} AND kind IN ('artikel', 'watch')
    `).map(r => r.ref as string);
    if (refs.length) await sql`DELETE FROM offer WHERE canonical_name IN ${sql(refs)}`;
    // The search runs in the BACKGROUND, so on demo it must hold its OWN household-scoped
    // connection — the request's reserved connection is released when this response is sent,
    // and a fire-and-forget job on it would run unscoped (RLS → sees no subscriptions, can't
    // insert offers). withHousehold opens+pins a fresh scoped connection for the whole run.
    if (DEMO_MODE) {
      const hid = req.user!.household_id ?? 1;
      void withHousehold(hid, () => runOfferSearch()).catch(err => req.log.error(`offer refresh failed: ${err.message}`));
    } else {
      void runOfferSearch().catch(err => req.log.error(`offer refresh failed: ${err.message}`));
    }
    return { ok: true, started: true };
  });

  /** Run the offer web-search now (manual/testing); emails digests after.
   *  Demo: OPERATOR-only. requireAdmin is satisfied by every visitor for their own household, so
   *  off the operator gate this is an unbounded clone of /refresh — the same per-product LLM
   *  burst plus a digest mail on the operator's SMTP relay — but WITHOUT /refresh's pre-flight
   *  and its per-product charge. Pricing it per run would still have been the wrong fix: a run
   *  is unbounded in products, which is exactly what /refresh's per-product unit exists to price.
   *  No frontend calls this endpoint (it is a manual/testing hook), so operator-only costs the
   *  demo nothing. (The detached run below USED to carry no household scope either, so on demo
   *  it was starved to nothing by RLS; it is `withHousehold`-scoped now — see there.)
   *  Off-demo: unchanged. */
  app.post('/api/offers/search', { preHandler: DEMO_MODE ? requireOperator : requireAdmin }, async (_req, reply) => {
    if (isOfferSearchRunning()) return reply.code(409).send({ error: 'Angebotssuche läuft bereits' });
    // Belt and braces: dead while the preHandler above is operator-only (household 1 is exempt
    // from every cap), but kept so that relaxing that gate can never silently re-open an uncapped
    // LLM burst.
    if (DEMO_MODE) {
      const claim = await claimDemoAi(_req.user?.household_id);
      if (!claim.ok) return reply.code(429).send({ error: aiLimitMessage(claim.max) });
    }
    // Same background-scoping rule as /refresh above, and for the same reason: this body is
    // detached with `void`, so by the time it runs the request's reserved connection has been
    // released (and its app.current_household reset). Unscoped, runOfferSearch's
    // `SELECT ... FROM offer_subscription` is RLS-starved to zero rows and the run reports
    // {checked:0, found:0, reason:'no_products'} — a completed search that could never find
    // anything. sendOfferDigests behaves the same way. withHousehold pins a fresh scoped
    // connection around BOTH steps for the whole run. Off-demo this branch never runs.
    if (DEMO_MODE) {
      const hid = _req.user!.household_id ?? 1;
      void withHousehold(hid, async () => {
        await runOfferSearch();
        await sendOfferDigests();
      }).catch(err => _req.log.error(`offer search failed: ${err.message}`));
    } else {
      void (async () => {
        await runOfferSearch();
        await sendOfferDigests();
      })().catch(err => _req.log.error(`offer search failed: ${err.message}`));
    }
    return { ok: true, started: true };
  });
}
