import type { FastifyInstance } from 'fastify';
import sql from '../db.js';

type SubKind = 'filiale' | 'artikel';
const KINDS: SubKind[] = ['filiale', 'artikel'];

/** Per-user offer subscriptions (filiale or canonical article). The downstream
 *  notification + prospectus matching is still WIP; these endpoints just persist
 *  the subscription so the "Angebote abonnieren" buttons are functional. */
export function subscriptionRoutes(app: FastifyInstance): void {
  /** All of the caller's subscriptions, grouped by kind. */
  app.get('/api/subscriptions', async (req) => {
    const rows = await sql`
      SELECT kind, ref FROM offer_subscription WHERE user_id = ${req.user!.id}
    `;
    return {
      filiale: rows.filter(r => r.kind === 'filiale').map(r => Number(r.ref)),
      artikel: rows.filter(r => r.kind === 'artikel').map(r => r.ref as string),
    };
  });

  /** Toggle one subscription on/off. Body: { kind, ref }. Returns the new state. */
  app.post('/api/subscriptions/toggle', async (req, reply) => {
    const { kind, ref } = (req.body ?? {}) as { kind?: SubKind; ref?: string | number };
    if (!kind || !KINDS.includes(kind) || ref === undefined || ref === null || ref === '') {
      return reply.code(400).send({ error: 'kind (filiale|artikel) and ref required' });
    }
    const refStr = String(ref);
    const [existing] = await sql`
      SELECT id FROM offer_subscription
      WHERE user_id = ${req.user!.id} AND kind = ${kind} AND ref = ${refStr}
    `;
    if (existing) {
      await sql`DELETE FROM offer_subscription WHERE id = ${existing.id}`;
      return { subscribed: false };
    }
    await sql`
      INSERT INTO offer_subscription (user_id, kind, ref)
      VALUES (${req.user!.id}, ${kind}, ${refStr})
      ON CONFLICT (user_id, kind, ref) DO NOTHING
    `;
    return { subscribed: true };
  });

  /** Bulk-subscribe several refs at once (used by the Artikel multi-select). */
  app.post('/api/subscriptions/bulk', async (req, reply) => {
    const { kind, refs } = (req.body ?? {}) as { kind?: SubKind; refs?: (string | number)[] };
    if (!kind || !KINDS.includes(kind) || !Array.isArray(refs) || !refs.length) {
      return reply.code(400).send({ error: 'kind and refs[] required' });
    }
    await sql.begin(async tx => {
      for (const ref of refs) {
        await tx`
          INSERT INTO offer_subscription (user_id, kind, ref)
          VALUES (${req.user!.id}, ${kind}, ${String(ref)})
          ON CONFLICT (user_id, kind, ref) DO NOTHING
        `;
      }
    });
    return { ok: true, subscribed: refs.length };
  });
}
