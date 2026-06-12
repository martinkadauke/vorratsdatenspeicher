import cron from 'node-cron';
import { getConfig } from '../config.js';
import { runSupermarketInfo, isSupermarketRunning } from './info.js';

let task: cron.ScheduledTask | null = null;

/** (Re)start the nightly supermarket-info crawler from app_config. */
export async function rescheduleSupermarket(): Promise<void> {
  if (task) { task.stop(); task = null; }
  const enabled = await getConfig('supermarket.enabled');
  const schedule = await getConfig('supermarket.cron');
  if (!enabled) { console.log('[supermarket] disabled'); return; }
  if (!cron.validate(schedule)) {
    console.error(`[supermarket] invalid cron "${schedule}", not scheduling`);
    return;
  }
  task = cron.schedule(schedule, () => {
    if (isSupermarketRunning()) return;
    runSupermarketInfo().catch(err => console.error('[supermarket] cron run failed:', err));
  });
  console.log(`[supermarket] scheduled: ${schedule}`);
}
