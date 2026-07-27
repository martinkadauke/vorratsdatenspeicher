import sql from '../db.js';
import { parseLlmJson } from '../llm/ollama.js';
import { providerForTask } from '../llm/provider.js';
import { notify } from '../notify.js';

const ALLOWED = ['Stück', 'Packung', 'kg', 'l'] as const;

const PROMPT = `Du bestimmst die VERGLEICHS-Einheit eines Produkts — also die Einheit, in der der
Preis im Laden ausgezeichnet und bei Marktguru angegeben wird (der "Grundpreis"),
NICHT das Gebinde, in dem man es kauft.

Erlaubte Werte (genau einer pro Produkt): "Stück", "Packung", "kg", "l".

Wichtig — es zählt der Grundpreis, auch wenn man es als Becher/Packung kauft:
- Milchprodukte mit kg-Grundpreis (Joghurt, Quark, Sahne, Frischkäse, Butter, Margarine) → "kg".
- Käse, Wurst, Aufschnitt, Fleisch, Obst, Gemüse, Nüsse (lose oder verpackt, pro kg ausgezeichnet) → "kg".
- Getränke/Flüssigkeiten (Milch, Saft, Öl, Limo, Wasser, Essig) → "l".
- Pro Stück ausgezeichnete Ware: Konserven & Dosen (Thunfisch, Mais, Bohnen), Eier, Drogerie-/Hygieneartikel, Tafel Schokolade, einzelne Fertiggerichte → "Stück".
- Mehrfach-/Großgebinde ohne kg-/l-Grundpreis → "Packung".
Die "erfasste_einheit" ist ein Hinweis aus echten Bons, oft ungenau — entscheide nach dem Produkt und seinem üblichen Grundpreis.

Antworte AUSSCHLIESSLICH mit JSON-Array (keine Code-Fences):
[{"canonical":"<name>","base_unit":"Stück|Packung|kg|l"}]`;

let running = false;
export function isSeedUnitsRunning(): boolean { return running; }

/** One-time: let the LLM pick a base_unit for every canonical product. */
export async function runSeedBaseUnits(onlyMissing: boolean): Promise<number> {
  if (running) throw new Error('seed-units already running');
  running = true;

  const [event] = await sql`
    INSERT INTO maintenance_event (kind, status, summary)
    VALUES ('seed_units.run', 'running', ${sql.json({ only_missing: onlyMissing })})
    RETURNING id`;
  const eventId = event.id as number;

  void seedWork(eventId, onlyMissing)
    .catch(async err => {
      await sql`UPDATE maintenance_event SET ended_at = NOW(), status = 'error',
                summary = ${sql.json({ error: (err as Error).message })} WHERE id = ${eventId}`;
    })
    .finally(() => { running = false; });

  return eventId;
}

async function seedWork(eventId: number, onlyMissing: boolean): Promise<void> {
  const llm = await providerForTask('recategorize');
  // distinct canonicals + the most common observed unit (a hint for the LLM)
  const cans = await sql`
    SELECT a.canonical_name AS name,
           mode() WITHIN GROUP (ORDER BY NULLIF(TRIM(LOWER(a.einheit)), '')) AS common_unit
    FROM artikel a
    LEFT JOIN canonical_meta m ON m.canonical_name = a.canonical_name
    WHERE a.canonical_name IS NOT NULL AND TRIM(a.canonical_name) <> ''
      ${onlyMissing ? sql`AND (m.base_unit IS NULL OR m.base_unit = '')` : sql``}
    GROUP BY a.canonical_name
    ORDER BY a.canonical_name`;

  const allowed = new Set<string>(ALLOWED);
  let set = 0;
  const BATCH = 25;
  for (let i = 0; i < cans.length; i += BATCH) {
    const batch = cans.slice(i, i + BATCH);
    let res: { canonical: string; base_unit: string }[] = [];
    try {
      res = parseLlmJson<{ canonical: string; base_unit: string }[]>(await llm.chat({
        system: PROMPT,
        user: JSON.stringify({ produkte: batch.map(b => ({ canonical: b.name, erfasste_einheit: b.common_unit })) }),
        json: true,
        arrayResult: true,   // prompt returns [{canonical,base_unit}]
      }));
    } catch (e) {
      console.error(`[seed-units] batch at ${i} failed: ${(e as Error).message}`);
    }
    const byName = new Map(
      (Array.isArray(res) ? res : [])
        .filter(r => r && typeof r.canonical === 'string' && allowed.has(r.base_unit))
        .map(r => [r.canonical, r.base_unit]),
    );
    for (const b of batch) {
      const bu = byName.get(b.name as string);
      if (!bu) continue;
      await sql`
        INSERT INTO canonical_meta (canonical_name, base_unit, updated_at)
        VALUES (${b.name}, ${bu}, NOW())
        ON CONFLICT (canonical_name) DO UPDATE SET base_unit = EXCLUDED.base_unit, updated_at = NOW()`;
      set++;
    }
  }

  const summary = { total: cans.length, set };
  await sql`UPDATE maintenance_event SET ended_at = NOW(), status = 'success',
            summary = ${sql.json(summary)} WHERE id = ${eventId}`;
  await notify('seed_units.done', summary);
  console.log('[seed-units] done:', JSON.stringify(summary));
}
