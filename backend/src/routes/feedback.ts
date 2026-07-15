import type { FastifyInstance } from 'fastify';
import sql, { adminSql } from '../db.js';
import { requirePlatformAdmin } from '../auth/plugin.js';
import { sendMail } from '../mailer.js';
import { feedbackEmail } from '../email/templates.js';

/** Bug report / feedback — available in ALL builds (the header "Feedback" button, plus the
 *  demo's floating button). Reports are stored in the global (no-RLS) bug_report table and
 *  best-effort forwarded to the operator by e-mail. Reading is platform-admin only
 *  (off-demo = sees_all_konten admin; demo = super-admin). */
export function feedbackRoutes(app: FastifyInstance): void {
  app.post('/api/bug-reports', async (req, reply) => {
    const { message, page } = (req.body ?? {}) as { message?: string; page?: string };
    if (!message || !message.trim()) return reply.code(400).send({ error: 'message required' });
    const ctx = {
      page: (page ?? '').slice(0, 300),
      household_id: req.user?.household_id ?? null,
      ua: String(req.headers['user-agent'] ?? '').slice(0, 300),
    };
    // bug_report is global (no RLS) → the ambient connection inserts fine regardless of scope.
    await sql`INSERT INTO bug_report (user_id, message, context) VALUES (${req.user?.id ?? null}, ${message.trim().slice(0, 5000)}, ${sql.json(ctx)})`;
    // Forward to the operator (fire-and-forget; never blocks the report). No-op if SMTP unset.
    void (async () => {
      try {
        const mail = feedbackEmail({ message: message.trim(), page: ctx.page, from: req.user?.email ?? req.user?.username ?? 'anonym', householdId: req.user?.household_id ?? null });
        await sendMail('webmaster@vorratsdatenspeicher.com', mail.subject, mail.text, mail.html, req.user?.email ?? undefined);
      } catch (err) { req.log.error(`feedback mail failed: ${(err as Error).message}`); }
    })();
    return { ok: true };
  });

  app.get('/api/bug-reports', { preHandler: requirePlatformAdmin }, async () =>
    adminSql`
      SELECT b.id, b.message, b.context, b.status, b.created_at, u.username, u.email
      FROM bug_report b LEFT JOIN users u ON u.id = b.user_id
      ORDER BY b.created_at DESC LIMIT 500`);

  app.patch('/api/bug-reports/:id', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const { status } = (req.body ?? {}) as { status?: string };
    if (!status) return reply.code(400).send({ error: 'status required' });
    await adminSql`UPDATE bug_report SET status = ${status} WHERE id = ${id}`;
    return { ok: true };
  });
}
