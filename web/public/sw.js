// Minimal network-first service worker. Never serves a stale app shell when
// the network is up (Veneer's stale-bundle lesson); cache is a fallback for
// offline only. Bump CACHE_VERSION to invalidate.
const CACHE_VERSION = 'vp-v5';

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
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // A bot is calling: name the caller, and let the tap open the call in the app.
    if (payload.kind === 'call' && typeof payload.href === 'string' && /^#\/answer-call\/[\w%.-]{1,200}$/.test(payload.href)) {
      const caller = typeof payload.caller === 'string' ? payload.caller.replace(/[^\p{L}\p{N} .'’&-]/gu, '').slice(0, 60).trim() : '';
      await self.registration.showNotification(caller ? `${caller} is calling` : 'A bot is calling', {
        body: 'Tap to answer the question.', tag: 'veneer-bot-call', renotify: true,
        data: { href: payload.href }, icon: '/icons/icon-192.png',
      });
      return;
    }
    // A calendar reminder. An open, focused Veneer already shows its own popup.
    if (payload.kind === 'calendar' && typeof payload.occurrenceKey === 'string') {
      if (windows.some(client => client.focused)) return;
      const clean = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').slice(0, max).trim() : '';
      const join = typeof payload.joinUrl === 'string' && /^https:\/\/[^\s<>"']+$/.test(payload.joinUrl) ? payload.joinUrl : null;
      await self.registration.showNotification(clean(payload.title, 120) || 'Calendar reminder', {
        body: clean(payload.body, 200), tag: clean(payload.tag, 200) || 'veneer-calendar', renotify: true, requireInteraction: true,
        icon: '/icons/icon-192.png',
        data: { calendar: payload.occurrenceKey.slice(0, 1200), join },
        actions: [...(join ? [{ action: 'join', title: 'Join' }] : []), { action: 'snooze', title: 'Snooze 5 min' }, { action: 'dismiss', title: 'Dismiss' }],
      });
      return;
    }
    const href = typeof payload.href === 'string' && /^#\/(chat|bots)\//.test(payload.href) ? payload.href : '#/bots';
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
  const calendar = event.notification.data?.calendar;
  if (typeof calendar === 'string') {
    event.waitUntil((async () => {
      const join = event.notification.data?.join;
      if (event.action === 'snooze' || event.action === 'dismiss' || event.action === 'join') {
        // Shared with every device: the reminder clears everywhere.
        await fetch('/api/master-calendar/reminders', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ occurrenceKey: calendar, action: event.action === 'snooze' ? 'snooze' : 'dismiss' }),
        }).catch(() => {});
      }
      if (event.action === 'join' && typeof join === 'string') { await self.clients.openWindow(join); return; }
      if (event.action === 'snooze' || event.action === 'dismiss') return;
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
      if (existing) await existing.focus();
      else await self.clients.openWindow(new URL('#/', self.location.origin + '/').href);
    })());
    return;
  }
  const href = event.notification.data?.href;
  const target = new URL(typeof href === 'string' && href.startsWith('#/') ? href : '#/bots', self.location.origin + '/').href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) { await existing.navigate(target); await existing.focus(); }
    else await self.clients.openWindow(target);
  })());
});
