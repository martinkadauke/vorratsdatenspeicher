import fs from 'node:fs/promises';
import path from 'node:path';
import sql from './db.js';
import { sendMail } from './mailer.js';
import { DESKTOP_DIR, isDesktop } from './desktop.js';

/** "Your phone can connect now" — the mail half of the shell's announcement.
 *
 *  Tailscale publishes a funnel address on its own schedule, and it can take hours. The shell keeps
 *  checking and drops a marker here the moment the address answers; this turns that into a mail, so
 *  someone who set the app up in the morning and walked away learns about it without going back to
 *  look. The shell handles the case where they ARE at the machine, with an OS notification.
 *
 *  Own module rather than a helper in desktop.ts: that file is imported by config.ts, and reaching
 *  for the mailer from there would close an import cycle. */
export function watchTunnelReady(log: (m: string) => void): void {
  if (!isDesktop()) return;
  const marker = path.join(DESKTOP_DIR, 'tunnel-ready.json');

  setInterval(() => {
    void (async () => {
      let payload: { url?: string } | null = null;
      try {
        payload = JSON.parse(await fs.readFile(marker, 'utf8')) as { url?: string };
      } catch { return; }                      // no marker, or half-written — try again next minute
      // ⚠️ Consume BEFORE sending. A permanently misconfigured relay would otherwise turn one piece
      // of good news into a mail attempt every sixty seconds, forever.
      await fs.rm(marker, { force: true }).catch(() => {});
      if (!payload?.url) return;

      const rows = await sql`
        SELECT email FROM users WHERE is_admin = TRUE AND email IS NOT NULL AND email <> ''`;
      if (!rows.length) { log('tunnel ready, but no admin has an e-mail address — nothing to send'); return; }

      const url = String(payload.url);
      for (const r of rows) {
        try {
          await sendMail(
            String(r.email),
            'Dein Handy kann jetzt auf den Vorratsdatenspeicher zugreifen',
            `Die Verbindung steht.\n\nÖffne am Handy: ${url}\n\n`
            + 'Das hat etwas gedauert, weil deine Adresse erst im Internet bekannt gemacht werden musste — '
            + 'das passiert bei Tailscale und kann bei neuen Konten Stunden dauern. Du musstest nichts tun, '
            + 'und musst jetzt auch nichts einstellen.\n\n'
            + 'Am Rechner findest du unter „Handy verbinden" einen QR-Code, den du mit der Handy-Kamera scannen kannst.',
          );
          log(`tunnel-ready mail sent to ${String(r.email)}`);
        } catch (e) {
          // SMTP is optional on a desktop install; not having it is a normal state, not an error.
          log(`tunnel-ready mail could not be sent: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        }
      }
    })();
  }, 60_000).unref();
}
