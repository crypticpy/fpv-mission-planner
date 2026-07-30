# 0008 — Warning taxonomy, stable IDs, provenance on every snapshot

**Status**: Accepted (2026-07-30)

## Decision

### Warnings

- Every constraint/warning has a **stable namespaced code** (e.g.
  `W-TERR-CLEARANCE`, `W-RF-FRESNEL`, `W-ENERGY-RESERVE`, `W-WIND-LEE`) and a
  **stable instance identifier** tied to the segment/sample it attaches to.
  Map, planner rail, segment inspector, and mission brief all reference the
  same instance IDs — severity and explanation text must agree everywhere
  (cross-surface invariant, enforced by tests from M2 on).
- **Severity taxonomy** (fixed, chemistry of ADR 0001's "never say safe"):
  - `advisory` (blue) — relative uplift potential, informational;
  - `caution` (yellow) — acceleration zones, regime sensitivity, narrow
    pass/gap concern;
  - `warning` (orange) — lee-side descent risk, degraded margins;
  - `critical` (red) — reserve violation, clearance violation, rotor-prone
    advisory, link blocked;
  - `unknown` (purple/gray hatch) — missing data or high uncertainty;
  - `low-forcing` (green-gray) — low modeled terrain forcing. Rendered and
    worded as "low modeled forcing", **never** "safe".
- Every warning carries an **explanation code** resolving to: the inputs that
  triggered it, their age, the model baseline that produced it, sensitivity
  (does it flip within forecast uncertainty?), and stated limitations.
- **Missing or stale data never becomes zero wind, calm, clear terrain, or an
  absent warning.** Absence of data produces an `unknown` warning, which ranks
  above `low-forcing` in display priority.

### Provenance

Every snapshot (forecast, terrain, corridor, analysis) carries a provenance
object:

```text
{ modelVersion, forecastIssue, forecastValid, terrainSource,
  samplingResolution, calibrationSource, retrievedAt }
```

- The `AnalysisSnapshot` aggregates the provenance of everything it consumed
  plus its own model version and calculation timestamp.
- Freshness is computed against provenance, displayed in the UI and brief
  (M8), and stale evidence is impossible to mistake for current evidence.

## Why

Warnings that drift between surfaces (map says orange, brief says fine) are
worse than no warnings — they teach the pilot to ignore the tool. Stable IDs +
one snapshot source make agreement structural. Provenance is what lets an
advisory be honest: "based on the 06Z GFS run, 30 m terrain, model v3".

## Consequences

- M2 assigns constraint IDs in the analysis pipeline; M5's mountain-flow
  warnings join the same taxonomy rather than inventing colors.
- The existing warning strings in the planner migrate to coded warnings during
  M2 (text preserved; codes added).
