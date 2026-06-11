import type { FastifyInstance } from 'fastify';
import sql from '../db.js';

export function goalRoutes(app: FastifyInstance): void {
  app.get('/api/goals', async (req) => {
    const q = req.query as { year?: string; month?: string };
    const now = new Date();
    const year = parseInt(q.year ?? '', 10) || now.getFullYear();
    const month = parseInt(q.month ?? '', 10) || now.getMonth() + 1;
    return sql`
      SELECT category_path, goal_eur FROM spending_goal
      WHERE year = ${year} AND month = ${month}
    `;
  });

  app.put('/api/goals', async (req, reply) => {
    const { category_path, year, month, goal_eur } = (req.body ?? {}) as {
      category_path?: string; year?: number; month?: number; goal_eur?: number | string | null;
    };
    if (category_path === undefined || !year || !month) {
      return reply.code(400).send({ error: 'category_path, year, month required' });
    }
    if (goal_eur === null || goal_eur === undefined || goal_eur === '') {
      await sql`DELETE FROM spending_goal WHERE category_path = ${category_path} AND year = ${year} AND month = ${month}`;
      return { ok: true, deleted: true };
    }
    // Accept comma-decimal from German input
    const normalized = parseFloat(String(goal_eur).replace(',', '.'));
    if (!Number.isFinite(normalized) || normalized < 0) {
      return reply.code(400).send({ error: 'invalid goal_eur' });
    }
    await sql`
      INSERT INTO spending_goal (category_path, year, month, goal_eur, set_by)
      VALUES (${category_path}, ${year}, ${month}, ${normalized}, ${req.user?.id ?? null})
      ON CONFLICT (category_path, year, month)
      DO UPDATE SET goal_eur = EXCLUDED.goal_eur, set_at = NOW(), set_by = EXCLUDED.set_by
    `;
    return { ok: true };
  });
}
