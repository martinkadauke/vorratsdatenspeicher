// Offer pipeline: for every subscribed product, search the web (SearXNG) and have
// the LLM extract whether it's currently on offer somewhere — with a cited source
// and a confidence, to guard against hallucination. Found offers are stored and
// the subscribers get an email digest + an in-app "Angebote für dich" view.
import sql from '../db.js';
import { getConfig } from '../config.js';
import { providerForTask } from '../llm/provider.js';
import { parseLlmJson } from '../llm/ollama.js';
import { searxngSearchRaw } from '../llm/searxng.js';
import { sendMail } from '../mailer.js';

let running = false;
export function isOfferSearchRunning(): boolean { return running; }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const OFFER_PROMPT =
  'Du prüfst anhand der gegebenen Web-Suchergebnisse, ob ein bestimmtes Produkt aktuell bei einem konkreten '
  + 'Laden/Kette im Angebot oder im aktuellen Prospekt ist. Erfinde NICHTS, aber sei nicht übermäßig streng. '
  + 'Antworte NUR mit JSON: {"found": boolean, "store": "Laden/Kette", "price": "Preis falls genannt, sonst null", '
  + '"valid_until": "Zeitraum falls genannt, sonst null", "source_url": "passende URL aus den Ergebnissen", '
  + '"confidence": 0.0-1.0, "reason": "kurz"}. '
  + 'found=true, wenn ein Ergebnis klar sagt, dass GENAU dieses Produkt (oder die Marke) aktuell bei einem BENANNTEN '
  + 'Laden im Prospekt/Angebot/reduziert ist — AUCH OHNE genauen Preis (dann price=null). Gib immer die source_url an. '
  + 'found=false nur, wenn es keinen klaren Hinweis auf ein aktuelles Angebot bei einem benannten Laden gibt '
  + '(z.B. nur allgemeine Shop-/Hofladen-/Preisvergleichsseiten oder irrelevante Treffer).';

interface OfferExtract {
  found?: boolean; store?: string | null; price?: string | null;
  valid_until?: string | null; source_url?: string | null; confidence?: number;
}

/** Try a few offer queries (specific → broad) and return the first with hits. */
async function offerSearchHits(product: string, region: string): Promise<{ query: string; hits: { title: string; content: string; url: string }[] }> {
  const queries = [
    region ? `${product} Angebot ${region}` : '',  // local prospectus mention
    `${product} Angebot Prospekt`,                  // chain-wide weekly offer
    `${product} Angebot`,
    `${product} reduziert`,
  ].filter(Boolean);
  for (const query of queries) {
    try {
      const hits = await searxngSearchRaw(query);
      if (hits.length) return { query, hits };
    } catch { /* try next */ }
  }
  return { query: queries[0] ?? product, hits: [] };
}

/** Region hint (city) from the household address, to bias the search locally. */
async function regionHint(): Promise<string> {
  const addr = (await getConfig('household.address')).trim();
  if (!addr) return '';
  const zip = addr.match(/\d{5}\s+([^\d,]+)/);
  if (zip) return zip[1].trim();
  return addr.split(',').pop()!.trim();
}

/** Search the web for current offers of every subscribed product. Returns stats. */
export async function runOfferSearch(): Promise<{ checked: number; found: number }> {
  if (running) throw new Error('Angebotssuche läuft bereits');
  running = true;
  try {
    const products = (await sql`SELECT DISTINCT ref FROM offer_subscription WHERE kind = 'artikel'`).map(r => r.ref as string);
    if (!products.length) return { checked: 0, found: 0 };
    const llm = await providerForTask('churner_stage2'); // the "interpret web results" model
    const region = await regionHint();

    let checked = 0, found = 0;
    for (const product of products) {
      checked++;
      try {
        const { hits } = await offerSearchHits(product, region);
        if (!hits.length) continue;
        const ex = parseLlmJson<OfferExtract>(await llm.chat({
          system: OFFER_PROMPT,
          user: JSON.stringify({ produkt: product, region, suchergebnisse: hits.slice(0, 5) }),
          json: true,
        }));
        if (!ex.found || (ex.confidence ?? 0) < 0.5 || !ex.source_url) continue; // price optional
        // de-dup: same product+store+price already seen recently
        const dupe = await sql`
          SELECT 1 FROM offer
          WHERE canonical_name = ${product}
            AND store IS NOT DISTINCT FROM ${ex.store ?? null}
            AND price IS NOT DISTINCT FROM ${ex.price ?? null}
            AND found_at > NOW() - INTERVAL '6 days'
          LIMIT 1`;
        if (dupe.length) continue;
        await sql`
          INSERT INTO offer (canonical_name, store, price, valid_until, source_url, confidence)
          VALUES (${product}, ${ex.store ?? null}, ${ex.price ?? null}, ${ex.valid_until ?? null}, ${ex.source_url}, ${ex.confidence ?? null})`;
        found++;
      } catch { /* skip this product */ }
      await sleep(800); // gentle on SearXNG
    }
    return { checked, found };
  } finally {
    running = false;
  }
}

/** Debug helper: show the raw SearXNG hits + LLM extraction for one product. */
export async function debugOfferSearch(product: string): Promise<unknown> {
  const region = await regionHint();
  let query = '';
  let hits: { title: string; content: string; url: string }[] = [];
  let llmRaw = '';
  let parsed: unknown = null;
  let error: string | null = null;
  try {
    ({ query, hits } = await offerSearchHits(product, region));
    const llm = await providerForTask('churner_stage2');
    llmRaw = await llm.chat({
      system: OFFER_PROMPT,
      user: JSON.stringify({ produkt: product, region, suchergebnisse: hits.slice(0, 5) }),
      json: true,
    });
    parsed = parseLlmJson<OfferExtract>(llmRaw);
  } catch (e) { error = (e as Error).message; }
  return { query, region, hitCount: hits.length, hits, llmRaw, parsed, error };
}

interface OfferRow { id: number; canonical_name: string; store: string | null; price: string | null; valid_until: string | null; source_url: string | null }

/** Email each subscriber a digest of newly-found offers for their products,
 *  then mark those offers notified. */
export async function sendOfferDigests(): Promise<void> {
  const fresh = await sql`
    SELECT id, canonical_name, store, price, valid_until, source_url
    FROM offer WHERE notified = FALSE AND found_at > NOW() - INTERVAL '2 days'
  ` as unknown as OfferRow[];
  if (!fresh.length) return;

  // user → email, and which canonicals they subscribed to
  const subs = await sql`
    SELECT s.ref, u.id AS user_id, u.email
    FROM offer_subscription s JOIN users u ON u.id = s.user_id
    WHERE s.kind = 'artikel' AND u.email IS NOT NULL AND u.email <> ''`;
  const byUser = new Map<number, { email: string; refs: Set<string> }>();
  for (const s of subs) {
    const e = byUser.get(s.user_id as number) ?? { email: s.email as string, refs: new Set<string>() };
    e.refs.add(s.ref as string);
    byUser.set(s.user_id as number, e);
  }

  for (const { email, refs } of byUser.values()) {
    const mine = fresh.filter(o => refs.has(o.canonical_name));
    if (!mine.length) continue;
    const lines = mine.map(o =>
      `• ${o.canonical_name}: ${o.store ?? '?'}${o.price ? ` – ${o.price}` : ''}`
      + `${o.valid_until ? ` (bis ${o.valid_until})` : ''}\n    Quelle: ${o.source_url}`,
    ).join('\n\n');
    try {
      await sendMail(email, 'VDS: Angebote für deine Artikel', `Neue Angebote für deine abonnierten Artikel:\n\n${lines}\n\n(laut Web-Suche – bitte vor dem Kauf prüfen.)`);
    } catch (e) { console.error('[offers] digest mail failed:', (e as Error).message); }
  }

  await sql`UPDATE offer SET notified = TRUE WHERE id IN ${sql(fresh.map(o => o.id))}`;
}
