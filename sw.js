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
// inherits it. The PRECACHE_URLS list below is generated too (see the comment
// above it), so this file no longer carries a hand-maintained asset list.
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

const CACHE_NAME = 'fpv-shell-v12';

/* GENERATED LIST — do not edit between the brackets by hand.
   scripts/generate-dev-sw.mjs derives it from the static shell (index.html,
   the manifest, css/, vendor/, icons/) plus the ESM import graph of
   src/app.js, static and dynamic imports both; `npm run check` fails when it
   drifts, and re-running the script fixes it. M6's lazily imported compiler +
   adapters (ADR 0010) are therefore included: ~40 kB gzip of pure text
   handling, exactly what a pilot at a trailhead needs to hand a mission to a
   radio's own app with no signal.

   Nothing from src/presentation/map/scene3d/ — deliberately, and the generated
   production worker excludes its built chunk for the same reason (ADR 0004).
   The 3D scene is MapLibre and deck.gl, ~442 kB gzip against the ~150 kB of
   everything else, and it exists behind a button most pilots will never press.
   Precaching it would spend the whole offline budget on the one feature that
   cannot work offline anyway — the terrain and imagery it draws are network
   tiles. The 2D map modules are precached and are the fallback. */
const PRECACHE_URLS = [
  '.',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'src/analysis-host.js',
  'src/app.js',
  'src/application/analysis/analysis-contracts.js',
  'src/application/analysis/analyze.js',
  'src/application/analysis/constraints.js',
  'src/application/analysis/fix-links.js',
  'src/application/analysis/route-checks.js',
  'src/application/analysis/vertical-flight.js',
  'src/application/analysis/wind-advisory.js',
  'src/application/terrain/elevation-cache.js',
  'src/application/terrain/sample-corridor.js',
  'src/application/terrain/sample-grid.js',
  'src/application/terrain/terrain-contracts.js',
  'src/brief.js',
  'src/calibrate.js',
  'src/catalog/batteries.js',
  'src/catalog/cameras.js',
  'src/catalog/classes.js',
  'src/catalog/drones.js',
  'src/catalog/manufacturers.js',
  'src/catalog/payloads.js',
  'src/catalog/scenarios.js',
  'src/catalog/weather.js',
  'src/charts.js',
  'src/components/data-freshness.js',
  'src/components/elevation-profile.js',
  'src/components/icons.js',
  'src/components/mission-summary.js',
  'src/components/review-panel.js',
  'src/components/route-timeline.js',
  'src/components/system-state.js',
  'src/components/verdict-card.js',
  'src/components/wind-ribbon.js',
  'src/data.js',
  'src/domain/camera.js',
  'src/domain/fresnel.js',
  'src/domain/geo.js',
  'src/domain/mission/altitude.js',
  'src/domain/mission/compile.js',
  'src/domain/mission/mission-migrations.js',
  'src/domain/mission/mission-reducer.js',
  'src/domain/mission/mission-schema.js',
  'src/domain/mission/scene-commands.js',
  'src/domain/mission/scene-schema.js',
  'src/domain/physics.js',
  'src/domain/route.js',
  'src/domain/terrain/terrain-features.js',
  'src/domain/units.js',
  'src/domain/vertical.js',
  'src/domain/wind/regime.js',
  'src/domain/wind/terrain-forcing.js',
  'src/drift.js',
  'src/flightlog.js',
  'src/forms.js',
  'src/infrastructure/elevation/open-meteo-elevation.js',
  'src/infrastructure/export/adapter-contracts.js',
  'src/infrastructure/export/ardupilot-wpl.js',
  'src/infrastructure/export/gpx.js',
  'src/infrastructure/export/import-router.js',
  'src/infrastructure/export/inav-mission.js',
  'src/infrastructure/export/kml.js',
  'src/infrastructure/export/qgc-plan.js',
  'src/infrastructure/export/xml.js',
  'src/infrastructure/persistence/evidence-repository.js',
  'src/infrastructure/persistence/indexeddb-store.js',
  'src/infrastructure/persistence/memory-store.js',
  'src/infrastructure/persistence/mission-repository.js',
  'src/interop.js',
  'src/mission-bridge.js',
  'src/mission-commands.js',
  'src/packinstances.js',
  'src/presentation/map/advisory-panel.js',
  'src/presentation/map/footprint-panel.js',
  'src/presentation/map/layer-registry.js',
  'src/presentation/map/layers/advisory-layer.js',
  'src/presentation/map/layers/footprint-layer.js',
  'src/presentation/map/layers/launch-layer.js',
  'src/presentation/map/layers/route-layer.js',
  'src/presentation/map/layers/spots-layer.js',
  'src/presentation/map/layers/subject-layer.js',
  'src/presentation/map/layers/wind-layer.js',
  'src/presentation/map/leaflet-adapter.js',
  'src/presentation/map/map-view.js',
  'src/presentation/map/segment-editor.js',
  'src/presentation/map/segment-inspector.js',
  'src/presentation/map/tile-sources.js',
  'src/registry.js',
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
  'src/render/update-notice.js',
  'src/rf.js',
  'src/schema.js',
  'src/share.js',
  'src/shell.js',
  'src/state.js',
  'src/store.js',
  'src/sweep.js',
  'src/terrain.js',
  'src/themes.js',
  'src/thrust.js',
  'src/weather.js',
  'src/windprofile.js',
  'vendor/leaflet/leaflet-src.esm.js',
  'vendor/fonts/fonts.css',
  'vendor/fonts/ibm-plex-sans-latin.woff2',
  'vendor/fonts/space-grotesk-latin.woff2',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/leaflet.css',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon.svg',
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
