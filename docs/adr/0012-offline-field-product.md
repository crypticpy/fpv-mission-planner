# 0012 — Offline field product: evidence governance and release hardening

**Status**: Accepted (2026-07-31)

## Decision

M8 makes the planner trustworthy when connectivity, cached evidence, or
browser storage is imperfect. The seams already exist — an `evidence`
object store created empty in ADR 0005's database, an
`EnvironmentReference.provenance` bag typed since ADR 0008 but hardcoded
`null` at its one write site, a snapshot `AnalysisProvenance` whose
forecast fields are read but never fed — M8 fills them, additively, with
no schemaVersion bump and no new database version.

### 1. Forecast provenance stops being null

`fetchLiveEnv`/`fetchArchiveEnv` stamp what they know at the moment the
response lands: `{ source: 'open-meteo-forecast' | 'open-meteo-archive',
retrievedAt, validAt }` (ISO strings; `validAt` is the forecast hour the
values were read for). `live.js` threads the bag through, and
`mission-commands.js`'s `environmentReference()` accepts it instead of
writing `provenance: null`. `analyze.js`'s `buildProvenance()` already
reads `env.provenance` — `forecastValid` and `retrievedAt` simply stop
being permanently null. Manual and preset environments keep
`provenance: null`: a pilot-authored number has no fetch time, and
fabricating one would be the exact dishonesty this milestone exists to
prevent.

Two codes join the `W-DATA-*` family (producer `'analysis'`, registered
before any pass emits them):

- `W-DATA-FORECAST-AGE` — caution: a fetched forecast is older than
  **6 h** at analysis time.
- `W-DATA-FORECAST-STALE` — warning: older than **24 h**. The text says
  what the pilot should do (refetch when connectivity returns) and what
  the numbers still are (the last real forecast, not padding).

Both anchor to the mission and appear only for fetched sources — the
age of a manual environment is not a concept. `calibrationSource` in the
snapshot provenance names the flight count when calibrated
(`'flight-log calibration (3 flights)'`) so the brief can print one
honest uncertainty line without a new contract.

### 2. The evidence store gets its callers

A new `src/infrastructure/persistence/evidence-repository.js` drives the
`evidence` object store that ADR 0005 created on purpose and left empty.
One record per mission, keyed by mission id:
`{ id, savedAt, terrainField, advisoryGrid, profile }` — the sampled
evidence with its embedded provenance, exactly as the snapshot carried
it. Rules, in order of importance:

- **Evidence is derived; the mission is authoritative.** An evidence
  write failure — quota above all — is swallowed with a console warning
  and never surfaces as a save failure. When storage runs out, evidence
  is the first thing to give way; the mission document's existing
  quota-exceeded path is untouched.
- **Restore is best-effort and honest.** On mission open, restored
  fields re-enter the analysis exactly as a fresh sample would, keeping
  their original `retrievedAt` — the terrain card and brief show the true
  age. A malformed record is discarded silently (no quarantine: derived
  data is re-derivable; the network will replace it).
- Persist is debounced after each successful sample publish, mirroring
  the mission autosave cadence; removal of a mission removes its
  evidence.

This is the plan's "cached evidence": a pilot who planned at home opens
the app in the mountains offline and still has the mission (IndexedDB),
the shell (service worker), the captured environment (inside the
document), and now the terrain field and advisory grid — every one
labelled with when it was really fetched.

### 3. Cancellation joins the staleness guards

The sequence-counter / `acceptAsync` guards remain the correctness
layer; M8 adds the resource layer. `fetchLiveEnv`/`fetchArchiveEnv` and
the Open-Meteo elevation provider accept an `AbortSignal`; `goLive`
aborts its previous in-flight request when superseded, and the
analysis-host samplers abort a superseded run when the debounce re-arms.
An `AbortError` is silence, not failure — it never reaches a banner, a
constraint, or a console.error.

### 4. App-shell updates become visible; lazy chunks become retryable

- The service worker keeps `skipWaiting()`/`clients.claim()` (ADR 0009's
  posture) but the app now listens for `controllerchange` and shows a
  dismissible, `aria-live="polite"` notice: the planner updated in the
  background — reload to run the newest build. **No auto-reload**: a
  pilot mid-edit never loses work to a deploy.
- `briefUi()` and `engine()` stop caching a rejected `import()` forever:
  on rejection the cached promise resets to null, so the next click
  retries the chunk fetch instead of replaying the failure until a full
  page reload. One shared reason: a chunk fetch that failed offline
  should succeed the moment connectivity returns.
- A Node guard test walks the static + dynamic import graph from
  `src/app.js` and compares it against `sw.js`'s hand-maintained dev
  `PRECACHE_URLS`, modulo the documented scene3d exclusion — the dev
  list can no longer silently drift from what `src/` actually imports.

### 5. Storage stewardship

- `navigator.storage.estimate()` feeds the existing storage banner: at
  ≥ 80 % of quota the banner says storage is nearly full before writes
  start failing, and repeats the export advice. Where `estimate()` is
  unavailable the banner makes no claim.
- Quarantined records surface. The missions list shows each quarantined
  envelope as a row that says it could not be read and offers one
  affordance: download the raw contents (the untouched original bytes,
  Blob download). No delete, no repair-in-place — the recovery path is
  export → fix → import, and destroying the only copy is not a button.

### 6. The brief carries its evidence; coordinates become withholdable

- A new **Evidence** section (between ground/radio and warnings) prints,
  from `snapshot.provenance` and the field provenances alone: forecast
  source and age (or "manual — authored by the pilot"), terrain source /
  resolution / coverage and sample age, the calibration line from §1,
  and `ANALYSIS_MODEL_VERSION`. No recomputation — the section is a
  window onto provenance the snapshot already carries (ADR 0002).
- `buildBrief` gains `{ redactCoordinates }`. When set, every coordinate
  string in the brief renders as "withheld" — launch point, route rows,
  all of it — and a checkbox on the brief sheet ("Hide coordinates for
  sharing", default off) drives it; print honors the toggle. The brief
  is the one shareable artifact where a location is optional. The
  mission JSON backup and the flight-controller exports are **never**
  redacted: the backup is the recovery path and a flight plan without
  coordinates does not fly — README states the boundary. The
  hangar/logbook share path already scrubs coordinates (`scrubCoords`)
  and is unchanged.

### 7. Exit gate

Node: provenance flows end-to-end (fetched env → document → snapshot);
the two age codes fire at their thresholds and never for manual sources;
evidence repository round-trips, discards corrupt records, and swallows
quota; abort reaches the providers and an aborted run changes no state;
the brief's evidence section and redaction; the precache guard.

Browser (Playwright): a corrupted mission record still boots the app,
shows the quarantine row, and downloads its raw bytes; the update notice
appears on `controllerchange` and is dismissible; restored evidence
survives an offline reload with its age visible. New surfaces follow the
existing keyboard/reduced-motion/contrast patterns and the deterministic
screenshot spec stays deterministic.

## Out of scope, on purpose

- **Bounded offline-region packages** — the plan's own priority list
  places licensed offline terrain regions in "expansion after the core
  is coherent"; the license research (R-DEM) has not cleared a
  redistributable source. Cached evidence (§2) is the honest subset that
  ships now.
- **Map-tile precaching** — unchanged license posture (ADR 0004, sw.js):
  tiles fail offline rather than being hoarded against provider policy.
- **Auto-reload on update**, **redaction of flight-controller exports or
  the JSON backup** — both rejected above, for stated reasons.

## Why

Every M8 surface is a window onto provenance rather than a new
computation, which keeps ADR 0002's rule — one snapshot, many readers —
true for evidence metadata. Evidence-as-derived-data resolves the quota
tension by construction: the authoritative mission can never lose a
write race to a cache. Cancellation layered under the existing staleness
guards means correctness never depended on it — it is hygiene, so a
platform that drops an abort changes nothing.

## Consequences

- `evidence-repository.js` joins the persistence layer beside
  `mission-repository.js`; the IndexedDB `DATABASE_VERSION` stays 1
  (the store already exists).
- `environmentReference()` callers that passed no provenance keep
  working — the parameter is additive with a `null` default.
- The dev `PRECACHE_URLS` list is now enforced by test; adding a module
  without adding its precache line fails the suite instead of silently
  shipping a dev-path hole.
- The brief grows one section and one option; its energy/reserve numbers
  must not change (same diff discipline as ADR 0011's brief re-point).
- Sixty-plus modules now assume rejected lazy imports retry; a future
  chunk rename mid-deploy is survivable by clicking again once the new
  worker precaches.
