import type { FastifyInstance } from 'fastify';
import sql, { DEMO_MODE } from '../db.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { testMailbox, runMailImportForUser, backfillEmails, retryImportedEmail, reinterpretImportedEmail, confirmMailIncome } from '../mail/importer.js';
import { ocrAndStore } from './receipts.js';

/** Re-run OCR (with the now invoice-aware prompt) on the given PDF receipts,
 *  one at a time in the background, flagging ocr_pending per receipt. */
async function reocrPdfs(rows: { id: number; bild_pfad: string }[]): Promise<void> {
  for (const r of rows) {
    if (!r.bild_pfad) continue;
    await sql`UPDATE einkauf SET ocr_pending = TRUE WHERE id = ${r.id}`.catch(() => {});
    try {
      await ocrAndStore(r.id, r.bild_pfad);
    } catch (e) {
      console.error(`[reocr] receipt ${r.id} failed:`, (e as Error).message);
    } finally {
      await sql`UPDATE einkauf SET ocr_pending = FALSE WHERE id = ${r.id}`.catch(() => {});
    }
  }
}

interface MailboxBody {
  imap_host?: string;
  imap_port?: number;
  imap_secure?: boolean;
  imap_user?: string;
  imap_pass?: string;   // write-only; omitted on update keeps the stored password
  folder?: string;
  enabled?: boolean;
  make_private?: boolean;
}

function normalise(b: MailboxBody) {
  return {
    host: (b.imap_host ?? '').trim(),
    user: (b.imap_user ?? '').trim(),
    port: Number.isInteger(b.imap_port) && (b.imap_port as number) > 0 ? (b.imap_port as number) : 993,
    secure: b.imap_secure !== false,        // default implicit TLS (993)
    folder: (b.folder ?? '').trim() || 'INBOX',
    enabled: b.enabled !== false,           // default on
    makePrivate: !!b.make_private,
    pass: (b.imap_pass ?? '').toString(),
  };
}

/** Per-user IMAP mailbox config for automatic e-mail receipt import (Path B).
 *  All endpoints act on the authenticated user only; the password is encrypted
 *  at rest and never returned. */
export function mailboxRoutes(app: FastifyInstance): void {
  // Defense-in-depth: these routes accept and store REAL IMAP credentials and turn every
  // attachment into a vision-OCR call. On the public demo — open signup, throwaway
  // households — neither is acceptable. index.ts already skips this whole module when
  // DEMO_MODE is on; assert here too so a future refactor that mounts it unconditionally
  // registers NOTHING rather than silently exposing the mailbox API.
  if (DEMO_MODE) { console.error('[mailbox] mailboxRoutes() invoked with DEMO_MODE on — refusing to register'); return; }

  // Current config (without the password).
  app.get('/api/me/mailbox', async (req) => {
    const userId = req.user!.id;
    const [m] = await sql`
      SELECT imap_host, imap_port, imap_secure, imap_user, folder, enabled, make_private,
             last_poll_at, last_ok_at, last_error
      FROM user_mailbox WHERE user_id = ${userId}`;
    if (!m) return { configured: false };
    return { configured: true, ...m };
  });

  // Create or update. On update, an empty password keeps the stored one.
  app.put('/api/me/mailbox', async (req, reply) => {
    const userId = req.user!.id;
    const n = normalise((req.body ?? {}) as MailboxBody);
    if (!n.host || !n.user) return reply.code(400).send({ error: 'imap_host and imap_user required' });

    const [existing] = await sql`SELECT imap_pass_enc FROM user_mailbox WHERE user_id = ${userId}`;
    let passEnc: string;
    if (n.pass) passEnc = encryptSecret(n.pass);
    else if (existing) passEnc = existing.imap_pass_enc as string;
    else return reply.code(400).send({ error: 'imap_pass required' });

    await sql`
      INSERT INTO user_mailbox
        (user_id, imap_host, imap_port, imap_secure, imap_user, imap_pass_enc, folder, enabled, make_private, updated_at)
      VALUES
        (${userId}, ${n.host}, ${n.port}, ${n.secure}, ${n.user}, ${passEnc}, ${n.folder}, ${n.enabled}, ${n.makePrivate}, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        imap_host = EXCLUDED.imap_host, imap_port = EXCLUDED.imap_port, imap_secure = EXCLUDED.imap_secure,
        imap_user = EXCLUDED.imap_user, imap_pass_enc = EXCLUDED.imap_pass_enc, folder = EXCLUDED.folder,
        enabled = EXCLUDED.enabled, make_private = EXCLUDED.make_private, updated_at = NOW()`;
    return { ok: true };
  });

  // Remove the mailbox (stops importing; keeps already-imported receipts).
  app.delete('/api/me/mailbox', async (req) => {
    await sql`DELETE FROM user_mailbox WHERE user_id = ${req.user!.id}`;
    return { ok: true };
  });

  // Live connection check for the "Test" button — uses the supplied password, or
  // the stored one when the field is left blank.
  app.post('/api/me/mailbox/test', async (req, reply) => {
    const userId = req.user!.id;
    const n = normalise((req.body ?? {}) as MailboxBody);
    if (!n.host || !n.user) return reply.code(400).send({ error: 'imap_host and imap_user required' });
    let pass = n.pass;
    if (!pass) {
      const [existing] = await sql`SELECT imap_pass_enc FROM user_mailbox WHERE user_id = ${userId}`;
      if (!existing) return reply.code(400).send({ error: 'imap_pass required' });
      try { pass = decryptSecret(existing.imap_pass_enc as string); }
      catch { return reply.code(400).send({ error: 'stored password could not be decrypted — please re-enter it' }); }
    }
    return testMailbox({ imap_host: n.host, imap_port: n.port, imap_secure: n.secure, imap_user: n.user, pass, folder: n.folder });
  });

  // Trigger an immediate poll for this user ("fetch now").
  app.post('/api/me/mailbox/run', async (req) => {
    return runMailImportForUser(req.user!.id);
  });

  // Back-fill stored source mails for receipts imported before e-mail storage existed.
  app.post('/api/me/mailbox/backfill-emails', async (req) => {
    return backfillEmails(req.user!.id);
  });

  // Import log: what each fetched mail produced (imported / skipped / failed +
  // reason), newest first, with a link to the resulting receipt and its item
  // count. This is the user-facing answer to "why didn't my invoice show up?".
  app.get('/api/me/mailbox/log', async (req) => {
    const userId = req.user!.id;
    const limit = Math.min(Number((req.query as { limit?: string }).limit) || 60, 200);
    const rows = await sql`
      SELECT ie.id, ie.status, ie.reason, ie.einkauf_id, ie.income_id, ie.created_at::text AS created_at,
             LEFT(ie.subject, 200) AS subject,
             e.roh_ladenname, inc.amount AS income_amount,
             COALESCE((SELECT COUNT(*)::int FROM artikel a WHERE a.einkauf_id = ie.einkauf_id), 0) AS items
      FROM imported_email ie
      LEFT JOIN einkauf e ON e.id = ie.einkauf_id
      LEFT JOIN income inc ON inc.id = ie.income_id
      WHERE ie.user_id = ${userId}
      ORDER BY ie.created_at DESC
      LIMIT ${limit}`;
    return { entries: rows };
  });

  // Retry ONE skipped/failed mail from the log. Three modes on one endpoint:
  //  • {}                      → plain re-run through the pipeline (unchanged behaviour).
  //  • {instruction:"…"}       → AI reinterpret under a user instruction → a corrected receipt,
  //                              or an income PREVIEW (no write) the user then confirms.
  //  • {confirmIncome:{…}}     → book the previewed income (server re-validates + caps the amount).
  // Guarded to this user's own unresolved rows, so it can never duplicate an import.
  app.post('/api/me/mailbox/log/:id/retry', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
    const body = (req.body ?? {}) as { instruction?: unknown; confirmIncome?: Record<string, unknown> };
    if (body.confirmIncome && typeof body.confirmIncome === 'object') {
      const ci = body.confirmIncome;
      return confirmMailIncome(req.user!.id, id, {
        amount: ci.amount, datum: ci.datum, category_path: ci.category_path, description: ci.description,
      });
    }
    const instruction = (body.instruction ?? '').toString().trim();
    if (instruction) return reinterpretImportedEmail(req.user!.id, id, instruction);
    return retryImportedEmail(req.user!.id, id);
  });

  // Re-OCR this user's e-mail-imported PDF receipts that ended up with NO line
  // items (e.g. PDFs that the old Kassenbon-tuned prompt rejected). Only touches
  // 0-item receipts, so it can't overwrite anything the user corrected. Runs in
  // the background; each receipt shows its ocr_pending spinner while processing.
  app.post('/api/me/mailbox/reocr', async (req) => {
    const userId = req.user!.id;
    const rows = await sql`
      SELECT DISTINCT e.id, e.bild_pfad
      FROM einkauf e
      JOIN imported_email ie ON ie.einkauf_id = e.id AND ie.user_id = ${userId}
      WHERE e.quelle = 'email' AND e.bild_pfad ILIKE '%.pdf'
        AND NOT EXISTS (SELECT 1 FROM artikel a WHERE a.einkauf_id = e.id)`;
    void reocrPdfs(rows as unknown as { id: number; bild_pfad: string }[]);
    return { queued: rows.length };
  });
}
