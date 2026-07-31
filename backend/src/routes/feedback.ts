import type { FastifyInstance } from 'fastify';
import sql, { adminSql, DEMO_MODE } from '../db.js';
import { requirePlatformAdmin } from '../auth/plugin.js';
import { sendMail, smtpConfigured, verifySmtp, invalidateSmtpCheck, type MailAttachment, type MailFailReason } from '../mailer.js';
import { feedbackEmail, feedbackThanksEmail } from '../email/templates.js';

/** Where every report goes, in EVERY build (demo, dev, prod, self-host): the developer. The
 *  admin of a self-hosted box can read the bug_report table all day and still not be the person
 *  who can fix a bug in the app. */
const DEVELOPER_MAIL = 'webmaster@vorratsdatenspeicher.com';

/** Ceiling on how often ONE user may file a report, in EVERY build. Each call sends a mail with
 *  the ≤12 MB screenshot attached (plus, on the demo, a thank-you to the caller) from a route
 *  that needs no admin rights at all — the same reason the invite/reset sends in routes/admin.ts
 *  are metered.
 *
 *  Off-demo this used to be unmetered, on the argument that a self-hosted send is "one mail from
 *  a trusted household member over their own relay". That stopped being true when the forward
 *  below lost its DEMO_MODE gate: the destination is now a THIRD party (the developer's mailbox)
 *  reached over the operator's relay, so any household account — or anyone holding a stolen
 *  7-day token — could loop this route into a mail cannon aimed at someone the operator does not
 *  control, and every failed send drops the cached SMTP verdict (see below), which without a cap
 *  turns the dialog's own status endpoint into a connection probe. Self-hosters get a far higher
 *  ceiling than the demo because a real household files real reports in bursts.
 *
 *  A sliding hour window rather than one of the cumulative household counters in demo/limits.ts:
 *  those are lifetime spend caps with a column per quota, and a bug report is neither tokens nor
 *  something a visitor should permanently run out of — the person who just hit a bug is exactly
 *  who we want writing in. bug_report already stores created_at, so the window costs one COUNT
 *  and no migration. */
const MAX_REPORTS_PER_HOUR = DEMO_MODE ? 5 : 20;
const reportLimitMessage = (max: number) =>
  `Zu viele Fehlerberichte in kurzer Zeit: maximal ${max} pro Stunde. Bitte versuche es später noch einmal.`;

/** One cap for the stored row AND the forwarded mail. The row was always trimmed, the mail was
 *  not — so a 12 MB body (the limit is that high because an annotated screenshot rides in the
 *  same JSON) became a 12 MB e-mail to a mailbox the operator does not own. */
const MAX_MESSAGE_CHARS = 5000;

/** Why a report did not reach the developer. The two SMTP reasons come from the mailer and are
 *  about this box; 'consent_missing' is about the CLIENT — a tab or script that predates the
 *  consent tick and therefore may not have its screenshot forwarded. Kept apart because they
 *  need different sentences and only the SMTP ones say anything about the mail setup. */
type ReportFailReason = MailFailReason | 'consent_missing';

/** Which build a report came from — the first question when one lands in the inbox: public demo,
 *  or someone's self-hosted image of unknown vintage? feedbackEmail() (email/templates.ts) has no
 *  field for it, so the stamp rides at the END of the message body; the subject is cut from the
 *  first 50 characters, so it stays out of there. Build facts only — nothing identifying beyond
 *  the reply-to address that already goes out. */
function buildStamp(hasScreenshot: boolean): string {
  const version = process.env.APP_VERSION || 'dev';
  const sha = (process.env.GIT_SHA || 'unknown').slice(0, 12);
  return `--\nBuild: ${version} (${sha}) · Modus: ${DEMO_MODE ? 'Demo' : 'Self-Host'} · Screenshot: ${hasScreenshot ? 'ja' : 'nein'}`;
}

/** Bug report / feedback — available in ALL builds (the header "Feedback" button, plus the
 *  demo's floating button). Reports are stored in the global (no-RLS) bug_report table AND
 *  e-mailed to the developer, in every build; the dialog discloses that before the user writes,
 *  and off-demo the report only leaves the box with an explicit `consent: true` in the body.
 *  Reading the stored rows is platform-admin only (off-demo = sees_all_konten admin; demo =
 *  super-admin). */
export function feedbackRoutes(app: FastifyInstance): void {
  /** Can a report actually reach the developer from THIS box? The dialog asks before the user
   *  types, so the disclosure only promises an e-mail when one can really go out — and when it
   *  cannot, the user learns that instead of being told nothing. A live connect/handshake, not a
   *  config read: half-filled SMTP settings look perfect in app_config and bounce every send.
   *
   *  Deliberately NOT requireOperator, unlike /api/smtp/test (which mails a caller-supplied
   *  address and hands back the raw transport error): ANY logged-in user may file a report, so
   *  any of them must be able to ask this first. What comes back is a boolean plus a coarse
   *  reason — never the operator's host, account or error text. verifySmtp() caches and
   *  single-flights, so this cannot be turned into a connection probe. */
  app.get('/api/bug-reports/mail-status', async (req) => {
    const check = await verifySmtp(msg => req.log.warn(msg));
    return { ok: check.ok, reason: check.ok ? null : check.reason };
  });

  // bodyLimit raised: an annotated screenshot (JPEG data-URL) rides along in the body.
  app.post('/api/bug-reports', { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const { message, page, screenshot_base64, consent } = (req.body ?? {}) as { message?: string; page?: string; screenshot_base64?: string; consent?: boolean };
    if (!message || !message.trim()) return reply.code(400).send({ error: 'message required' });
    // Metered per user; the route sits behind the global JWT gate (auth/plugin.ts), so an
    // authenticated id is always present — the null branch is only there to keep an anonymous
    // caller from being counted as "user NULL" and sharing one bucket with everyone.
    const uid = req.user?.id ?? null;
    if (uid != null) {
      const [{ n }] = await sql`
        SELECT count(*)::int AS n FROM bug_report
        WHERE user_id = ${uid} AND created_at > NOW() - INTERVAL '1 hour'`;
      if ((n as number) >= MAX_REPORTS_PER_HOUR) {
        return reply.code(429).send({ error: reportLimitMessage(MAX_REPORTS_PER_HOUR) });
      }
    }
    const text = message.trim().slice(0, MAX_MESSAGE_CHARS);
    // Screenshot the user drew on: a data-URL. Turned into a mail attachment, not stored in the row.
    const shot = typeof screenshot_base64 === 'string' && screenshot_base64.startsWith('data:image/') ? screenshot_base64 : null;
    // Off-demo the forward below is gated on an explicit tick in the dialog, so the tick has to
    // travel WITH the report — a consent that exists only in the browser is no consent at all
    // once a stale tab (or a script holding a token) posts the pre-tick body. On the demo the
    // operator is already the controller of that data and no tick is shown.
    const consented = consent === true;
    const ctx = {
      page: (page ?? '').slice(0, 300),
      household_id: req.user?.household_id ?? null,
      has_screenshot: !!shot,
      ua: String(req.headers['user-agent'] ?? '').slice(0, 300),
      // Recorded so a stored row can afterwards be told apart from one that was allowed to leave
      // the box. Demo rows carry no such field rather than a meaningless `false`.
      ...(DEMO_MODE ? {} : { consent: consented }),
    };
    // bug_report is global (no RLS) → the ambient connection inserts fine regardless of scope.
    // The row stays the record and the fallback for when mail cannot go out, but it is no longer
    // the only channel: a failed insert must not swallow the report, so it is logged and
    // answered as stored:false instead of thrown — the forward below still runs.
    let stored = false;
    try {
      await sql`INSERT INTO bug_report (user_id, message, context) VALUES (${uid}, ${text}, ${sql.json(ctx)})`;
      stored = true;
    } catch (err) {
      req.log.error(`bug report insert failed: ${(err as Error).message}`);
    }
    // On the demo, resolve the household NAME so the developer knows who reported it.
    let householdName: string | null = null;
    if (DEMO_MODE && req.user?.household_id != null) {
      try {
        const [h] = await adminSql`SELECT name FROM household WHERE id = ${req.user.household_id}`;
        householdName = (h?.name as string | undefined) ?? null;
      } catch { /* household table only exists on the demo build */ }
    }
    // Forward to the developer in EVERY build. This used to be DEMO_MODE-gated so a self-hoster's
    // report (screenshot of their own data included) never left their box — but silently keeping
    // it was the bug: the reporter believed they had written to someone who can fix it, and
    // nobody had. What replaces the gate is disclosure, in the dialog, before they type — visible
    // and refusable. Awaited rather than fire-and-forget: the answer below states mailed
    // true/false, so it has to be the truth by the time we reply.
    let mailed = false;
    let reason: ReportFailReason | null = null;
    if (!DEMO_MODE && !consented) {
      // No tick on the wire → nothing leaves the box. A client written before the tick existed
      // (a long-lived home-screen PWA tab, a script with a 7-day token) posts exactly the old
      // body, and forwarding that would mail somebody's receipts with zero disclosure — the very
      // thing the disclosure replaced the old gate with. The report is still stored, and the
      // answer says why, so the dialog can ask for a reload instead of failing silently.
      reason = 'consent_missing';
    } else if (!(await smtpConfigured())) {
      reason = 'smtp_unconfigured';
    } else {
      try {
        let attachments: MailAttachment[] | undefined;
        const comma = shot ? shot.indexOf(',') : -1;
        if (shot && comma > -1) {
          const contentType = shot.slice(5, comma).split(';')[0] || 'image/jpeg';
          attachments = [{ filename: 'screenshot.jpg', content: shot.slice(comma + 1), encoding: 'base64', contentType }];
        }
        // The reporter's address rides along twice — in the body (templates.ts renders "Von: …")
        // and as Reply-To, so the developer can ask back. Off-demo that address leaves the
        // self-hoster's box for the first time here, so the consent line in the dialog names it
        // explicitly; keep the two in step if this ever sends more than it says.
        const mail = feedbackEmail({
          message: `${text}\n\n${buildStamp(!!shot)}`,
          page: ctx.page,
          from: req.user?.email ?? req.user?.username ?? 'anonym',
          householdId: req.user?.household_id ?? null,
          householdName,
        });
        await sendMail(DEVELOPER_MAIL, mail.subject, mail.text, mail.html, req.user?.email ?? undefined, attachments);
        mailed = true;
      } catch (err) {
        req.log.error(`feedback mail failed: ${(err as Error).message}`);
        reason = 'smtp_failed';
        // A cached "mail works" verdict has just been proven wrong — drop it so the next dialog
        // stops promising a delivery this box cannot make.
        invalidateSmtpCheck();
      }
    }

    // Thank the sender and tell them VDS is free + self-hostable — someone who just took the time
    // to write in is the best person to hear it. DEMO only: a self-hoster writing to the
    // developer does not need a marketing reply. Sent only once the report itself is out (same
    // relay, proven working seconds ago), and fire-and-forget so a bounce here can neither delay
    // the reporter's answer nor change it.
    const to = req.user?.email;
    if (DEMO_MODE && mailed && to) void (async (dest: string) => {
      try {
        const thanks = feedbackThanksEmail();
        await sendMail(dest, thanks.subject, thanks.text, thanks.html);
      } catch (err) { req.log.error(`feedback thank-you mail failed: ${(err as Error).message}`); }
    })(to);

    // 200 even when nothing could be sent: the report is written (or at least logged), and
    // failing the request would only make the user type it all again. The caller decides what to
    // show from stored/mailed/reason.
    return { ok: true, stored, mailed, reason };
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
