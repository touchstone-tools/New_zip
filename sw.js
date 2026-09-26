/*!
 * ZIP Checker — service worker
 *
 * Caches ONLY the application shell (HTML/CSS/JS/icons) so the app opens
 * instantly and keeps working through network drops.
 *
 * The ZIP dataset is deliberately NOT handled here: cross-origin requests
 * (OpenSheet / Google) pass straight through to the network, and the data
 * layer (IndexedDB, stale-while-revalidate) decides what is fresh.
 *
 * Strategy for shell files: stale-while-revalidate — serve from cache
 * immediately, refresh the cached copy in the background. Bump VERSION to
 * force an atomic refresh of every shell file.
 */
'use strict';

var VERSION = 'zip-checker-shell-v1.0.0';
var SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './data-worker.js',
  './manifest.json',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(VERSION).then(function (cache) {
      // cache: 'reload' bypasses the HTTP cache so a new VERSION gets fresh files.
      return cache.addAll(SHELL.map(function (url) { return new Request(url, { cache: 'reload' }); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== VERSION && key.indexOf('zip-checker-shell-') === 0) return caches.delete(key);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // data endpoints: never intercepted

  var isNavigation = req.mode === 'navigate';
  // Normalise navigations (any query string) to the cached shell document.
  var cacheKey = isNavigation ? './index.html' : req;

  event.respondWith(
    caches.open(VERSION).then(function (cache) {
      return cache.match(cacheKey, { ignoreSearch: isNavigation }).then(function (cached) {
        var network = fetch(req).then(function (res) {
          if (res && res.ok && res.type === 'basic' && !res.redirected) {
            cache.put(cacheKey, res.clone());
          }
          return res;
        });

        if (cached) {
          // Revalidate in the background; ignore failures (offline).
          event.waitUntil(network.catch(function () {}));
          return cached;
        }
        return network.catch(function () {
          if (isNavigation) return cache.match('./index.html');
          return Response.error();
        });
      });
    })
  );
});
