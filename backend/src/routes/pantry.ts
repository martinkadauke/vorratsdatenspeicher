import type { FastifyInstance } from 'fastify';
import sql from '../db.js';

export function pantryRoutes(app: FastifyInstance): void {
  app.get('/api/pantry', async () => {
    return sql`
      SELECT canonical_name, einheit, avg_daily, last_qty, last_bought,
             est_remaining, days_until_empty, purchase_count, updated_at
      FROM vorrat_status
      ORDER BY days_until_empty ASC NULLS LAST
    `;
  });

  app.get('/api/shopping-list', async () => {
    return sql`
      SELECT el.canonical_name, el.priority, el.added_by, el.added_at,
             vs.days_until_empty, vs.est_remaining, vs.einheit, vs.last_qty
      FROM einkaufsliste el
      LEFT JOIN vorrat_status vs ON vs.canonical_name = el.canonical_name
      ORDER BY COALESCE(vs.days_until_empty, 999) ASC, el.priority DESC
    `;
  });

  app.post('/api/shopping-list/feedback', async (req, reply) => {
    const { action, canonical_name, snooze_days } = (req.body ?? {}) as {
      action?: string; canonical_name?: string; snooze_days?: number;
    };
    if (!action || !canonical_name) return reply.code(400).send({ error: 'action and canonical_name required' });

    if (action === 'done') {
      await sql`DELETE FROM einkaufsliste WHERE canonical_name = ${canonical_name}`;
    } else if (action === 'snooze') {
      const days = snooze_days ?? 7;
      await sql.begin(async tx => {
        await tx`
          INSERT INTO vorschlag_snooze (canonical_name, snooze_bis)
          VALUES (${canonical_name}, CURRENT_DATE + ${days})
          ON CONFLICT (canonical_name) DO UPDATE SET snooze_bis = EXCLUDED.snooze_bis
        `;
        await tx`DELETE FROM einkaufsliste WHERE canonical_name = ${canonical_name}`;
      });
    } else if (action === 'exclude') {
      await sql.begin(async tx => {
        await tx`INSERT INTO artikel_ausschluss (canonical_name) VALUES (${canonical_name}) ON CONFLICT DO NOTHING`;
        await tx`DELETE FROM einkaufsliste WHERE canonical_name = ${canonical_name}`;
      });
    } else {
      return reply.code(400).send({ error: 'unknown action' });
    }
    return { ok: true };
  });

  app.get('/api/alerts', async () => {
    return sql`
      SELECT canonical_name, einheit, est_remaining, days_until_empty, last_bought
      FROM vorrat_status
      WHERE avg_daily IS NOT NULL
        AND (days_until_empty <= 3 OR est_remaining <= 0)
      ORDER BY days_until_empty ASC NULLS FIRST
      LIMIT 20
    `;
  });
}
