import sql from '../db.js';
import { getConfig } from '../config.js';
import { parseLlmJson } from '../llm/ollama.js';
import { providerForTask } from '../llm/provider.js';
import { searxngSearch, searxngImageSearch } from '../llm/searxng.js';
import { STAGE1_PROMPT, STAGE2_PROMPT } from '../llm/prompts.js';
import { mostSimilar } from '../llm/similarity.js';
import { notify } from '../notify.js';
import { processRecategorizeBatch } from '../maintenance/recategorize.js';

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

let running = false;

export function isChurnRunning(): boolean {
  return running;
}

/** One churner pass: clean up weak canonical names. Returns the maintenance_event id. */
export async function runChurn(trigger: 'cron' | 'manual'): Promise<number> {
  if (running) throw new Error('churner already running');
  running = true;

  const [event] = await sql`
    INSERT INTO maintenance_event (kind, status, summary)
    VALUES ('churner.run', 'running', ${sql.json({ trigger })})
    RETURNING id
  `;
  const eventId = event.id as number;

  // Fire-and-forget the actual work; the event row tracks progress.
  void churnWork(eventId).catch(async err => {
    await sql`UPDATE maintenance_event SET ended_at = NOW(), status = 'error',
              summary = ${sql.json({ error: (err as Error).message })} WHERE id = ${eventId}`;
  }).finally(() => { running = false; });

  return eventId;
}

async function churnWork(eventId: number): Promise<void> {
  // Step 1: assign categories to any artikel with NULL category_path.
  // This makes the nightly churn self-healing for freshly-imported data.
  let recategorize = { total: 0, updated: 0, fallback: 0 };
  try {
    recategorize = await processRecategorizeBatch(true);
    if (recategorize.updated > 0) {
      console.log(`[churner] recategorize: ${recategorize.updated}/${recategorize.total} artikel got a category_path`);
    }
  } catch (err) {
    console.warn('[churner] recategorize step failed:', (err as Error).message);
  }

  const batchSize = await getConfig('churner.batch_size');
  const confidenceGate = await getConfig('churner.confidence');

  const candidates = await sql`
    SELECT a.id, a.name, a.original_text, a.ai_guess, a.canonical_name
    FROM artikel a
    WHERE a.canonical_name IS NULL
       OR LENGTH(a.canonical_name) > 40
       OR a.canonical_name IN ('Diverse Artikel', 'Backwaren', 'Gemüse', 'Fleisch', 'Gewürze')
    ORDER BY a.id DESC
    LIMIT ${batchSize}
  `;

  const existing = (await sql`
    SELECT canonical_name, COUNT(*) AS n FROM artikel
    WHERE canonical_name IS NOT NULL
    GROUP BY canonical_name ORDER BY n DESC LIMIT 200
  `).map(r => r.canonical_name as string);

  let autoApplied = 0;
  let queued = 0;
  let skipped = 0;
  let dropped = 0;

  const stage1Llm = await providerForTask('churner_stage1');
  const stage2Llm = await providerForTask('churner_stage2');

  for (const a of candidates) {
    try {
      const stage1 = parseLlmJson<Stage1Result>(await stage1Llm.chat({
        system: STAGE1_PROMPT,
        user: JSON.stringify({
          original_text: a.original_text,
          name: a.name,
          ai_guess: a.ai_guess,
          current_canonical: a.canonical_name,
          existierende_namen: existing,
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
        const hits = await searxngSearch(stage1.query);
        if (hits.length) {
          const stage2 = parseLlmJson<Stage2Result>(await stage2Llm.chat({
            system: STAGE2_PROMPT,
            user: JSON.stringify({
              original_text: a.original_text,
              name: a.name,
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

      if (!canonical) { skipped++; continue; }

      // Snap near-duplicates to existing canonical names
      const twin = mostSimilar(canonical, existing, 0.85);
      if (twin) canonical = twin;

      if (canonical === a.canonical_name) { skipped++; continue; }

      if (confidence >= confidenceGate) {
        await sql`UPDATE artikel SET canonical_name = ${canonical} WHERE id = ${a.id}`;
        if (translationEn) {
          await sql`
            INSERT INTO canonical_translation (canonical_name, lang, translated, source)
            VALUES (${canonical}, 'en', ${translationEn}, 'churner')
            ON CONFLICT (canonical_name, lang) DO NOTHING
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
        await sql`
          INSERT INTO verifikations_queue (proposed_canonical, raw_patterns, ai_examples, confidence, status)
          VALUES (${canonical}, ${a.original_text ?? a.name}, ${a.ai_guess ?? a.name}, ${String(confidence.toFixed(2))}, 'pending')
        `;
        await notify('churner.queued', {
          artikel_id: a.id,
          original_text: a.original_text,
          proposed_canonical: canonical,
          confidence,
          source_url: sourceUrl,
        });
        queued++;
      }
    } catch (err) {
      console.error(`[churner] artikel ${a.id} failed:`, (err as Error).message);
      skipped++;
    }
  }

  // Also fetch store icons for any stores that don't have one yet
  const storeIconsAdded = await churnStoreIcons();

  const summary = {
    recategorize,
    candidates: candidates.length,
    auto_applied: autoApplied,
    queued,
    skipped,
    garbage: dropped,
    store_icons: storeIconsAdded,
  };
  await sql`UPDATE maintenance_event SET ended_at = NOW(), status = 'success',
            summary = ${sql.json(summary)} WHERE id = ${eventId}`;
  await notify('churner.run.summary', summary);
  console.log('[churner] done:', JSON.stringify(summary));
}

/** Fetches a logo image for every store that's been seen but has no icon yet.
 *  Picks first SearXNG image hit, logs source URL. Bounded to 20 per run. */
async function churnStoreIcons(): Promise<number> {
  const rows = await sql`
    SELECT DISTINCT
      LOWER(SPLIT_PART(REGEXP_REPLACE(roh_ladenname, '[^A-Za-zäöüÄÖÜß0-9]+', ' ', 'g'), ' ', 1)) AS key,
      MIN(roh_ladenname) AS display
    FROM einkauf
    WHERE roh_ladenname IS NOT NULL
    GROUP BY key
  `;
  const existing = new Set((await sql`SELECT store_key FROM store_meta WHERE icon_url IS NOT NULL`).map(r => r.store_key as string));
  const candidates = rows.filter(r => r.key && !existing.has(r.key as string)).slice(0, 20);

  let added = 0;
  for (const c of candidates) {
    try {
      const hits = await searxngImageSearch(`${c.display} logo`);
      if (!hits.length) continue;
      const url = hits[0].src;
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
