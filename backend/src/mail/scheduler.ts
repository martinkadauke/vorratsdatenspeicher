import cron from 'node-cron';
import { getConfig } from '../config.js';
import { runMailImport } from './importer.js';

let task: cron.ScheduledTask | null = null;

/** (Re)start the e-mail import poll from app_config. Global on/off + schedule live
 *  in `mailimport.*`; the real per-user gate is `user_mailbox.enabled`. Mirrors the
 *  churner scheduler. Call again after changing the config to apply it. */
export async function rescheduleMailImport(): Promise<void> {
  if (task) {
    task.stop();
    task = null;
  }
  const enabled = await getConfig('mailimport.enabled');
  const schedule = await getConfig('mailimport.cron');
  const env = process.env.VDS_ENV ?? 'prod';
  if (!enabled) {
    console.log(`[mailimport] disabled in ${env}`);
    return;
  }
  if (!cron.validate(schedule)) {
    console.error(`[mailimport] invalid cron "${schedule}", not scheduling`);
    return;
  }
  if (!process.env.MAILBOX_ENC_KEY) {
    // Still works (falls back to a JWT_SECRET-derived key) but couples the IMAP
    // password encryption to the auth secret — set a dedicated key in prod/stage.
    console.warn('[mailimport] MAILBOX_ENC_KEY not set — IMAP passwords are encrypted with a JWT_SECRET-derived key. Set MAILBOX_ENC_KEY for a dedicated secret.');
  }
  task = cron.schedule(schedule, () => {
    runMailImport('cron').catch(err => console.error('[mailimport] cron run failed:', err));
  });
  console.log(`[mailimport] scheduled in ${env}: ${schedule}`);
}
