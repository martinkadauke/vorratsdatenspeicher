import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
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
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&euro;/gi, '€')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
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

  // Claim the message atomically; if another run already has it, stop here.
  const claim = await sql`
    INSERT INTO imported_email (user_id, message_id, subject, status)
    VALUES (${mb.user_id}, ${messageId}, ${subject}, 'processing')
    ON CONFLICT (user_id, message_id) DO NOTHING
    RETURNING id`;
  if (!claim.length) return false;
  const ledgerId = claim[0].id as number;

  const datum = parsed.date ? parsed.date.toISOString().slice(0, 10) : null;
  const privateFor = mb.make_private ? mb.user_id : null;
  const atts = (parsed.attachments ?? []).filter(a => a.content && ((a.size ?? a.content.length) > 0));
  const pdf = atts.find(a => (a.contentType ?? '').toLowerCase().includes('pdf') || /\.pdf$/i.test(a.filename ?? ''));
  const img = atts.find(a => (a.contentType ?? '').toLowerCase().startsWith('image/'));

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
      try {
        const r = await ocrAndStore(einkaufId, bildPfad);
        madeItems = r.items > 0;
        if (!madeItems) reason = 'attachment OCR returned no line items';
      } finally {
        await sql`UPDATE einkauf SET ocr_pending = FALSE WHERE id = ${einkaufId}`.catch(() => {});
      }
    } else {
      const body = (parsed.text && parsed.text.trim()) || (parsed.html ? stripHtml(parsed.html) : '');
      if (!body) {
        status = 'skipped';
        reason = 'no attachment and empty body';
      } else {
        const extracted = await ocrFromText(`Betreff: ${parsed.subject ?? ''}\nVon: ${parsed.from?.text ?? ''}\n\n${body}`);
        if (!extracted.ladenkette && !(extracted.artikel?.length)) {
          status = 'skipped';
          reason = 'no receipt data found in e-mail body';
        } else {
          const [row] = await sql`
            INSERT INTO einkauf (datum, roh_ladenname, quelle, konto_id, private_for_user_id)
            VALUES (${datum ?? todayISO()}, ${subject}, 'email', ${kontoId}, ${privateFor})
            RETURNING id`;
          einkaufId = row.id as number;
          const r = await storeOcrResult(einkaufId, extracted);
          madeItems = r.items > 0;
        }
      }
    }
  } catch (e) {
    status = 'failed';
    reason = (e as Error).message.slice(0, 300);
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
