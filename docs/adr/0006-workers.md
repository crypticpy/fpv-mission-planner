# 0006 — Workers for spatial computation, immutable messages, stale-drop

**Status**: Accepted (2026-07-30)

## Decision

- Expensive spatial computation — corridor grid sampling/interpolation (M3) and
  mountain-flow field modeling (M5) — runs in **dedicated module workers**
  (`src/workers/corridor.worker.js`, `mountain-flow.worker.js`). The main
  thread never blocks on grid math.
- **Messages are plain structured-clone data, treated as immutable.** A request
  carries `{ requestId, missionRev, inputs, provenance }`; the response echoes
  `requestId` and `missionRev` unchanged.
- **Stale responses are dropped at the boundary**: the application layer keeps
  the latest `requestId` per computation kind and discards any response that
  doesn't match. A stale async result can never overwrite a newer mission's
  calculation (M2 exit gate).
- **Cancellation** is a `{ type: 'cancel', requestId }` message; workers check a
  cancellation flag between grid chunks and reply `cancelled` rather than
  completing silently.
- Workers hold no authoritative state — only caches keyed by provenance
  (terrain source + resolution + bbox; forecast issue time + model). Cache hits
  must be indistinguishable from recomputation in results and provenance.
- Domain functions stay pure and callable synchronously in Node tests; the
  worker files are thin hosts that import domain modules and speak the message
  protocol. Tests exercise the domain directly and the protocol separately.

## Why

Route-wide corridors and wind fields are orders of magnitude more samples than
today's 28-point bearing profile. Doing that on the main thread janks the map;
doing it without request identity creates the classic last-write-wins race when
the pilot drags a waypoint mid-computation.

## Consequences

- The Vite build (ADR 0009) must emit worker bundles; the SW precache includes
  them.
- Node's test runner covers domain math without a browser; Playwright covers
  the protocol (cancel, stale-drop) in M3.
