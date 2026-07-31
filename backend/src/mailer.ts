import nodemailer from 'nodemailer';
import { getConfig } from './config.js';

export async function smtpConfigured(): Promise<boolean> {
  const host = await getConfig('smtp.host');
  return !!host;
}

export interface MailAttachment { filename: string; content: string; encoding?: 'base64'; contentType?: string; }

/** Why mail could not go out, coarse enough to hand to ANY logged-in user: "nobody set it up"
 *  vs "it is set up and the relay said no". Never the host, the account or the transport error —
 *  those name the operator's infrastructure and stay with the operator (/api/smtp/test). */
export type MailFailReason = 'smtp_unconfigured' | 'smtp_failed';
export type SmtpCheck = { ok: true } | { ok: false; reason: MailFailReason };

/** Nodemailer's own defaults are minutes long. POST /api/bug-reports now AWAITS its send so it
 *  can tell the reporter whether the mail really left, and a black-holed relay would otherwise
 *  park that request — and the user's dialog — for two minutes. socketTimeout is an INACTIVITY
 *  timeout, so a slow but progressing 12 MB screenshot upload still completes. */
const TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 60_000 };

/** A set of SMTP settings that is NOT (yet) the instance's own — the unsaved fields an operator
 *  is trying out in the setup dialog. */
export interface SmtpSettings { host: string; port?: number; secure?: boolean; user?: string; pass?: string; from?: string; }

/** The single place the operator's stored config becomes a transport, so verifySmtp() below
 *  handshakes with EXACTLY the settings a real send uses — a check against a separately built
 *  transport would be a check of nothing. null = no host configured.
 *  `settings` overrides the stored config wholesale (never field by field): a half-merged
 *  transport is exactly the "tested something that isn't what you typed" trap this exists to
 *  avoid. Defaults mirror config.ts's DEFAULTS so an omitted port behaves like a fresh install. */
async function smtpTransport(settings?: SmtpSettings) {
  const host = settings ? settings.host : await getConfig('smtp.host');
  if (!host) return null;
  const port = settings ? (settings.port ?? 587) : await getConfig('smtp.port');
  const secure = settings ? !!settings.secure : await getConfig('smtp.secure');
  const user = settings ? (settings.user ?? '') : await getConfig('smtp.user');
  const pass = settings ? (settings.pass ?? '') : await getConfig('smtp.pass');
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
    ...TIMEOUTS,
  });
}

export async function sendMail(to: string, subject: string, text: string, html?: string, replyTo?: string, attachments?: MailAttachment[]): Promise<void> {
  const transporter = await smtpTransport();
  if (!transporter) throw new Error('SMTP ist nicht konfiguriert (Admin → SMTP)');
  const from = await getConfig('smtp.from');

  await transporter.sendMail({ from, to, subject, text, ...(html ? { html } : {}), ...(replyTo ? { replyTo } : {}), ...(attachments?.length ? { attachments } : {}) });
}

/** Send through settings the operator has typed but NOT saved — the SMTP dialog's "Test senden".
 *  Its own function rather than a flag on sendMail(): only the test may ever bypass the stored
 *  config, and the dialog promises that "Abbrechen" leaves the instance's mail server untouched.
 *  Saving first to make the test meaningful broke that promise — a typo'd host replaced a working
 *  relay for the whole instance (invites, resets, the offer digest) before the test even ran.
 *  An empty `from` falls back to the stored sender, which is what an untouched field means. */
export async function sendMailWith(settings: SmtpSettings, to: string, subject: string, text: string, html?: string): Promise<void> {
  const transporter = await smtpTransport(settings);
  if (!transporter) throw new Error('SMTP ist nicht konfiguriert (Admin → SMTP)');
  const from = settings.from || await getConfig('smtp.from');
  await transporter.sendMail({ from, to, subject, text, ...(html ? { html } : {}) });
}

// ── live SMTP check ─────────────────────────────────────────────────────────
const CHECK_TTL_MS = 60_000;
let checkCache: { at: number; result: SmtpCheck } | null = null;
let checkInFlight: Promise<SmtpCheck> | null = null;

/** Drop the cached verdict after anything that CHANGES the answer — an smtp.* config write, the
 *  operator's SMTP test, a send that failed against an "ok" cache — so the UI never keeps
 *  promising a delivery this box can no longer make (or denying one it can). */
export function invalidateSmtpCheck(): void {
  checkCache = null;
}

/** Can mail actually leave this box right now? Connect, greet and AUTH against the operator's
 *  relay — NOT "are the config fields filled in", which a half-configured or since-revoked
 *  account passes while every send bounces.
 *
 *  Cached for a minute and single-flighted because the caller is the bug-report dialog, open to
 *  every logged-in user: without that, one outbound connection per page view would turn the
 *  operator's relay into the target of our own UI. Callers get a boolean plus a coarse reason;
 *  the transport error (which names host and credentials) only ever reaches the server log. */
export async function verifySmtp(logWarn?: (msg: string) => void): Promise<SmtpCheck> {
  if (checkCache && Date.now() - checkCache.at < CHECK_TTL_MS) return checkCache.result;
  if (checkInFlight) return checkInFlight;
  const run = (async (): Promise<SmtpCheck> => {
    let result: SmtpCheck;
    try {
      const transporter = await smtpTransport();
      if (!transporter) {
        result = { ok: false, reason: 'smtp_unconfigured' };
      } else {
        await transporter.verify();
        result = { ok: true };
      }
    } catch (e) {
      logWarn?.(`smtp verify failed: ${(e as Error).message}`);
      result = { ok: false, reason: 'smtp_failed' };
    }
    checkCache = { at: Date.now(), result };
    return result;
  })();
  checkInFlight = run;
  try {
    return await run;
  } finally {
    checkInFlight = null;
  }
}
