import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { kontoScope, canSeeKonto } from '../auth/konto.js';

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

    const [row] = await sql`
      INSERT INTO artikel
        (einkauf_id, name, canonical_name, category_path, menge, einheit, preis, ai_guess, original_text)
      VALUES
        (${einkaufId}, ${name || canonical || 'Artikel'}, ${canonical}, ${category},
         ${menge}, ${einheit}, ${preis}, ${canonical}, ${'manuell hinzugefügt'})
      RETURNING id
    `;
    return { ok: true, id: row.id };
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
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'no patchable fields' });

    const rows = await sql`UPDATE artikel SET ${sql(updates)} WHERE id = ${id} RETURNING id`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.delete('/api/articles/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    if (!await guardArtikel(req, reply, id)) return;
    await sql`DELETE FROM artikel WHERE id = ${id}`;
    return { ok: true };
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
