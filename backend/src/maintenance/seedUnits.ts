import sql, { adminSql, DEMO_MODE, withHousehold } from '../db.js';
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

/** Tenant scope for `void`-detached work. Off-demo a plain call (no RLS, `sql` is the pool).
 *  On the demo the detached body outlives the request, so the request's reserved household
 *  connection is already released by then — the job would read/write nothing (no
 *  app.current_household → the RLS predicate is NULL) or land in whichever household the
 *  recycled connection now serves. Re-opening the household fixes both. Fails closed when the
 *  household is unknown rather than inventing one; the caller's `.catch` records it. */
const bgHousehold = <T>(householdId: number | null | undefined, fn: () => Promise<T>): Promise<T> => {
  if (!DEMO_MODE) return fn();
  if (householdId == null) return Promise.reject(new Error('kein Haushalt im Kontext – Hintergrundlauf abgebrochen'));
  return withHousehold(householdId, fn);
};

/** The household this call is scoped to, read from the session GUC while we are still on the
 *  caller's reserved connection. Demo only; never throws, so it can't strand `running`. */
async function currentHousehold(): Promise<number | null> {
  try {
    const [row] = await sql`SELECT NULLIF(current_setting('app.current_household', true), '')::bigint AS hid`;
    const hid = Number(row?.hid ?? NaN);
    return Number.isFinite(hid) && hid > 0 ? hid : null;
  } catch { return null; }
}

/** One-time: let the LLM pick a base_unit for every canonical product.
 *  `householdId` is demo-only and three-valued: `undefined` = the caller never looked (an
 *  awaited route call, still on its own live connection) → derive it from the GUC, `null` = the
 *  caller looked and found none → fail closed, a number = that tenant. Off-demo it is ignored. */
export async function runSeedBaseUnits(onlyMissing: boolean, householdId?: number | null): Promise<number> {
  if (running) throw new Error('seed-units already running');
  running = true;

  let hid: number | null = null;
  let eventId = 0;
  try {
    // Capture the tenant scope BEFORE the `void` below detaches the work — see bgHousehold().
    // Re-read the GUC only when the caller never looked; a late re-read on the demo could
    // answer from a recycled connection that now serves a different household.
    hid = DEMO_MODE ? (householdId !== undefined ? householdId : await currentHousehold()) : null;

    // adminSql, not sql: the hazard is connection IDENTITY, not RLS. maintenance_event really is
    // platform-global, but a detached caller reaches this line after its reserved connection was
    // released, so the AsyncLocalStorage handle would pipeline this INSERT into whatever request
    // now owns that physical connection. Off-demo `adminSql` IS the pool object `sql` uses.
    const [event] = await adminSql`
      INSERT INTO maintenance_event (kind, status, summary)
      VALUES ('seed_units.run', 'running', ${adminSql.json({ only_missing: onlyMissing })})
      RETURNING id`;
    eventId = event.id as number;
  } catch (err) {
    // Setup failed before the `.finally` below exists — release the single-flight flag by hand,
    // otherwise every later run 409s "seed-units already running" for the process lifetime.
    running = false;
    throw err;
  }

  void bgHousehold(hid, () => seedWork(eventId, onlyMissing))
    .catch(async err => {
      // Owner pool for the same reason as the INSERT above: a promise continuation inherits the
      // store captured when it was registered — the caller's already-released connection.
      await adminSql`UPDATE maintenance_event SET ended_at = NOW(), status = 'error',
                summary = ${adminSql.json({ error: (err as Error).message })} WHERE id = ${eventId}`;
    })
    .finally(() => { running = false; })
    // Tail guard: an unobserved rejection from the error handler would kill the container under
    // Node's default policy (→ Swarm rollback). bgHousehold fails closed, so this path is real.
    .catch(err => console.error('[seed-units] run bookkeeping failed:', (err as Error).message));

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
      // Update-then-insert rather than ON CONFLICT: the conflict target differs per env (PK is
      // canonical_name off-demo, (household_id, canonical_name) on the demo — migration 087), so
      // naming one shape raises 42P10 on the other. Same idiom as routes/icons.ts. RLS already
      // scopes the UPDATE — and the INSERT's household_id — to the run's household.
      const upd = await sql`
        UPDATE canonical_meta SET base_unit = ${bu}, updated_at = NOW()
        WHERE canonical_name = ${b.name}`;
      if (upd.count === 0) {
        // Bare DO NOTHING (no named arbiter, same reason): a writer that created the row
        // between the UPDATE and here must not abort the whole seed run over one product.
        // The PK is this table's only unique constraint → identical arbitration off-demo.
        await sql`
          INSERT INTO canonical_meta (canonical_name, base_unit, updated_at)
          VALUES (${b.name}, ${bu}, NOW())
          ON CONFLICT DO NOTHING`;
      }
      set++;
    }
  }

  const summary = { total: cans.length, set };
  await sql`UPDATE maintenance_event SET ended_at = NOW(), status = 'success',
            summary = ${sql.json(summary)} WHERE id = ${eventId}`;
  await notify('seed_units.done', summary);
  console.log('[seed-units] done:', JSON.stringify(summary));
}
