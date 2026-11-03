// Elevate Inventory's service worker: the app installs to the home screen and
// still OPENS when the warehouse Wi-Fi drops (owner 11/3, "add to home screen,
// more reliable, app-esque"). Served by server.js with the build number filled
// in, so every deploy installs a fresh worker and clears the old copies.
//
// Rules:
//  - /api/* is never touched: stock counts, money and everything else from the
//    server always come live (a cached On Hand would be yesterday's numbers).
//    Scans made offline are already kept by the page's own offline queue.
//  - The app's own files (the page, its scripts, styles, icons) are NETWORK
//    FIRST: a deploy shows up on the next load; the saved copy is only used
//    when the network is down or takes more than a few seconds for the page.
const BUILD = '__BUILD__';
const CACHE = 'elevate-' + BUILD;
const SHELL = ['/', '/look2.css', '/dash2.js', '/onhand2.js', '/palette.js', '/tablet.js', '/vendor/bwip-js.min.js',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png'];
// Outside files the page loads (barcode drawing, fonts): kept for offline too.
const OUTSIDE = /^https:\/\/(cdn\.jsdelivr\.net\/npm\/jsbarcode|fonts\.googleapis\.com|fonts\.gstatic\.com)/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('elevate-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function fromNetwork(req, key, waitMs) {
  const net = fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key || req, copy)); }
    return res;
  });
  const saved = () => caches.match(key || req, { ignoreSearch: !!key });
  if (!waitMs) return net.catch(() => saved().then(r => r || Promise.reject(new Error('offline'))));
  // The page: wait a few seconds for the network, then show the saved copy.
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => saved().then(r => { if (r && !done) { done = true; resolve(r); } }), waitMs);
    net.then(r => { if (!done) { done = true; clearTimeout(t); resolve(r); } })
       .catch(() => saved().then(r => { if (done) return; done = true; clearTimeout(t); r ? resolve(r) : reject(new Error('offline')); }));
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
    if (req.mode === 'navigate') return e.respondWith(fromNetwork(req, '/', 4000));
    if (SHELL.includes(url.pathname)) return e.respondWith(fromNetwork(req));
    return;
  }
  if (OUTSIDE.test(req.url)) e.respondWith(fromNetwork(req));
});
