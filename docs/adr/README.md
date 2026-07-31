# Architecture decision records

Decisions that shape the mission-planner architecture. One decision per file,
numbered in acceptance order. The source plan is
`research/AI_AGENT_DEVELOPMENT_PLAN.md` (the product/architecture plan this
phase implements).

Format: **Status** (Proposed → Accepted → Amended/Superseded), **Decision**,
**Why**, **Consequences**. Terse on purpose — the decision and its reasons, not
an essay. A contract named in an ADR is frozen: consumers may use it, nobody
extends it implicitly. Changing a frozen contract requires amending the ADR and
updating its fixtures in the same change.

| # | Decision | Status |
|---|---|---|
| 0001 | Product scope: mission confidence layer, not a GCS | Accepted |
| 0002 | MissionDocumentV1 is the authoritative mission state | Accepted |
| 0003 | One altitude truth: MSL meters, authored reference retained | Accepted |
| 0004 | Map engine is an adapter; MapLibre+deck.gl is the 3D target | Proposed (pending R-3D spike) |
| 0005 | Missions and evidence in IndexedDB; prefs stay in localStorage | Accepted |
| 0006 | Workers for spatial computation, immutable messages, stale-drop | Accepted |
| 0007 | Provider ports everywhere; AdapterResult for import/export | Accepted |
| 0008 | Warning taxonomy, stable IDs, provenance on every snapshot | Accepted |
| 0009 | Build/type/test tooling and the move to src/ | Accepted |
| 0010 | Mission compiler, concept inventory, loss-by-construction adapters | Accepted |
