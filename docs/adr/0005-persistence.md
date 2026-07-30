# 0005 — Missions and evidence in IndexedDB; prefs stay in localStorage

**Status**: Accepted (2026-07-30; failure-mode details refined by R-OFFLINE)

## Decision

- **IndexedDB** (database `fpv-planner`) becomes the durable store for:
  mission documents (`missions` store, keyed by mission id), and evidence
  snapshots (`evidence` store: forecast snapshots, terrain/corridor samples,
  DEM metadata — keyed by content-derived provenance keys).
- **localStorage keeps only small preferences** and the existing records it
  already serves well (UI prefs, session restore, catalog customs, pack
  instances, flight log) via the current namespaced `store.js` wrapper.
  Existing data is not force-migrated; anything that grows into mission-scale
  or evidence-scale data moves to IndexedDB.
- **Atomic writes**: a mission save is one IndexedDB transaction writing the
  full document; no partial-field updates. A failed transaction leaves the
  previous version intact. Saves are verified by reading back the key in the
  same flow before reporting success.
- **Recovery posture**: quota exhaustion or a corrupt record must never destroy
  the authoritative mission — writes fail loudly, the in-memory document stays
  usable, and JSON export remains available as the escape hatch. Corrupt
  records are quarantined (moved aside), not deleted.
- `navigator.storage.persist()` is requested when the first mission is saved
  (the moment the user has expressed durable intent), and the granted/denied
  result is surfaced as data-durability provenance, not ignored.
- All repository access goes through a persistence port
  (`infrastructure/persistence/indexeddb.js`); domain code never touches
  IndexedDB APIs directly.

## Why

Mission versions, forecast snapshots, and DEM metadata exceed localStorage's
role (string-only, ~5 MB, synchronous). IndexedDB gives structured records,
transactions, and quota headroom. Keeping prefs in localStorage avoids
rewriting working storage for records that fit it.

## Consequences

- M1 builds the mission repository + save/open/duplicate/rename/delete/import/
  export operations against this port, with corrupt/old/unknown-version fixture
  tests (ADR 0002 migration rules).
- M8 layers freshness indicators, eviction handling, and backup guidance on the
  same port — no second storage path.
