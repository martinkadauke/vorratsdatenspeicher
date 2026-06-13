// Offer pipeline: for every subscribed product, search the web (SearXNG) and have
// the LLM extract whether it's currently on offer somewhere — with a cited source
// and a confidence, to guard against hallucination. Found offers are stored and
// the subscribers get an email digest + an in-app "Angebote für dich" view.
import sql from '../db.js';
import { getConfig } from '../config.js';
import { providerForTask } from '../llm/provider.js';
import { parseLlmJson } from '../llm/ollama.js';
import { searxngSearchRaw } from '../llm/searxng.js';
import { searchMarktguru, type MarktguruOffer } from './marktguru.js';
import { sendMail } from '../mailer.js';
import { offerDigestEmail } from '../email/templates.js';

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

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

/** 5-digit zip from the household address (Marktguru needs a zip code). */
async function householdZip(): Promise<string> {
  const addr = (await getConfig('household.address')).trim();
  return addr.match(/\b(\d{5})\b/)?.[1] ?? '';
}

const fmtEur = (n: number | null) => (n == null ? null : `${n.toFixed(2).replace('.', ',')} €`);
const fmtDay = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : null;
function validWindow(o: MarktguruOffer): string | null {
  const a = fmtDay(o.validFrom), b = fmtDay(o.validTo);
  if (a && b) return `${a}–${b}`;
  return b ? `bis ${b}` : a;
}

/** Does this Marktguru hit plausibly match the subscribed product? (cut noise) */
function offerMatches(product: string, o: MarktguruOffer): boolean {
  const hay = fold(`${o.name} ${o.brand ?? ''} ${o.categories.join(' ')}`);
  const tokens = fold(product).split(/[^a-z0-9]+/).filter(w => w.length >= 3);
  if (!tokens.length) return true;
  return tokens.some(t => hay.includes(t));
}

/** Marktguru structured offers for one product → offer rows. Returns count inserted. */
async function marktguruForProduct(product: string, zip: string): Promise<number> {
  const offers = (await searchMarktguru(product, zip, 20)).filter(o => offerMatches(product, o)).slice(0, 6);
  let found = 0;
  for (const o of offers) {
    const store = o.retailers[0] ?? null;
    const price = fmtEur(o.price);
    const dupe = await sql`
      SELECT 1 FROM offer
      WHERE canonical_name = ${product}
        AND store IS NOT DISTINCT FROM ${store}
        AND price IS NOT DISTINCT FROM ${price}
        AND found_at > NOW() - INTERVAL '6 days'
      LIMIT 1`;
    if (dupe.length) continue;
    await sql`
      INSERT INTO offer (canonical_name, store, price, old_price, valid_until, source_url, confidence, brand, image_url, unit, source)
      VALUES (${product}, ${store}, ${price}, ${fmtEur(o.oldPrice)}, ${validWindow(o)}, ${o.url}, ${0.95}, ${o.brand ?? null}, ${o.image}, ${o.unit ?? null}, ${'marktguru'})`;
    found++;
  }
  return found;
}

/** Search the web for current offers of every subscribed product. Returns stats. */
export async function runOfferSearch(): Promise<{ checked: number; found: number }> {
  if (running) throw new Error('Angebotssuche läuft bereits');
  running = true;
  try {
    const products = (await sql`SELECT DISTINCT ref FROM offer_subscription WHERE kind = 'artikel'`).map(r => r.ref as string);
    if (!products.length) return { checked: 0, found: 0 };
    const zip = await householdZip();
    const region = await regionHint();
    let llm: Awaited<ReturnType<typeof providerForTask>> | null = null; // lazy: only if we fall back

    let checked = 0, found = 0;
    for (const product of products) {
      checked++;
      try {
        // Primary: Marktguru structured offers API (needs a zip code).
        if (zip) {
          try {
            found += await marktguruForProduct(product, zip);
            await sleep(400);
            continue;
          } catch (e) {
            console.error('[offers] marktguru failed, falling back to web:', product, (e as Error).message);
          }
        }
        // Fallback: SearXNG + LLM web search (price optional, anti-hallucination gate).
        const { hits } = await offerSearchHits(product, region);
        if (!hits.length) continue;
        llm ??= await providerForTask('churner_stage2');
        const ex = parseLlmJson<OfferExtract>(await llm.chat({
          system: OFFER_PROMPT,
          user: JSON.stringify({ produkt: product, region, suchergebnisse: hits.slice(0, 5) }),
          json: true,
        }));
        if (!ex.found || (ex.confidence ?? 0) < 0.5 || !ex.source_url) continue;
        const dupe = await sql`
          SELECT 1 FROM offer
          WHERE canonical_name = ${product}
            AND store IS NOT DISTINCT FROM ${ex.store ?? null}
            AND price IS NOT DISTINCT FROM ${ex.price ?? null}
            AND found_at > NOW() - INTERVAL '6 days'
          LIMIT 1`;
        if (dupe.length) continue;
        await sql`
          INSERT INTO offer (canonical_name, store, price, valid_until, source_url, confidence, source)
          VALUES (${product}, ${ex.store ?? null}, ${ex.price ?? null}, ${ex.valid_until ?? null}, ${ex.source_url}, ${ex.confidence ?? null}, ${'web'})`;
        found++;
        await sleep(800); // gentle on SearXNG
      } catch { /* skip this product */ }
    }
    return { checked, found };
  } finally {
    running = false;
  }
}

/** Debug helper: show Marktguru hits (primary) + the SearXNG/LLM fallback for one product. */
export async function debugOfferSearch(product: string): Promise<unknown> {
  const zip = await householdZip();
  let marktguru: { count: number; offers?: MarktguruOffer[]; matched?: number; error?: string } = { count: 0 };
  if (zip) {
    try {
      const all = await searchMarktguru(product, zip, 20);
      const matched = all.filter(o => offerMatches(product, o));
      marktguru = { count: all.length, matched: matched.length, offers: matched.slice(0, 8) };
    } catch (e) { marktguru = { count: 0, error: (e as Error).message }; }
  } else {
    marktguru = { count: 0, error: 'no household zip configured' };
  }

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
  return { zip, marktguru, web: { query, region, hitCount: hits.length, hits, llmRaw, parsed, error } };
}

interface OfferRow {
  id: number; canonical_name: string; store: string | null; price: string | null;
  old_price: string | null; valid_until: string | null; source_url: string | null;
  brand: string | null; image_url: string | null; unit: string | null;
}

/** Email each subscriber a digest of newly-found offers for their products,
 *  then mark those offers notified. */
export async function sendOfferDigests(): Promise<void> {
  const fresh = await sql`
    SELECT id, canonical_name, store, price, old_price, valid_until, source_url, brand, image_url, unit
    FROM offer WHERE notified = FALSE AND found_at > NOW() - INTERVAL '2 days'
  ` as unknown as OfferRow[];
  if (!fresh.length) return;
  const appUrl = await getConfig('app.base_url');

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
    try {
      const mail = offerDigestEmail({ offers: mine, appUrl });
      await sendMail(email, mail.subject, mail.text, mail.html);
    } catch (e) { console.error('[offers] digest mail failed:', (e as Error).message); }
  }

  await sql`UPDATE offer SET notified = TRUE WHERE id IN ${sql(fresh.map(o => o.id))}`;
}
