# 0007 — Provider ports everywhere; AdapterResult for import/export

**Status**: Accepted (2026-07-30)

## Decision

- All external I/O sits behind **ports** with in-repo contracts:
  weather (`infrastructure/weather/`), elevation + DEM tiles
  (`infrastructure/elevation/`, `infrastructure/terrain/`), persistence
  (ADR 0005), and mission import/export (`infrastructure/export/`). Domain and
  application code depend on the port interface, never on fetch, URLs, or
  vendor formats. Provider swaps (R-DEM outcome) touch one adapter file.
- Every provider response is normalized into a **typed snapshot with
  provenance** (source, version/model id, issue/valid or retrieval time,
  resolution, license/attribution requirement) before it crosses into
  application code. Raw provider payloads do not travel.
- **Missing data is a stated fact, not a default.** Ports return explicit
  missing/stale/invalid flags; they never substitute zero wind, sea-level
  terrain, or "clear" (ADR 0008).
- Every importer/exporter returns an **`AdapterResult`** (frozen contract):

```text
status          ok | degraded | failed
payload         the produced artifact or imported document (null on failed)
warnings[]      non-semantic notes
errors[]        why it failed, machine-readable codes + message
semanticLosses[] { concept, detail, disposition }  — every dropped or
                degraded mission semantic, named individually
sourceFormat, targetFormat, adapterVersion
```

- **No silent semantic loss**: an exporter that cannot express hold duration,
  camera intent, altitude reference, or reserve policy in the target format
  must name each one in `semanticLosses`. The UI and the mission brief surface
  them (M6). Imports sanitize: unknown fields dropped with a named loss, no
  executable content or markup passes through.

## Why

The current code fetches Open-Meteo inline and shares via a bespoke schema.
That works at today's scale but makes provider changes, offline caching,
fixtures, and loss reporting ad-hoc. Ports give every milestone (terrain, wind
levels, exports, offline) the same seam, and `AdapterResult` makes "what did
this export actually keep?" a first-class answer.

## Consequences

- Contract tests run against recorded fixtures per provider (R-WX, R-DEM,
  R-EXPORT deliverables become the fixture sources).
- Existing `weather.js` / `terrain.js` fetch paths migrate behind ports during
  M2–M3 without changing their physics consumers.
