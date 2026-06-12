import sql from '../db.js';
import { parseLlmJson } from '../llm/ollama.js';
import { providerForTask } from '../llm/provider.js';
import { RECATEGORIZE_PROMPT } from '../llm/prompts.js';
import { notify } from '../notify.js';

interface CatAssignment {
  id: number;
  category_path: string;
}

let running = false;

export function isRecategorizeRunning(): boolean {
  return running;
}

/** Assign category_path to artikel via LLM. onlyMissing=true → only NULL rows. */
export async function runRecategorize(onlyMissing: boolean): Promise<number> {
  if (running) throw new Error('recategorize already running');
  running = true;

  const [event] = await sql`
    INSERT INTO maintenance_event (kind, status, summary)
    VALUES ('recategorize.run', 'running', ${sql.json({ only_missing: onlyMissing })})
    RETURNING id
  `;
  const eventId = event.id as number;

  void recategorizeWork(eventId, onlyMissing).catch(async err => {
    await sql`UPDATE maintenance_event SET ended_at = NOW(), status = 'error',
              summary = ${sql.json({ error: (err as Error).message })} WHERE id = ${eventId}`;
  }).finally(() => { running = false; });

  return eventId;
}

/** Categorize-batch work without event tracking — callable from other jobs. */
export async function processRecategorizeBatch(onlyMissing: boolean): Promise<{ total: number; updated: number; fallback: number }> {
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
  }

  return { total: items.length, updated, fallback };
}

async function recategorizeWork(eventId: number, onlyMissing: boolean): Promise<void> {
  const summary = await processRecategorizeBatch(onlyMissing);
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
  }));

  const asg = Array.isArray(assignments) ? assignments[0] : null;
  const safePath = asg && validPaths.includes(asg.category_path) ? asg.category_path : 'Sonstiges/Unkategorisiert';
  await sql`UPDATE artikel SET category_path = ${safePath} WHERE id = ${artikelId}`;
  return safePath;
}
