import type { FastifyInstance } from 'fastify';
import sql from '../db.js';

/** Fixed costs (recurring monthly expenses) CRUD — the manual-entry UI the
 *  analytics foundation (mig 040 `fixed_cost` → `v_transactions`) always expected.
 *  Scope is encoded by konto_id: a SHARED konto = household cost (rent, loan…), a
 *  personal konto = that person's cost ("Anthropic" for Martin). No per-row
 *  privacy — household finance planning is shared; can_write is enforced globally
 *  in the auth plugin, so these handlers only need an authenticated user. */
export function financeRoutes(app: FastifyInstance): void {
  const toNum = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  const toDate = (v: unknown): string | null => {
    const s = (v ?? '').toString().trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  };

  /** All fixed costs with their konto scope (household vs which person). */
  app.get('/api/fixed-costs', async () => {
    return sql`
      SELECT f.id, f.label, f.category_path, f.monthly_eur::float8 AS monthly_eur,
             f.konto_id, f.start_date, f.end_date, f.active,
             k.name AS konto_name, k.is_shared, k.user_id AS konto_user_id, u.username AS owner
      FROM fixed_cost f
      LEFT JOIN konto k ON k.id = f.konto_id
      LEFT JOIN users u ON u.id = k.user_id
      ORDER BY f.active DESC, k.is_shared DESC, u.username NULLS FIRST, f.label
    `;
  });

  app.post('/api/fixed-costs', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const label = (b.label ?? '').toString().trim();
    const monthly = toNum(b.monthly_eur);
    const kontoId = b.konto_id != null ? parseInt(String(b.konto_id), 10) : null;
    const start = toDate(b.start_date) ?? new Date().toISOString().slice(0, 10);
    const end = toDate(b.end_date);
    const category = (b.category_path ?? '').toString().trim() || null;
    if (!label) return reply.code(400).send({ error: 'label required' });
    if (monthly == null) return reply.code(400).send({ error: 'monthly_eur required' }); // negatives allowed (= recurring credit/income)
    if (!kontoId) return reply.code(400).send({ error: 'konto_id required' });
    const [row] = await sql`
      INSERT INTO fixed_cost (label, category_path, monthly_eur, konto_id, start_date, end_date, active, created_by)
      VALUES (${label}, ${category}, ${monthly}, ${kontoId}, ${start}, ${end}, ${b.active !== false}, ${req.user?.id ?? null})
      RETURNING id`;
    return { ok: true, id: row.id };
  });

  app.patch('/api/fixed-costs/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    if ('label' in b) {
      const l = (b.label ?? '').toString().trim();
      if (!l) return reply.code(400).send({ error: 'label cannot be empty' });
      updates.label = l;
    }
    if ('monthly_eur' in b) {
      const m = toNum(b.monthly_eur);
      if (m == null) return reply.code(400).send({ error: 'monthly_eur invalid' }); // negatives allowed
      updates.monthly_eur = m;
    }
    if ('konto_id' in b) {
      const k = b.konto_id != null ? parseInt(String(b.konto_id), 10) : null;
      if (!k) return reply.code(400).send({ error: 'konto_id required' });
      updates.konto_id = k;
    }
    if ('category_path' in b) updates.category_path = (b.category_path ?? '').toString().trim() || null;
    if ('start_date' in b) { const d = toDate(b.start_date); if (d) updates.start_date = d; }
    if ('end_date' in b) updates.end_date = toDate(b.end_date); // null clears it
    if ('active' in b) updates.active = !!b.active;
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'no patchable fields' });
    const [row] = await sql`UPDATE fixed_cost SET ${sql(updates)} WHERE id = ${id} RETURNING id`;
    if (!row) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.delete('/api/fixed-costs/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    await sql`DELETE FROM fixed_cost WHERE id = ${id}`;
    return { ok: true };
  });
}
