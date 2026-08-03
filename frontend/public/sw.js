/* Service worker for Vorratsdatenspeicher — Web Push only (no offline caching). */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_e) { data = {}; }
  const title = data.title || 'Vorratsdatenspeicher';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    // Android draws `badge` as a monochrome ALPHA MASK — it discards the colours and paints
    // every opaque pixel one flat tint. icon-192 is a fully opaque cream square, so it came
    // out as a featureless blob in the status bar. badge-72 is the glyph on transparency.
    badge: '/badge-72.png',
    tag: data.tag || undefined,
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          if ('navigate' in client) { try { client.navigate(url); } catch (_e) { /* ignore */ } }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
      return undefined;
    })
  );
});
