import type { FastifyInstance } from 'fastify';
import type { TransactionSql } from 'postgres';
import sql from '../db.js';
import { kontoScope, canSeeKonto } from '../auth/konto.js';
import { recordAlias, recordAliases } from '../lib/canonicalAlias.js';

const PATCHABLE = ['name', 'canonical_name', 'category_path', 'menge', 'einheit', 'preis'] as const;
const DECIMAL_FIELDS = new Set(['menge', 'preis']);

/** Accept German "1,99" alongside "1.99" — normalize for Postgres NUMERIC. */
function coerceDecimal(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).replace(',', '.').trim();
  return Number.isFinite(parseFloat(s)) ? s : null;
}

export function articleRoutes(app: FastifyInstance): void {
  /** Guard: the artikel belongs to a receipt the caller may see. */
  async function guardArtikel(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply, artikelId: number): Promise<boolean> {
    const [row] = await sql`SELECT e.konto_id FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id WHERE a.id = ${artikelId}`;
    if (!row) { void reply.code(404).send({ error: 'not found' }); return false; }
    if (!canSeeKonto(req.user, row.konto_id as number | null)) { void reply.code(403).send({ error: 'forbidden' }); return false; }
    return true;
  }

  /** Manually add an artikel to an existing einkauf. */
  app.post('/api/articles', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const einkaufId = parseInt(String(body.einkauf_id ?? ''), 10);
    if (!einkaufId) return reply.code(400).send({ error: 'einkauf_id required' });
    const [exists] = await sql`SELECT id, konto_id FROM einkauf WHERE id = ${einkaufId}`;
    if (!exists) return reply.code(404).send({ error: 'einkauf not found' });
    if (!canSeeKonto(req.user, exists.konto_id as number | null)) return reply.code(403).send({ error: 'forbidden' });

    const name = String(body.name ?? '').trim();
    if (!name && !body.canonical_name) return reply.code(400).send({ error: 'name or canonical_name required' });
    const menge = coerceDecimal(body.menge);
    const preis = coerceDecimal(body.preis);
    const einheit = body.einheit ? String(body.einheit) : null;
    const canonical = body.canonical_name ? String(body.canonical_name) : null;
    const category = body.category_path ? String(body.category_path) : null;
    const afterId = body.after_artikel_id ? parseInt(String(body.after_artikel_id), 10) : null;

    const id = await sql.begin(async tx => {
      // Insert directly under `afterId` when given (the gap-divider flow); else
      // sort_order stays NULL so COALESCE(sort_order, id) appends by id.
      let at: number | null = null;
      if (afterId) {
        const [chk] = await tx`SELECT id FROM artikel WHERE id = ${afterId} AND einkauf_id = ${einkaufId}`;
        if (chk) at = await gapAfter(tx, einkaufId, afterId);
      }
      const [row] = await tx`
        INSERT INTO artikel
          (einkauf_id, name, canonical_name, category_path, menge, einheit, preis, ai_guess, original_text, sort_order)
        VALUES
          (${einkaufId}, ${name || canonical || 'Artikel'}, ${canonical}, ${category},
           ${menge}, ${einheit}, ${preis}, ${canonical}, ${'manuell hinzugefügt'}, ${at})
        RETURNING id`;
      return row.id as number;
    });
    return { ok: true, id };
  });

  app.patch('/api/articles/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    if (!await guardArtikel(req, reply, id)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const updates: Record<string, unknown> = {};
    for (const key of PATCHABLE) {
      if (!(key in body)) continue;
      updates[key] = DECIMAL_FIELDS.has(key) ? coerceDecimal(body[key]) : body[key];
    }
    // Canonical names must be trimmed so "Bananen" and "Bananen " don't split.
    if (typeof updates.canonical_name === 'string') {
      updates.canonical_name = (updates.canonical_name as string).trim() || null;
    }
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'no patchable fields' });

    const rows = await sql`UPDATE artikel SET ${sql(updates)} WHERE id = ${id} RETURNING id, original_text, name`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    // learn from the manual correction so future scans of the same OCR text match
    if ('canonical_name' in updates && updates.canonical_name) {
      await recordAlias((rows[0].original_text as string) ?? (rows[0].name as string), updates.canonical_name as string);
    }
    return { ok: true };
  });

  app.delete('/api/articles/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    if (!await guardArtikel(req, reply, id)) return;
    await sql`DELETE FROM artikel WHERE id = ${id}`;
    return { ok: true };
  });

  /** Renumber a receipt's articles to multiples of 10 (current display order),
   *  so a new row can slot in at +5 without touching its neighbours. */
  async function gapAfter(tx: TransactionSql, einkaufId: number, afterId: number): Promise<number> {
    await tx`
      WITH ordered AS (
        SELECT id, (ROW_NUMBER() OVER (ORDER BY COALESCE(sort_order, id), id)) * 10 AS rn
        FROM artikel WHERE einkauf_id = ${einkaufId}
      )
      UPDATE artikel a SET sort_order = o.rn FROM ordered o WHERE a.id = o.id
    `;
    const [pos] = await tx`SELECT sort_order FROM artikel WHERE id = ${afterId}`;
    return (pos.sort_order as number) + 5;
  }

  /** Duplicate an article, placing the copy directly under the original. */
  app.post('/api/articles/:id/duplicate', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    if (!await guardArtikel(req, reply, id)) return;
    const [src] = await sql`SELECT einkauf_id FROM artikel WHERE id = ${id}`;
    const newId = await sql.begin(async tx => {
      const at = await gapAfter(tx, src.einkauf_id as number, id);
      const [row] = await tx`
        INSERT INTO artikel (einkauf_id, name, canonical_name, category_path, menge, einheit, preis, ai_guess, original_text, sort_order)
        SELECT einkauf_id, name, canonical_name, category_path, menge, einheit, preis, ai_guess, original_text, ${at}
        FROM artikel WHERE id = ${id}
        RETURNING id`;
      return row.id as number;
    });
    return { ok: true, id: newId };
  });

  /** Apply a canonical name (and optionally category) to every artikel that
   *  shares THIS one's OCR identity — same original_text / ai_guess / name.
   *  This is what "Alle mit diesem Namen" means when the siblings don't yet
   *  carry the canonical name (they only match on raw OCR text). */
  app.post('/api/articles/:id/apply-canonical', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    if (!await guardArtikel(req, reply, id)) return;
    const raw = (req.body ?? {}) as { canonical_name?: string; category_path?: string | null };
    const canonical_name = raw.canonical_name?.trim();
    const category_path = raw.category_path;
    if (!canonical_name) return reply.code(400).send({ error: 'canonical_name required' });

    const [src] = await sql`SELECT original_text, ai_guess, name FROM artikel WHERE id = ${id}`;
    if (!src) return reply.code(404).send({ error: 'not found' });
    const ot = (src.original_text as string | null)?.trim() || null;
    const ag = (src.ai_guess as string | null)?.trim() || null;
    const nm = (src.name as string | null)?.trim() || null;

    // Match siblings by the same raw OCR line (most reliable), or ai_guess,
    // or name. Scoped to accounts the caller can see.
    const idMatch = sql`(
      ${ot ? sql`a.original_text = ${ot}` : sql`FALSE`}
      OR ${ag ? sql`a.ai_guess = ${ag}` : sql`FALSE`}
      OR ${nm ? sql`a.name = ${nm}` : sql`FALSE`}
    )`;
    const setCat = category_path !== undefined ? sql`, category_path = ${category_path}` : sql``;
    const rows = await sql`
      UPDATE artikel a SET canonical_name = ${canonical_name} ${setCat}
      FROM einkauf e
      WHERE a.einkauf_id = e.id AND ${idMatch}
        ${kontoScope(req.user, sql`e.konto_id`)}
      RETURNING a.id
    `;
    // learn this OCR identity → canonical for future scans
    await recordAliases([[ot, canonical_name], [ag, canonical_name], [nm, canonical_name]]);
    return { ok: true, updated: rows.length };
  });

  app.put('/api/articles/:id/consumers', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    const { members } = (req.body ?? {}) as { members?: number[] };
    if (!Array.isArray(members)) return reply.code(400).send({ error: 'members must be an array' });

    await sql.begin(async tx => {
      await tx`DELETE FROM artikel_consumer WHERE artikel_id = ${id}`;
      for (const m of members) {
        await tx`INSERT INTO artikel_consumer (artikel_id, family_member_id) VALUES (${id}, ${m}) ON CONFLICT DO NOTHING`;
      }
    });
    return { ok: true };
  });

  /** Cascading edit: applies to ALL artikel sharing this canonical name. */
  app.put('/api/canonical/:name', async (req, reply) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    const { new_name, category_path, einheit } = (req.body ?? {}) as {
      new_name?: string; category_path?: string; einheit?: string;
    };
    if (!new_name && !category_path && einheit === undefined) {
      return reply.code(400).send({ error: 'nothing to update' });
    }

    await sql.begin(async tx => {
      let current = name;
      if (new_name && new_name !== name) {
        await tx`UPDATE artikel SET canonical_name = ${new_name} WHERE canonical_name = ${name}`;
        await tx`UPDATE einkaufsliste SET canonical_name = ${new_name} WHERE canonical_name = ${name}`;
        await tx`UPDATE vorrat_status SET canonical_name = ${new_name} WHERE canonical_name = ${name}`;
        await tx`UPDATE canonical_consumer SET canonical_name = ${new_name} WHERE canonical_name = ${name}`;
        await tx`UPDATE canonical_translation SET canonical_name = ${new_name} WHERE canonical_name = ${name}`;
        await tx`UPDATE canonical_alias SET canonical_name = ${new_name} WHERE canonical_name = ${name}`;
        // Offer subscriptions follow the rename too (else "Angebote holen" keeps
        // searching the old name). Guard the (user_id, kind, ref) uniqueness.
        await tx`
          UPDATE offer_subscription s SET ref = ${new_name}
          WHERE s.kind = 'artikel' AND s.ref = ${name}
            AND NOT EXISTS (SELECT 1 FROM offer_subscription s2
                            WHERE s2.user_id = s.user_id AND s2.kind = 'artikel' AND s2.ref = ${new_name})`;
        await tx`DELETE FROM offer_subscription WHERE kind = 'artikel' AND ref = ${name}`;
        // Avoid list + product icon (both keyed by canonical_name) — guard PK clash.
        await tx`UPDATE artikel_ausschluss SET canonical_name = ${new_name}
                 WHERE canonical_name = ${name} AND NOT EXISTS (SELECT 1 FROM artikel_ausschluss WHERE canonical_name = ${new_name})`;
        await tx`DELETE FROM artikel_ausschluss WHERE canonical_name = ${name}`;
        await tx`UPDATE canonical_meta SET canonical_name = ${new_name}
                 WHERE canonical_name = ${name} AND NOT EXISTS (SELECT 1 FROM canonical_meta WHERE canonical_name = ${new_name})`;
        await tx`DELETE FROM canonical_meta WHERE canonical_name = ${name}`;
        current = new_name;
      }
      if (category_path !== undefined) {
        await tx`UPDATE artikel SET category_path = ${category_path || null} WHERE canonical_name = ${current}`;
      }
      if (einheit !== undefined) {
        await tx`UPDATE artikel SET einheit = ${einheit || null} WHERE canonical_name = ${current}`;
      }
    });
    return { ok: true };
  });

  app.put('/api/canonical/:name/consumers', async (req, reply) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    const { members, exclusive } = (req.body ?? {}) as { members?: number[]; exclusive?: boolean };
    if (!Array.isArray(members)) return reply.code(400).send({ error: 'members must be an array' });

    await sql.begin(async tx => {
      await tx`DELETE FROM canonical_consumer WHERE canonical_name = ${name}`;
      for (const m of members) {
        await tx`
          INSERT INTO canonical_consumer (canonical_name, family_member_id, is_exclusive)
          VALUES (${name}, ${m}, ${exclusive ?? false})
          ON CONFLICT DO NOTHING
        `;
      }
      if (exclusive) {
        // Exclusive at the canonical level overrides any per-artikel tags
        await tx`DELETE FROM artikel_consumer WHERE artikel_id IN (SELECT id FROM artikel WHERE canonical_name = ${name})`;
      }
    });
    return { ok: true };
  });

  app.put('/api/canonical/:name/translation', async (req, reply) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    const { lang, translated } = (req.body ?? {}) as { lang?: string; translated?: string };
    if (!lang || translated === undefined) return reply.code(400).send({ error: 'lang and translated required' });

    if (!translated) {
      await sql`DELETE FROM canonical_translation WHERE canonical_name = ${name} AND lang = ${lang}`;
    } else {
      await sql`
        INSERT INTO canonical_translation (canonical_name, lang, translated, source, updated_at)
        VALUES (${name}, ${lang}, ${translated}, 'manual', NOW())
        ON CONFLICT (canonical_name, lang) DO UPDATE SET translated = EXCLUDED.translated, source = 'manual', updated_at = NOW()
      `;
    }
    return { ok: true };
  });

  app.get('/api/canonical/:name/receipts', async (req) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    return sql`
      SELECT DISTINCT e.id, e.datum, e.roh_ladenname, e.bild_pfad
      FROM einkauf e
      JOIN artikel a ON a.einkauf_id = e.id
      WHERE (a.canonical_name = ${name}
         OR COALESCE(NULLIF(a.ai_guess, ''), a.name) = ${name})
        ${kontoScope(req.user, sql`e.konto_id`)}
      ORDER BY e.datum DESC, e.id DESC
      LIMIT 10
    `;
  });
}
