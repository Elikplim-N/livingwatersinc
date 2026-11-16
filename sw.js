// Minimal service worker: makes the apps installable and keeps the shell
// (logo, styles) available on a weak connection. API calls always go to the network.
const CACHE = 'lwi-shell-v1';
const SHELL = ['/app.css', '/img/logo-192.png', '/img/logo-96.png', '/img/favicon-64.png', '/division.geojson'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Pages: network first, fall back to the last copy when offline
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
    }).catch(() => caches.match(e.request)));
    return;
  }
  // Static files: answer from cache straight away, refresh the copy in the background (updates arrive on next open)
  e.respondWith(caches.match(e.request).then((hit) => {
    const fresh = fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    });
    return hit ? (fresh.catch(() => hit), hit) : fresh;
  }));
});
