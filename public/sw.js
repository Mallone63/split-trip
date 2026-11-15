// Push-only worker: no asset cache, so releases and invite URLs stay fresh.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { /* Always show a visible notification on iOS. */ }
  const fallback = new URL('./', self.registration.scope).href;
  let url = fallback;
  try { const target = new URL(message.data?.url || fallback); if (target.origin === self.location.origin && target.pathname.startsWith(new URL(self.registration.scope).pathname)) url = target.href; } catch {}
  event.waitUntil(self.registration.showNotification(message.title || 'Split Trip', {
    body: message.body || 'В поездке появились изменения', tag: message.tag || 'split-trip',
    icon: new URL('icon-192.png', self.registration.scope).href,
    badge: new URL('icon-192.png', self.registration.scope).href,
    data: { url },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || './', self.registration.scope);
    if (target.origin !== self.location.origin || !target.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const sameTrip = windows.find(client => new URL(client.url).pathname === target.pathname && new URL(client.url).searchParams.get('trip') === target.searchParams.get('trip'));
    if (sameTrip) { await sameTrip.navigate(target.href); await sameTrip.focus(); }
    else await self.clients.openWindow(target.href);
  })());
});
