import cron from 'node-cron';
import { getConfig } from '../config.js';
import { runDropfolderImport } from './importer.js';

let task: cron.ScheduledTask | null = null;

/** (Re)start the drop-folder scanner from app_config. Mirrors the mail-import
 *  scheduler: reads dropfolder.enabled + dropfolder.cron, validates, schedules. */
export async function rescheduleDropfolder(): Promise<void> {
  if (task) { task.stop(); task = null; }
  const enabled = await getConfig('dropfolder.enabled');
  const schedule = await getConfig('dropfolder.cron');
  const env = process.env.VDS_ENV ?? 'prod';
  if (!enabled) {
    console.log(`[dropfolder] disabled in ${env}`);
    return;
  }
  if (!cron.validate(schedule)) {
    console.error(`[dropfolder] invalid cron "${schedule}", not scheduling`);
    return;
  }
  task = cron.schedule(schedule, () => {
    runDropfolderImport('cron').catch(err => console.error('[dropfolder] cron run failed:', err));
  });
  console.log(`[dropfolder] scheduled in ${env}: ${schedule}`);
}
