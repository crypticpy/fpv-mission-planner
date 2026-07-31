# 0004 — Map engine is an adapter; MapLibre + deck.gl is the 3D target

**Status**: Accepted (spike gate passed 2026-07-30; see Evidence below)

## Decision

- The map becomes a **map-engine adapter** behind a stable interface
  (`presentation/map/map-adapter.js`) plus a **layer registry**: independent
  layers for route, corridor, terrain, constraints, wind, subjects, and camera
  geometry. Layers render **only** from the `AnalysisSnapshot` and the mission
  document; no layer imports physics, fetches data, or writes mission state.
  Edits raise commands (ADR 0002).
- Current Leaflet stays as the 2D adapter — it works, it's vendored, and 2D
  remains the fallback for non-WebGL2 environments and reduced-motion users.
- The 3D target is **MapLibre GL JS terrain + deck.gl overlays** with explicit
  MSL Z on route and hazard vertices. Adoption is gated on the R-3D research
  doc and a committed spike proving: correct depth/occlusion of
  explicit-elevation paths against 3D terrain (a route behind a ridge is
  hidden), picking, and an acceptable bundle. deck.gl documents that
  zero-elevation data sits at sea level rather than draping — the spike must
  prove our explicit-Z approach renders above terrain in ridge and valley
  fixtures before any production integration.

## Why

`js/map.js` currently owns Leaflet setup, route authoring, wind controls,
particles, range charts, terrain/radio drawings, and spot markers. A 3D
renderer bolted onto that either duplicates domain work or becomes a second
monolith. An adapter + registry makes 2D and 3D two consumers of the same
snapshot, and makes the map engine replaceable without touching domain code.

## Consequences

- M1/M2 strip route state and domain calculations out of `map.js` before any
  3D work starts.
- The wind particles stop being decorative: they become a layer fed by the
  modeled local wind field (M5) or they are removed from the 3D path.
- This ADR flips to Accepted (or is amended to a different engine) when the
  spike's exit gate passes; production 3D integration before that is blocked.

## Evidence (occlusion spike, 2026-07-30)

`spike/occlusion/` + `tests/browser/spike-occlusion.spec.js`, run with
`npm run spike:occlusion` — fully offline, synthetic terrarium DEM tiles,
pixel-probe assertions, 19 passed / 2 skipped by design. All four gate proofs
pass: explicit-MSL-Z paths render above terrain in ridge and valley fixtures
(a z=0 control path is correctly buried, ruling out both the sea-level pitfall
and draping), a path behind a 140 m ridge is occluded by the terrain depth
buffer, and `overlay.pickObject()` resolves the path at a painted pixel.
Versions proven: maplibre-gl 5.24.0, @deck.gl/{core,layers,mapbox} 9.3.7.

## Conditions of acceptance

- **Interleaved mode only.** `MapboxOverlay({interleaved: true})` draws inside
  MapLibre's render pass against the terrain depth buffer. Overlaid mode is
  disqualified: it composites a separate canvas and paints straight through
  terrain — it cannot occlude, which was the whole question.
- **Pin maplibre-gl to 5.x** until @deck.gl/mapbox supports maplibre 6: v6
  removed the `map.transform` properties deck reads (first render throws), and
  v6's runtime-resolved worker URL breaks under bundling.
- **The 3D scene is a lazy-loaded chunk**, fetched on first use of the 3D
  toggle. The libraries cost ~442 kB gzip — 3× the entire current app — and do
  not enter the service-worker shell precache; offline 3D is an M8 decision.
- Integration constraints the spike proved (violate any and the failure is
  silent): add the overlay only after `map.once('idle')` following
  `setTerrain`, or deck's snapshotted view state leaves `project()`/
  `pickObject()` wrong while the picture looks right; interleaved mode wires no
  pointer handlers, so picking needs an explicit `map.on('click')` →
  `overlay.pickObject()` bridge; `info.coordinate` is a z=0 ground-plane
  unprojection, never the picked vertex's 3D position; set `maxPitch`
  explicitly (default 60 is below every useful terrain camera); billboarded
  path ribbons span real world-space height, so above-terrain checks need a
  margin proportional to screen width, not a fixed metre value.
