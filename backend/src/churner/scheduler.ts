import cron from 'node-cron';
import { getConfig } from '../config.js';
import { runChurn, isChurnRunning } from './index.js';

let task: cron.ScheduledTask | null = null;

/** (Re)start the nightly churner from app_config. Call again after config changes. */
export async function rescheduleChurner(): Promise<void> {
  if (task) {
    task.stop();
    task = null;
  }
  const enabled = await getConfig('churner.enabled');
  const schedule = await getConfig('churner.cron');
  if (!enabled) {
    console.log('[churner] disabled');
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
  console.log(`[churner] scheduled: ${schedule}`);
}
