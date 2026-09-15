import sql from './db.js';
import { balanceOf } from './routes/accountBalances.js';
import { sendPush } from './push.js';
import { sendMail } from './mailer.js';

/**
 * Warns when an account drops below the line its household set for it.
 *
 * The case this is for, verbatim: "unser GKK soll nicht unter 2000 euro. weil wir da aber nicht
 * immer drauf gucken kann das schon mal passieren. das darf nicht sein." So the warning fires at
 * SCAN time, against the PROJECTED balance — 2005 € on the account, a 6 € receipt scanned, the
 * projection is 1999 € and the household hears about it now, not when the bank gets round to it.
 *
 * ⚠️ ONCE PER BREACH, not once per receipt. `konto.low_notified_at` holds the state: set when we
 * warn, cleared when the balance climbs back above the line. An account sitting just under its
 * threshold would otherwise warn after every single purchase, and a warning that arrives after
 * every purchase is one nobody reads — which costs exactly the thing it was built to protect.
 */
export async function checkLowBalance(kontoId: number | null | undefined): Promise<void> {
  if (!kontoId) return;
  try {
    const [k] = await sql`
      SELECT id, name, low_threshold::float8 AS threshold, low_notified_at
      FROM konto WHERE id = ${kontoId}`;
    if (!k || k.threshold === null) return;

    const balance = await balanceOf(kontoId);
    // No anchor → no absolute balance → nothing to compare. Silence is right here: a warning
    // derived from an invented zero point would be a false alarm about real money.
    if (balance === null) return;

    const under = balance < (k.threshold as number);
    const alreadyWarned = k.low_notified_at !== null;

    if (!under) {
      if (alreadyWarned) await sql`UPDATE konto SET low_notified_at = NULL WHERE id = ${kontoId}`;
      return;                                   // back above the line: the next dip warns again
    }
    if (alreadyWarned) return;                  // this breach has already been reported

    await sql`UPDATE konto SET low_notified_at = NOW() WHERE id = ${kontoId}`;

    const eur = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
    const title = `${k.name}: unter ${eur(k.threshold as number)}`;
    const body = `Voraussichtlicher Stand: ${eur(balance)}.`;

    const admins = await sql`SELECT id, email FROM users WHERE is_admin = TRUE`;
    for (const a of admins) {
      // Neither channel may break scanning a receipt — the user is standing in a kitchen with a
      // phone, and a mail server having a bad day is not their problem.
      try { await sendPush(a.id as number, { title, body, url: '/finanzen?tab=konten', tag: `low-${kontoId}` }); }
      catch { /* push is best effort */ }
      if (a.email) {
        try {
          await sendMail(a.email as string, title,
            `${body}\n\nDas Konto „${k.name}" liegt unter der vereinbarten Schwelle von `
            + `${eur(k.threshold as number)}.\n\nGerechnet wird aus dem eingetragenen Kontostand, allen `
            + `Bankbuchungen danach und den Belegen, die die Bank noch nicht gemeldet hat — dieser `
            + `Stand kann der Bank also voraus sein.`);
        } catch { /* mail is best effort */ }
      }
    }
  } catch {
    /* A warning that throws would take the receipt down with it. */
  }
}
