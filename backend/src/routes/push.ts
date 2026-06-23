import type { FastifyInstance } from 'fastify';
import { vapidPublicKey, saveSubscription, removeSubscription, sendPush } from '../push.js';

/** Web Push subscription management. The VAPID public key is needed by the browser
 *  to subscribe; subscribe/unsubscribe persist the per-device endpoint. */
export function pushRoutes(app: FastifyInstance): void {
  app.get('/api/push/key', async () => ({ key: await vapidPublicKey() }));

  app.post('/api/push/subscribe', async (req, reply) => {
    const sub = (req.body ?? {}) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      return reply.code(400).send({ error: 'invalid subscription' });
    }
    await saveSubscription(req.user!.id, {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', async (req) => {
    const { endpoint } = (req.body ?? {}) as { endpoint?: string };
    if (endpoint) await removeSubscription(endpoint);
    return { ok: true };
  });

  // Self-test: push to the caller's own devices. `sent` = number of devices reached.
  app.post('/api/push/test', async (req) => {
    const sent = await sendPush(req.user!.id, {
      title: 'Test 🔔', body: 'Push-Benachrichtigungen funktionieren.', url: '/', tag: 'push-test',
    });
    return { ok: true, sent };
  });
}
