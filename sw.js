// Elevate Inventory's service worker: the app installs to the home screen and
// still OPENS when the warehouse Wi-Fi drops (owner 11/3, "add to home screen,
// more reliable, app-esque"). Served by server.js with the build number filled
// in, so every deploy installs a fresh worker and clears the old copies.
//
// Rules:
//  - /api/* is never touched: stock counts, money and everything else from the
//    server always come live (a cached On Hand would be yesterday's numbers).
//    Scans made offline are already kept by the page's own offline queue.
//  - The app's own files (the page, its scripts, styles, icons) open from the
//    copy saved for THIS build, at once (owner 11/4: network-first made the
//    home-screen app feel slower than Chrome; iOS restarts a home-screen app
//    often, and each start waited on the ~1 MB page). A deploy changes this
//    file (the build number), so the browser installs the new worker, which
//    saves the new files; the page then offers "New version — tap to update"
//    (index.html) and reloads by itself when it's next hidden.
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

// The saved copy at once; the network only when this build has none yet.
function fromCache(req, key) {
  return caches.open(CACHE).then(c => c.match(key || req, { ignoreSearch: !!key }).then(hit => hit || fromNetwork(req, key)));
}
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

// A refresh (F5, pull-to-refresh: the browser marks it no-cache) asks for the
// live page (owner 11/4: F5 in the installed Chrome app only showed "New
// version ready" over the old page). If the server is on another build, this
// worker's saved files are dropped too, so the page's scripts come live with
// it, and the new worker is fetched. Offline or slow (4 s): the saved copy.
function freshPage(req) {
  const net = fetch(req).then(async (res) => {
    if (!res || !res.ok) return res;
    const m = (await res.clone().text()).match(/PAGE_BUILD = '([^']*)'/);
    if (m && m[1] !== BUILD) { await caches.delete(CACHE); self.registration.update().catch(() => {}); }
    else { const copy = res.clone(); caches.open(CACHE).then(c => c.put('/', copy)); }
    return res;
  });
  const saved = () => caches.match('/', { ignoreSearch: true });
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => saved().then(r => { if (r && !done) { done = true; resolve(r); } }), 4000);
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
    if (req.mode === 'navigate') return e.respondWith(req.cache === 'no-cache' || req.cache === 'reload' ? freshPage(req) : fromCache(req, '/'));
    if (SHELL.includes(url.pathname)) return e.respondWith(fromCache(req, url.pathname));
    return;
  }
  // Barcode library and fonts: fixed versions, so the saved copy is right.
  if (OUTSIDE.test(req.url)) e.respondWith(caches.match(req).then(hit => hit || fromNetwork(req)));
});
