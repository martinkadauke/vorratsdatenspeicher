import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sql from '../db.js';
import { decryptSecret } from '../lib/crypto.js';
import { ocrFromText, reinterpretMail, INCOME_CATEGORIES, type OcrResult, type IncomeCategory } from '../llm/ocr.js';
import { ocrAndStore, storeOcrResult } from '../routes/receipts.js';
import { applyLearnedKonto } from '../lib/merchant.js';
import { todayLocal, localDay } from '../lib/localDate.js';
import { getConfig } from '../config.js';

/** Local mount where receipt photos/PDFs are persisted (shared with receipts.ts;
 *  the host path is mapped here via the docker volume in deploy/stack.yml). */
const RECEIPTS_LOCAL_PATH = process.env.RECEIPTS_LOCAL_PATH ?? '/receipts';

/** Unique application-wide id for the pg advisory lock that serialises the global
 *  poll across Swarm replicas (the in-app `running` flag is per-process only). */
const LOCK_KEY = 825041;

export interface MailboxRow {
  user_id: number;
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  imap_user: string;
  imap_pass_enc: string;
  folder: string;
  enabled: boolean;
  make_private: boolean;
  last_uid: number | string;
  uid_validity: number | string | null;
}

interface ConnectCfg {
  imap_host: string; imap_port: number; imap_secure: boolean; imap_user: string; pass: string;
}

function todayISO(): string { return todayLocal(); }

/** Cheap HTML→text for invoices delivered as an HTML body with no plain-text part. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(td|th)>/gi, '\t')                    // keep table columns (name … price) apart
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&euro;/gi, '€')
    .replace(/&#0*39;|&#x0*27;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Count NON-ZERO money tokens ("99,95", "1.234,50") — a cheap proxy for "does
 *  this text actually carry the invoice's line items and total?". Zeros ("0,00")
 *  are ignored on purpose: some shops (OBI via Emarsys) send a text/plain part
 *  whose amounts are all placeholders (0,00 €) while the real prices live only in
 *  the HTML part — counting zeros would make the two parts look equal. */
function priceSignal(s: string): number {
  return (s.match(/\d{1,3}(?:[.\s]\d{3})*[.,]\d{2}(?!\d)/g) ?? [])
    .filter(t => !/^0+[.,]00$/.test(t)).length;
}

/** The two candidate bodies (plain text, stripped HTML) ordered best-first: the
 *  one that actually carries the prices comes first; on a tie the structured HTML
 *  wins (a text/plain part is often marketing clutter / tracking URLs). Returns
 *  only non-empty, distinct candidates. */
function bodyCandidates(parsed: ParsedMail): string[] {
  const plain = (parsed.text ?? '').trim();
  const html = parsed.html ? stripHtml(parsed.html) : '';
  if (!html) return plain ? [plain] : [];
  if (!plain) return [html];
  const ph = priceSignal(html), pp = priceSignal(plain);
  const htmlFirst = ph !== pp ? ph > pp : true;   // tie → prefer HTML
  return htmlFirst ? [html, plain] : [plain, html];
}

/** Primary body to extract from (best candidate). */
function pickBody(parsed: ParsedMail): string {
  return bodyCandidates(parsed)[0] ?? '';
}

/** Extract receipt data from the e-mail body, trying each candidate body in
 *  best-first order and returning the FIRST that yields data. This is the safety
 *  net for the OBI/Emarsys case: if the primary body (say the text/plain part) is
 *  a broken/zeroed placeholder, the HTML part still gets a shot before we skip.
 *  Returns the last (empty) attempt if nothing yields, so callers' existing
 *  "no ladenkette && no artikel ⇒ skip" check is unchanged. */
async function extractBody(parsed: ParsedMail): Promise<OcrResult> {
  const header = `Betreff: ${parsed.subject ?? ''}\nVon: ${parsed.from?.text ?? ''}\n\n`;
  let last: OcrResult | null = null;
  for (const body of bodyCandidates(parsed)) {
    last = await ocrFromText(header + body);
    if (last.ladenkette || last.artikel?.length) return last; // first usable wins
  }
  return last ?? { confidence: 0, ladenkette: '', filiale: null, datum: '', uhrzeit: null, gesamt_betrag: 0, artikel: [] };
}

/** The (non-cash) account to attribute this user's imported receipts to: their own
 *  personal account first, otherwise a shared household account (GKK) so a receipt is
 *  never left "floating" with no home. Privacy is independent (private_for_user_id).
 *  NULL only if the household has no non-cash account at all. */
async function defaultKontoFor(userId: number): Promise<number | null> {
  const [k] = await sql`
    SELECT id FROM konto
    WHERE (user_id = ${userId} OR is_shared = TRUE) AND is_cash = FALSE
    ORDER BY CASE WHEN user_id = ${userId} THEN 0 ELSE 1 END, is_shared ASC, sort_order ASC, id ASC
    LIMIT 1`;
  return (k?.id as number | undefined) ?? null;
}

/** Persist the source e-mail (from/subject/date + html/text body) so the receipt
 *  detail page can show the original mail instead of a photo. Idempotent. */
async function storeEmail(einkaufId: number, parsed: ParsedMail): Promise<void> {
  const html = parsed.html || null; // mailparser yields `false` when there's no HTML part
  const text = parsed.text ?? null;
  if (!html && !text) return;
  // Guard against an Invalid Date from a malformed header (→ NULL sent_at).
  const sentAt = parsed.date instanceof Date && !isNaN(parsed.date.getTime()) ? parsed.date : null;
  await sql`
    INSERT INTO email_message (einkauf_id, from_addr, subject, sent_at, html, body_text)
    VALUES (${einkaufId}, ${parsed.from?.text ?? null}, ${parsed.subject ?? null}, ${sentAt}, ${html}, ${text})
    ON CONFLICT (einkauf_id) DO UPDATE SET
      from_addr = EXCLUDED.from_addr, subject = EXCLUDED.subject, sent_at = EXCLUDED.sent_at,
      html = EXCLUDED.html, body_text = EXCLUDED.body_text`;
}

/** Open & authenticate an IMAP connection. Caller must logout(). */
async function openMailbox(cfg: ConnectCfg): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: cfg.imap_host,
    port: cfg.imap_port,
    secure: cfg.imap_secure,
    auth: { user: cfg.imap_user, pass: cfg.pass },
    logger: false,
    socketTimeout: 60_000, // a hung server shouldn't wedge the whole poll
  });
  await client.connect();
  return client;
}

/** Live connection check for the Profile "Test" button. Never throws. */
export async function testMailbox(cfg: ConnectCfg & { folder: string }): Promise<{ ok: true; messages: number } | { ok: false; error: string }> {
  let client: ImapFlow | null = null;
  try {
    client = await openMailbox(cfg);
    const lock = await client.getMailboxLock(cfg.folder || 'INBOX');
    try {
      return { ok: true, messages: client.mailbox ? client.mailbox.exists : 0 };
    } finally {
      lock.release();
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 300) };
  } finally {
    if (client) { try { await client.logout(); } catch { /* ignore */ } }
  }
}

/** Parse one raw message and, if new, file it as a receipt for this user.
 *  Dedup is an ATOMIC claim on (user_id, message_id): the ledger INSERT wins or
 *  loses the race outright, so a cron run and a manual run can never double-import
 *  the same mail. Returns true only when a receipt with line items was created. */
async function processMessage(mb: MailboxRow, kontoId: number | null, raw: Buffer): Promise<boolean> {
  const parsed = await simpleParser(raw);
  const messageId = (parsed.messageId ?? '').trim()
    || `nomsgid-${mb.user_id}-${crypto.createHash('sha1').update(raw).digest('hex')}`;
  const subject = (parsed.subject ?? '').slice(0, 500) || null;

  // Claim the message atomically. A new message inserts; a previously FAILED or
  // SKIPPED one is re-claimed (so re-labelling/forwarding retries it after a fix) —
  // but a SUCCESSFUL import stays blocked, so re-fetching can never duplicate it.
  // Both the INSERT (new) and the UPDATE (retry, single-winner via the row lock +
  // status guard) are race-safe vs. a concurrent manual run.
  const claim = await sql`
    WITH ins AS (
      INSERT INTO imported_email (user_id, message_id, subject, status)
      VALUES (${mb.user_id}, ${messageId}, ${subject}, 'processing')
      ON CONFLICT (user_id, message_id) DO NOTHING
      RETURNING id
    ), upd AS (
      UPDATE imported_email SET status = 'processing', reason = NULL, subject = ${subject}
      WHERE user_id = ${mb.user_id} AND message_id = ${messageId}
        AND status IN ('failed', 'skipped')
      RETURNING id
    )
    SELECT id FROM ins UNION ALL SELECT id FROM upd`;
  if (!claim.length) return false;
  const ledgerId = claim[0].id as number;

  const datum = parsed.date ? localDay(parsed.date) : null;
  const privateFor = mb.make_private ? mb.user_id : null;
  // Attribute the receipt to the mailbox owner's household member — the inbox belongs to
  // exactly one member, so e-mail invoices are member-scoped WITHOUT any manual picking
  // (the manual "Aufgenommen von" picker is only for ambiguous till/cash scans).
  const [snapMember] = await sql`SELECT id FROM family_member WHERE user_id = ${mb.user_id} ORDER BY sort_order, id LIMIT 1`;
  const snappedBy = (snapMember?.id as number | undefined) ?? null;
  const atts = (parsed.attachments ?? []).filter(a => a.content && ((a.size ?? a.content.length) > 0));
  // Pick the attachment most likely to BE the invoice. The actual invoice is often
  // in the e-mail body while the only PDF attached is legal boilerplate (AGB / terms
  // / cancellation / privacy) or an inline HTML logo — those must not be OCR'd in
  // place of the real invoice. Drop inline (cid-referenced) parts + boilerplate by
  // filename (unless the name also says "Rechnung"), and prefer an invoice-named PDF.
  const NONINVOICE = /(agb|gtc|terms|conditions|widerruf|datenschutz|privacy|policy|sepa[-_ ]?mandat|impressum)/i;
  const INVOICE = /(rechnung|invoice|beleg|quittung|receipt|bestell|order|lieferschein)/i;
  const isPdf = (a: { contentType?: string; filename?: string }) =>
    (a.contentType ?? '').toLowerCase().includes('pdf') || /\.pdf$/i.test(a.filename ?? '');
  const isImg = (a: { contentType?: string }) => (a.contentType ?? '').toLowerCase().startsWith('image/');
  const usable = atts.filter(a => {
    const fn = a.filename ?? '';
    if ((a as { related?: boolean }).related) return false;       // inline logo/signature
    if (NONINVOICE.test(fn) && !INVOICE.test(fn)) return false;    // legal boilerplate
    return true;
  });
  const pdf = usable.find(a => isPdf(a) && INVOICE.test(a.filename ?? '')) ?? usable.find(a => isPdf(a));
  const img = usable.find(a => isImg(a));
  const bodyText = pickBody(parsed);

  let einkaufId: number | null = null;
  let status = 'imported';
  let reason: string | null = null;
  let madeItems = false;

  try {
    if (pdf || img) {
      const att = (pdf ?? img)!;
      const ext = pdf ? 'pdf' : ((att.contentType ?? '').toLowerCase().includes('png') ? 'png' : 'jpg');
      const filename = `vds-${crypto.randomUUID()}.${ext}`;
      await writeFile(path.join(RECEIPTS_LOCAL_PATH, filename), att.content as Buffer);
      const bildPfad = `/receipts/${filename}`;
      const [row] = await sql`
        INSERT INTO einkauf (datum, roh_ladenname, quelle, konto_id, bild_pfad, private_for_user_id, snapped_by_member_id, ocr_pending)
        VALUES (${datum ?? todayISO()}, ${subject}, 'email', ${kontoId}, ${bildPfad}, ${privateFor}, ${snappedBy}, TRUE)
        RETURNING id`;
      einkaufId = row.id as number;
      let attItems = 0;
      try {
        attItems = (await ocrAndStore(einkaufId, bildPfad)).items;
      } catch { attItems = 0; } // attachment unreadable or not a receipt (e.g. AGB) → try body
      finally {
        await sql`UPDATE einkauf SET ocr_pending = FALSE WHERE id = ${einkaufId}`.catch(() => {});
      }
      if (attItems > 0) {
        madeItems = true;
      } else if (bodyText) {
        // The attachment wasn't the invoice — the real one is in the body. Fill the
        // same receipt from it (correct items + date) and drop the misleading image.
        const extracted = await extractBody(parsed);
        if (extracted.ladenkette || extracted.artikel?.length) {
          madeItems = (await storeOcrResult(einkaufId, extracted)).items > 0;
          if (madeItems) await sql`UPDATE einkauf SET bild_pfad = NULL WHERE id = ${einkaufId}`.catch(() => {});
        }
        if (!madeItems) reason = 'attachment + e-mail body had no usable line items';
      } else {
        reason = 'attachment OCR returned no line items';
      }
    } else if (bodyText) {
      const extracted = await extractBody(parsed);
      if (!extracted.ladenkette && !(extracted.artikel?.length)) {
        status = 'skipped';
        reason = 'no receipt data found in e-mail body';
      } else {
        const [row] = await sql`
          INSERT INTO einkauf (datum, roh_ladenname, quelle, konto_id, private_for_user_id, snapped_by_member_id)
          VALUES (${datum ?? todayISO()}, ${subject}, 'email', ${kontoId}, ${privateFor}, ${snappedBy})
          RETURNING id`;
        einkaufId = row.id as number;
        madeItems = (await storeOcrResult(einkaufId, extracted)).items > 0;
      }
    } else {
      status = 'skipped';
      reason = 'no attachment and empty body';
    }
  } catch (e) {
    status = 'failed';
    reason = (e as Error).message.slice(0, 300);
  }

  // Email-date anchor: the mail's Date header is a far more reliable "when" than a
  // date the OCR may have lifted from the body (a delivery estimate, a copyright
  // year, a previous order). Fall back to the header when the OCR found NO reliable
  // date (date_uncertain) or landed >21 days off it — so an e-mail invoice is never
  // left flagged "please type the date" when the header date is right there. Skipped
  // for forwards, where the header is the forward time, not the invoice's.
  const isForward = /^\s*(wg|fwd?|fw):/i.test(parsed.subject ?? '');
  if (einkaufId && datum && !isForward) {
    await sql`
      UPDATE einkauf SET datum = ${datum}::date, date_uncertain = FALSE
      WHERE id = ${einkaufId} AND (datum IS NULL OR date_uncertain = TRUE OR ABS(datum - ${datum}::date) > 21)`.catch(() => {});
  }

  // Now the real biller is known (post-OCR): if we've learned which account this biller is
  // paid from, move the invoice there (it inherited the mailbox owner's account on insert).
  if (einkaufId) await applyLearnedKonto(einkaufId).catch(() => {});

  // Keep the source mail so the detail page can show it (best-effort, non-fatal).
  if (einkaufId) {
    try { await storeEmail(einkaufId, parsed); }
    catch (e) { console.error(`[mailimport] storeEmail failed for receipt ${einkaufId}:`, (e as Error).message); }
  }

  await sql`
    UPDATE imported_email
    SET einkauf_id = ${einkaufId}, status = ${status}, reason = ${reason}
    WHERE id = ${ledgerId}`;
  return madeItems;
}

/** Poll one mailbox for messages newer than the last seen UID and import them.
 *  Returns the count of receipts created. Throws on connection/auth failure. */
async function pollUser(mb: MailboxRow): Promise<number> {
  const client = await openMailbox({
    imap_host: mb.imap_host,
    imap_port: mb.imap_port,
    imap_secure: mb.imap_secure,
    imap_user: mb.imap_user,
    pass: decryptSecret(mb.imap_pass_enc),
  });
  let imported = 0;
  try {
    const lock = await client.getMailboxLock(mb.folder || 'INBOX');
    try {
      const box = client.mailbox;
      const uidValidity = box ? Number(box.uidValidity) : null;
      let lastUid = Number(mb.last_uid) || 0;
      // If the server reset UIDVALIDITY, old UIDs are meaningless → start from the
      // top. The message-id dedup ledger still prevents re-importing seen mails.
      if (mb.uid_validity != null && uidValidity != null && Number(mb.uid_validity) !== uidValidity) {
        lastUid = 0;
      }
      const kontoId = await defaultKontoFor(mb.user_id);
      let maxUid = lastUid;
      if (box && box.exists > 0) {
        for await (const msg of client.fetch(`${lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
          const uid = Number(msg.uid);
          // An IMAP `start:*` range always yields the highest-UID message even when
          // nothing is actually newer — skip anything we've already processed.
          if (uid <= lastUid) continue;
          maxUid = Math.max(maxUid, uid);
          if (!msg.source) continue;
          try {
            if (await processMessage(mb, kontoId, msg.source as Buffer)) imported++;
          } catch (e) {
            console.error(`[mailimport] user ${mb.user_id} msg uid ${uid} failed:`, (e as Error).message);
          }
        }
      }
      await sql`
        UPDATE user_mailbox
        SET last_uid = ${maxUid}, uid_validity = ${uidValidity},
            last_poll_at = NOW(), last_ok_at = NOW(), last_error = NULL, updated_at = NOW()
        WHERE user_id = ${mb.user_id}`;
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
  return imported;
}

let running = false;
export function isMailImportRunning(): boolean { return running; }

/** Global poll over every enabled mailbox. Serialised across replicas by a pg
 *  advisory lock held on a reserved connection for the batch's duration. */
export async function runMailImport(trigger: string): Promise<{ users: number; imported: number }> {
  if (running) return { users: 0, imported: 0 };
  running = true;
  const conn = await sql.reserve();
  try {
    const [{ locked }] = await conn`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`;
    if (!locked) return { users: 0, imported: 0 }; // another replica is mid-run
    try {
      // Re-open any ledger row wedged in 'processing' — a container that died between the
      // reinterpret claim and its completion would otherwise block that mail's retry forever.
      await sql`
        UPDATE imported_email SET status = 'failed', reason = 'timeout — bitte erneut versuchen'
        WHERE status = 'processing' AND claimed_at IS NOT NULL AND claimed_at < NOW() - INTERVAL '15 minutes'`
        .catch(() => {});
      const mbs = await sql<MailboxRow[]>`SELECT * FROM user_mailbox WHERE enabled = TRUE ORDER BY user_id`;
      let imported = 0;
      for (const mb of mbs) {
        try {
          imported += await pollUser(mb);
        } catch (e) {
          const msg = (e as Error).message.slice(0, 300);
          console.error(`[mailimport] user ${mb.user_id} poll failed:`, msg);
          await sql`UPDATE user_mailbox SET last_poll_at = NOW(), last_error = ${msg}, updated_at = NOW() WHERE user_id = ${mb.user_id}`.catch(() => {});
        }
      }
      if (mbs.length) console.log(`[mailimport] ${trigger}: ${mbs.length} mailbox(es), ${imported} new receipt(s)`);
      return { users: mbs.length, imported };
    } finally {
      await conn`SELECT pg_advisory_unlock(${LOCK_KEY})`;
    }
  } finally {
    conn.release();
    running = false;
  }
}

/** Manual single-user poll for the Profile "fetch now" button. Records its own
 *  errors onto the mailbox row. Atomic claim makes it race-safe vs. the cron. */
export async function runMailImportForUser(userId: number): Promise<{ imported: number } | { error: string }> {
  const [mb] = await sql<MailboxRow[]>`SELECT * FROM user_mailbox WHERE user_id = ${userId} AND enabled = TRUE`;
  if (!mb) return { error: 'no enabled mailbox configured' };
  try {
    const imported = await pollUser(mb);
    return { imported };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await sql`UPDATE user_mailbox SET last_poll_at = NOW(), last_error = ${msg}, updated_at = NOW() WHERE user_id = ${userId}`.catch(() => {});
    return { error: msg };
  }
}

/** Refuse to scan absurdly large folders (the point at which an envelope scan
 *  itself gets expensive); the import is meant for a dedicated invoice folder. */
const BACKFILL_MAX_SCAN = 20000;

/** Re-fetch and re-process ONE previously skipped/failed mail (the import-log
 *  "Retry" button) — e.g. after an extractor improvement. Normal incremental
 *  polling won't re-touch it (its UID is already below last_uid), so we find it
 *  by Message-ID via a header scan and run it through processMessage again, which
 *  re-claims a 'skipped'/'failed' ledger row and imports it if it now yields data.
 *  Guarded to rows without a receipt yet, so it can never duplicate an import. */
export async function retryImportedEmail(userId: number, ledgerId: number): Promise<{ status: string; einkauf_id: number | null; reason: string | null } | { error: string }> {
  const [row] = await sql`SELECT message_id, status, einkauf_id, income_id FROM imported_email WHERE id = ${ledgerId} AND user_id = ${userId}`;
  if (!row) return { error: 'not found' };
  if (row.einkauf_id != null) return { error: 'already has a receipt — use "re-scan PDFs" instead' };
  if (row.income_id != null) return { error: 'already recorded as income' };
  const mid = normMid(row.message_id as string);
  if (!mid || mid.startsWith('nomsgid-')) return { error: 'this mail has no Message-ID and cannot be re-fetched' };
  const [mb] = await sql<MailboxRow[]>`SELECT * FROM user_mailbox WHERE user_id = ${userId} AND enabled = TRUE`;
  if (!mb) return { error: 'no enabled mailbox configured' };

  let source: Buffer | null;
  try { source = await fetchRawByMessageId(mb, mid); }
  catch (e) { return { error: (e as Error).message.slice(0, 300) }; }
  if (!source) return { error: 'message no longer found in the mailbox folder' };
  try {
    const kontoId = await defaultKontoFor(userId);
    await processMessage(mb, kontoId, source);
  } catch (e) {
    return { error: (e as Error).message.slice(0, 300) };
  }
  const [after] = await sql`SELECT status, einkauf_id, reason FROM imported_email WHERE id = ${ledgerId}`;
  return { status: after.status as string, einkauf_id: (after.einkauf_id as number | null) ?? null, reason: (after.reason as string | null) ?? null };
}

/** Fetch one raw message from the user's mailbox folder by Message-ID (header scan; last
 *  match wins for a re-labelled copy). Returns null if not present. Throws on connect/auth
 *  failure or a folder too large to scan. Shared by the plain retry and the instructed retry. */
async function fetchRawByMessageId(mb: MailboxRow, mid: string): Promise<Buffer | null> {
  let client: ImapFlow | null = null;
  try {
    client = await openMailbox({
      imap_host: mb.imap_host, imap_port: mb.imap_port, imap_secure: mb.imap_secure,
      imap_user: mb.imap_user, pass: decryptSecret(mb.imap_pass_enc),
    });
    const lock = await client.getMailboxLock(mb.folder || 'INBOX');
    try {
      const box = client.mailbox;
      if (box && box.exists > BACKFILL_MAX_SCAN) throw new Error(`mailbox too large to scan (${box.exists} messages)`);
      if (!box || box.exists === 0) return null;
      let uid = 0;
      for await (const m of client.fetch('1:*', { uid: true, envelope: true }, { uid: true })) {
        if (normMid(m.envelope?.messageId) === mid) uid = Number(m.uid); // last match wins (newest label copy)
      }
      if (!uid) return null;
      for await (const m of client.fetch(String(uid), { uid: true, source: true }, { uid: true })) {
        if (m.source) return m.source as Buffer;
      }
      return null;
    } finally {
      lock.release();
    }
  } finally {
    if (client) { try { await client.logout(); } catch { /* ignore */ } }
  }
}

export interface RefundCandidate { id: number; datum: string; roh_ladenname: string | null; gesamt_betrag: number | null; konto_name: string | null; positions: { id: number; name: string; preis: number | null }[] }

export type ReinterpretOutcome =
  | { status: 'imported'; einkauf_id: number; reason: null }
  | { status: 'skipped'; reason: string; einkauf_id: null }
  | { status: 'preview'; income: { amount: number; datum: string | null; category_path: IncomeCategory; description: string; confidence: number } }
  | { status: 'refund_preview'; refund: { amount: number; datum: string | null; merchant: string; description: string; confidence: number }; candidates: RefundCandidate[] }
  | { error: string };

/** Retry a skipped/failed import under a free-text USER instruction. The AI reclassifies the
 *  mail into a corrected receipt (created here) or a one-off income (PREVIEW only — the user
 *  confirms the amount via confirmMailIncome before anything is booked) or none. The plain
 *  cron/retry path is untouched; this runs only when an instruction is supplied. */
export async function reinterpretImportedEmail(userId: number, ledgerId: number, instruction: string): Promise<ReinterpretOutcome> {
  const ins = instruction.slice(0, 2000);
  const [row] = await sql`SELECT message_id, einkauf_id, income_id FROM imported_email WHERE id = ${ledgerId} AND user_id = ${userId}`;
  if (!row) return { error: 'not found' };
  if (row.einkauf_id != null || row.income_id != null) return { error: 'already resolved' };
  const mid = normMid(row.message_id as string);
  if (!mid || mid.startsWith('nomsgid-')) return { error: 'this mail has no Message-ID and cannot be re-fetched' };
  const [mb] = await sql<MailboxRow[]>`SELECT * FROM user_mailbox WHERE user_id = ${userId} AND enabled = TRUE`;
  if (!mb) return { error: 'no enabled mailbox configured' };

  let source: Buffer | null;
  try { source = await fetchRawByMessageId(mb, mid); }
  catch (e) { return { error: (e as Error).message.slice(0, 300) }; }
  if (!source) return { error: 'message no longer found in the mailbox folder' };

  const parsed = await simpleParser(source);
  const header = `Betreff: ${parsed.subject ?? ''}\nVon: ${parsed.from?.text ?? ''}\n\n`;
  const subject = (parsed.subject ?? '').slice(0, 500) || null;
  const datum = parsed.date ? localDay(parsed.date) : null;

  let r;
  try { r = await reinterpretMail(header + pickBody(parsed), instruction); }
  catch (e) {
    await sql`UPDATE imported_email SET status = 'failed', reason = ${'KI-Fehler: ' + (e as Error).message.slice(0, 200)}, instruction = ${ins} WHERE id = ${ledgerId}`.catch(() => {});
    return { error: (e as Error).message.slice(0, 300) };
  }

  if (r.kind === 'income') {
    // Preview only — booking money requires the user's explicit confirm (confirmMailIncome).
    await sql`UPDATE imported_email SET instruction = ${ins} WHERE id = ${ledgerId}`.catch(() => {});
    return { status: 'preview', income: { amount: r.amount, datum: r.datum ?? datum, category_path: r.category_path, description: r.description, confidence: r.confidence } };
  }

  if (r.kind === 'refund') {
    // A refund belongs ON an existing receipt as a negative position. Propose the most likely
    // original receipts (user-visible only) + their positions; the user picks + confirms via
    // confirmMailRefund. No write here.
    await sql`UPDATE imported_email SET instruction = ${ins} WHERE id = ${ledgerId}`.catch(() => {});
    const refDate = r.datum ?? datum;
    const merchant = r.merchant.trim();
    // Propose only receipts THIS user may see (super-admins see all; others: shared + own-private).
    const [u] = await sql`SELECT sees_all_konten FROM users WHERE id = ${userId}`;
    const visScope = u?.sees_all_konten ? sql`` : sql`AND (e.private_for_user_id IS NULL OR e.private_for_user_id = ${userId})`;
    // Match a candidate receipt by merchant name and/or a total close to the refund amount.
    // Every ${amount} is cast ::numeric — a bare `$n = 0` (or `numeric - $n`) makes postgres.js
    // infer the param as int4, which then rejects a decimal amount (e.g. 24.99) with a 500.
    const like = merchant ? '%' + merchant + '%' : null;
    const amtPos = r.amount > 0;
    const amtNear = sql`ABS(COALESCE(e.gesamt_betrag,0) - ${r.amount}::numeric) <= GREATEST(1, ${r.amount}::numeric * 0.01)`;
    const matchCond =
      like && amtPos ? sql`AND (e.roh_ladenname ILIKE ${like} OR ${amtNear})`
      : like ? sql`AND e.roh_ladenname ILIKE ${like}`
      : amtPos ? sql`AND ${amtNear}`
      : sql``;   // no merchant + no amount → fall back to the most recent receipts before the mail
    const cands = await sql`
      SELECT e.id, e.datum::text AS datum, e.roh_ladenname, e.gesamt_betrag::float8 AS gesamt_betrag, k.name AS konto_name
      FROM einkauf e
      LEFT JOIN konto k ON k.id = e.konto_id
      WHERE TRUE
        ${matchCond}
        ${refDate ? sql`AND e.datum <= ${refDate}::date` : sql``}
        ${visScope}
      ORDER BY
        ${like ? sql`(CASE WHEN e.roh_ladenname ILIKE ${like} THEN 0 ELSE 1 END),` : sql``}
        ABS(COALESCE(e.gesamt_betrag,0) - ${r.amount}::numeric) ASC,
        e.datum DESC
      LIMIT 8`;
    const candidates: RefundCandidate[] = [];
    for (const c of cands) {
      const pos = await sql`
        SELECT id, COALESCE(NULLIF(canonical_name,''), NULLIF(ai_guess,''), name, '?') AS name, preis::float8 AS preis
        FROM artikel WHERE einkauf_id = ${c.id as number} AND NOT is_refund
        ORDER BY ABS(COALESCE(preis,0) - ${r.amount}::numeric) ASC, id ASC`;
      candidates.push({
        id: c.id as number, datum: c.datum as string, roh_ladenname: c.roh_ladenname as string | null,
        gesamt_betrag: (c.gesamt_betrag as number | null) ?? null, konto_name: c.konto_name as string | null,
        positions: pos.map(p => ({ id: p.id as number, name: p.name as string, preis: (p.preis as number | null) ?? null })),
      });
    }
    return { status: 'refund_preview', refund: { amount: r.amount, datum: refDate, merchant: r.merchant, description: r.description, confidence: r.confidence }, candidates };
  }

  if (r.kind === 'receipt' && (r.receipt.ladenkette || r.receipt.artikel.length)) {
    // Mirror processMessage's body path: create the einkauf, store items best-effort, and ALWAYS
    // link einkauf_id on the ledger — so a storeOcrResult failure leaves a linked (openable)
    // receipt, never an orphan, and a re-click can't create a second one (the guard blocks it).
    const privateFor = mb.make_private ? mb.user_id : null;
    const [snapMember] = await sql`SELECT id FROM family_member WHERE user_id = ${userId} ORDER BY sort_order, id LIMIT 1`;
    const snappedBy = (snapMember?.id as number | undefined) ?? null;
    const kontoId = await defaultKontoFor(userId);
    const [einkauf] = await sql`
      INSERT INTO einkauf (datum, roh_ladenname, quelle, konto_id, private_for_user_id, snapped_by_member_id)
      VALUES (${datum ?? todayISO()}, ${subject}, 'email', ${kontoId}, ${privateFor}, ${snappedBy})
      RETURNING id`;
    const einkaufId = einkauf.id as number;
    let status = 'imported';
    let reason: string | null = null;
    try { await storeOcrResult(einkaufId, r.receipt); }
    catch (e) { status = 'failed'; reason = (e as Error).message.slice(0, 300); }
    if (datum) {
      await sql`UPDATE einkauf SET datum = ${datum}::date, date_uncertain = FALSE
                WHERE id = ${einkaufId} AND (datum IS NULL OR date_uncertain = TRUE OR ABS(datum - ${datum}::date) > 21)`.catch(() => {});
    }
    await applyLearnedKonto(einkaufId).catch(() => {});
    try { await storeEmail(einkaufId, parsed); } catch { /* best-effort */ }
    await sql`UPDATE imported_email SET einkauf_id = ${einkaufId}, status = ${status}, reason = ${reason}, instruction = ${ins} WHERE id = ${ledgerId}`;
    return status === 'imported'
      ? { status: 'imported', einkauf_id: einkaufId, reason: null }
      : { error: reason ?? 'receipt import failed' };
  }

  // kind === 'none', or a receipt the model couldn't fill.
  const note = (r.kind === 'none' ? r.note : null) || 'KI: weder Beleg noch Einnahme erkennbar';
  await sql`UPDATE imported_email SET status = 'skipped', reason = ${note}, instruction = ${ins} WHERE id = ${ledgerId}`;
  return { status: 'skipped', reason: note, einkauf_id: null };
}

function isRealYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Book the previewed income after the user has seen and confirmed the amount. Re-validates
 *  everything server-side (client-echoed values are re-checked; konto/source/created_by are
 *  never client-supplied) and inserts exactly one income row via a single-winner atomic claim,
 *  so a double-click or a race can never create two. */
export async function confirmMailIncome(
  userId: number, ledgerId: number,
  income: { amount: unknown; datum: unknown; category_path: unknown; description: unknown },
): Promise<{ status: 'income'; income_id: number } | { error: string }> {
  const cap = await getConfig('income.max_mail_amount');
  const amount = Number(income.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Betrag muss größer als 0 sein.' };
  if (amount > cap) return { error: `Betrag über dem Limit (max. ${cap} €).` };
  const category_path: IncomeCategory = INCOME_CATEGORIES.includes(income.category_path as IncomeCategory)
    ? (income.category_path as IncomeCategory) : 'Erstattung';
  const rawDatum = String(income.datum ?? '');
  const datum = isRealYmd(rawDatum) ? rawDatum : todayISO();
  const description = (String(income.description ?? '').trim() || 'Einnahme (E-Mail)').slice(0, 300);
  const kontoId = await defaultKontoFor(userId);

  try {
    const incomeId = await sql.begin(async (tx) => {
      // Single-winner claim: only a still-unresolved skipped/failed row can be booked. A concurrent
      // second commit finds status='processing' (or already 'income') → no row → aborts.
      const claim = await tx`
        UPDATE imported_email SET status = 'processing', claimed_at = NOW()
        WHERE id = ${ledgerId} AND user_id = ${userId}
          AND einkauf_id IS NULL AND income_id IS NULL AND status IN ('skipped', 'failed')
        RETURNING id`;
      if (!claim.length) return null;
      const [inc] = await tx`
        INSERT INTO income (datum, amount, category_path, konto_id, source, description, created_by)
        VALUES (${datum}::date, ${amount}, ${category_path}, ${kontoId}, 'email', ${description}, ${userId})
        RETURNING id`;
      const id = inc.id as number;
      await tx`UPDATE imported_email SET income_id = ${id}, status = 'income', reason = ${'Einnahme: ' + amount.toFixed(2) + ' €'} WHERE id = ${ledgerId}`;
      return id;
    });
    if (incomeId == null) return { error: 'bereits verbucht oder in Bearbeitung' };
    return { status: 'income', income_id: incomeId };
  } catch (e) {
    // The tx rolled back → no partial income row; re-open the ledger row for another attempt.
    await sql`UPDATE imported_email SET status = 'failed', reason = ${(e as Error).message.slice(0, 200)} WHERE id = ${ledgerId} AND income_id IS NULL`.catch(() => {});
    return { error: (e as Error).message.slice(0, 300) };
  }
}

/** Book a refund the user confirmed: add ONE negative artikel position to the chosen receipt,
 *  linked to the original position it refunds (refund_for_artikel_id) so both vanish from product
 *  statistics. gesamt_betrag (gross paid) is untouched; the negative position nets category spend
 *  and the receipt's derived net. Re-validates everything server-side (amount cap, receipt + the
 *  refunded position both visible to this user) and is idempotent via a single-winner ledger claim. */
export async function confirmMailRefund(
  userId: number, ledgerId: number,
  refund: { einkauf_id: unknown; refund_for_artikel_id: unknown; amount: unknown; description: unknown },
): Promise<{ status: 'refund'; einkauf_id: number } | { error: string }> {
  const cap = await getConfig('income.max_mail_amount');
  const amount = Number(refund.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Betrag muss größer als 0 sein.' };
  if (amount > cap) return { error: `Betrag über dem Limit (max. ${cap} €).` };
  const einkaufId = Number(refund.einkauf_id);
  if (!Number.isInteger(einkaufId)) return { error: 'Kein Beleg gewählt.' };
  const description = (String(refund.description ?? '').trim() || 'Erstattung (E-Mail)').slice(0, 300);
  const refForRaw = refund.refund_for_artikel_id == null ? null : Number(refund.refund_for_artikel_id);
  const refFor = refForRaw != null && Number.isInteger(refForRaw) ? refForRaw : null;

  // The chosen receipt must be visible to this user (shared, own-private, or super-admin).
  const [u] = await sql`SELECT sees_all_konten FROM users WHERE id = ${userId}`;
  const [tgt] = await sql`
    SELECT e.id FROM einkauf e WHERE e.id = ${einkaufId}
      ${u?.sees_all_konten ? sql`` : sql`AND (e.private_for_user_id IS NULL OR e.private_for_user_id = ${userId})`}`;
  if (!tgt) return { error: 'Beleg nicht gefunden oder nicht sichtbar.' };
  // The referenced original position (if any) must belong to that receipt.
  let refCategory: string | null = null;
  if (refFor != null) {
    const [orig] = await sql`SELECT category_path FROM artikel WHERE id = ${refFor} AND einkauf_id = ${einkaufId} AND NOT is_refund`;
    if (!orig) return { error: 'Original-Position gehört nicht zu diesem Beleg.' };
    refCategory = (orig.category_path as string | null) ?? null;
  }
  // Fall back to the receipt's dominant non-Meta category so the refund nets the right bucket.
  if (!refCategory) {
    const [dom] = await sql`
      SELECT category_path FROM artikel
      WHERE einkauf_id = ${einkaufId} AND category_path IS NOT NULL AND category_path NOT LIKE 'Meta/%' AND NOT is_refund
      GROUP BY category_path ORDER BY SUM(preis) DESC LIMIT 1`;
    refCategory = (dom?.category_path as string | null) ?? null;
  }

  try {
    const ok = await sql.begin(async (tx) => {
      const claim = await tx`
        UPDATE imported_email SET status = 'processing', claimed_at = NOW()
        WHERE id = ${ledgerId} AND user_id = ${userId}
          AND einkauf_id IS NULL AND income_id IS NULL AND status IN ('skipped', 'failed')
        RETURNING id`;
      if (!claim.length) return false;
      await tx`
        INSERT INTO artikel (einkauf_id, name, menge, einheit, preis, category_path, original_text, canonical_name, is_refund, refund_for_artikel_id)
        VALUES (${einkaufId}, ${description}, 1, NULL, ${-amount}, ${refCategory}, ${'Erstattung (E-Mail): ' + description}, NULL, TRUE, ${refFor})`;
      // Link the ledger to the receipt it landed on (einkauf_id has no UNIQUE constraint) and mark resolved.
      await tx`UPDATE imported_email SET einkauf_id = ${einkaufId}, status = 'refund', reason = ${'Erstattung: -' + amount.toFixed(2) + ' € auf Beleg #' + einkaufId} WHERE id = ${ledgerId}`;
      return true;
    });
    if (!ok) return { error: 'bereits verbucht oder in Bearbeitung' };
    return { status: 'refund', einkauf_id: einkaufId };
  } catch (e) {
    await sql`UPDATE imported_email SET status = 'failed', reason = ${(e as Error).message.slice(0, 200)} WHERE id = ${ledgerId} AND einkauf_id IS NULL`.catch(() => {});
    return { error: (e as Error).message.slice(0, 300) };
  }
}

/** Normalise a Message-ID for matching: strip the angle brackets + lowercase, so
 *  the IMAP envelope id lines up with however mailparser stored it at import. */
function normMid(m: string | null | undefined): string {
  return (m ?? '').replace(/[<>]/g, '').trim().toLowerCase();
}

/** If an e-mail receipt has no stored image/PDF but its mail actually carries a
 *  PDF/image attachment (missed at import — e.g. it went down the text path),
 *  save the attachment now and OCR it when the receipt has no line items yet.
 *  Notification mails without an attachment are left as-is (the body is shown). */
async function recoverAttachment(einkaufId: number, parsed: ParsedMail): Promise<void> {
  const [row] = await sql`SELECT bild_pfad FROM einkauf WHERE id = ${einkaufId}`;
  if (!row || row.bild_pfad) return;
  const atts = (parsed.attachments ?? []).filter(a => a.content && ((a.size ?? a.content.length) > 0));
  const att = atts.find(a => (a.contentType ?? '').toLowerCase().includes('pdf') || /\.pdf$/i.test(a.filename ?? ''))
           ?? atts.find(a => (a.contentType ?? '').toLowerCase().startsWith('image/'));
  if (!att) return;
  const isPdf = (att.contentType ?? '').toLowerCase().includes('pdf') || /\.pdf$/i.test(att.filename ?? '');
  const ext = isPdf ? 'pdf' : ((att.contentType ?? '').toLowerCase().includes('png') ? 'png' : 'jpg');
  const filename = `vds-${crypto.randomUUID()}.${ext}`;
  await writeFile(path.join(RECEIPTS_LOCAL_PATH, filename), att.content as Buffer);
  const bildPfad = `/receipts/${filename}`;
  await sql`UPDATE einkauf SET bild_pfad = ${bildPfad} WHERE id = ${einkaufId}`;
  const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM artikel WHERE einkauf_id = ${einkaufId}`;
  if (n === 0) {
    await sql`UPDATE einkauf SET ocr_pending = TRUE WHERE id = ${einkaufId}`;
    try { await ocrAndStore(einkaufId, bildPfad); }
    catch (e) { console.error(`[backfill] re-OCR receipt ${einkaufId} failed:`, (e as Error).message); }
    finally { await sql`UPDATE einkauf SET ocr_pending = FALSE WHERE id = ${einkaufId}`.catch(() => {}); }
  }
}

/** Back-fill the stored source mail for THIS user's e-mail-sourced receipts that
 *  were imported before e-mail storage existed. Two-pass to stay cheap: a header
 *  (envelope) scan finds which UIDs carry a wanted Message-ID, then only those
 *  bodies are downloaded. Never creates receipts; skips fallback-hash imports
 *  (no real Message-ID to re-match). */
export async function backfillEmails(userId: number): Promise<{ filled: number } | { error: string }> {
  const [mb] = await sql<MailboxRow[]>`SELECT * FROM user_mailbox WHERE user_id = ${userId}`;
  if (!mb) return { error: 'no mailbox configured' };
  const missing = await sql`
    SELECT ie.message_id, ie.einkauf_id
    FROM imported_email ie
    JOIN einkauf e ON e.id = ie.einkauf_id AND e.quelle = 'email'
    WHERE ie.user_id = ${userId} AND ie.einkauf_id IS NOT NULL
      AND (e.bild_pfad IS NULL
           OR NOT EXISTS (SELECT 1 FROM email_message em WHERE em.einkauf_id = ie.einkauf_id))`;
  if (!missing.length) return { filled: 0 };
  const wanted = new Map<string, number>();
  for (const r of missing) {
    const k = normMid(r.message_id as string);
    if (k && !k.startsWith('nomsgid-')) wanted.set(k, r.einkauf_id as number);
  }
  if (!wanted.size) return { filled: 0 }; // only fallback-hash imports → nothing re-matchable

  let filled = 0;
  try {
    const client = await openMailbox({
      imap_host: mb.imap_host, imap_port: mb.imap_port, imap_secure: mb.imap_secure,
      imap_user: mb.imap_user, pass: decryptSecret(mb.imap_pass_enc),
    });
    try {
      const lock = await client.getMailboxLock(mb.folder || 'INBOX');
      try {
        const box = client.mailbox;
        if (box && box.exists > BACKFILL_MAX_SCAN) {
          return { error: `mailbox too large (${box.exists} messages) — point the import at a dedicated invoice folder` };
        }
        if (box && box.exists > 0) {
          // Pass 1 — cheap header scan: which UIDs carry a wanted Message-ID.
          const hits: { uid: number; einkaufId: number }[] = [];
          for await (const msg of client.fetch('1:*', { uid: true, envelope: true }, { uid: true })) {
            const einkaufId = wanted.get(normMid(msg.envelope?.messageId));
            if (einkaufId) hits.push({ uid: Number(msg.uid), einkaufId });
          }
          // Pass 2 — download the full source only for the matches: store the mail
          // body AND recover a PDF/image attachment that was missed at import.
          for (const { uid, einkaufId } of hits) {
            for await (const m of client.fetch(String(uid), { uid: true, source: true }, { uid: true })) {
              if (m.source) {
                const parsed = await simpleParser(m.source as Buffer);
                await storeEmail(einkaufId, parsed);
                filled++;
                try { await recoverAttachment(einkaufId, parsed); }
                catch (e) { console.error(`[backfill] recoverAttachment ${einkaufId} failed:`, (e as Error).message); }
              }
              break;
            }
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      try { await client.logout(); } catch { /* ignore */ }
    }
  } catch (e) {
    return { error: (e as Error).message.slice(0, 300) };
  }
  return { filled };
}
