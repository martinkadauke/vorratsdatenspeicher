// Web Push (browser notifications). VAPID keypair is generated once and persisted
// in app_config, so it stays stable across restarts (changing it would invalidate
// every existing subscription). Sending is best-effort: dead subscriptions (the
// push service answers 404/410) are pruned automatically.
import webpush from 'web-push';
import sql from './db.js';
import { getConfig, setConfig } from './config.js';

let cachedPublic: string | null = null;

/** Ensure VAPID details are configured (generate + persist on first use). Returns
 *  the public key, or null if for some reason it can't be set up. */
async function ensureVapid(): Promise<string | null> {
  if (cachedPublic) return cachedPublic;
  let pub = await getConfig('push.vapid_public');
  let priv = await getConfig('push.vapid_private');
  let subject = await getConfig('push.vapid_subject');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    await setConfig('push.vapid_public', pub);
    await setConfig('push.vapid_private', priv);
  }
  if (!subject) {
    subject = 'mailto:push@vorratsdatenspeicher.local';
    await setConfig('push.vapid_subject', subject);
  }
  webpush.setVapidDetails(subject, pub, priv);
  cachedPublic = pub;
  return pub;
}

export async function vapidPublicKey(): Promise<string> {
  return (await ensureVapid()) ?? '';
}

export async function saveSubscription(
  userId: number, sub: { endpoint: string; keys: { p256dh: string; auth: string } },
): Promise<void> {
  await sql`
    INSERT INTO push_subscription (user_id, endpoint, p256dh, auth)
    VALUES (${userId}, ${sub.endpoint}, ${sub.keys.p256dh}, ${sub.keys.auth})
    ON CONFLICT (endpoint) DO UPDATE
      SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`;
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await sql`DELETE FROM push_subscription WHERE endpoint = ${endpoint}`;
}

export interface PushPayload { title: string; body: string; url?: string; tag?: string }

/** Send a push to every device the user has subscribed. No-op if push isn't set up
 *  or the user has no subscriptions. Prunes expired subscriptions. */
export async function sendPush(userId: number, payload: PushPayload): Promise<number> {
  if (!(await ensureVapid())) return 0;
  const subs = await sql`SELECT id, endpoint, p256dh, auth FROM push_subscription WHERE user_id = ${userId}`;
  if (!subs.length) return 0;
  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint as string, keys: { p256dh: s.p256dh as string, auth: s.auth as string } },
        body,
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        await sql`DELETE FROM push_subscription WHERE id = ${s.id}`; // gone for good
      } else {
        console.error('[push] send failed:', code, (e as Error).message);
      }
    }
  }));
  return sent;
}
