// Demo sweep: deletes every ephemeral demo household (is_demo, id > 1), ALL its data,
// AND its user-generated files on disk (receipt photos + income pay-slips). Runs nightly
// (demo_sweep cron, midnight Europe/Berlin) and on demand via the super-admin wipe-all
// button (POST /api/households/wipe-all). Household 1 (platform) is never touched.
//
// Cascade approach mirrors the manual household delete (routes/demo.ts): adminSql (owner,
// bypasses RLS) + SET LOCAL session_replication_role = replica so inter-table FKs don't
// force a dependency-ordered delete.
import cron from 'node-cron';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { adminSql } from '../db.js';
import { getConfig } from '../config.js';

const RECEIPTS_LOCAL_PATH = process.env.RECEIPTS_LOCAL_PATH ?? '/receipts';
const PAYSLIP_DIR = path.join(RECEIPTS_LOCAL_PATH, '_payslips');

let task: cron.ScheduledTask | null = null;
let running = false;
export function isDemoSweepRunning(): boolean { return running; }

export interface SweepResult { households: number; files: number }

/** Delete all ephemeral demo households + their data + their files. */
export async function runDemoSweep(): Promise<SweepResult> {
  if (running) return { households: 0, files: 0 };
  running = true;
  try {
    const victims = await adminSql`SELECT id FROM household WHERE is_demo = TRUE AND id > 1`;
    const ids = victims.map(v => Number(v.id));   // BIGINT comes back as a string from postgres.js
    if (!ids.length) return { households: 0, files: 0 };

    // Collect user-generated file paths BEFORE the rows disappear.
    const receipts = await adminSql`SELECT bild_pfad FROM einkauf WHERE household_id = ANY(${ids}) AND bild_pfad IS NOT NULL`;
    const payslips = await adminSql`SELECT file_path FROM income  WHERE household_id = ANY(${ids}) AND file_path IS NOT NULL`;

    const tables = await adminSql`
      SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'household_id' AND t.table_type = 'BASE TABLE'`;

    await adminSql.begin(async tx => {
      await tx`SET LOCAL session_replication_role = replica`;
      for (const id of ids) {
        for (const { table_name } of tables) {
          await tx.unsafe(`DELETE FROM "${table_name}" WHERE household_id = $1`, [id]);
        }
      }
      await tx`DELETE FROM household WHERE id = ANY(${ids})`;
    });

    // Delete the physical files (best-effort — swallow ENOENT). bild_pfad is a
    // '/receipts/<file>' URL → take basename; income.file_path is a bare filename.
    let files = 0;
    for (const { bild_pfad } of receipts) {
      const name = String(bild_pfad).split('/').pop();
      if (name) await unlink(path.join(RECEIPTS_LOCAL_PATH, name)).then(() => { files++; }).catch(() => {});
    }
    for (const { file_path } of payslips) {
      if (file_path) await unlink(path.join(PAYSLIP_DIR, path.basename(String(file_path)))).then(() => { files++; }).catch(() => {});
    }

    console.log(`[demo-sweep] deleted ${ids.length} household(s) [${ids.join(', ')}] + ${files} file(s)`);
    return { households: ids.length, files };
  } finally {
    running = false;
  }
}

export async function rescheduleDemoSweep(): Promise<void> {
  if (task) { task.stop(); task = null; }
  const enabled = await getConfig('demo_sweep.enabled');
  const schedule = await getConfig('demo_sweep.cron');
  if (!enabled) { console.log('[demo-sweep] disabled'); return; }
  if (!cron.validate(schedule)) { console.error(`[demo-sweep] invalid cron "${schedule}"`); return; }
  task = cron.schedule(schedule, () => {
    if (running) return;
    runDemoSweep().catch(err => console.error('[demo-sweep] cron run failed:', err));
  }, { timezone: 'Europe/Berlin' });   // "midnight" = Berlin midnight (matches the login copy)
  console.log(`[demo-sweep] scheduled: ${schedule} (Europe/Berlin)`);
}
