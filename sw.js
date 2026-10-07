/* PCW Inventory — service worker
   App shell is cached so the phone opens instantly and works in the freezer
   shed with no signal. API calls always go to the network; anything entered
   offline is queued in the page itself and replayed on reconnect. */

/* Bumping this name is what makes a phone drop the old shell and take the new
   one. It has to change whenever the files below change, or an update sits in
   the cache unused. */
const CACHE = 'pcw-inv-v2';
const SHELL = ['./', './index.html', './photos.js', './manifest.json',
               './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // never cache API posts
  if (req.url.indexOf('script.google.com') !== -1) return; // never cache the backend

  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
