/* PCW Inventory — service worker
   App shell is cached so the phone opens instantly and works in the freezer
   shed with no signal. API calls always go to the network; anything entered
   offline is queued in the page itself and replayed on reconnect. */

/* Bumping this name makes a phone drop the old shell and take the new one.
   v2 listed a photos.js that is not there; addAll refuses the whole list if
   one file is missing, so the worker never installed and offline mode died
   with it. v3 lists only files that exist, and the bump forces a clean
   re-install over the broken v2 state. v5 goes with the change below, so a
   phone sitting on an old page gets a clean start rather than holding it.
   v6 stops asking the browser's own cache for the page — see pageFirst. */
const CACHE = 'pcw-inv-v10';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png',
               './icon-maskable-512.png', './apple-touch-icon.png'];

/* How long to wait for the real page before falling back to the stored one.
   Long enough for a slow rural connection, short enough that nobody standing
   in the shed thinks the app has hung. */
const PAGE_WAIT_MS = 2500;

/* "Go and ask the server", not "whatever you have lying about". GitHub Pages
   sends the page with max-age=600, so an ordinary fetch can be answered out
   of the browser's own cache without the network being touched at all —
   which quietly turned network-first back into cache-first for up to ten
   minutes after every deploy. That is why a new version could sit published
   and still not appear on the phone. */
function fromServer(url) { return new Request(url, { cache: 'reload' }); }

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => fetch(fromServer(u)).then(r => c.put(u, r)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* The page itself, as opposed to the bits it loads. */
function isPage(req) {
  if (req.mode === 'navigate') return true;
  try { return /(^|\/)(index\.html)?$/.test(new URL(req.url).pathname); }
  catch (err) { return false; }
}

function keep(req, res) {
  if (res && res.status === 200 && res.type === 'basic') {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy));
  }
  return res;
}

/* Whatever we have, including the shell copy if this exact URL is a miss —
   a navigation can arrive as "…/pcw-inventory/" or "…/index.html". */
function stored(req) {
  return caches.match(req).then(hit => hit || caches.match('./index.html'));
}

/**
 * The page: network first.
 *
 * It used to be cache first, which is why a new version only appeared on the
 * SECOND open — the first one rendered yesterday's copy and quietly fetched
 * today's for next time. Asking the network first means a deploy lands the
 * moment the phone has signal, and the stored copy is still there the instant
 * the network is slow or gone, so the shed still works.
 */
function pageFirst(req) {
  return new Promise(resolve => {
    let settled = false;
    const done = r => { if (!settled && r) { settled = true; resolve(r); } };

    const timer = setTimeout(() => { stored(req).then(done); }, PAGE_WAIT_MS);

    // no-cache, not no-store: the browser still keeps the answer, it just has
    // to check with the server before serving it. One conditional request,
    // and a deploy is never more than that away.
    fetch(new Request(req, { cache: 'no-cache' })).then(res => {
      clearTimeout(timer);
      done(keep(req, res));
    }).catch(() => {
      clearTimeout(timer);
      stored(req).then(hit => done(hit || Response.error()));
    });
  });
}

/* Everything else: cache first, refreshed in the background. Icons and the
   manifest change about twice a year; waiting on the network for them would
   cost every open and buy nothing. */
function shellFirst(req) {
  return caches.match(req).then(hit => {
    const net = fetch(req).then(res => keep(req, res)).catch(() => hit);
    return hit || net;
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // never cache API posts
  if (req.url.indexOf('script.google.com') !== -1) return; // never cache the backend

  e.respondWith(isPage(req) ? pageFirst(req) : shellFirst(req));
});
