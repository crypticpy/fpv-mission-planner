# FPV Mission Planner — developer asset manifest

## Master screen sheets

Full-resolution PNG masters live in this folder. Compressed WebP review copies
live in `../compressed/`. Use the numbered order as the design review sequence:

1. `05-deep-mobile-mission-flow.png`
2. `06-mobile-wind-intelligence.png`
3. `07-tablet-mission-studio.png`
4. `08-wind-aware-cross-device-system.png`
5. `09-first-run-field-readiness.png`
6. `10-mission-spots-library.png`
7. `11-equipment-calibration-library.png`
8. `12-orthographic-3d-terrain-planner.png`
9. `13-mountain-dive-high-altitude-flow.png`
10. `14-mission-delivery-offline-recovery.png`
11. `15-developer-component-state-kit.png`

These generated masters communicate layout, hierarchy, behavior, and visual
direction. Treat exact map imagery and rendered typography as reference—not as
production raster assets.

## Components developers should create

- `WindRibbon`: speed, compass direction, altitude, gust, freshness, and impact.
- `VerdictCard`: GO, CAUTION, NO-GO, UNKNOWN; consequence and next action required.
- `MissionSummary`: distance, duration, turn-home, landing state, and reserve.
- `MapToolbar`: 2D/3D mode, layers, center, fit route, and selection tools.
- `ContextInspector`: waypoint, leg, shot, warning, aircraft, or pack variant.
- `ElevationProfile`: terrain, MSL/AGL route, clearance band, selection sync.
- `RouteTimeline`: segment intent, wind, energy, link, thermal, and reserve tracks.
- `DataFreshness`: source, timestamp/age, cached/current/stale/unavailable state.
- `ConfidenceBadge`: measured/estimated provenance and model confidence.
- `ExportCompatibilityCard`: supported, degraded, unsupported, and lost fields.
- `RecoveryEntry`: manual save, autosave, recovered version, or quarantine state.

## Map and orthographic 3D symbols

Build symbols as code-driven SVG/canvas/WebGL assets so they scale with zoom and
sunlight mode: launch/home, waypoint, selected waypoint, subject, recovery,
bailout, approach/dive/pullout gates, route intent colors, altitude stem, ground
foot, safe-altitude corridor, terrain-clearance heat ribbon, wind vector,
camera look line, camera frustum/frame plane, radio line, Fresnel volume, and
occluded link segment.

## Orthographic 3D interaction contract

- Projection: `Orthographic`, `Perspective`, and `Top` modes.
- Azimuth: north-locked, route-aligned, or free rotation.
- Navigation: fit route, orbit, pan, zoom, reset, and selected-leg focus.
- Terrain: 1.0–2.5× exaggeration, contours, satellite/style layer, tile status.
- Geometry: direct manipulation of 3D waypoints plus vertical altitude stems.
- Altitude: explicit AGL/MSL reference and synchronized numeric/profile editing.
- Analysis: clearance corridor, wind by altitude, density altitude, energy,
  camera volume, radio line, and first-Fresnel obstruction.
- Safety: every no-go overlay links to a specific editor or suggested fix.
- Fallback: preserve route authoring and analysis in 2D when 3D is unavailable.

### Engineering note

The current code already provides MapLibre terrain, deck.gl route layers,
waypoint picking/dragging, terrain exaggeration, subject/shot lines, camera
frustums, AGL/MSL-aware analysis, terrain clearance, and RF/Fresnel analysis in:

- `src/presentation/map/scene3d/scene.js`
- `src/presentation/map/scene3d/scene-layers.js`
- `src/presentation/map/scene3d/scene-geometry.js`
- `src/presentation/map/segment-editor.js`
- `src/presentation/map/segment-inspector.js`

True parallel projection is a new rendering requirement. Validate the engine
path before implementation—e.g. a dedicated deck.gl orthographic planning view
sharing mission geometry with the MapLibre terrain view. Do not label a normal
perspective view “Orthographic.” The projection toggle should preserve route,
selection, layers, azimuth, and inspector state.

## Data and accessibility requirements

- Centralize palette/type/spacing/elevation as tokens; sheet 15 is the visual index.
- Do not encode safety by color alone: pair icon, text label, severity, and action.
- Use locale-aware units while storing canonical values; never mix MSL and AGL
  without the reference beside the value.
- Include source and age on weather, terrain, calibration, and imported data.
- Persist drafts locally and version destructive/derived model changes.
- Provide accessible names for map tools and a non-map list/editor for every
  waypoint, warning, and route segment.

