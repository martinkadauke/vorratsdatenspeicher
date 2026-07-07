import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sql from '../db.js';
import { decryptSecret } from '../lib/crypto.js';
import { ocrFromText } from '../llm/ocr.js';
import { ocrAndStore, storeOcrResult } from '../routes/receipts.js';

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

function todayISO(): string { return new Date().toISOString().slice(0, 10); }

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

/** Choose the body text to extract from. Prefer the plain-text part, BUT many
 *  shops send a thin text/plain stub ("Bitte im HTML-Format ansehen" / a one-line
 *  summary) while the itemised order actually lives in the HTML part — using the
 *  stub makes the extractor return "no receipt data" and the mail is skipped. So
 *  when the plain text is too short to hold a receipt, fall back to the (usually
 *  much richer) stripped HTML. */
function pickBody(parsed: ParsedMail): string {
  const plain = (parsed.text ?? '').trim();
  const html = parsed.html ? stripHtml(parsed.html) : '';
  if (plain.length >= 400) return plain;          // substantial plain text → trust it
  return html.length > plain.length ? html : plain;
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

  const datum = parsed.date ? parsed.date.toISOString().slice(0, 10) : null;
  const privateFor = mb.make_private ? mb.user_id : null;
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
  const bodyPrompt = `Betreff: ${parsed.subject ?? ''}\nVon: ${parsed.from?.text ?? ''}\n\n${bodyText}`;

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
        INSERT INTO einkauf (datum, roh_ladenname, quelle, konto_id, bild_pfad, private_for_user_id, ocr_pending)
        VALUES (${datum ?? todayISO()}, ${subject}, 'email', ${kontoId}, ${bildPfad}, ${privateFor}, TRUE)
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
        const extracted = await ocrFromText(bodyPrompt);
        if (extracted.ladenkette || extracted.artikel?.length) {
          madeItems = (await storeOcrResult(einkaufId, extracted)).items > 0;
          if (madeItems) await sql`UPDATE einkauf SET bild_pfad = NULL WHERE id = ${einkaufId}`.catch(() => {});
        }
        if (!madeItems) reason = 'attachment + e-mail body had no usable line items';
      } else {
        reason = 'attachment OCR returned no line items';
      }
    } else if (bodyText) {
      const extracted = await ocrFromText(bodyPrompt);
      if (!extracted.ladenkette && !(extracted.artikel?.length)) {
        status = 'skipped';
        reason = 'no receipt data found in e-mail body';
      } else {
        const [row] = await sql`
          INSERT INTO einkauf (datum, roh_ladenname, quelle, konto_id, private_for_user_id)
          VALUES (${datum ?? todayISO()}, ${subject}, 'email', ${kontoId}, ${privateFor})
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
  // year, a previous order). If the OCR date landed >21 days from the header, trust
  // the header — unless this is a forward, where the header is the forward time, not
  // the original invoice's.
  const isForward = /^\s*(wg|fwd?|fw):/i.test(parsed.subject ?? '');
  if (einkaufId && datum && !isForward) {
    await sql`
      UPDATE einkauf SET datum = ${datum}::date, date_uncertain = FALSE
      WHERE id = ${einkaufId} AND (datum IS NULL OR ABS(datum - ${datum}::date) > 21)`.catch(() => {});
  }

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
