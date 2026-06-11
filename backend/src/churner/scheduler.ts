import cron from 'node-cron';
import { getConfig } from '../config.js';
import { runChurn, isChurnRunning } from './index.js';

let task: cron.ScheduledTask | null = null;

/** (Re)start the nightly churner from app_config. Per-env activation is now
 *  controlled by the in-app churner.enabled toggle alone — flip it in
 *  Admin → Churner per environment. (The old VDS_ENV gate was too strict
 *  for env-switching scenarios.) */
export async function rescheduleChurner(): Promise<void> {
  if (task) {
    task.stop();
    task = null;
  }
  const enabled = await getConfig('churner.enabled');
  const schedule = await getConfig('churner.cron');
  const env = process.env.VDS_ENV ?? 'prod';
  if (!enabled) {
    console.log(`[churner] disabled in ${env}`);
    return;
  }
  if (!cron.validate(schedule)) {
    console.error(`[churner] invalid cron "${schedule}", not scheduling`);
    return;
  }
  task = cron.schedule(schedule, () => {
    if (isChurnRunning()) return;
    runChurn('cron').catch(err => console.error('[churner] cron run failed:', err));
  });
  console.log(`[churner] scheduled in ${env}: ${schedule}`);
}
