// Minimal network-first service worker. Never serves a stale app shell when
// the network is up (Veneer's stale-bundle lesson); cache is a fallback for
// offline only. Bump CACHE_VERSION to invalidate.
const CACHE_VERSION = 'vp-v3';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  // The foreground app uses this network-only probe to compare the deployed
  // Vite bundle hash. Do not accumulate one cache entry per timestamp.
  if (url.searchParams.has('vp-bundle-check')) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? Response.error())),
  );
});

// Push is independent of an open app tab. Only same-origin hash links are accepted.
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let payload;
    try { payload = event.data.json(); } catch { return; }
    const href = typeof payload.href === 'string' && /^#\/(chat|bots)\//.test(payload.href) ? payload.href : '#/bots';
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some(client => client.focused && client.url.endsWith(href))) return;
    await self.registration.showNotification('Veneer', {
      body: ['A bot needs your input.', 'A bot needs help to continue.', 'A bot has finished work.'].includes(payload.body) ? payload.body : 'A bot has an update.',
      tag: String(payload.tag || 'veneer-bot').slice(0,100),
      data: { href }, icon: '/icons/icon-192.png',
    });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const href = event.notification.data?.href;
  const target = new URL(typeof href === 'string' && href.startsWith('#/') ? href : '#/bots', self.location.origin + '/').href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) { await existing.navigate(target); await existing.focus(); }
    else await self.clients.openWindow(target);
  })());
});
