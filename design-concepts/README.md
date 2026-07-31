# FPV Mission Planner redesign concepts

These concept sheets are based on the running app at `http://localhost:8321`
and the current source in this repository. They are exploratory UI directions,
not implementation-ready pixel specifications.

## What the audit found

- The current responsive shell already has useful foundations: a bottom dock,
  a Loadout bottom sheet, touch-sized controls, a verdict, and a strong map.
- On a phone, the masthead settings, verdict, and separate warning cards consume
  nearly the entire first viewport. The radius, timer, and map arrive too late.
- On tablet portrait, the map is strong but global settings and warnings still
  take a large amount of vertical space before the primary task.
- The single long Loadout rail mixes setup, catalog management, calibration,
  weather, mission planning, sharing, and export. A guided setup flow plus
  contextual advanced tools would reduce cognitive load without removing depth.

## Recommended direction

Use the verdict-first structure from mobile mission A, the compact bottom-sheet
map treatment from mobile map C, the editable-summary setup model from mobile
setup C, and the split cockpit / route studio patterns from tablet A and C.

That combination keeps the field workflow to: verdict -> radius/timer/wind ->
map -> details, while leaving the deeper analysis and authoring tools one layer
away instead of deleting them.

## Files

- `01-mobile-mission-contact-sheet.webp` — four mobile mission/home directions
- `02-mobile-map-contact-sheet.webp` — four mobile map directions
- `03-mobile-setup-contact-sheet.webp` — four setup/loadout directions
- `04-tablet-workspaces-contact-sheet.webp` — four tablet workspace directions

The downloadable archive uses WebP quality 88 with sharp YUV conversion. PNG
masters remain in `final/` for closer inspection or later design work.
