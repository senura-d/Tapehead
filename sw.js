'use strict';

// Offline support for the hosted web version. Network first, so a new release shows up on the
// next load; the cached copy is only used when there is no connection.
const CACHE = 'tapehead-v1';
const FILES = [
  "./",
  "index.html",
  "manifest.json",
  "css/app.css",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "js/vendor/lame.min.js",
  "js/util.js",
  "js/db.js",
  "js/kit.js",
  "js/fx.js",
  "js/fx2.js",
  "js/worklets.js",
  "js/stretch.js",
  "js/engine.js",
  "js/playlist.js",
  "js/rack.js",
  "js/pianoroll.js",
  "js/panels.js",
  "js/automix.js",
  "js/home.js",
  "js/app.js",
  "js/app2.js"
];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
