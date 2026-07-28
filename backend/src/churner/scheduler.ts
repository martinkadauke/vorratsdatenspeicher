import cron from 'node-cron';
import { getConfig } from '../config.js';
import { DEMO_MODE } from '../db.js';
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
  // DEMO: a cron callback has no request and therefore no household to run in. Until now the
  // job was armed anyway and was inert only BY ACCIDENT (RLS returned nothing on the unscoped
  // pool connection); that is not a decision anyone recorded, and it would silently start
  // touching real data the moment scoping changed. Make it an explicit skip instead. Fanning
  // out over every household is not the answer either: the demo caps AI usage per household on
  // purpose, a nightly churn across N visitor households is unbounded LLM spend, and demo_sweep
  // deletes those households at 00:00 Berlin — three hours before the default 03:00 churn — so
  // it would only ever see the handful signed up in between. The demo's real need is already
  // covered by the per-receipt auto_ocr trigger, which carries the uploader's household. Same
  // call as rescheduleMailImport, which index.ts likewise does not arm on the demo.
  if (DEMO_MODE) {
    console.log('[churner] nightly cron not armed in DEMO_MODE — per-receipt auto-churn only');
    return;
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
