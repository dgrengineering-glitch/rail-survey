/* Rail Survey service worker – offline app shell.
   Bump VERSION (and the ?v= in index.html) on every release: a changed sw.js makes browsers install
   the new version, which re-downloads every file (bypassing the HTTP cache) into a fresh cache. */
const VERSION = 'rail-survey-v0.1.0';
const Q = '?v=0.1.0';
const SHELL = [
  './',
  './index.html',
  './styles.css' + Q,
  './vendor/jszip.min.js' + Q,
  './js/util.js' + Q,
  './js/db.js' + Q,
  './js/geo.js' + Q,
  './js/voice.js' + Q,
  './js/chainage.js' + Q,
  './js/export.js' + Q,
  './js/sync.js' + Q,
  './js/app.js' + Q,
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.all(SHELL.map((u) => fetch(new Request(u, { cache: 'reload' })).then((res) => {
        if (!res.ok) throw new Error('Precache failed for ' + u + ': ' + res.status);
        return c.put(u, res);
      }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('rail-survey-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'version' && event.source) event.source.postMessage({ version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only the app's own files are cached. Overpass, Google Apps Script and map links always go to the network.
  if (url.origin !== self.location.origin) return;

  // Page loads: serve the cached app shell instantly (works with no signal on the track).
  // Updates arrive through a new sw.js VERSION, which re-caches everything.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.open(VERSION).then((c) => c.match('./index.html').then((cached) => cached || fetch(req).catch(() => c.match('./'))))
    );
    return;
  }

  // Static assets: cache first, then network (caching same-origin successes).
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }))
  );
});
