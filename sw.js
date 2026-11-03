/* Offline shell: cache everything on install, serve cache-first so the app
   opens with no signal at all. Bump CACHE to ship an update. */
const CACHE = 'blockwright-v2';
const ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './vendor/three.min.js',
  './js/app.js', './js/worker.bundle.js', './js/worker.js', './js/litematic.js', './js/blocks.js', './js/projects.js',
  './icon-180.png', './icon-192.png', './icon-512.png'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;            // fonts etc: let them fail offline
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
