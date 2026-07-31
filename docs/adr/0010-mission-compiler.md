# 0010 — Mission compiler: CompiledMission, concept inventory, loss-by-construction

**Status**: Accepted (2026-07-31)

## Decision

M6 moves missions between this planner and established tools (ADR 0007's
`AdapterResult` is the frozen envelope; this ADR fixes what travels inside it
and how loss reporting is made impossible to forget).

### 1. CompiledMission — one frame-resolved view, in `domain/mission/compile.js`

Every adapter reads the same **CompiledMission**, produced by the pure
`compileMission(doc, { terrainSampler? })`. It is a derivation of
`MissionDocumentV1`, never a second authority:

```text
CompiledMission
  missionId, title, createdAt, updatedAt
  home        { latitude, longitude, elevationMslM|null }
  points[]    one per waypoint, in route order:
              { id, latitude, longitude, altitude: CompiledAltitude }
  legs[]      one per segment, in route order:
              { id, fromId, toId, intent, speed { mode, ms|null },
                holdS|null, subjectRef|null, camera|null }
  returnPolicy  { mode, altitude: CompiledAltitude|null }   — declarative;
                adapters map it (RTL command, geometry, or a named loss),
                the compiler never materialises a return leg
  reserve     { landFloorPct }
  scene       { subjects[] }
  inventory   Concept[] — the concepts this mission actually uses
  issues[]    { code, path, message } — what kept a frame or field unresolved

CompiledAltitude — every frame precomputed via domain/mission/altitude.js:
  { authored, reference, amslM|null, launchRelM|null, aglM|null }
```

An adapter picks the altitude frame its format speaks; a `null` in that frame
is a named loss or a failed export, never a fabricated number (ADR 0003).
`speed.ms` is resolved from the segment's policy against the aircraft
snapshot's cruise/max figures when the mode needs them; unresolvable → null.

The compiler lives in the **domain** layer because infrastructure adapters may
import domain but not application (ADR 0009 layering), and the compile is a
pure function of the document plus an injected terrain sampler.

### 2. Concept inventory and loss-by-construction

The plan's rule — *route geometry, altitude reference, speed, hold, camera
intent, return policy, and reserve semantics are evaluated independently* — is
encoded as a frozen concept list:

```text
CONCEPTS = geometry | altitude-reference | speed | hold | camera-intent
         | return-policy | reserve
```

`compileMission` derives which concepts the mission *uses* (`inventory`).
Each adapter declares a static support table
`{ [concept]: 'native' | 'approximate' | 'unsupported' }`, and the shared
`deriveLosses(inventory, support)` in
`infrastructure/export/adapter-contracts.js` computes the `semanticLosses`
entries mechanically: a concept the mission uses that the adapter cannot
express natively **becomes a loss without any adapter author remembering to
write one**. Adapters append value-level losses on top (e.g. an altitude
re-referenced within tolerance). Loss `disposition` is
`'dropped' | 'approximated'`. `status` is derived, not chosen: `failed` when
`payload` is null, `degraded` when any losses exist, `ok` otherwise.

### 3. Formats

| Format | File | Export | Import | Notes |
|---|---|---|---|---|
| GPX 1.1 | `.gpx` | yes | yes | track + wpt; `ele` is metres MSL; visualization/interchange only |
| KML | `.kml` | yes | no | LineString `absolute` altitude mode; visualization only |
| QGroundControl Plan | `.plan` | yes | yes | JSON, `fileType:"Plan"`; MAV_CMD items |
| ArduPilot / MAVLink WPL | `.waypoints` | yes | yes | `QGC WPL 110` tab-separated text |
| INAV mission | `.mission` | yes | no* | XML per current INAV Configurator source; *import lands with M6 if the verified format round-trips, else desk-noted |
| Betaflight | — | no | no | experimental upstream; stays out per the plan rule |

Adapter authors verify field semantics against **official documentation or
open-repository source at build time** and record the source URL + retrieval
date in a provenance header of each golden fixture under
`tests/fixtures/interop/`. Format facts nobody verified do not ship.

Round-trip tolerances (the exit gate's "defined tolerances"):
coordinates ≤ 1e-6°, altitude ≤ 0.1 m, hold ≤ 1 s, speed ≤ 0.1 m/s.
Identity (waypoint/segment ids) does not survive vendor formats; a re-import
mints fresh ids and says so in a loss entry.

### 4. Import security (hard exit-gate item)

Imported files are hostile until proven otherwise:

- **XML** is read by a strict subset reader in
  `infrastructure/export/xml.js` — no DOM, no vendor parser. It **rejects**
  DOCTYPE and ENTITY declarations and processing instructions (other than the
  XML declaration) outright: XXE and entity-expansion are refused, not
  survived. Only the five predefined entities decode.
- **JSON** goes through `JSON.parse` only; imported objects are never spread
  or merged — every normalized document is built field-by-field, so
  `__proto__`/`constructor` keys die on the floor.
- All imported text (titles, names, notes) is sanitized: control characters
  stripped, length-capped, carried as data and rendered only via
  `textContent`. No imported string ever reaches `innerHTML` or a URL.
- Inputs are size-capped (5 MB) before parsing. Unknown vendor extensions are
  dropped and named in one aggregate loss entry.
- Every import ends at `validateMission` and lands with
  `provenance.origin = 'imported'` and `sourceFormat` set (ADR 0002).

### 5. SITL validation — desk-noted as out of scope

The exit gate offers "SITL or containerized open tooling validates outputs
where available". It is not available: this is a static PWA with a
zero-dependency CI that runs node + a browser; running ArduPilot SITL or a
containerized QGC is a different product's CI. As with WindNinja (M5), the
substitute is: golden fixtures taken from official docs/repositories, strict
schema-shape assertions on our own output, and round-trip tests within the
tolerances above. If a maintained web-assembly SITL becomes practical, revisit.

### 6. Wiring

Layer rules keep application from importing infrastructure, so the
composition happens in an unlayered top-level module (`src/interop.js`), the
same way `mission-bridge.js` wires persistence. UI and the mission brief read
compatibility *per format* by running `deriveLosses` against each adapter's
support table without serializing — the report is available before any export
button is pressed.

## Why

One neutral representation means adding a format touches one adapter file
(ADR 0007's promise). Deriving losses from a declared support table makes
"unsupported concepts are never silently dropped" a property of the system
rather than a review checklist. Refusing DOCTYPE outright is the only XML
security posture a hand-rolled parser can honestly claim.

## Consequences

- `compileMission` is the single place altitude frames are resolved for
  export; adapters contain format knowledge only.
- A new concept (M7 camera profiles) is one new inventory entry plus a
  support-table row per adapter — existing adapters degrade honestly by
  default because an undeclared concept is treated as `unsupported`.
- The INAV import decision (ship vs desk-note) is made by the implementing
  wave against verified source, and recorded here when made.
