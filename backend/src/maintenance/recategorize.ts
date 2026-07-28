import sql, { adminSql, DEMO_MODE, withHousehold } from '../db.js';
import { parseLlmJson } from '../llm/ollama.js';
import { providerForTask } from '../llm/provider.js';
import { RECATEGORIZE_PROMPT } from '../llm/prompts.js';
import { notify } from '../notify.js';
import { ProgressReporter } from './progress.js';

interface CatAssignment {
  id: number;
  category_path: string;
}

let running = false;

export function isRecategorizeRunning(): boolean {
  return running;
}

/**
 * Tenant scope for `void`-detached work. Off-demo this is a plain call — there is no RLS and
 * `sql` is just the pool, so the behaviour is byte-for-byte the original.
 *
 * On the demo it matters a lot: work launched with `void` outlives the request, so by the time
 * it runs the request's reserved household connection has already been released — and postgres.js
 * hands a released connection straight to the next waiting reserve(). The detached job would then
 * either see and write NOTHING (no app.current_household → the RLS predicate is NULL) or, worse,
 * operate inside a stranger's household: every UPDATE below is an id-only predicate filtered
 * solely by RLS. Re-opening the household for the detached body restores the isolation.
 *
 * Fails closed when the household is unknown on the demo: fabricating one would mean writing a
 * visitor's data into somebody else's household. The caller's `.catch` records it on the event.
 */
const bgHousehold = <T>(householdId: number | null | undefined, fn: () => Promise<T>): Promise<T> => {
  if (!DEMO_MODE) return fn();
  if (householdId == null) return Promise.reject(new Error('kein Haushalt im Kontext – Hintergrundlauf abgebrochen'));
  return withHousehold(householdId, fn);
};

/** The household this call is scoped to, read from the session GUC while we are still on the
 *  caller's reserved connection. Lets a job capture its own scope even when the caller did not
 *  pass one. Demo only (off-demo there is no GUC and no RLS); never throws, so it can't strand
 *  the `running` flag. */
async function currentHousehold(): Promise<number | null> {
  try {
    const [row] = await sql`SELECT NULLIF(current_setting('app.current_household', true), '')::bigint AS hid`;
    const hid = Number(row?.hid ?? NaN);
    return Number.isFinite(hid) && hid > 0 ? hid : null;
  } catch { return null; }
}

/** Assign category_path to artikel via LLM. onlyMissing=true → only NULL rows.
 *  `householdId` is demo-only and three-valued: `undefined` = the caller never looked (an
 *  awaited route call, still on its own live connection) → derive it from the GUC, `null` = the
 *  caller looked and found none → fail closed, a number = that tenant. Off-demo it is ignored. */
export async function runRecategorize(onlyMissing: boolean, householdId?: number | null): Promise<number> {
  if (running) throw new Error('recategorize already running');
  running = true;

  let hid: number | null = null;
  let eventId = 0;
  try {
    // Capture the tenant scope BEFORE the `void` below detaches the work — see bgHousehold().
    // Only re-read the GUC when the caller never looked: an explicit `null` means it did look
    // and found nothing, and a late re-read on the demo could answer from a recycled connection
    // that now serves a different household.
    hid = DEMO_MODE ? (householdId !== undefined ? householdId : await currentHousehold()) : null;

    // adminSql, not sql: the hazard here is connection IDENTITY, not RLS. maintenance_event is
    // indeed platform-global, but on the demo a detached caller reaches this line after its
    // reserved connection was released back to the pool, so writing through the AsyncLocalStorage
    // handle would pipeline this INSERT into whatever request now owns that physical connection.
    // Off-demo `adminSql` IS the same pool object as `sql` (db.ts) → unchanged there.
    const [event] = await adminSql`
      INSERT INTO maintenance_event (kind, status, summary)
      VALUES ('recategorize.run', 'running', ${adminSql.json({ only_missing: onlyMissing })})
      RETURNING id
    `;
    eventId = event.id as number;
  } catch (err) {
    // Setup failed before the `.finally` below exists, so nothing would ever clear the
    // single-flight flag again and every later run would 409 for the process lifetime.
    running = false;
    throw err;
  }

  void bgHousehold(hid, () => recategorizeWork(eventId, onlyMissing)).catch(async err => {
    // Owner pool for the same reason as the INSERT above: this continuation inherits the
    // AsyncLocalStorage store captured when it was registered — the caller's released connection.
    await adminSql`UPDATE maintenance_event SET ended_at = NOW(), status = 'error',
              summary = ${adminSql.json({ error: (err as Error).message })} WHERE id = ${eventId}`;
  }).finally(() => { running = false; })
    // Tail guard: without it a throw inside the error handler rejects an unobserved promise,
    // and Node's default policy kills the container (→ Swarm rolls back to the old image).
    // bgHousehold's fail-closed rejection makes that handler a routine path, not an exotic one.
    .catch(err => console.error('[recategorize] run bookkeeping failed:', (err as Error).message));

  return eventId;
}

/** Categorize-batch work without event tracking — callable from other jobs.
 *  Optional onProgress reports (done, total) after each batch. */
export async function processRecategorizeBatch(
  onlyMissing: boolean,
  onProgress?: (done: number, total: number) => Promise<void> | void,
): Promise<{ total: number; updated: number; fallback: number }> {
  const llm = await providerForTask('recategorize');
  const validPaths = (await sql`SELECT path FROM category ORDER BY path`).map(r => r.path as string);
  // "missing" also retries items previously dumped into the fallback bucket,
  // so a stronger model on the next run can rescue them.
  const items = onlyMissing
    ? await sql`SELECT id, name, ai_guess, canonical_name FROM artikel
                WHERE category_path IS NULL OR category_path = 'Sonstiges/Unkategorisiert'
                ORDER BY id`
    : await sql`SELECT id, name, ai_guess, canonical_name FROM artikel ORDER BY id`;

  let updated = 0;
  let fallback = 0;

  const BATCH = 20;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    let assignments: CatAssignment[] = [];
    try {
      assignments = parseLlmJson<CatAssignment[]>(await llm.chat({
        system: RECATEGORIZE_PROMPT,
        user: JSON.stringify({
          artikel: batch.map(b => ({ id: b.id, name: b.name, canonical_name: b.canonical_name ?? b.ai_guess })),
          gueltige_pfade: validPaths,
        }),
        json: true,
        arrayResult: true,   // prompt returns [{id,category_path}] — see LlmChatOptions
      }));
    } catch (err) {
      console.error(`[recategorize] batch at ${i} failed: ${(err as Error).message} — falling through to per-item fallback`);
    }

    // index returned assignments by id for fast lookup
    const byId = new Map<number, CatAssignment>();
    if (Array.isArray(assignments)) {
      for (const asg of assignments) {
        if (asg && typeof asg.id === 'number') byId.set(asg.id, asg);
      }
    }

    // for every item in the batch: write whatever the LLM gave us OR fallback path,
    // so the count of NULLs always shrinks each run (no infinite-retry on hard items)
    for (const b of batch) {
      const asg = byId.get(b.id);
      const proposed = asg && validPaths.includes(asg.category_path) ? asg.category_path : 'Sonstiges/Unkategorisiert';
      if (proposed === 'Sonstiges/Unkategorisiert') fallback++;
      await sql`UPDATE artikel SET category_path = ${proposed} WHERE id = ${b.id}`;
      updated++;
    }
    if (onProgress) await onProgress(Math.min(i + BATCH, items.length), items.length);
  }

  return { total: items.length, updated, fallback };
}

async function recategorizeWork(eventId: number, onlyMissing: boolean): Promise<void> {
  const progress = new ProgressReporter(eventId);
  const summary = await processRecategorizeBatch(onlyMissing, (done, total) =>
    progress.set({ phase: 'recategorize', current: done, total }));
  await progress.clear();
  await sql`UPDATE maintenance_event SET ended_at = NOW(), status = 'success',
            summary = ${sql.json(summary)} WHERE id = ${eventId}`;
  await notify('recategorize.done', summary);
  console.log('[recategorize] done:', JSON.stringify(summary));
}

/** Categorize a single artikel (called from n8n right after receipt ingestion). */
export async function recategorizeOne(artikelId: number): Promise<string | null> {
  const rows = await sql`SELECT id, name, ai_guess, canonical_name FROM artikel WHERE id = ${artikelId}`;
  if (!rows.length) return null;
  const a = rows[0];
  const validPaths = (await sql`SELECT path FROM category ORDER BY path`).map(r => r.path as string);
  const llm = await providerForTask('recategorize');

  const assignments = parseLlmJson<CatAssignment[]>(await llm.chat({
    system: RECATEGORIZE_PROMPT,
    user: JSON.stringify({
      artikel: [{ id: a.id, name: a.name, canonical_name: a.canonical_name ?? a.ai_guess }],
      gueltige_pfade: validPaths,
    }),
    json: true,
    arrayResult: true,
  }));

  const asg = Array.isArray(assignments) ? assignments[0] : null;
  const safePath = asg && validPaths.includes(asg.category_path) ? asg.category_path : 'Sonstiges/Unkategorisiert';
  await sql`UPDATE artikel SET category_path = ${safePath} WHERE id = ${artikelId}`;
  return safePath;
}
