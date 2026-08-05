// Monthly to-do push reminders.
//
//   1st  → adjust this month's budgets (nudge toward spending goals)
//   7th  → upload payslips / e-mail invoices / bank statements  (+ a SECOND push:
//          "set up e-mail invoices" if none has ever arrived and the tutorial isn't dismissed)
//   15th → finish (green-check) the receipts that are still open
//
// Recipients = every user who OWNS at least one konto (konto.user_id = them), has a push
// subscription, and hasn't opted out of 'reminders'. Household-shared data reaches each such
// user ONCE — there is no per-konto fan-out, so a user with three konten still gets one push.
//
// Push-only (per Martin's spec). DEMO_MODE-skipped at the call site (per-user data has no
// household scope inside a cron callback; the demo is ephemeral anyway).
import cron from 'node-cron';
import sql from '../db.js';
import { getConfig } from '../config.js';
import { sendPush, type PushPayload } from '../push.js';

const REMINDER_DAYS = [1, 7, 15];

/** Berlin-local calendar day, independent of the DB/session TZ. The container TZ is
 *  Europe/Berlin, but compute it explicitly so a missing TZ env can never shift the day. */
function berlinToday(): { date: string; day: number } {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());               // 'YYYY-MM-DD'
  return { date, day: Number(date.slice(8, 10)) };
}

/** Users eligible for reminders: own >=1 konto, have >=1 push subscription, not opted out. */
async function reminderRecipients(): Promise<number[]> {
  const rows = await sql`
    SELECT u.id
    FROM users u
    WHERE EXISTS (SELECT 1 FROM konto k WHERE k.user_id = u.id)
      AND EXISTS (SELECT 1 FROM push_subscription ps WHERE ps.user_id = u.id)
      AND NOT EXISTS (
        SELECT 1 FROM notification_pref np
        WHERE np.user_id = u.id AND np.kind = 'reminders' AND np.push = FALSE
      )
    ORDER BY u.id`;
  return rows.map(r => r.id as number);
}

// ── per-user payload builders ─────────────────────────────────────────────────

/** 1st: adjust this month's budgets. Wording depends on whether any budget exists yet. */
async function budgetReminder(uid: number): Promise<PushPayload> {
  const [{ has }] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM budget b
      WHERE b.active AND b.kind = 'category' AND b.monthly_target IS NOT NULL
        AND (b.konto_id IS NULL OR b.konto_id IN (SELECT id FROM konto WHERE user_id = ${uid} OR is_shared))
    ) AS has`;
  return has
    ? { title: 'Neuer Monat – Budgets prüfen 🎯',
        body: 'Passe deine Budgetziele für den Monat an und drück deine Kosten weiter.',
        url: '/finanzen?tab=monat', tag: 'reminder-budget' }
    : { title: 'Budgets setzen 🎯',
        body: 'Setz dir Budgetziele und behalte deine Ausgaben im Griff – der erste Schritt zum Sparen.',
        url: '/finanzen?tab=monat', tag: 'reminder-budget' };
}

/** 7th (primary): upload payslips / invoices / bank statements. First-time wording when the
 *  user has neither a payslip nor any bank transactions yet. */
async function uploadReminder(uid: number): Promise<PushPayload> {
  const [{ has_payslip, has_bank }] = await sql`
    SELECT
      EXISTS (SELECT 1 FROM income WHERE source = 'salary' AND created_by = ${uid})               AS has_payslip,
      EXISTS (SELECT 1 FROM bank_tx bt JOIN konto k ON k.id = bt.konto_id
              WHERE k.user_id = ${uid} OR k.is_shared)                                             AS has_bank`;
  return (!has_payslip && !has_bank)
    ? { title: 'Unterlagen anlegen 📤',
        body: 'Leg zum ersten Mal deine Gehaltszettel und Bankauszüge an, damit VDS Einnahmen und Konten kennt.',
        url: '/finanzen?tab=verwaltung', tag: 'reminder-upload' }
    : { title: 'Unterlagen hochladen 📤',
        body: 'Zeit für deine aktuellen Gehaltszettel, E-Mail-Rechnungen und Bankauszüge – so bleiben deine Auswertungen vollständig.',
        url: '/finanzen?tab=verwaltung', tag: 'reminder-upload' };
}

/** 7th (SECOND push): only when NO e-mail invoice has EVER arrived for this user, their konto,
 *  or the shared household konto — and the user hasn't dismissed the tutorial. null → skip. */
async function emailSetupReminder(uid: number): Promise<PushPayload | null> {
  const [{ dismissed }] = await sql`SELECT COALESCE(has_seen_email_tutorial, FALSE) AS dismissed FROM users WHERE id = ${uid}`;
  if (dismissed) return null;
  const [{ has_email }] = await sql`
    SELECT (
      EXISTS (SELECT 1 FROM imported_email WHERE user_id = ${uid})
      OR EXISTS (SELECT 1 FROM einkauf e JOIN konto k ON k.id = e.konto_id
                 WHERE e.quelle = 'email' AND (k.user_id = ${uid} OR k.is_shared))
    ) AS has_email`;
  if (has_email) return null;
  return { title: 'E-Mail-Rechnungen einrichten 📧',
           body: 'Lass Rechnungen automatisch in VDS landen. So richtest du die Weiterleitung bei deinem Mail-Anbieter ein.',
           url: '/profile?help=mailforward', tag: 'reminder-mailsetup' };
}

/** 15th: finish the receipts still open. null when nothing is open (don't nag). */
async function receiptsReminder(uid: number): Promise<PushPayload | null> {
  const [{ open }] = await sql`
    SELECT COUNT(*)::int AS open FROM einkauf e
    WHERE NOT e.geprueft AND NOT COALESCE(e.ocr_pending, FALSE)
      AND (e.private_for_user_id IS NULL OR e.private_for_user_id = ${uid})`;
  const n = open as number;
  if (!n) return null;
  return { title: 'Belege abschließen ✓',
           body: `${n} ${n === 1 ? 'Beleg ist' : 'Belege sind'} noch nicht abgeschlossen. Prüf ${n === 1 ? 'ihn' : 'sie'} kurz und setz den grünen Haken.`,
           url: '/receipts?status=open', tag: 'reminder-receipts' };
}

// ── the run ────────────────────────────────────────────────────────────────────

/** Claim today's batch exactly once across replicas. Returns true if THIS process won it. */
async function claimRun(kind: string, date: string): Promise<boolean> {
  const rows = await sql`
    INSERT INTO reminder_run (kind, run_date) VALUES (${kind}, ${date})
    ON CONFLICT DO NOTHING RETURNING kind`;
  return rows.length > 0;
}

/**
 * Run the reminder batch for a given day-of-month. Normally called by the cron for the
 * current Berlin day; pass `forceDay` (1|7|15) to trigger a specific one manually (bypasses
 * the once-per-day claim — for the admin "send test now" path).
 */
export async function runReminders(forceDay?: number): Promise<{ day: number; users: number; pushes: number }> {
  const { date, day } = berlinToday();
  const which = forceDay ?? day;
  if (!REMINDER_DAYS.includes(which)) return { day: which, users: 0, pushes: 0 };
  if (forceDay === undefined && !(await claimRun(`reminder.day${which}`, date))) {
    console.log(`[reminders] day ${which} already ran on ${date} (other replica) — skipping`);
    return { day: which, users: 0, pushes: 0 };
  }
  const uids = await reminderRecipients();
  let pushes = 0;
  for (const uid of uids) {
    try {
      if (which === 1) {
        pushes += await sendPush(uid, await budgetReminder(uid));
      } else if (which === 7) {
        pushes += await sendPush(uid, await uploadReminder(uid));
        const setup = await emailSetupReminder(uid);
        if (setup) pushes += await sendPush(uid, setup);
      } else if (which === 15) {
        const r = await receiptsReminder(uid);
        if (r) pushes += await sendPush(uid, r);
      }
    } catch (e) {
      console.error(`[reminders] user ${uid} day ${which} failed:`, (e as Error).message);
    }
  }
  console.log(`[reminders] day ${which} → ${pushes} push(es) to ${uids.length} user(s)`);
  return { day: which, users: uids.length, pushes };
}

// ── scheduler ──────────────────────────────────────────────────────────────────
let task: cron.ScheduledTask | null = null;

export async function rescheduleReminders(): Promise<void> {
  if (task) { task.stop(); task = null; }
  const enabled = await getConfig('reminders.enabled');
  const schedule = await getConfig('reminders.cron');
  if (!enabled) { console.log('[reminders] disabled'); return; }
  if (!cron.validate(schedule)) { console.error(`[reminders] invalid cron "${schedule}"`); return; }
  task = cron.schedule(schedule, () => {
    runReminders().catch(err => console.error('[reminders] cron run failed:', err));
  }, { timezone: 'Europe/Berlin' });
  console.log(`[reminders] scheduled: ${schedule} (Europe/Berlin)`);
}
