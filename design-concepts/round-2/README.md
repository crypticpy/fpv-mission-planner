# FPV Mission Planner — polished deep-screen concepts

Round 2 moves beyond the first-pass navigation and visual hierarchy into the
actual planning workflow.

## Recommended product structure

1. **Route** — map-first mission geometry with waypoints, subject, reach rings,
   and wind vectors visible on the map.
2. **Leg** — one selected segment at a time, with intent, distance, course,
   altitude, speed, camera, wind effect, energy cost, and ETA.
3. **Analyze** — terrain/link clearance, per-leg energy, altitude profile,
   wind exposure, and home-leg reserve.
4. **Review** — one calm verdict, supporting evidence, actionable fixes, and
   export/brief actions.

## Persistent wind system

Wind should never live only in Weather settings. Use a compact context ribbon
throughout the app containing speed, compass direction, altitude, and gust.
Expand that same data differently by task:

- overview: `9 mph · SSW · 80 m · Gust 14`
- map: directional arrows or restrained streamlines
- selected leg: headwind/tailwind and ground-speed/energy effect
- analysis: 10/80/120/180 m vertical profile and route exposure
- review: home-leg reserve and the wind limit the plan still holds to

## Key interaction improvements

- Pair every caution with its consequence and a concrete fix.
- Keep the map dominant; contextual editors should replace permanent sidebars.
- Make route time, turn-home time, landing state, and return reserve first-class.
- Use a sequential mobile flow and a split-workspace tablet flow built from the
  same components and mission state.
- Keep advanced evidence expandable, but never hide the decision or wind context.

## Contact sheets

- `05-deep-mobile-mission-flow.webp` — route → leg → clearance → validation
- `06-mobile-wind-intelligence.webp` — forecast → altitude → heading → map
- `07-tablet-mission-studio.webp` — route → shot → simulation → review
- `08-wind-aware-cross-device-system.webp` — shared mobile/tablet component system
- `09-first-run-field-readiness.webp` — onboarding → location → offline → field
- `10-mission-spots-library.webp` — missions → spots → forecast → recovery
- `11-equipment-calibration-library.webp` — aircraft → packs → camera → calibration
- `12-orthographic-3d-terrain-planner.webp` — terrain → vertical edit → shot → link
- `13-mountain-dive-high-altitude-flow.webp` — conditions → dive → dynamics → abort
- `14-mission-delivery-offline-recovery.webp` — brief → export → cache → restore
- `15-developer-component-state-kit.webp` — tokens, components, symbols, and states

The complete handoff ZIP contains compressed review copies plus the screen
inventory and asset manifest. Full PNG masters remain in `final/`.
