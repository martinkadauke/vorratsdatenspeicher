import type { FastifyInstance } from 'fastify';
import sql, { adminSql, DEMO_MODE } from '../db.js';
import { requirePlatformAdmin } from '../auth/plugin.js';
import { sendMail, type MailAttachment } from '../mailer.js';
import { feedbackEmail, feedbackThanksEmail } from '../email/templates.js';

/** Bug report / feedback — available in ALL builds (the header "Feedback" button, plus the
 *  demo's floating button). Reports are stored in the global (no-RLS) bug_report table and
 *  best-effort forwarded to the operator by e-mail. Reading is platform-admin only
 *  (off-demo = sees_all_konten admin; demo = super-admin). */
export function feedbackRoutes(app: FastifyInstance): void {
  // bodyLimit raised: an annotated screenshot (JPEG data-URL) rides along in the body.
  app.post('/api/bug-reports', { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const { message, page, screenshot_base64 } = (req.body ?? {}) as { message?: string; page?: string; screenshot_base64?: string };
    if (!message || !message.trim()) return reply.code(400).send({ error: 'message required' });
    // Screenshot the user drew on: a data-URL. Turned into a mail attachment, not stored in the row.
    const shot = typeof screenshot_base64 === 'string' && screenshot_base64.startsWith('data:image/') ? screenshot_base64 : null;
    const ctx = {
      page: (page ?? '').slice(0, 300),
      household_id: req.user?.household_id ?? null,
      has_screenshot: !!shot,
      ua: String(req.headers['user-agent'] ?? '').slice(0, 300),
    };
    // bug_report is global (no RLS) → the ambient connection inserts fine regardless of scope.
    await sql`INSERT INTO bug_report (user_id, message, context) VALUES (${req.user?.id ?? null}, ${message.trim().slice(0, 5000)}, ${sql.json(ctx)})`;
    // On the demo, resolve the household NAME so the operator knows who reported it.
    let householdName: string | null = null;
    if (DEMO_MODE && req.user?.household_id != null) {
      try {
        const [h] = await adminSql`SELECT name FROM household WHERE id = ${req.user.household_id}`;
        householdName = (h?.name as string | undefined) ?? null;
      } catch { /* household table only exists on the demo build */ }
    }
    // Forward to the operator ONLY on the demo — a self-hoster's report (now carrying a
    // screenshot of their private data) must never leave their box. Self-host reports stay
    // in bug_report, readable by the local admin. Fire-and-forget; no-op if SMTP unset.
    if (DEMO_MODE) void (async () => {
      try {
        let attachments: MailAttachment[] | undefined;
        const comma = shot ? shot.indexOf(',') : -1;
        if (shot && comma > -1) {
          const contentType = shot.slice(5, comma).split(';')[0] || 'image/jpeg';
          attachments = [{ filename: 'screenshot.jpg', content: shot.slice(comma + 1), encoding: 'base64', contentType }];
        }
        const mail = feedbackEmail({ message: message.trim(), page: ctx.page, from: req.user?.email ?? req.user?.username ?? 'anonym', householdId: req.user?.household_id ?? null, householdName });
        await sendMail('webmaster@vorratsdatenspeicher.com', mail.subject, mail.text, mail.html, req.user?.email ?? undefined, attachments);
      } catch (err) { req.log.error(`feedback mail failed: ${(err as Error).message}`); }

      // Thank the sender and tell them VDS is free + self-hostable — someone who just took the
      // time to write in is the best person to hear it. Separate try/catch so a bounce here can
      // never cost the operator their copy of the report above.
      const to = req.user?.email;
      if (to) {
        try {
          const thanks = feedbackThanksEmail();
          await sendMail(to, thanks.subject, thanks.text, thanks.html);
        } catch (err) { req.log.error(`feedback thank-you mail failed: ${(err as Error).message}`); }
      }
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
