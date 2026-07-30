# 0004 — Map engine is an adapter; MapLibre + deck.gl is the 3D target

**Status**: Proposed (pending R-3D evidence + rendering spike; 2026-07-30)

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
