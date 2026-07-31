# FPV Mission Planner — screen inventory

This inventory turns contact sheets 05–15 into a buildable product surface. A
sheet is a visual reference; the IDs below are the stable screen/state names the
application should use in tickets, routes, analytics, and QA.

## Product navigation

- **Field** — immediate weather, readiness, checklist, and live map.
- **Plan** — route authoring, leg editing, 2D/3D analysis, shot intent, and review.
- **Library** — missions, saved spots, imports, versions, and recovery.
- **Aircraft** — aircraft, battery instances, camera profiles, and calibration.

Inside **Plan**, keep `2D`, `3D`, `Analyze`, and `Review` as workspace modes—not
new top-level destinations. Selecting a waypoint, leg, subject, warning, or shot
opens a contextual inspector while preserving the map and current selection.

## Approved core screens — sheets 05–08

| ID | Screen | Required outcome |
|---|---|---|
| P-01 | Mission overview | Understand route, range, time, wind, and current verdict. |
| P-02 | Route map | Create/reorder waypoints, launch, subject, and return geometry. |
| P-03 | Leg editor | Set intent, altitude, speed, pitch, camera, and wind response for one leg. |
| P-04 | Terrain/link clearance | See AGL clearance and RF/Fresnel risk along the full route. |
| P-05 | Mission validation | Resolve actionable constraints and confirm final reserve. |
| W-01 | Weather now + forecast | Choose a safe, practical flight window. |
| W-02 | Wind by altitude | Compare surface and flight-level wind before authoring altitude. |
| W-03 | Heading exposure | See headwind, crosswind, groundspeed, and energy effects per heading. |
| W-04 | Wind map | Read restrained vectors/streamlines in direct route context. |
| T-01 | Tablet route studio | Author geometry with map-first split workspace. |
| T-02 | Shot inspector | Add subject, look line, framing, and shot intent to a leg. |
| T-03 | Energy + wind simulation | Inspect route timeline, reserve, and wind sensitivity. |
| T-04 | Final review | Present one verdict, evidence, fixes, and brief/export actions. |

## Newly extrapolated screens — sheets 09–15

| ID | Screen | Sheet | Required outcome |
|---|---|---:|---|
| O-01 | Welcome / choose mode | 09 | Start a field check, mission plan, analysis, or saved mission without setup friction. |
| O-02 | Location + permission | 09 | Confirm the actual planning location and explain why it is needed. |
| O-03 | Offline readiness | 09 | Verify app, terrain/3D, cached weather, and mission data before leaving coverage. |
| F-01 | Field Mode home | 09 | Read verdict, wind, timer, turn-home time, GPS, and offline status in sunlight. |
| L-01 | Mission library | 10 | Search/filter saved, imported, recent, and draft missions. |
| L-02 | Saved spot detail | 10 | Reuse terrain, default aircraft, notes, and current wind for a known location. |
| L-03 | Saved-spot forecast planner | 10 | Compare wind, gust, rain, and sunlight across days and flight heights. |
| L-04 | Import + version recovery | 10 | Validate an import, inspect history, restore autosaves, and quarantine corrupt data. |
| E-01 | Aircraft library | 11 | Choose a measured or estimated aircraft model with visible confidence. |
| E-02 | Battery-instance library | 11 | Track cycles, IR, temperature, health, and safe parallel pairing per physical pack. |
| E-03 | Camera + shot profiles | 11 | Define lens/FOV and reusable shot parameters with framing preview. |
| E-04 | Flight-log calibration | 11 | Compare predicted vs actual behavior and apply a reversible model revision. |
| 3D-01 | Orthographic terrain overview | 12 | Understand terrain, route height, dive/recovery legs, wind, and mission scale at a glance. |
| 3D-02 | Vertical route editor | 12 | Edit 3D waypoints, MSL/AGL altitude, pitch, speed, and clearance in terrain context. |
| 3D-03 | Camera volume editor | 12 | See subject, look line, frame plane, camera frustum, and shot direction. |
| 3D-04 | 3D mission envelope | 12 | Inspect terrain corridor, wind vectors, Fresnel/link blockage, and density altitude. |
| 3D-05 | Mountain conditions | 13 | Establish launch elevation, density altitude, winds aloft, and lift/power margin. |
| 3D-06 | Dive gates + pullout | 13 | Author ridge approach, dive gate, recovery gate, and bailout geometry. |
| 3D-07 | Dive dynamics | 13 | Verify descent, pullout load, pack sag, thermal margin, reserve, and RF continuity. |
| 3D-08 | Contingency review | 13 | Resolve a no-go condition or select an alternate recovery/abort route. |
| H-01 | Mission brief + checklist | 14 | Give the pilot a concise, acknowledged preflight contract for this mission. |
| H-02 | Export compatibility | 14 | Export GPX/KML/QGC/ArduPilot/INAV with explicit, format-specific data-loss warnings. |
| H-03 | Offline cache + freshness | 14 | Download/update a field region and distinguish current, stale, and unavailable data. |
| H-04 | Recovery + version history | 14 | Restore known-good saves and preserve raw/corrupt data for diagnosis. |
| DS-01 | Components + system states | 15 | Provide reusable tokens, controls, map/3D symbols, verdicts, and failure states. |

## Mandatory system states

Every data-backed screen must implement: loading, empty, partial, offline,
stale, permission denied, and recoverable error. Planning adds no terrain,
missing elevation, weather unavailable, invalid geometry, and unsaved changes.
3D adds WebGL unsupported, GPU/context loss, terrain tiles missing, and 2D
fallback. Import adds unsupported file, partial compatibility, validation errors,
quarantined data, and successful recovery.

## Responsive behavior

- **Phone:** one dominant task, map or form full-screen, inspector as bottom sheet,
  bottom navigation, primary actions within thumb reach.
- **Tablet:** persistent rail, map/canvas remains visible, contextual inspector at
  right, synchronized profile/timeline below when useful.
- **Field/readability:** 48 px minimum targets, high-contrast sunlight mode, no
  color-only verdicts, and wind/verdict visible without opening a panel.

