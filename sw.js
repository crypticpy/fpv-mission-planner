// FPV Mission Planner — service worker (DEV PATH ONLY).
//
// ============================================================================
// THE PRODUCTION WORKER IS GENERATED. `npm run build` emits dist/sw.js from
// scripts/generate-sw.mjs, which walks the build output for the precache list
// and derives the cache version from file content — the PRECACHE_URLS array
// below is NOT what ships. This file serves the no-build dev path
// (`python3 -m http.server` at the repo root), and its runtime logic — from
// the install listener down — is lifted verbatim into the generated worker,
// so caching and offline behaviour still have exactly one source of truth.
//
// Editing rules: change the fetch/install/activate logic here and the build
// inherits it. Adding an asset means adding a line to PRECACHE_URLS *for the
// dev path only*; forgetting to is no longer a production bug.
// ============================================================================
//
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

const CACHE_NAME = 'fpv-shell-v3';

const PRECACHE_URLS = [
  '.',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'src/app.js',
  'src/brief.js',
  'src/calibrate.js',
  'src/charts.js',
  'src/data.js',
  'src/drift.js',
  'src/flightlog.js',
  'src/forms.js',
  'src/geo.js',
  'src/map.js',
  'src/mission-bridge.js',
  'src/mission-rail.js',
  'src/packinstances.js',
  'src/physics.js',
  'src/registry.js',
  'src/rf.js',
  'src/route.js',
  'src/schema.js',
  'src/share.js',
  'src/shell.js',
  'src/state.js',
  'src/store.js',
  'src/sweep.js',
  'src/terrain.js',
  'src/themes.js',
  'src/thrust.js',
  'src/units.js',
  'src/weather.js',
  'src/windprofile.js',
  'src/domain/mission/altitude.js',
  'src/domain/mission/mission-migrations.js',
  'src/domain/mission/mission-reducer.js',
  'src/domain/mission/mission-schema.js',
  'src/infrastructure/persistence/indexeddb-store.js',
  'src/infrastructure/persistence/memory-store.js',
  'src/infrastructure/persistence/mission-repository.js',
  'src/catalog/classes.js',
  'src/catalog/drones.js',
  'src/catalog/manufacturers.js',
  'src/catalog/batteries.js',
  'src/catalog/payloads.js',
  'src/catalog/weather.js',
  'src/catalog/scenarios.js',
  'src/render/batterychecks.js',
  'src/render/brief.js',
  'src/render/calibration.js',
  'src/render/comparison.js',
  'src/render/controls.js',
  'src/render/dashboard.js',
  'src/render/dom.js',
  'src/render/droneform.js',
  'src/render/flightlog.js',
  'src/render/forecast.js',
  'src/render/format.js',
  'src/render/live.js',
  'src/render/missions.js',
  'src/render/packinstances.js',
  'src/render/route.js',
  'src/render/session.js',
  'src/render/share.js',
  'src/render/spots.js',
  'src/render/terrain.js',
  'src/render/thrustfield.js',
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
  // Both Open-Meteo hosts: `api` for the forecast, `archive-api` for the hour a
  // logged flight actually happened in.
  if (url.hostname.endsWith('open-meteo.com')) {
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
