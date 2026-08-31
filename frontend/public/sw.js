/* Service worker for Vorratsdatenspeicher: Web Push, and the app shell offline.
 *
 * The problem this solves is not "empty lists in the supermarket" — it is that without a network
 * the app does not open AT ALL. index.html itself comes over the wire, so a phone with no signal
 * gets the browser's own error page and VDS may as well not be installed. Cookies cannot help
 * with that; they hold a session, not a program.
 *
 * ⚠️ A service worker only runs in a SECURE CONTEXT — https or localhost. The desktop build
 * (localhost) and the Tailscale funnel (https) both qualify; a self-hoster on plain
 * http://192.168.x.x does not, and the browser refuses to register this file at all. Nothing
 * breaks there, it simply stays as it is today. Same rule already governs passkeys and push.
 *
 * ⚠️ NOTHING here writes to the filesystem. Everything lives in the Cache API, inside the
 * browser's private storage — invisible to the Android media store, so cached receipt photos can
 * never surface in the gallery or be picked up by Nextcloud or Immich as new uploads. Any future
 * addition here must keep that property: no downloads, no File System Access API.
 */
const CACHE_PREFIX = 'vds-shell-';

/** Tell any open page how precaching went — see main.tsx. */
async function report(detail) {
  try {
    const list = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    for (const c of list) c.postMessage({ type: 'vds:precache', ...detail });
  } catch (_e) { /* nobody listening */ }
}
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


// ── offline app shell ────────────────────────────────────────────────────────────────────────
// Install: read the list the build wrote and take the whole app in one go. addAll is atomic —
// a half-populated cache is worse than none, because it opens and then breaks on one screen.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const res = await fetch('/precache.json', { cache: 'no-store' });
      if (!res.ok) return;                       // no manifest → stay push-only, break nothing
      const { buildId, files } = await res.json();
      const cache = await caches.open(CACHE_PREFIX + buildId);
      // ⚠️ NOT cache.addAll(). The Cache API stores a compressed response DECODED, but keeps its
      // `content-encoding: gzip` header — so on the way out the browser gunzips a body that is
      // already plain and the request dies with ERR_FAILED. Measured here: the shell loaded, then
      // its script and stylesheet both failed, i.e. a blank page in a shop. Fetch everything
      // first, then write, so the cache is still all-or-nothing.
      const entries = await Promise.all(files.map(async (url) => {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) throw new Error('precache ' + url + ' → ' + r.status);
        const headers = new Headers(r.headers);
        headers.delete('content-encoding');
        headers.delete('content-length');            // stale once the encoding header is gone
        // ⚠️ And `vary`. We store under a URL string, so the stored request carries no Origin
        // header — while the page's real request for a module script does. With `vary: Origin`
        // kept, the two never match, every asset misses the cache, and the app is blank offline
        // while the cache sits there full. Measured: the shell loaded, script and stylesheet
        // both ERR_FAILED. The URL is the identity here; nothing else may decide a hit.
        headers.delete('vary');
        return [url, new Response(await r.blob(), { status: r.status, statusText: r.statusText, headers })];
      }));
      for (const [url, response] of entries) await cache.put(url, response);
      // Take over at once instead of waiting for every tab to close. Safe because a cache is
      // keyed by build id: this worker only ever serves the bundle it just cached.
      await self.skipWaiting();
      await report({ ok: true, buildId, files: files.length });
    } catch (e) {
      // ⚠️ A silent catch here is how "the cache is simply empty" happens — the app looks
      // installed, opens online, and is blank in the shop. Failing to precache is legitimate
      // (offline during install, server restarting), so it must not throw; but it must be
      // SAYABLE. The page logs whatever arrives here.
      await report({ ok: false, error: String((e && e.message) || e) });
    }
  })());
});

// Activate: drop every older build's cache. Without this a phone accumulates one full copy of
// the app per release until the browser evicts the lot — usually at the least helpful moment.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const res = await fetch('/precache.json', { cache: 'no-store' });
      const keep = res.ok ? CACHE_PREFIX + (await res.json()).buildId : null;
      for (const key of await caches.keys()) {
        if (key.startsWith(CACHE_PREFIX) && key !== keep) await caches.delete(key);
      }
    } catch (_e) { /* keep what we have — an old shell beats no shell */ }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                                   // writes are stage 3
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                    // never touch third parties
  // ⚠️ /api and /receipts are deliberately NOT handled yet. Serving a stale API answer without
  // the UI saying so would show a shopping list from hours ago as if it were current, and that
  // is how you buy milk you already have. Data caching comes with its "Stand HH:MM" marker.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/receipts/')) return;

  // A navigation is the moment that decides whether the app opens. Network first, so a fresh
  // release is picked up immediately; the cached shell catches the case with no signal.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try { return await fetch(req); }
      catch (_e) {
        const hit = await caches.match('/index.html', { ignoreVary: true });
        return hit || Response.error();
      }
    })());
    return;
  }

  // Assets carry a content hash in their name, so a hit is by definition the right file and can
  // be served without asking the network.
  event.respondWith((async () => {
    // ignoreVary for the same reason we strip the header on the way in: belt and braces, because
    // a cache that silently never matches is indistinguishable from no cache at all.
    const hit = await caches.match(req, { ignoreVary: true });
    if (hit) return hit;
    try { return await fetch(req); } catch (_e) { return Response.error(); }
  })());
});
