import cron from 'node-cron';
import { getConfig } from '../config.js';
import { runChurn, isChurnRunning } from './index.js';

let task: cron.ScheduledTask | null = null;

/** (Re)start the nightly churner from app_config. Call again after config changes.
 *  Only the prod environment runs the cron — stage/dev never auto-churn so we
 *  don't 3× the load on Ollama/DeepSeek. Manual "Run now" works everywhere. */
export async function rescheduleChurner(): Promise<void> {
  if (task) {
    task.stop();
    task = null;
  }
  const env = process.env.VDS_ENV ?? 'prod';
  if (env !== 'prod') {
    console.log(`[churner] cron disabled in ${env} environment — manual runs still work`);
    return;
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
  console.log(`[churner] scheduled: ${schedule} (env=${env})`);
}
