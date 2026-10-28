// UNP al Día — service worker
// Página y noticias: primero la red (siempre lo último), copia guardada si no hay señal.
const CACHE = 'unp-al-dia-v1';
const BASE = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const red = /\.(html|json)$|\/$/.test(url.pathname);
  if (red) {
    e.respondWith(fetch(e.request).then(r => {
      const copia = r.clone();
      caches.open(CACHE).then(c => c.put(e.request.url.split('?')[0], copia));
      return r;
    }).catch(() => caches.match(e.request.url.split('?')[0]).then(r => r || caches.match('index.html'))));
  } else {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      const copia = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); return res;
    })));
  }
});
