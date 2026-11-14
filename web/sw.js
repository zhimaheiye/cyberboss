const CACHE = 'cyberboss-shell-v3-assistant-ui';
const NOTICES = 'cyberboss-notices-v1';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/', '/app.js', '/style.css', '/icon.svg', '/manifest.webmanifest'])));
  self.skipWaiting();
});
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('cyberboss-shell-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
let noticeChain = Promise.resolve();
function notify(data) {
  noticeChain = noticeChain.catch(() => {}).then(async () => {
    if (!data?.id) return;
    const cache = await caches.open(NOTICES);
    const key = new Request(`${self.location.origin}/notice/${encodeURIComponent(data.id)}`);
    if (await cache.match(key)) return;
    await self.registration.showNotification(data.title || 'CyberBoss', {
      body: data.body || '', tag: data.id, icon: '/icon.svg', data: { url: `/#message=${encodeURIComponent(data.id)}` },
    });
    await cache.put(key, new Response('shown'));
    const entries = await cache.keys();
    for (const old of entries.slice(0, Math.max(0, entries.length - 1000))) await cache.delete(old);
  });
  return noticeChain;
}
self.addEventListener('push', event => {
  let data; try { data = event.data.json(); } catch { return; }
  event.waitUntil(notify(data));
});
self.addEventListener('message', event => {
  if (event.data?.type === 'notify') event.waitUntil(notify(event.data.message));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(w => new URL(w.url).origin === target.origin);
    if (existing) { await existing.navigate(target.href); await existing.focus(); }
    else await self.clients.openWindow(target.href);
  })());
});
