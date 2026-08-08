import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';

// Household members are the PEOPLE; a login is something a person may or may not have, and a bank
// account belongs to the person, not to the login. See migration 110 for why that distinction
// matters (a child's account has no login to hang on, and deleting a user silently orphaned it).

export function familyRoutes(app: FastifyInstance): void {
  /** Members with their login link and the bank accounts they own.
   *  Archived members are hidden unless explicitly asked for — they still own their history. */
  app.get<{ Querystring: { archived?: string } }>('/api/family', async (req) => {
    const withArchived = req.query?.archived === '1';
    return sql`
      SELECT fm.id, fm.name, fm.color, fm.emoji, fm.user_id, fm.sort_order, fm.archived_at,
             u.username,
             COALESCE(
               (SELECT json_agg(ko.konto_id ORDER BY ko.konto_id) FROM konto_owner ko WHERE ko.family_member_id = fm.id),
               '[]'::json
             ) AS konto_ids
      FROM family_member fm
      LEFT JOIN users u ON u.id = fm.user_id
      WHERE ${withArchived ? sql`TRUE` : sql`fm.archived_at IS NULL`}
      ORDER BY fm.sort_order, fm.id`;
  });

  app.post('/api/family', { preHandler: requireAdmin }, async (req, reply) => {
    const { name, color, emoji, user_id, sort_order } = (req.body ?? {}) as {
      name?: string; color?: string; emoji?: string; user_id?: number; sort_order?: number;
    };
    if (!name) return reply.code(400).send({ error: 'name required' });
    const [row] = await sql`
      INSERT INTO family_member (name, color, emoji, user_id, sort_order)
      VALUES (${name}, ${color ?? null}, ${emoji ?? null}, ${user_id ?? null}, ${sort_order ?? 99})
      RETURNING id
    `;
    return { ok: true, id: row.id };
  });

  app.patch('/api/family/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    for (const key of ['name', 'color', 'emoji', 'user_id', 'sort_order']) {
      if (key in body) updates[key] = body[key];
    }
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'nothing to update' });
    const rows = await sql`UPDATE family_member SET ${sql(updates)} WHERE id = ${id} RETURNING id`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  /** "Das bin ich" — link the CALLING user to this member.
   *
   *  Exactly one member may carry it per user, and the database enforces that with a partial
   *  unique index. So the previous link has to go first, in the same transaction: setting it on
   *  Lena while it still sits on Martin would otherwise just fail with a constraint error and the
   *  user would have no idea why the toggle "did nothing". */
  app.post('/api/family/:id/thats-me', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const userId = req.user!.id;
    const [member] = await sql`SELECT id, user_id FROM family_member WHERE id = ${id} AND archived_at IS NULL`;
    if (!member) return reply.code(404).send({ error: 'not found' });
    // Someone else's account already claims this member — that is a different person, not a toggle.
    if (member.user_id != null && member.user_id !== userId) {
      return reply.code(409).send({ error: 'member_taken' });
    }
    await sql.begin(async (tx) => {
      await tx`UPDATE family_member SET user_id = NULL WHERE user_id = ${userId}`;
      await tx`UPDATE family_member SET user_id = ${userId} WHERE id = ${id}`;
    });
    return { ok: true };
  });

  /** Which member am I? Lets the wizard show the toggle already set on a revisit. */
  app.get('/api/family/me', async (req) => {
    const [row] = await sql`SELECT id FROM family_member WHERE user_id = ${req.user!.id}`;
    return { member_id: row?.id ?? null };
  });

  /** Who owns this bank account. Replaces the whole set in one call — the UI edits a list of
   *  checkboxes, and a partial update would leave it guessing what it did not send. */
  app.put<{ Body: { member_ids?: number[] } }>('/api/family/konto/:kontoId/owners', { preHandler: requireAdmin }, async (req, reply) => {
    const kontoId = parseInt((req.params as { kontoId: string }).kontoId, 10);
    const ids = Array.isArray(req.body?.member_ids) ? req.body!.member_ids.filter(n => Number.isInteger(n)) : [];
    const [konto] = await sql`SELECT id FROM konto WHERE id = ${kontoId}`;
    if (!konto) return reply.code(404).send({ error: 'not found' });
    await sql.begin(async (tx) => {
      await tx`DELETE FROM konto_owner WHERE konto_id = ${kontoId}`;
      if (ids.length) {
        await tx`INSERT INTO konto_owner ${tx(ids.map(m => ({ konto_id: kontoId, family_member_id: m })))} ON CONFLICT DO NOTHING`;
      }
    });
    return { ok: true, owners: ids.length };
  });

  /** Leaving the household ARCHIVES the member.
   *
   *  ⚠️ Not a DELETE. canonical_consumer and artikel_consumer hang off the member with
   *  ON DELETE CASCADE and einkauf.snapped_by_member_id goes NULL, so removing the row would quietly rewrite
   *  history: who ate what, who scanned which receipt, and the ownership of their bank accounts.
   *  Someone who moves out did not retroactively never exist. They vanish from every picker, keep
   *  their past, and can be restored.
   *  A member with no history at all is deleted for real — nothing to preserve, and an accidental
   *  typo should not leave a tombstone. */
  app.delete('/api/family/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const [{ used }] = await sql`
      SELECT (
        EXISTS (SELECT 1 FROM canonical_consumer WHERE family_member_id = ${id})
        OR EXISTS (SELECT 1 FROM artikel_consumer WHERE family_member_id = ${id})
        OR EXISTS (SELECT 1 FROM einkauf WHERE snapped_by_member_id = ${id})
        OR EXISTS (SELECT 1 FROM konto_owner WHERE family_member_id = ${id})
      ) AS used`;
    if (!used) {
      await sql`DELETE FROM family_member WHERE id = ${id}`;
      return { ok: true, deleted: true };
    }
    const rows = await sql`
      UPDATE family_member SET archived_at = NOW(), user_id = NULL
      WHERE id = ${id} AND archived_at IS NULL RETURNING id`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    return { ok: true, archived: true };
  });

  /** Moved back in. */
  app.post('/api/family/:id/restore', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const rows = await sql`UPDATE family_member SET archived_at = NULL WHERE id = ${id} RETURNING id`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });
}
