# 0011 — Cinematic intent: camera geometry, shot-aware analysis, honest export

**Status**: Accepted (2026-07-31)

## Decision

M7 makes route geometry represent the shot, not only vehicle motion. The
schema already reserved the seats (segment `intent`/`holdS`/`subjectRef`/
`camera`, `scene.subjects`, `scene.cameraProfile` — all schemaVersion 1,
`camera` explicitly "M1P owns the shape; carried verbatim"); M7 fills them,
additively, with no schemaVersion bump.

### 1. Camera geometry — pure math in `src/domain/camera.js`

One new domain module, importing nothing, owns every camera number:

```text
fovDeg({ sensorWidthMm, sensorHeightMm, focalLengthMm })
    → { hDeg, vDeg }            pinhole model: 2·atan(sensor/2f)
shotGeometry(legStart, legEnd, subject, { altitudeMslM })
    → { distanceStartM, distanceEndM, bearingToSubjectDeg,
        elevationAngleDeg, screenDirection }   — screenDirection is the
        side of frame the subject crosses toward: 'left-to-right' |
        'right-to-left' | 'toward' | 'away' | 'held'
frustumCorners(position, headingDeg, pitchDeg, { hDeg, vDeg }, rangeM)
    → four world-space corner offsets for the view pyramid at rangeM
orbitAirspeedMs(tangentialMs, windMs)
    → worst-case airspeed around a full circle (tangential speed against
      the wind's worst quarter: tangential + wind, the honest bound)
subjectFraming(distanceM, subjectRadiusM, { hDeg })
    → fraction of horizontal frame the subject spans, 0..1 clamped
```

Every function is total over valid inputs and returns named nulls (never
NaN) when an input is unresolvable — the compiler/analysis callers decide
whether a null is a warning or a loss. Exit-gate fixtures are **analytic**:
hand-derived cases (e.g. 24 mm focal on a 36 mm sensor is exactly 53.13°;
an equilateral geometry gives a known elevation angle) asserted to 1e-6,
not golden files.

### 2. Schema deepening — shapes for the reserved bags (additive)

- `SEGMENT_INTENTS` gains `'approach'` (the plan's seventh intent).
  `HOLD_INTENTS` is unchanged (`hold`, `orbit`); the compiler's
  `CAMERA_INTENTS` becomes `reveal | orbit | pass | approach`.
- `scene.cameraProfile` gets a validated shape:
  `{ name, sensorWidthMm, sensorHeightMm, focalLengthMm, stabilized }` —
  numbers positive-finite, name sanitized/capped; still nullable. A small
  catalog of presets (`src/catalog/cameras.js`) covers common FPV setups;
  a custom profile is typed in the same shape.
- `segment.camera` gets a validated shape:
  `{ pitchDeg, yawOffsetDeg, orbit: { radiusM, clockwise } | null }` —
  every field optional-nullable; `orbit` meaningful only on intent
  `'orbit'` (else `E-SEG-CAMERA-ORBIT`). Unknown keys are rejected
  (`E-SEG-CAMERA-KEY`) so the bag stops being a junk drawer the moment it
  has a shape.
- `scene.templates[]` — reusable shot presets stored in the mission:
  `{ id, name, intent, holdS, camera }`, validated with the same segment
  rules; applying one to a segment copies values (no live reference).
- `checkScene` tightens: subject `name` sanitized/capped, `elevationMslM`
  and `radiusM` number-or-null.
- New reducer commands (same envelope as the twelve existing ones):
  `addSubject`, `moveSubject`, `removeSubject`, `setSegmentCamera`,
  `setSegmentSubject`, `setSegmentHold`, `setCameraProfile`,
  `saveSceneTemplate`, `applySceneTemplate`, `removeSceneTemplate`.
  Removing a subject nulls every segment's dangling `subjectRef` in the
  same reduction — the document is never invalid between commands.

### 3. Analysis — the shot reaches the snapshot, and holds pay for wind

- `SegmentAnalysis` gains `subjectRef`, `camera`, and a computed
  `shot` record (`null` for non-camera segments): subject distance at leg
  ends, framing fraction, screen direction, elevation angle — computed
  from `domain/camera.js` against the same resolved altitudes the rest of
  the analysis uses. The map, 3D scene, inspector, and brief all read this
  one record; nobody recomputes camera math downstream (ADR 0002).
- **Hold/orbit energy becomes wind-aware.** `analyze.js`'s per-segment
  `segHoldWh` stops using flat calm-air hover power: a `hold` charges
  `powerAtSpeed(cfg, windMs)` (station-keeping is flying at the wind's own
  speed — the same physics `route.js` has always used for loiter-at-range);
  an `orbit` charges `powerAtSpeed(cfg, orbitAirspeedMs(tangentialMs,
  windMs))` with the worst-quarter bound from §1. `W-RESERVE-HOLD-BUDGET`'s
  explanation drops its "calm-air figure" limitation line and gains the
  orbit bound's own honesty note (worst-case, not average).
- Shot intent never bypasses existing gates: cinematic segments flow
  through the same clearance, energy, reserve, and RF checks as transit
  legs — the new fields are additions to `SegmentAnalysis`, not a parallel
  path around it. The exit gate asserts an orbit over a ridge still
  raises its terrain-clearance warning and still debits reserve.

### 4. New constraints — registered, segment-anchored

New codes join `CONSTRAINT_CODES` (producer `'analysis'`) before any pass
emits them (`draftConstraint` throws on unregistered codes, by design):

- `W-SHOT-SUBJECT-MISSING` — camera intent with no subject to frame.
- `W-SHOT-ORBIT-RADIUS` — orbit radius inside the subject's own radius,
  or unresolvable (no radius authored, none inferable).
- `W-SHOT-HOLD-WIND` — hold/orbit whose wind-aware airspeed exceeds the
  aircraft's `maxSpeedMs` (the shot is aerodynamically unflyable as
  authored, before energy is even counted).

`AnchorScope` stays closed (`mission | segment | sample`) — subject-relative
findings anchor to the **segment** whose shot they break and name the
subject in the text. Extending the frozen anchor vocabulary for a pointer
the text already carries is cost without a reader.

### 5. UI — the first segment-editing surface

The read-only segment inspector grows an editing half (the reducer commands
in §2 already exist to receive it; `setSegmentIntent`/`setSegmentAltitude`/
`setSegmentSpeed` have waited unwired since M2). Editing dispatches
commands through the bridge — the inspector still computes nothing.
Subjects get map affordances (place/drag/remove markers, 2D and 3D via the
shared `routeSpans`/`segmentIdOrder` vocabulary), the 3D scene gains a
shot-line + view-frustum layer beside `routeLayers()` (same pick payload
shape, same billboarding-vs-flat degradation for unresolved altitudes),
and the brief's route section is re-pointed at `snapshot.segments` (the
intent-aware model) rather than the physics integrator's `RouteLeg[]`,
gaining per-leg shot wording. 2D, 3D, brief, and exports all name segments
by the same authored ids — that is the exit gate's interoperability claim.

### 6. Export degradation — one new concept

`CONCEPTS` gains `'camera-profile'` (used when `scene.cameraProfile` is
non-null), exactly as ADR 0010's consequences predicted: existing adapters
declare nothing about it, an undeclared concept is `unsupported`, so every
current format reports it as a named loss mechanically. `camera-intent`
inventory detail widens to count `approach` segments. No adapter's SUPPORT
table changes in M7 — the honesty is free; that it is free is the point.

## Why

Camera math in one pure module means the analytic fixtures pin every number
the UI will ever draw. Threading the shot through `SegmentAnalysis` (not a
side channel) keeps ADR 0002's rule — one snapshot, many readers — true for
cinematic data. Charging holds at station-keeping power replaces a known
understatement with physics the codebase already trusted for loiter.
Segment-anchored subject findings avoid unfreezing a contract for a pointer
prose already carries.

## Consequences

- `domain/camera.js` joins the tsconfig ratchet on arrival (imports
  nothing); `catalog/cameras.js` beside the other catalogs.
- The brief's route section changes data source (`RouteLeg[]` →
  `snapshot.segments`); its energy/reserve numbers must not change, only
  gain wording — the exit gate diffs them.
- `segment.camera` validation is a behavior change for hand-authored
  documents that stuffed arbitrary keys into the bag; the migration path
  is "the validator now says which key it rejects", and no shipped surface
  ever wrote one.
- Orbit energy uses a worst-case bound, not an average — briefs read
  slightly pessimistic for orbits in wind, and say so.
