# 0003 — One altitude truth: MSL meters, authored reference retained

**Status**: Accepted (2026-07-30)

## Decision

- **All calculation coordinates are meters MSL.** Physics, corridor, clearance,
  RF, rendering Z, and export all consume `resolvedMslM`. No calculation ever
  receives a launch-relative or AGL number.
- **The authored reference is retained.** Each altitude-bearing field stores
  what the pilot typed and in which frame: `launchRelative` (m above launch),
  `agl` (m above terrain at that point), or `msl`. The UI and mission brief
  display in the authored frame; resolution to MSL happens in one place
  (`src/domain/mission/altitude.js`).
- Resolution requirements: `launchRelative` needs `launch.elevationMslM`;
  `agl` needs a terrain sample at that latitude/longitude. **If the terrain
  sample is missing or stale, the altitude is unresolved** — the segment carries
  a validity flag and analysis reports it as a blocking unknown. Unknown terrain
  is never treated as elevation 0, and unknown clearance is never shown as
  clear (ADR 0008).
- **Vertical datum**: DEM elevations and exchange-format elevations (GPX `ele`,
  KML `absolute`) are treated as orthometric height (MSL/geoid). We do not mix
  WGS84 ellipsoidal heights; any source documented as ellipsoidal must be
  converted at the provider port or rejected with a named semantic loss.
- Re-resolution happens whenever launch elevation or the terrain snapshot
  changes; `resolvedMslM` carries the provenance of the terrain sample that
  resolved it.

## Why

Altitude bugs are the classic mission-planning failure: three frames in play
(pilot thinks launch-relative, terrain data is MSL, exports want relative-alt),
and every consumer converting independently guarantees drift. One conversion
site with retained authorship keeps the pilot's intent and the model's truth
simultaneously.

## Consequences

- `MissionDocumentV1` segments store `{ authored, reference, resolvedMslM }`
  (ADR 0002).
- The corridor contract (M2/M3) samples terrain in MSL and reports AGL
  clearance per sample.
- Export adapters map from MSL + authored reference to each format's frame and
  declare degradation when a frame doesn't exist in the target (R-EXPORT).
