import sql, { adminSql, DEMO_MODE, withHousehold } from '../db.js';
import { getConfig } from '../config.js';
import { parseLlmJson } from '../llm/ollama.js';
import { providerForTask } from '../llm/provider.js';
import { searxngSearch, searxngImageSearch } from '../llm/searxng.js';
import { cleanMatch } from '../lib/canonicalMatch.js';
import { ocrKey, recordAlias, loadAliasMap, loadUserAliases } from '../lib/canonicalAlias.js';
import { STAGE1_PROMPT, STAGE2_PROMPT } from '../llm/prompts.js';
import { mostSimilar } from '../llm/similarity.js';
import { notify } from '../notify.js';
import { processRecategorizeBatch } from '../maintenance/recategorize.js';
import { ProgressReporter } from '../maintenance/progress.js';

interface Stage1Result {
  action: 'match' | 'new' | 'lookup' | 'garbage';
  value?: string;
  query?: string;
  confidence?: number;
  translation_en?: string;
}

interface Stage2Result {
  canonical?: string;
  confidence?: number;
  translation_en?: string;
}

// Single-flight guard shared by runChurn + runIconFetch. NOTE (demo): one flag per REPLICA, not
// per household — households queue behind each other instead of churning in parallel. Kept
// deliberately global: it bounds concurrent LLM/SearXNG load and connection reservations on a
// shared demo host. Correctness does not depend on it — the trailing pass below is per-household.
let running = false;
// Households whose receipt was OCR'd while a churn was already running, so we do one
// trailing pass afterwards to pick up items imported mid-run (debounce). Off-demo this
// only ever holds the single `null` key — i.e. exactly the old boolean flag. On the demo
// it must be per-household: a receipt imported by household B while household A's churn
// was running has to be churned in B's scope, not A's.
const pendingRerun = new Set<number | null>();
/** Hard ceiling on the trailing-pass queue. Off-demo the set only ever holds the single `null`
 *  key, so this can never bite there. On the demo it stops a pathological situation (a replica
 *  that keeps failing to start a churn, so nothing ever drains the queue) from growing an
 *  unbounded set of household ids for the lifetime of the process. */
const MAX_PENDING_RERUN = 500;
function queueRerun(hid: number | null): void {
  if (pendingRerun.size >= MAX_PENDING_RERUN && !pendingRerun.has(hid)) return;
  pendingRerun.add(hid);
}

export function isChurnRunning(): boolean {
  return running;
}

/**
 * Tenant scope for `void`-detached work. Off-demo this is a plain call — no RLS, `sql` is just
 * the pool — so the behaviour is byte-for-byte the original.
 *
 * On the demo it matters: work launched with `void` outlives the request, so by the time it runs
 * the request's reserved household connection has already been released, and postgres.js hands a
 * released connection straight to the next waiting reserve(). The detached job would then either
 * see and write NOTHING (no app.current_household → the RLS predicate is NULL) or, worse, operate
 * inside a stranger's household — churnWork's `UPDATE artikel … WHERE id = …` is an id-only
 * predicate filtered solely by RLS. Re-opening the household for the detached body fixes both.
 *
 * Fails closed when the household is unknown on the demo instead of inventing one: guessing would
 * mean writing a visitor's data into somebody else's household. The caller's `.catch` records the
 * refusal on the maintenance_event, so it is visible rather than silent.
 */
const bgHousehold = <T>(householdId: number | null | undefined, fn: () => Promise<T>): Promise<T> => {
  if (!DEMO_MODE) return fn();
  if (householdId == null) return Promise.reject(new Error('kein Haushalt im Kontext – Hintergrundlauf abgebrochen'));
  return withHousehold(householdId, fn);
};

/** The household this call is scoped to, read from the session GUC while we are still on the
 *  caller's reserved connection. Lets a job capture its own scope even when the caller did not
 *  pass one. Demo only; never throws, so it can't strand the `running` flag. */
async function currentHousehold(): Promise<number | null> {
  try {
    const [row] = await sql`SELECT NULLIF(current_setting('app.current_household', true), '')::bigint AS hid`;
    const hid = Number(row?.hid ?? NaN);
    return Number.isFinite(hid) && hid > 0 ? hid : null;
  } catch { return null; }
}

/** Called from every run's finally: clears the running flag and, if receipts arrived
 *  mid-run, kicks one trailing auto pass per waiting household. */
function finishRun(): void {
  running = false;
  if (!pendingRerun.size) return;
  // Snapshot + clear first: only one churn runs at a time, so every trailing pass after the
  // first will re-arm its own household through the `running` branch below.
  const waiting = [...pendingRerun];
  pendingRerun.clear();
  void drainRerun(waiting).catch(err => console.error('[churner] rerun drain failed:', (err as Error).message));
}

/** Kick the queued trailing passes. Split out of finishRun so the demo can drop ids of
 *  households that no longer exist: demo_sweep deletes visitor households at 00:00 Berlin, and
 *  a ghost id would still consume the (global, per-replica) single-flight slot and write an
 *  all-zero churner.run event — delaying a LIVE household's real trailing pass behind it.
 *  Never rejects: it is launched fire-and-forget from a `finally`. */
async function drainRerun(waiting: (number | null)[]): Promise<void> {
  for (const hid of waiting) {
    try {
      // `household` is the tenant registry and deliberately NOT RLS'd (migration 089), and we
      // are outside any tenant connection here — hence adminSql, the separate owner pool.
      // Off-demo the ids are always `null`, so this check never runs at all.
      if (DEMO_MODE && hid != null) {
        const alive = await adminSql`SELECT 1 AS ok FROM household WHERE id = ${hid}`;
        if (!alive.length) continue; // swept away while it waited — nothing left to churn
      }
      await triggerChurnAfterOcr(hid);
    } catch {
      // triggerChurnAfterOcr never rejects, but re-arm on the off chance it does, so the
      // trailing pass is deferred rather than silently dropped.
      queueRerun(hid);
    }
  }
}

/** Run a churn pass right after a receipt was OCR'd. Debounced: if a churn is
 *  already running, mark a single trailing rerun instead of overlapping. Gated
 *  by churner.run_after_ocr (independent of the nightly churner.enabled).
 *  Called fire-and-forget (void) from finishRun and storeOcrResult, so it MUST
 *  never reject — a stray rejection would be an unhandled promise rejection
 *  (process crash under Node's default policy).
 *  `householdId` is demo-only. Three-valued on purpose: `undefined` = "I did not look, derive
 *  it from my own scope" (only the synchronous post-OCR call may say that — see below), an
 *  explicit `null` = "I looked and there is none" (fail closed), a number = that household.
 *  Off-demo it is ignored entirely. */
export async function triggerChurnAfterOcr(householdId?: number | null): Promise<void> {
  let hid: number | null = householdId ?? null;
  try {
    // Resolve the scope AND read the gate in the SAME synchronous tick. storeOcrResult calls
    // this fire-and-forget, so its reserved connection is about to be released; dispatching both
    // queries now queues them ahead of that release. Reading the config one await LATER (as
    // before) could already be pipelining onto a recycled connection — on the demo one that may
    // meanwhile serve a different household, or sit inside a stranger's transaction.
    const [resolved, enabled] = await Promise.all([
      DEMO_MODE && householdId === undefined ? currentHousehold() : Promise.resolve(householdId ?? null),
      getConfig('churner.run_after_ocr'),
    ]);
    hid = resolved;
    if (!enabled) return;
    if (running) { queueRerun(hid); return; }
    await runChurn('auto_ocr', hid);
  } catch (err) {
    // Transient DB error reading config, or runChurn lost a race to `running`:
    // re-arm a trailing pass so the just-imported items still get churned.
    queueRerun(hid);
    console.warn('[churner] auto-trigger deferred:', (err as Error).message);
  }
}

/** The canonical a user previously assigned to the most textually-similar OCR text
 *  (≥1 shared significant token). Fed to stage1 so manual corrections generalize to
 *  near-miss OCR variants instead of needing the exact same string. */
function userAliasHint(itemKey: string, userAliases: { key: string; canonical: string }[]): string | null {
  const toks = new Set(itemKey.split(' ').filter(w => w.length >= 4));
  if (!toks.size) return null;
  let best: { canonical: string; score: number } | null = null;
  for (const ua of userAliases) {
    let score = 0;
    for (const w of ua.key.split(' ')) if (w.length >= 4 && toks.has(w)) score++;
    if (score > 0 && (!best || score > best.score)) best = { canonical: ua.canonical, score };
  }
  return best?.canonical ?? null;
}

/** Short store/chain hint from a raw OCR store name (drops street/zip noise). */
function storeHint(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.split(/[\n,]/)[0].replace(/\d.*$/, '').trim().split(/\s+/).slice(0, 3).join(' ');
}

/** Web-search disambiguation for a confusing OCR item, biased by the store it was
 *  bought at — the way a human resolves a cryptic line ("EDEKA BIO BANAN." → Banane).
 *  Returns a canonical proposal + confidence, or null if nothing usable came back. */
async function storeAwareLookup(
  store: string,
  item: { original_text: string | null; name: string },
  stage2Llm: Awaited<ReturnType<typeof providerForTask>>,
): Promise<{ canonical: string; confidence: number; translationEn: string | null; sourceUrl: string | null } | null> {
  const ocrStr = item.original_text ?? item.name;
  const query = [store, ocrStr].filter(Boolean).join(' ').trim();
  if (!query) return null;
  const hits = await searxngSearch(query);
  if (!hits.length) return null;
  const s2 = parseLlmJson<Stage2Result>(await stage2Llm.chat({
    system: STAGE2_PROMPT,
    user: JSON.stringify({ original_text: item.original_text, name: item.name, laden: store, suchergebnisse: hits.slice(0, 3) }),
    json: true,
  }));
  const canonical = s2.canonical?.trim();
  if (!canonical) return null;
  return { canonical, confidence: s2.confidence ?? 0, translationEn: s2.translation_en ?? null, sourceUrl: hits[0]?.url ?? null };
}

/** Request cancellation of the running churn (cross-replica via DB flag). */
export async function requestChurnStop(): Promise<boolean> {
  const rows = await sql`
    UPDATE maintenance_event SET cancel_requested = TRUE
    WHERE kind = 'churner.run' AND status = 'running'
    RETURNING id
  `;
  return rows.length > 0;
}

async function isCancelled(eventId: number): Promise<boolean> {
  const [row] = await sql`SELECT cancel_requested FROM maintenance_event WHERE id = ${eventId}`;
  return Boolean(row?.cancel_requested);
}

class ChurnCancelled extends Error {
  constructor(public partial?: Record<string, unknown>) { super('churn cancelled'); }
}

/** One churner pass: clean up weak canonical names. Returns the maintenance_event id.
 *  `householdId` is demo-only and three-valued like triggerChurnAfterOcr's: `undefined` = the
 *  caller never looked (an awaited route call, still on its own live connection) → derive it,
 *  `null` = the caller looked and found none → fail closed, a number = that tenant.
 *  Off-demo the parameter is ignored entirely. */
export async function runChurn(trigger: 'cron' | 'manual' | 'auto_ocr', householdId?: number | null): Promise<number> {
  if (running) throw new Error('churner already running');
  running = true;

  let hid: number | null = null;
  let eventId = 0;
  try {
    // Capture the tenant scope BEFORE the `void` below detaches the work — see bgHousehold().
    // Only re-read the GUC when the caller never looked: an explicit `null` means it DID look
    // and found nothing, and re-reading here would be worse than useless — on the demo we may
    // by now be pipelining onto a recycled connection that serves somebody else's household.
    hid = DEMO_MODE ? (householdId !== undefined ? householdId : await currentHousehold()) : null;

    // adminSql, not sql: on the auto_ocr path this line is reached AFTER the request that
    // detached us was answered, so the AsyncLocalStorage store still points at a reserved
    // connection that was already released back to the pool. Writing through it would pipeline
    // this INSERT into whatever request now owns that physical connection — e.g. inside
    // analyticsRead's `SET LOCAL transaction_read_only` block, which fails the INSERT *and*
    // aborts the stranger's transaction. maintenance_event carries no household_id and no RLS,
    // so the owner pool is the right lane for it. Off-demo `adminSql` IS the same pool object as
    // `sql` (see db.ts), so this is byte-for-byte the same connection as before.
    const [event] = await adminSql`
      INSERT INTO maintenance_event (kind, status, summary)
      VALUES ('churner.run', 'running', ${adminSql.json({ trigger })})
      RETURNING id
    `;
    eventId = event.id as number;
  } catch (err) {
    // Setup failed BEFORE the `.finally(finishRun)` chain below exists, so nothing would ever
    // clear the single-flight flag again: every later churn (and runIconFetch, same flag) would
    // 409 "already running" for the lifetime of the process. Release it here. Deliberately not
    // finishRun(): draining pendingRerun re-enters runChurn, which would fail the same way and
    // recurse — the waiting households simply stay armed for the next successful run.
    running = false;
    throw err;
  }

  // Fire-and-forget the actual work under its own tenant scope; the event row tracks progress.
  // The bookkeeping handlers below run long after the request that started this was answered.
  // A promise continuation inherits the AsyncLocalStorage store captured when it was REGISTERED,
  // i.e. the caller's already-released connection — so they use the owner pool too, for exactly
  // the reason spelled out above. (The work itself is fine: bgHousehold opens a fresh one.)
  void bgHousehold(hid, () => churnWork(eventId, trigger)).catch(async err => {
    if (err instanceof ChurnCancelled) {
      await adminSql`UPDATE maintenance_event SET ended_at = NOW(), status = 'cancelled', progress = NULL,
                summary = ${adminSql.json({ cancelled: true, ...(err.partial ?? {}) })} WHERE id = ${eventId}`;
      console.log('[churner] cancelled by user');
      return;
    }
    await adminSql`UPDATE maintenance_event SET ended_at = NOW(), status = 'error', progress = NULL,
              summary = ${adminSql.json({ error: (err as Error).message })} WHERE id = ${eventId}`;
  }).finally(finishRun)
    // Tail guard: without it the promise returned by .finally() has no handler, so a throw
    // inside the error handler (or inside finishRun) becomes an unhandled rejection — which
    // under Node's default policy kills the container, and on the Swarm that means a rollback
    // to the previous image. bgHousehold's fail-closed rejection makes that handler a routine
    // path, not an exotic one, so this must not be optional.
    .catch(err => console.error('[churner] run bookkeeping failed:', (err as Error).message));

  return eventId;
}

/** Standalone icon fetch (store logos + canonical product images) via SearXNG
 *  image search — NO LLM involved. Decoupled from the slow nightly churn so it
 *  can be triggered on demand. Tracked as its own maintenance_event. */
export async function runIconFetch(householdId?: number | null): Promise<number> {
  if (running) throw new Error('maintenance already running');
  running = true;
  let hid: number | null = null;
  let eventId = 0;
  try {
    // Capture the tenant scope BEFORE the `void` below detaches the work — see bgHousehold()
    // and runChurn() for why `undefined` and `null` mean different things here.
    hid = DEMO_MODE ? (householdId !== undefined ? householdId : await currentHousehold()) : null;
    // Owner pool for the bookkeeping row — same reasoning as runChurn (and off-demo it IS the
    // same pool object, so nothing changes there).
    const [event] = await adminSql`
      INSERT INTO maintenance_event (kind, status, summary)
      VALUES ('icons.run', 'running', ${adminSql.json({ trigger: 'manual' })}) RETURNING id
    `;
    eventId = event.id as number;
  } catch (err) {
    // Nothing would ever clear the shared single-flight flag otherwise — see runChurn.
    running = false;
    throw err;
  }
  void bgHousehold(hid, async () => {
    const progress = new ProgressReporter(eventId);
    await progress.set({ phase: 'store_icons', current: 0, total: 1 }, true);
    const stores = await churnStoreIcons(100);
    await progress.set({ phase: 'canonical_icons', current: 0, total: 1 }, true);
    const canon = await churnCanonicalIcons(150);
    await progress.clear();
    const summary = { store_icons: stores, canonical_icons: canon };
    await sql`UPDATE maintenance_event SET ended_at = NOW(), status = 'success', progress = NULL,
              summary = ${sql.json(summary)} WHERE id = ${eventId}`;
    console.log('[icons] done:', JSON.stringify(summary));
  }).catch(async err => {
    // Owner pool: this continuation inherits the caller's (by now released) reserved connection
    // via AsyncLocalStorage — see runChurn for the full reasoning.
    await adminSql`UPDATE maintenance_event SET ended_at = NOW(), status = 'error', progress = NULL,
              summary = ${adminSql.json({ error: (err as Error).message })} WHERE id = ${eventId}`;
  }).finally(finishRun)
    // Tail guard against an unhandled rejection killing the process — see runChurn.
    .catch(err => console.error('[icons] run bookkeeping failed:', (err as Error).message));
  return eventId;
}

async function churnWork(eventId: number, trigger: 'cron' | 'manual' | 'auto_ocr' = 'cron'): Promise<void> {
  const progress = new ProgressReporter(eventId);

  // Step 1: assign categories to any artikel with NULL category_path.
  // This makes the nightly churn self-healing for freshly-imported data.
  let recategorize = { total: 0, updated: 0, fallback: 0 };
  try {
    recategorize = await processRecategorizeBatch(true, (done, total) =>
      progress.set({ phase: 'recategorize', current: done, total }));
    if (recategorize.updated > 0) {
      console.log(`[churner] recategorize: ${recategorize.updated}/${recategorize.total} artikel got a category_path`);
    }
  } catch (err) {
    console.warn('[churner] recategorize step failed:', (err as Error).message);
  }

  const batchSize = await getConfig('churner.batch_size');
  const confidenceGate = await getConfig('churner.confidence');
  const hitlMode = await getConfig('churner.hitl_mode'); // guarded | uncertain_only | all_new
  const GENERIC = ['Diverse Artikel', 'Backwaren', 'Gemüse', 'Fleisch', 'Gewürze'];
  // Durable reject memory: (ocr_key, proposed) pairs a human already rejected, so we
  // never re-propose them. JSON key → collision-proof, no delimiter games.
  const rejected = new Set(
    (await sql`SELECT ocr_key, proposed_canonical FROM rejected_proposal`)
      .map(r => JSON.stringify([r.ocr_key as string, r.proposed_canonical as string])),
  );

  const candidates = await sql`
    SELECT a.id, a.name, a.original_text, a.ai_guess, a.canonical_name, e.roh_ladenname AS store_raw
    FROM artikel a
    LEFT JOIN einkauf e ON e.id = a.einkauf_id
    WHERE NOT a.is_refund AND (
          a.canonical_name IS NULL
       OR LENGTH(a.canonical_name) > 40
       OR a.canonical_name IN ('Diverse Artikel', 'Backwaren', 'Gemüse', 'Fleisch', 'Gewürze'))
    ORDER BY a.id DESC
    LIMIT ${batchSize}
  `;

  const existing = (await sql`
    SELECT canonical_name, COUNT(*) AS n FROM artikel
    WHERE canonical_name IS NOT NULL
    GROUP BY canonical_name ORDER BY n DESC LIMIT 200
  `).map(r => r.canonical_name as string);
  const aliases = await loadAliasMap();
  const userAliases = await loadUserAliases(); // authoritative prior corrections, fed to the LLM
  const userKeys = new Set(userAliases.map(u => u.key)); // OCR keys with a user correction

  let autoApplied = 0;
  let queued = 0;
  let skipped = 0;
  let dropped = 0;

  const stage1Llm = await providerForTask('churner_stage1');
  const stage2Llm = await providerForTask('churner_stage2');

  let processed = 0;
  for (const a of candidates) {
    // Cheap DB check before each (slow) LLM call → cancellation is responsive.
    if (await isCancelled(eventId)) throw new ChurnCancelled();
    await progress.set({ phase: 'canonical', current: processed, total: candidates.length });
    processed++;
    const store = storeHint(a.store_raw as string | null);
    try {
      // 1) learned alias memory (exact OCR repeat), 2) deterministic whole-word
      // match — both free + reliable, before the (slow) LLM.
      const aKey = ocrKey(a.original_text ?? a.name);
      const fromAlias = aliases.get(aKey);
      // cleanMatch: only an unambiguous whole-word match (no other product noun)
      // auto-applies; risky containment falls through to the LLM + Prüfen. The
      // "no rival noun" guard runs on the RECEIPT text only (not ai_guess), so a
      // wrong AI paraphrase can't block a clean receipt match.
      const pre = fromAlias ?? cleanMatch([a.original_text, a.name, a.ai_guess], existing, [a.original_text, a.name]);
      if (pre) {
        // A deterministic match the human already rejected for this key must not
        // silently re-apply. (A learned alias is the user's own mapping → it wins.)
        if (!fromAlias && rejected.has(JSON.stringify([aKey, pre]))) { skipped++; continue; }
        if (pre !== a.canonical_name) {
          // Inherited from a user-confirmed alias → carry the "Nutzerkorrigiert" mark.
          const fromUser = !!fromAlias && userKeys.has(aKey);
          await sql`UPDATE artikel SET canonical_name = ${pre}, user_corrected = user_corrected OR ${fromUser} WHERE id = ${a.id}`;
          if (!fromAlias) await recordAlias(a.original_text ?? a.name, pre); // learn deterministic hits
          autoApplied++;
        } else { skipped++; }
        continue;
      }

      const stage1 = parseLlmJson<Stage1Result>(await stage1Llm.chat({
        system: STAGE1_PROMPT,
        user: JSON.stringify({
          original_text: a.original_text,
          name: a.name,
          ai_guess: a.ai_guess,
          current_canonical: a.canonical_name,
          existierende_namen: existing,
          frühere_nutzer_zuordnung: userAliasHint(ocrKey(a.original_text ?? a.name), userAliases),
        }),
        json: true,
      }));

      let canonical: string | null = null;
      let confidence = stage1.confidence ?? 0;
      let translationEn = stage1.translation_en ?? null;
      let sourceUrl: string | null = null;

      if (stage1.action === 'garbage') {
        dropped++;
        continue; // never auto-delete; just leave it alone and count it
      } else if (stage1.action === 'lookup' && stage1.query) {
        // bias the lookup with the store it was bought at — disambiguates better
        const hits = await searxngSearch([store, stage1.query].filter(Boolean).join(' '));
        if (hits.length) {
          const stage2 = parseLlmJson<Stage2Result>(await stage2Llm.chat({
            system: STAGE2_PROMPT,
            user: JSON.stringify({
              original_text: a.original_text,
              name: a.name,
              laden: store,
              suchergebnisse: hits.slice(0, 3),
            }),
            json: true,
          }));
          canonical = stage2.canonical ?? null;
          confidence = stage2.confidence ?? 0;
          translationEn = stage2.translation_en ?? translationEn;
          sourceUrl = hits[0]?.url ?? null;
        }
      } else if (stage1.value) {
        canonical = stage1.value;
      }

      canonical = canonical?.trim() || null;
      if (!canonical) { skipped++; continue; }

      // Low-confidence rescue: if stage1 wasn't confident (and didn't already do a
      // web lookup), search the web with the STORE + OCR string and let stage2 try
      // again — exactly how a human cracks a cryptic line. Adopt only if better.
      if (confidence < confidenceGate && store && stage1.action !== 'lookup') {
        try {
          const rescue = await storeAwareLookup(store, { original_text: a.original_text as string | null, name: a.name as string }, stage2Llm);
          if (rescue && rescue.confidence > confidence) {
            canonical = rescue.canonical;
            confidence = rescue.confidence;
            translationEn = rescue.translationEn ?? translationEn;
            sourceUrl = rescue.sourceUrl ?? sourceUrl;
          }
        } catch (err) {
          console.warn(`[churner] store-aware rescue failed for ${a.id}:`, (err as Error).message);
        }
      }

      // Snap near-duplicates to existing canonical names
      const twin = mostSimilar(canonical, existing, 0.85);
      const corroborated = !!twin || !!sourceUrl; // snapped to a known name OR web-sourced
      if (twin) canonical = twin;

      if (canonical === a.canonical_name) { skipped++; continue; }

      // Durable reject: never re-propose something a human already rejected for this key.
      if (rejected.has(JSON.stringify([aKey, canonical]))) { skipped++; continue; }

      // Guarded auto-apply: a confident AI name is applied silently ONLY when an
      // independent signal agrees (snapped to a known name, or came from a web
      // lookup) AND it isn't a vague catch-all. Otherwise it goes to Prüfen.
      const isGeneric = canonical.length > 40 || GENERIC.includes(canonical);
      const autoOk =
        hitlMode === 'uncertain_only' ? confidence >= confidenceGate
        : hitlMode === 'all_new' ? false
        : confidence >= confidenceGate && corroborated && !isGeneric; // guarded (default)

      if (autoOk) {
        await sql`UPDATE artikel SET canonical_name = ${canonical} WHERE id = ${a.id}`;
        await recordAlias(a.original_text ?? a.name, canonical); // learn so future repeats skip the LLM
        if (translationEn) {
          // Bare DO NOTHING, no named arbiter: the PK is (canonical_name, lang) off-demo but
          // (household_id, canonical_name, lang) on the demo (migration 087), so naming one
          // shape raises 42P10 on the other. The PK is this table's ONLY unique constraint,
          // so an unnamed arbiter resolves to exactly the same conflict off-demo.
          await sql`
            INSERT INTO canonical_translation (canonical_name, lang, translated, source)
            VALUES (${canonical}, 'en', ${translationEn}, 'churner')
            ON CONFLICT DO NOTHING
          `;
        }
        await notify('churner.auto_applied', {
          artikel_id: a.id,
          original_text: a.original_text,
          old_canonical: a.canonical_name,
          new_canonical: canonical,
          confidence,
          source_url: sourceUrl,
        });
        autoApplied++;
        if (!existing.includes(canonical)) existing.push(canonical);
      } else {
        // Queue for review — but only if no pending row already exists for this
        // article, so repeated churn passes don't pile up duplicates. No per-item
        // notification: the end-of-run summary + the Prüfen nav badge are the digest.
        await sql`
          INSERT INTO verifikations_queue (proposed_canonical, raw_patterns, ai_examples, confidence, status, artikel_id)
          SELECT ${canonical}, ${a.original_text ?? a.name}, ${a.ai_guess ?? a.name}, ${String(confidence.toFixed(2))}, 'pending', ${a.id}
          WHERE NOT EXISTS (
            SELECT 1 FROM verifikations_queue WHERE status = 'pending' AND artikel_id = ${a.id}
          )
        `;
        queued++;
      }
    } catch (err) {
      console.error(`[churner] artikel ${a.id} failed:`, (err as Error).message);
      skipped++;
    }
  }

  // Fetch missing icons: store logos + canonical-name product images.
  await progress.set({ phase: 'store_icons', current: 0, total: 1 }, true);
  const storeIconsAdded = await churnStoreIcons();
  if (await isCancelled(eventId)) throw new ChurnCancelled({ recategorize, candidates: candidates.length, auto_applied: autoApplied, queued, skipped, garbage: dropped, store_icons: storeIconsAdded });
  await progress.set({ phase: 'canonical_icons', current: 0, total: 1 }, true);
  const canonicalIconsAdded = await churnCanonicalIcons();
  await progress.clear();

  const summary = {
    recategorize,
    candidates: candidates.length,
    auto_applied: autoApplied,
    queued,
    skipped,
    garbage: dropped,
    store_icons: storeIconsAdded,
    canonical_icons: canonicalIconsAdded,
  };
  await sql`UPDATE maintenance_event SET ended_at = NOW(), status = 'success', progress = NULL,
            summary = ${sql.json(summary)} WHERE id = ${eventId}`;
  // Auto (per-receipt) runs are frequent; only ping when something actually changed,
  // so a routine import that produced nothing to review doesn't spam a summary.
  const changed = autoApplied > 0 || queued > 0;
  if (trigger !== 'auto_ocr' || changed) await notify('churner.run.summary', summary);
  console.log(`[churner] done (${trigger}):`, JSON.stringify(summary));
}

/** Fetches a logo image for every store that's been seen but has no icon yet.
 *  Picks first SearXNG image hit, logs source URL. Bounded per run. */
async function churnStoreIcons(limit = 20): Promise<number> {
  const rows = await sql`
    SELECT DISTINCT
      LOWER(SPLIT_PART(REGEXP_REPLACE(roh_ladenname, '[^A-Za-zäöüÄÖÜß0-9]+', ' ', 'g'), ' ', 1)) AS key,
      MIN(roh_ladenname) AS display
    FROM einkauf
    WHERE roh_ladenname IS NOT NULL
    GROUP BY key
  `;
  const existing = new Set((await sql`SELECT store_key FROM store_meta WHERE icon_url IS NOT NULL`).map(r => r.store_key as string));
  const candidates = rows.filter(r => r.key && !existing.has(r.key as string)).slice(0, limit);

  let added = 0;
  for (const c of candidates) {
    try {
      const hits = await searxngImageSearch(`${c.display} logo`);
      if (!hits.length) continue;
      const url = hits[0].src;
      // store_meta has NO household_id (migration 086 leaves it alone — chain logos are
      // platform-global in every env), so its PK is still (store_key) on the demo and this
      // named arbiter stays valid. Deliberately not converted like the canonical_* upserts.
      await sql`
        INSERT INTO store_meta (store_key, icon_url, source, updated_at)
        VALUES (${c.key}, ${url}, 'churner', NOW())
        ON CONFLICT (store_key) DO UPDATE SET icon_url = EXCLUDED.icon_url, source = 'churner', updated_at = NOW()
      `;
      added++;
    } catch (err) {
      console.warn(`[churner] store-icon ${c.key} failed:`, (err as Error).message);
    }
  }
  return added;
}

/** Fetches a product image for canonical names that have none yet, prioritising
 *  the most-frequently-bought ones. Picks first SearXNG image hit. Bounded
 *  per run so SearXNG isn't hammered. */
async function churnCanonicalIcons(limit = 20): Promise<number> {
  // Self-heal: if SearXNG ever returned the same garbage top-hit for many
  // products (failing image engines), that one URL ends up on lots of
  // canonicals. Clear auto-set icons shared by ≥3 canonicals so they re-fetch.
  await sql`
    UPDATE canonical_meta SET icon_url = NULL, source = 'churner'
    WHERE source = 'churner' AND icon_url IN (
      SELECT icon_url FROM canonical_meta
      WHERE icon_url IS NOT NULL
      GROUP BY icon_url HAVING COUNT(*) >= 3
    )
  `;

  // Most-used canonical names without an icon yet.
  const candidates = await sql`
    SELECT a.canonical_name AS name, COUNT(*)::int AS n
    FROM artikel a
    LEFT JOIN canonical_meta m ON m.canonical_name = a.canonical_name AND m.icon_url IS NOT NULL
    WHERE a.canonical_name IS NOT NULL AND m.canonical_name IS NULL
    GROUP BY a.canonical_name
    ORDER BY n DESC
    LIMIT ${limit}
  `;

  // Don't reuse an image that's already an icon for another product.
  const used = new Set(
    (await sql`SELECT icon_url FROM canonical_meta WHERE icon_url IS NOT NULL`).map(r => r.icon_url as string),
  );

  let added = 0;
  for (const c of candidates) {
    const name = c.name as string;
    try {
      const hits = await searxngImageSearch(`${name} Produkt`);
      const pick = hits.find(h => h.src && !used.has(h.src)) ?? hits[0];
      if (!pick?.src) continue;
      used.add(pick.src);
      // Update-then-insert rather than ON CONFLICT: the conflict target differs per env (PK is
      // canonical_name off-demo, (household_id, canonical_name) on the demo — migration 087), so
      // naming one shape raises 42P10 on the other. Same idiom as routes/icons.ts. RLS already
      // scopes the UPDATE — and the INSERT's household_id — to the run's household.
      const upd = await sql`
        UPDATE canonical_meta SET icon_url = ${pick.src}, source = 'churner', updated_at = NOW()
        WHERE canonical_name = ${name}`;
      if (upd.count === 0) {
        // Bare DO NOTHING (no named arbiter, for the same reason): a writer that created the
        // row between the UPDATE and here must not turn a missing icon into a failed run. The
        // PK is this table's only unique constraint, so off-demo it arbitrates identically.
        await sql`
          INSERT INTO canonical_meta (canonical_name, icon_url, source, updated_at)
          VALUES (${name}, ${pick.src}, 'churner', NOW())
          ON CONFLICT DO NOTHING`;
      }
      added++;
    } catch (err) {
      console.warn(`[churner] canonical-icon ${name} failed:`, (err as Error).message);
    }
  }
  return added;
}
