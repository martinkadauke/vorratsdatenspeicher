import type { FastifyInstance } from 'fastify';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { requireOperator, signToken } from '../auth/plugin.js';
import sql, { DEMO_MODE } from '../db.js';
import { DESKTOP_DIR, isDesktop, readBridgeFile } from '../desktop.js';

// ── Desktop bridge: "Handy verbinden" ───────────────────────────────────────────────────────
// Only the Electron build sets DESKTOP_DIR; in Docker these endpoints report unavailable and do
// nothing, so ONE frontend serves both channels (a container is already on the network — it has
// no use for a tunnel).
//
// VDS itself has no business starting a Tailscale node, and it deliberately cannot: the Electron
// shell owns that process. This module only WRITES a request marker the shell watches and READS
// the status the shell publishes — the same unprivileged-marker design as /api/self-update. Even
// a fully compromised app can ask for exactly two things here: tunnel on, tunnel off.
const desktopBuild = isDesktop;

/** The shell's view of the tunnel. Missing/garbled file → "off": the shell writes it on every
 *  state change, so its absence means nothing has ever been started. */
function readStatus(): Record<string, unknown> {
  return readBridgeFile('tunnel-status.json') ?? { state: 'off' };
}

// ── locked out of your own computer ─────────────────────────────────────────────────────────
// The mail round-trip is the wrong primitive here: it needs SMTP configured, an inbox, and a link
// that survives — and on a desktop instance the owner is simply SITTING AT THE MACHINE. So we let
// the machine itself vouch for them: the shell shows a one-time code in a native OS dialog, which
// a web page can neither read nor forge, and typing it back sets a new password.
//
// Being at the keyboard is the whole authentication factor, so it is bounded hard: the code is
// short-lived, single-use, dies after a few wrong guesses, and only ever resets an ADMIN account.
const RECOVER_MAX_ATTEMPTS = 5;
let recoverAttempts = 0;

export function desktopRoutes(app: FastifyInstance): void {
  /** Tunnel status for the connect-phone dialog. Operator-only: the public address of the
   *  household's own instance is not something a guest account should be able to read. */
  app.get('/api/desktop/tunnel', { preHandler: requireOperator }, async () => {
    if (!desktopBuild()) return { available: false, state: 'unavailable' };
    return { available: true, ...readStatus() };
  });

  /** Ask the shell to bring the tunnel up or take it down. The action is a closed set and the
   *  shell re-validates it; nothing here reaches the network. */
  app.post<{ Body: { action?: string } }>('/api/desktop/tunnel', { preHandler: requireOperator }, async (req, reply) => {
    if (DEMO_MODE) return reply.code(403).send({ error: 'forbidden' });
    if (!desktopBuild()) return reply.code(409).send({ error: 'not_desktop' });
    const action = req.body?.action === 'stop' ? 'stop' : 'start';
    try {
      await mkdir(DESKTOP_DIR, { recursive: true });
      await writeFile(path.join(DESKTOP_DIR, 'tunnel-request'), `${action}\n`, 'utf8');
    } catch (e) {
      return reply.code(500).send({ error: 'shell_unreachable', detail: String((e as Error)?.message ?? e).slice(0, 200) });
    }
    return { ok: true, action };
  });

  /** Step 1 — ask the shell to show a recovery code. Unauthenticated by necessity (the caller is
   *  locked out) and harmless: it triggers a native yes/no dialog and returns nothing secret, so
   *  the worst a stray local page can do is make a prompt appear that the user dismisses. */
  app.post('/api/desktop/recover', async (_req, reply) => {
    if (DEMO_MODE || !desktopBuild()) return reply.code(409).send({ error: 'not_desktop' });
    recoverAttempts = 0;
    try {
      await mkdir(DESKTOP_DIR, { recursive: true });
      await writeFile(path.join(DESKTOP_DIR, 'recover-request'), `${new Date().toISOString()}\n`, 'utf8');
    } catch (e) {
      return reply.code(500).send({ error: 'shell_unreachable', detail: String((e as Error)?.message ?? e).slice(0, 200) });
    }
    return { ok: true };
  });

  /** Step 2 — the code from the OS dialog buys exactly one password change on one admin account. */
  app.post<{ Body: { code?: string; username?: string; password?: string } }>('/api/desktop/recover/confirm', async (req, reply) => {
    if (DEMO_MODE || !desktopBuild()) return reply.code(409).send({ error: 'not_desktop' });
    // Compare on the bare characters. The code is READ OFF A SCREEN AND TYPED, so the grouping
    // hyphen, stray spaces and lower case are all things a person will legitimately produce — and
    // normalising only one side of the comparison is how "ABCD-EFGH" failed to equal "ABCD-EFGH".
    const bare = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const code = bare(req.body?.code);
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (password.length < 8) return reply.code(400).send({ error: 'password_too_short' });

    const issued = readBridgeFile<{ code?: string; expires?: string }>('recover.json');
    const expired = !issued?.expires || Date.parse(issued.expires) < Date.now();
    if (!issued?.code || expired) return reply.code(410).send({ error: 'code_expired' });

    if (++recoverAttempts > RECOVER_MAX_ATTEMPTS || !code || code !== bare(issued.code)) {
      // Out of guesses → burn the code rather than let anyone keep trying against a fresh request.
      if (recoverAttempts > RECOVER_MAX_ATTEMPTS) await rm(path.join(DESKTOP_DIR, 'recover.json'), { force: true }).catch(() => {});
      return reply.code(403).send({ error: 'code_invalid', attempts_left: Math.max(0, RECOVER_MAX_ATTEMPTS - recoverAttempts) });
    }

    // Admins only. A recovery code must never be a way to take over a household member's account.
    const rows = await sql`SELECT id FROM users WHERE username = ${username} AND is_admin = TRUE`;
    if (!rows.length) return reply.code(404).send({ error: 'no_such_admin' });

    const hash = await bcrypt.hash(password, 12);
    await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${rows[0].id}`;
    await rm(path.join(DESKTOP_DIR, 'recover.json'), { force: true }).catch(() => {});
    recoverAttempts = 0;
    req.log.info(`desktop recovery: password reset for admin "${username}"`);
    return { token: signToken(rows[0].id as number) };
  });

  /** Which admin accounts exist — so the locked-out owner picks a name instead of guessing it.
   *  Desktop-only and usernames only: on a single-household machine this is not a secret, and
   *  "I don't even know what my account is called" is exactly the state we are rescuing. */
  app.get('/api/desktop/admins', async (_req, reply) => {
    if (DEMO_MODE || !desktopBuild()) return reply.code(409).send({ error: 'not_desktop' });
    const rows = await sql`SELECT username FROM users WHERE is_admin = TRUE ORDER BY id`;
    return { admins: rows.map(r => r.username as string) };
  });
}
