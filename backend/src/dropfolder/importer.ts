import { readdir, stat, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sql from '../db.js';
import { getConfig } from '../config.js';
import { ocrAndStore } from '../routes/receipts.js';

// Same store dir the whole app uses; a dropped file is COPIED here (as vds-<uuid>.<ext>)
// so it's servable at /receipts/<name> and reachable by ocrAndStore, which resolves
// bild_pfad against RECEIPTS_LOCAL_PATH. The static route only serves the top level,
// not the /invoices subfolder — hence the copy rather than serving in place.
const RECEIPTS_LOCAL_PATH = process.env.RECEIPTS_LOCAL_PATH ?? '/receipts';
const LOCK_KEY = 825042;             // distinct from mail importer's 825041
const MIN_AGE_MS = 15_000;           // ignore files touched in the last 15s (still downloading/copying)
const MAX_ATTEMPTS = 3;              // stop re-OCR'ing a file that keeps failing
const ALLOWED = /\.(pdf|jpe?g|png|webp|gif|heic|heif)$/i;

function todayISO(): string { return new Date().toISOString().slice(0, 10); }

/** A drop-folder invoice has no user context → attribute it to the shared,
 *  non-cash household account (same "prefer shared non-cash" rule the mail
 *  importer uses, minus the per-user branch). NULL if none exists. */
async function defaultHouseholdKonto(): Promise<number | null> {
  const [k] = await sql`
    SELECT id FROM konto
    WHERE is_shared = TRUE AND is_cash = FALSE
    ORDER BY sort_order ASC, id ASC LIMIT 1`;
  return (k?.id as number | undefined) ?? null;
}

let running = false;
export function isDropfolderRunning(): boolean { return running; }

export interface DropScanResult { scanned: number; imported: number; failed: number; skipped: number; folder: string }

/** One scan pass over the drop folder. Serialized in-process (running flag) and
 *  across Swarm replicas (pg advisory lock), exactly like the mail importer. */
export async function runDropfolderImport(trigger: string): Promise<DropScanResult> {
  const empty: DropScanResult = { scanned: 0, imported: 0, failed: 0, skipped: 0, folder: '' };
  if (running) return empty;
  running = true;
  const conn = await sql.reserve();
  try {
    const [{ locked }] = await conn`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`;
    if (!locked) return empty;         // another replica is scanning
    try {
      return await scan(trigger);
    } finally {
      await conn`SELECT pg_advisory_unlock(${LOCK_KEY})`;
    }
  } finally {
    conn.release();
    running = false;
  }
}

async function scan(trigger: string): Promise<DropScanResult> {
  const folder = await getConfig('dropfolder.path');
  const res: DropScanResult = { scanned: 0, imported: 0, failed: 0, skipped: 0, folder };
  if (!folder) return res;

  let entries: string[];
  try {
    entries = await readdir(folder);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(`[dropfolder] path not found: ${folder} (nothing to scan)`);
      return res;
    }
    throw e;
  }

  const konto = await defaultHouseholdKonto();
  const now = Date.now();

  for (const name of entries) {
    if (!ALLOWED.test(name)) continue;                 // only invoices: pdf/image types
    const full = path.join(folder, name);
    let st;
    try { st = await stat(full); } catch { continue; }
    if (!st.isFile() || st.size === 0) continue;
    if (now - st.mtimeMs < MIN_AGE_MS) continue;       // likely still being written → next pass
    res.scanned++;

    const buf = await readFile(full);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');

    // Dedup by content: skip if already imported, or already given up on.
    const [prev] = await sql`SELECT status, attempts FROM imported_file WHERE file_hash = ${hash}`;
    if (prev && (prev.status === 'imported' || (prev.attempts as number) >= MAX_ATTEMPTS)) { res.skipped++; continue; }

    try {
      const einkaufId = await importOne(name, buf, konto);
      await sql`
        INSERT INTO imported_file (file_hash, source_name, einkauf_id, status, reason, attempts, updated_at)
        VALUES (${hash}, ${name}, ${einkaufId}, 'imported', NULL, 1, NOW())
        ON CONFLICT (file_hash) DO UPDATE SET
          einkauf_id = EXCLUDED.einkauf_id, status = 'imported', reason = NULL,
          attempts = imported_file.attempts + 1, updated_at = NOW()`;
      res.imported++;
    } catch (err) {
      const reason = (err as Error).message.slice(0, 300);
      await sql`
        INSERT INTO imported_file (file_hash, source_name, status, reason, attempts, updated_at)
        VALUES (${hash}, ${name}, 'failed', ${reason}, 1, NOW())
        ON CONFLICT (file_hash) DO UPDATE SET
          status = 'failed', reason = ${reason},
          attempts = imported_file.attempts + 1, updated_at = NOW()`;
      console.error(`[dropfolder] failed "${name}": ${reason}`);
      res.failed++;
    }
  }

  if (res.scanned) {
    console.log(`[dropfolder] ${trigger}: scanned ${res.scanned}, imported ${res.imported}, failed ${res.failed}, skipped ${res.skipped} (${folder})`);
  }
  return res;
}

/** Copy a dropped file into the receipts store, create the receipt row, run vision
 *  OCR (which also fires the post-OCR churn). Mirrors the mail importer's attachment
 *  path. On an unusable file (not a receipt / corrupt / HEIC) it rolls back the row
 *  and the copy so no junk empty receipt is left, then rethrows for the ledger. */
async function importOne(sourceName: string, buf: Buffer, konto: number | null): Promise<number> {
  const extMatch = sourceName.match(/\.([a-z0-9]+)$/i);
  let ext = (extMatch?.[1] ?? 'jpg').toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  const filename = `vds-${crypto.randomUUID()}.${ext}`;
  const diskPath = path.join(RECEIPTS_LOCAL_PATH, filename);
  await writeFile(diskPath, buf);
  const bildPfad = `/receipts/${filename}`;

  const label = sourceName.replace(/\.[a-z0-9]+$/i, '').slice(0, 200); // filename (sans ext) until OCR fills the store
  // A filesystem drop has no user context → attribute the invoice to the primary mailbox
  // owner's household member (the household's default invoice manager, same fallback as
  // migration 082 for uploads), so it isn't left un-attributed. Re-assignable in the UI.
  const [snapMember] = await sql`
    SELECT fm.id FROM family_member fm
    WHERE fm.user_id = (SELECT user_id FROM user_mailbox WHERE enabled ORDER BY user_id LIMIT 1)
    ORDER BY fm.sort_order, fm.id LIMIT 1`;
  const snappedBy = (snapMember?.id as number | undefined) ?? null;
  // quelle='email' — same bucket as e-mail invoices (they're the same kind of thing:
  // online invoices, not in-store receipts). Provenance stays in the imported_file
  // ledger; the e-mail-specific backfill/reocr queries also require an imported_email
  // row, which these never have, so they're not affected.
  const [row] = await sql`
    INSERT INTO einkauf (datum, roh_ladenname, quelle, konto_id, bild_pfad, private_for_user_id, snapped_by_member_id, ocr_pending)
    VALUES (${todayISO()}, ${label}, 'email', ${konto}, ${bildPfad}, ${null}, ${snappedBy}, TRUE)
    RETURNING id`;
  const einkaufId = row.id as number;

  try {
    await ocrAndStore(einkaufId, bildPfad);   // ocrFromImage (pdf+image) → storeOcrResult → churn
    await sql`UPDATE einkauf SET ocr_pending = FALSE WHERE id = ${einkaufId}`.catch(() => {});
    return einkaufId;
  } catch (err) {
    await sql`DELETE FROM einkauf WHERE id = ${einkaufId}`.catch(() => {});
    await unlink(diskPath).catch(() => {});
    throw err;
  }
}
