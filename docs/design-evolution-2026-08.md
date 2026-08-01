# Design evolution M9–M17 — the four-destination product

**Status: active. This is the tracking document for the next product evolution.**
Approved 2026-07-31. Source of truth for scope is
`design-concepts/round-2/final/SCREEN-INVENTORY.md` (screen IDs, required
outcomes, mandatory system states) and `ASSET-MANIFEST.md` (components, symbols,
orthographic 3D contract). This document adds the have/tweak/new gap analysis,
the milestone sequence, the **feature-preservation map**, and the branch
strategy. Check items off here as milestones land.

## Vision

Rebuild the app shell around four top-level destinations — **Field / Plan /
Library / Aircraft** — on every form factor, **including desktop** (left-hand
navigation rail on wide screens, bottom dock on phones, icon rail on tablets).
Inside Plan, `2D / 3D / Analyze / Review` are workspace modes, not
destinations. Selecting a waypoint, leg, subject, warning, or shot opens a
contextual inspector while preserving the map and selection. Wind is
persistent: a compact WindRibbon everywhere, expanded per task. Screens are
paged and viewport-fit — no long scrolling pages.

## Non-negotiable: zero feature loss

**No existing feature is removed by this evolution.** M9 re-homes every current
surface intact under the new navigation (lift-and-shift), and each destination
milestone then redesigns its surfaces in place. A milestone is not done if any
feature in the preservation map below is missing or degraded.

### Feature-preservation map (current surface → new home)

| Current feature | Lives today | New home |
|---|---|---|
| Route + loiter authoring (waypoints, launch, subject) | Map view | Plan → 2D (P-02) |
| Segment inspector + shot editor (M7) | Map view | Plan → ContextInspector (P-03, T-02) |
| Terrain + RF/Fresnel along outbound leg | Map view | Plan → Analyze (P-04) |
| Range vs heading chart | Map view | Plan → Analyze wind (seed of W-03) |
| Mission footprint (wind-shaped rings) | Map view | Plan → 2D overlay + W-03 |
| Wind particle animation | Map view | Plan → 2D/W-04 wind map layer |
| Mountain-flow advisory + layers + legend | Map + dashboard | Plan → Analyze; deepens into 3D-05 (M16) |
| 3D mission scene (MapLibre + deck.gl) | Map view | Plan → 3D mode (basis of 3D-01…04) |
| Saved spots | Map view | Library → L-02 |
| Saved missions (save/load) | Rail | Library → L-01 |
| Import GPX/KML/QGC/ArduPilot/INAV + loss report | Rail/brief | Library → L-04 |
| Share codes (drones, packs, flights) | Rail | Library → L-04 import/export |
| Spot forecast | Dashboard | Library → L-03 forecast planner |
| Live weather (Open-Meteo) + manual wind/temp + presets | Rail | Field + Plan wind system (W-01); manual override kept |
| Mission params (distance, speed, reserve…) | Rail | Plan → mission settings + MissionSummary |
| Session planner (multi-pack day) | Dashboard | Field (day-of flying) |
| Provenance / "What this was computed from" | Dashboard | DataFreshness + Plan → Review evidence |
| Update notice, offline/PWA | Shell | Shell (unchanged), surfaced in O-03/H-03 |
| Mission brief export (evidence + redaction) | Dashboard/brief | Plan → Review (H-01) |
| Power vs airspeed chart | Dashboard | Aircraft → aircraft analysis (E-01 detail) |
| Cruise speed trade-off chart | Dashboard | Aircraft → aircraft analysis (E-01 detail) |
| Mission profile chart | Dashboard | Plan → Analyze (feeds RouteTimeline) |
| Wind sensitivity chart | Dashboard | Plan → Analyze (T-03 simulation) |
| Battery shoot-out comparison table | Dashboard | Aircraft → E-02 comparison |
| Battery checks + pack identification ("Which pack is this?") | Rail/dashboard | Aircraft → E-02 |
| Battery manufacturers + add battery | Rail | Aircraft → E-02 |
| Pack instances (cycles, IR, health) | Dashboard | Aircraft → E-02 |
| Add drone / custom drones | Rail | Aircraft → E-01 |
| Camera catalog + shot intents (M7) | Segment editor | Aircraft → E-03 profiles + Plan shot inspector |
| Log a flight + calibrate-from-flight + drift panel | Rail/dashboard | Aircraft → E-04 |
| Themes (5 + auto) | Shell | Shell; tokens.json joins as new default dark theme |

## Gap analysis (have / tweak / new)

Engines mostly exist (M0–M8); surfaces are the gap. Verified against code:
a verdict concept already exists in `src/application/analysis/{analyze,route-checks}.js`;
`src/presentation/map/{segment-editor,segment-inspector}.js` and `scene3d/` match
the ASSET-MANIFEST engineering note; quarantine already exists in the
persistence layer; `weather.js`/`windprofile.js` already expose hourly and
multi-altitude data.

- **Have (re-home + reskin):** P-02 route map, E-01…E-04 equipment surfaces,
  import/export machinery, offline/evidence/freshness (M8), verdict + constraint
  engine, terrain/Fresnel analysis, camera catalog.
- **Tweak (new components over existing data):** P-01/P-03/P-04/P-05,
  T-01…T-04 tablet studio, W-01…W-04 wind suite, H-02 export compatibility UI,
  H-03 offline cache UI, L-01…L-03 library surfaces.
- **New (real engineering):**
  - Four-destination shell on all form factors (M9).
  - The 11 shared components (WindRibbon, VerdictCard, MissionSummary,
    MapToolbar, ContextInspector, ElevationProfile, RouteTimeline,
    DataFreshness, ConfidenceBadge, ExportCompatibilityCard, RecoveryEntry)
    plus a reusable system-state framework (loading/empty/partial/offline/
    stale/permission-denied/recoverable-error).
  - **Fix-linking engine**: every caution/no-go carries a machine-actionable
    remedy targeting a specific editor ("Raise recovery leg", current → after
    preview).
  - **True orthographic 3D** (see engineering note below).
  - **Autosave + version history** in the mission repository (L-04, H-04) —
    quarantine exists, versioning does not.
  - **Mountain-dive domain** (3D-05…08): gate entities, dive dynamics,
    contingency planes — new schema/reducer/compiler/analysis concepts.

### Engineering note — orthographic 3D

deck.gl 9.3.7 is installed; `@deck.gl/core` ships `OrthographicView` and
`OrbitView({orthographic: true})` — true parallel projection needs no new
rendering engine. The open question is terrain in the standalone ortho view
(MapLibre terrain does not carry over; elevation infra today is point-query
`open-meteo-elevation.js`). Validate via **`spike/ortho/`** (same pattern as
`spike/occlusion/`): TerrainLayer from `@deck.gl/geo-layers` (new dep,
terrain-RGB tiles) vs. SimpleMeshLayer over our own sampled elevation grid.
Never label a perspective view "Orthographic". Projection toggle preserves
route, selection, layers, azimuth, and inspector state. 2D fallback mandatory.

## Milestones

Each milestone merges to `main` when green (`npm run check`; `/freview` for the
big ones). No epic branch.

- [x] **M9 — Shell + design system.** *(landed 2026-07-31, main @ ee23af2)* Four-destination nav on all form factors
  (desktop left rail, phone bottom dock FIELD/PLAN/LIBRARY/AIRCRAFT, tablet icon
  rail); `tokens.json` folded into `themes.js` (keep Space Grotesk / IBM Plex —
  render typography is reference-only); `fpv-symbols.svg` inline sprite;
  VerdictCard, WindRibbon, MissionSummary, DataFreshness; system-state
  framework. **Lift-and-shift every existing surface intact** per the
  preservation map. Kick off `spike/ortho` in parallel.
- [x] **M10 — Plan workspace.** *(landed 2026-07-31, main @ 4e7bcb5)* Map-first:
  2D/Analyze/Review modes, ContextInspector replaces permanent sidebars,
  ElevationProfile, RouteTimeline, MapToolbar, fix-linking engine on validation
  (P-01…P-05, T-01…T-04).
- [x] **M11 — Wind intelligence.** *(landed 2026-08-01, main @ e00f62e)* W-01…W-04 + WindRibbon expansion states
  everywhere. Mostly visualization over existing data.
- [x] **M12 — Orthographic 3D planner.** *(landed 2026-08-01, main @ 33c6fcd)*
  Ortho engine per spike verdict is the 3D tab's default host, MapLibre
  satellite one toggle away; 3D-01…3D-04 via the scene viewbar (projection,
  azimuth, exaggeration, contours); failure keeps the pilot on the tab with a
  system-state card over the live 2D map (Retry is a document reload — a
  failed dynamic import is cached for the document's lifetime).
- [x] **M13 — Field + onboarding.** *(landed 2026-08-01, main @ 3bcff0a)*
  F-01 Field home card off the shared analysis pass (verdict at field scale,
  radius and turn-home tiles, wall-clock flight timer that survives a reload,
  sunlight theme latch); O-01/O-02 first-run tour (welcome chooser + location
  step, shown only when no session has ever been saved, every exit latches it
  off); O-03 offline readiness card — six honest rows, basemap stated as
  never stored, Check-for-updates reports the real registration outcome;
  H-03 cached-freshness wiring in the ribbon chip.
- [x] **M14 — Library + versions.** *(landed 2026-08-01, main @ bac9d99)*
  L-01 mission library (search, origin chips, cards with route thumbnails);
  L-02/L-03 saved-spot detail page + three-day forecast planner (pure-SVG
  chart, day tabs, 10/80 m toggle, hour scrub, Plan-at-this-time hand-off);
  L-04/H-04 RecoveryEntry timeline over a 20-checkpoint version store with
  non-destructive restore, quarantine rows, and preview-before-import.
  Sharing rigs/packs/flights stays in the Aircraft rail until the M15
  reframe.
- [ ] **M15 — Aircraft.** E-01…E-04 reframe with ConfidenceBadge; ΔIR
  parallel-pairing check surfaced; FOV frustum preview.
- [ ] **M16 — Mountain dive.** 3D-05…3D-08: gates in the mission schema,
  dive-dynamics analysis, contingency review.
- [ ] **M17 — Delivery polish.** H-01 acknowledged brief, H-02 export
  compatibility UI.

## Branch + asset strategy

- Work happens in a dedicated worktree (`.claude/worktrees/evolution`) with a
  branch per milestone (`evolution/m9-shell`, …), merged to `main` at each
  gate. Concurrent sessions edit the main tree; the worktree isolates this
  evolution.
- Committed design assets: round docs (`README.md`, `PROMPTS.md`,
  `ASSET-MANIFEST.md`, `SCREEN-INVENTORY.md`), `developer-assets/` (tokens +
  sprite are build inputs), compressed WebP review sheets, and the
  `reference/` before-screenshots. PNG masters and handoff ZIPs stay out of
  git (`.gitignore`); masters are archived outside the repo. `research/`
  remains untracked.

## Design guardrails (carried from the renders + prior direction)

- Paged, viewport-fit screens; no long scrolling pages. Pinch/tactile gestures
  reserved for map/plan surfaces.
- 48 px minimum touch targets; high-contrast sunlight mode; verdicts never by
  color alone (icon + label + severity + action).
- AGL/MSL always labeled beside the value; locale-aware units over canonical
  stored values; source + age on weather, terrain, calibration, imported data.
- Every caution pairs with its consequence and a concrete fix.
- Map stays dominant; contextual editors replace permanent sidebars.
