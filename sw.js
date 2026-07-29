// FPV Mission Planner — service worker.
// Stale-while-revalidate app shell: the tool still opens instantly at a
// trailhead with one bar of LTE (or none), while every online visit quietly
// refreshes the cache so the next load runs the newest deploy — there is no
// build step to stamp cache versions, so plain cache-first would pin users
// to the first version they ever downloaded. Network-first with cache
// fallback for the weather API so the last fetched payload survives offline.
// Map tiles are never cached — respect the tile providers' usage policies
// and let them fail offline; the app already handles tile failure.
//
// Paths are relative to this file's scope (the app can live at "/" locally
// or at a GitHub Pages subpath) — never use a leading "/".

const CACHE_NAME = 'fpv-shell-v1';

const PRECACHE_URLS = [
  '.',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/charts.js',
  'js/data.js',
  'js/map.js',
  'js/physics.js',
  'js/shell.js',
  'js/themes.js',
  'js/units.js',
  'js/weather.js',
  'vendor/leaflet/leaflet-src.esm.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/fonts/fonts.css',
  'vendor/fonts/ibm-plex-sans-latin.woff2',
  'vendor/fonts/space-grotesk-latin.woff2',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never touch map tile providers — let them fail offline.
  if (url.hostname.endsWith('arcgisonline.com') || url.hostname.endsWith('openstreetmap.org')) {
    return;
  }

  // Weather API: network-first, cache fallback (keeps the last live payload).
  // Only OK responses overwrite the cached payload — a 429/500 must not
  // clobber the last-good weather the offline fallback exists to serve.
  if (url.hostname === 'api.open-meteo.com') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || Response.error()))
    );
    return;
  }

  // App shell and same-origin assets: stale-while-revalidate.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const refresh = fetch(request)
          .then((response) => {
            if (response.ok && response.type === 'basic') {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || refresh;
      })
    );
  }
});
