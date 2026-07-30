// mission-bridge.js — the working mission document, and the only thing that
// writes it (ADR 0002, ADR 0005).
//
// One document is open at a time. Every change to it goes through `dispatch()`,
// which runs the command past the reducer, re-resolves altitudes against the
// launch elevation, and schedules a debounced write to the repository. Nothing
// else in the app is allowed to hold a reference to the document and mutate it:
// callers read snapshots (`missionWaypoints()`, `missionTitle()`) and raise
// commands. That single-writer rule is what makes "the document is the source of
// truth for the route" a fact rather than an aspiration.
//
// ---------------------------------------------------------------------------
// THE TRANSITIONAL LAUNCH BRIDGE (M1b only — M2 deletes it)
// ---------------------------------------------------------------------------
// The route already lives here. The launch point does not, yet: weather fetches,
// terrain probes, saved spots and the physics inputs all still read it off the
// rail (src/state.js + the `map` key in src/store.js). Rewriting those five
// consumers is M2's job, so for one milestone the two are kept in step, in one
// direction each and in exactly one place:
//
//   boot     — the rail is set FROM the restored document (`railFromDocument`),
//              so a reload and an "open mission" both land the pin where the
//              mission says it is;
//   render   — `syncMissionFromRail()` runs once per render pass and dispatches
//              `setLaunch` only when the rail has genuinely moved away from the
//              document. Every launch change in the app therefore reaches the
//              document, whichever control made it.
//
// The rail itself is reached through an injected port (src/mission-rail.js), not
// imported: this module stays free of the untyped rail modules, which is what
// lets it sit under `strict` in tsconfig's include list. When M2 moves the
// consumers onto the document, the port and both directions above go with it.
//
// Storage failures are never swallowed. `MissionRepositoryError` messages are
// written for pilots and point at the export escape hatch, so they travel
// verbatim to the missions fold through `deps.onStorage`.

import { createMission } from './domain/mission/mission-schema.js';
import { missionReduce } from './domain/mission/mission-reducer.js';
import { resolveMissionAltitudes } from './domain/mission/altitude.js';
import { openMissionRepository } from './infrastructure/persistence/mission-repository.js';

/** @typedef {import('./domain/mission/mission-schema.js').MissionDocumentV1} MissionDocumentV1 */
/** @typedef {import('./domain/mission/mission-schema.js').CreateMissionOptions} CreateMissionOptions */
/** @typedef {import('./domain/mission/mission-reducer.js').MissionCommand} MissionCommand */
/** @typedef {import('./domain/mission/mission-reducer.js').MissionWarning} MissionWarning */
/** @typedef {import('./domain/mission/altitude.js').TerrainSampler} TerrainSampler */
/** @typedef {import('./infrastructure/persistence/mission-repository.js').MissionSummary} MissionSummary */
/** @typedef {Awaited<ReturnType<typeof openMissionRepository>>} MissionRepository */

/** The launch point as both sides of the transitional bridge speak it. */
/** @typedef {{ latitude: number, longitude: number, elevationMslM: number|null }} LaunchPoint */

/**
 * The rail, as much of it as this module is allowed to know about.
 * @typedef {object} RailPort
 * @property {() => LaunchPoint} readLaunch   where the rail thinks the launch is
 * @property {(launch: LaunchPoint) => void} writeLaunch  put the rail there instead
 * @property {() => Omit<CreateMissionOptions, 'launch'>} seed  loadout snapshots,
 *   environment reference and planning policy for a mission being created now
 */

/**
 * @typedef {object} BridgeDeps
 * @property {RailPort} rail
 * @property {() => void} requestRender          app.js's update()
 * @property {() => void} [onMissionChanged]     the open mission's identity or title moved
 * @property {(state: MissionStorageState) => void} [onStorage]
 * @property {TerrainSampler|null} [terrainSampler] M3 supplies a real one; until
 *   then launch-relative altitudes resolve and AGL ones honestly do not
 * @property {MissionRepository} [repository]  tests inject a failing store here;
 *   the app always lets `openMissionBridge` open the real one
 */

/**
 * What the missions fold says about where this mission lives.
 * @typedef {object} MissionStorageState
 * @property {'memory'|'indexeddb'|null} adapter
 * @property {boolean} durable      false means session-only: nothing survives the tab
 * @property {boolean|null} persisted  navigator.storage.persist()'s answer, or null
 * @property {'idle'|'pending'|'saved'|'failed'} save
 * @property {string} message       pilot-facing; '' when there is nothing to say
 */

/** Long enough to coalesce a drag, short enough that a fast reload keeps the edit. */
const SAVE_DEBOUNCE_MS = 300;

/** @type {BridgeDeps|null} */ let deps = null;
/** @type {MissionRepository|null} */ let repo = null;
/** @type {MissionDocumentV1|null} */ let doc = null;
/** @type {Promise<void>|null} */ let inflight = null;
let booted = false;
let dirty = false;
let saveTimer = 0;

/** @type {MissionStorageState} */
let storage = { adapter: null, durable: false, persisted: null, save: 'idle', message: '' };

/** @param {BridgeDeps} d */
export function setupMissionBridge(d) { deps = d; }

/** @param {unknown} e @returns {string} */
const reason = (e) => (e instanceof Error ? e.message : String(e));

/**
 * @param {MissionStorageState['save']} save
 * @param {string} [message]
 */
function report(save, message = '') {
  storage = { ...storage, save, message };
  deps?.onStorage?.(storage);
}

/** @param {MissionWarning} w */
function onWarning(w) {
  // A rejected command is never silent — the console always gets it. It is not
  // a storage failure, though, so it must stay out of the storage banner (which
  // shows its message only inside the red failed state). M2's coded-warning
  // surface (ADR 0008) is where these get a pilot-facing home.
  console.warn(`mission: ${w.message}`);
}

/* ---------- persistence ---------- */

/** @param {MissionDocumentV1} snapshot */
async function writeNow(snapshot) {
  if (!repo) return;
  dirty = false;
  try {
    const res = await repo.save(snapshot);
    storage = { ...storage, ...res.storage, save: 'saved', message: '' };
    deps?.onStorage?.(storage);
  } catch (e) {
    // Stay dirty so the next edit or flush retries, but never re-arm the timer
    // from here: a persistent failure (full disk) would otherwise retry at
    // debounce rate forever, flashing the very banner it is trying to show.
    dirty = true;
    report('failed', reason(e));
    return;
  }
  if (dirty) scheduleSave(); // a new edit landed while the write was in flight
}

function scheduleSave() {
  if (!repo || !doc) return;
  dirty = true;
  report('pending');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void flushMission(); }, SAVE_DEBOUNCE_MS);
}

/**
 * Write the open mission now and wait for it. Called before every operation that
 * reads storage — a copy, an export or a list has to describe the mission on
 * screen, not the one the debounce has not written yet.
 * @returns {Promise<void>}
 */
export async function flushMission() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  while (inflight) await inflight;
  if (!repo || !doc || !dirty) return;
  const promise = writeNow(doc);
  inflight = promise;
  try { await promise; } finally { inflight = null; }
}

/* ---------- the open document ---------- */

/** @returns {MissionDocumentV1|null} the open mission — read it, never write it */
export function missionDocument() { return doc; }

/** @returns {string} */
export function missionTitle() { return doc ? doc.title : ''; }

/** @returns {string|null} */
export function missionId() { return doc ? doc.id : null; }

/** @returns {MissionStorageState} */
export function missionStorage() { return { ...storage }; }

/**
 * The route as the map and src/domain/route.js read it: plain `{ id, lat, lng }`, in
 * flight order, launch excluded (the launch is not a waypoint).
 * @returns {{ id: string, lat: number, lng: number }[]}
 */
export function missionWaypoints() {
  return doc ? doc.route.waypoints.map((w) => ({ id: w.id, lat: w.latitude, lng: w.longitude })) : [];
}

/**
 * Apply one command to the open mission.
 *
 * Altitudes are re-resolved on every accepted command rather than only after the
 * three that strictly need it: resolution is a pure pass over a handful of
 * segments, and "re-resolve after setLaunch, moveWaypoint and setSegmentAltitude
 * but not the others" is a rule that would rot the first time a command is added.
 *
 * @param {MissionCommand} command
 * @param {{ render?: boolean }} [opts] `render: false` for a dispatch already
 *   inside a render pass — re-entering update() from here would recurse
 * @returns {boolean} whether the document changed
 */
export function dispatch(command, opts = {}) {
  if (!doc) return false;
  const next = missionReduce(doc, command, { onWarning });
  if (next === doc) return false; // rejected — the reducer already explained why
  doc = resolveMissionAltitudes(next, deps?.terrainSampler ?? null).doc;
  scheduleSave();
  if (opts.render !== false) deps?.requestRender();
  return true;
}

/* ---------- route commands (raised by src/map.js through its deps) ---------- */

/** @param {{ lat: number, lng: number }} pt */
export function addWaypoint(pt) {
  dispatch({ type: 'addWaypoint', payload: { latitude: pt.lat, longitude: pt.lng } });
}

/** @param {string} id @param {{ lat: number, lng: number }} pt */
export function moveWaypoint(id, pt) {
  dispatch({ type: 'moveWaypoint', payload: { id, latitude: pt.lat, longitude: pt.lng } });
}

/** @param {string} id */
export function removeWaypoint(id) {
  dispatch({ type: 'removeWaypoint', payload: { id } });
}

/**
 * Drop every waypoint. There is no `clearRoute` command and there should not be
 * one — the reducer's vocabulary is the edits a pilot makes, and "clear" is n
 * removals in a row, each of which repairs the segment chain the same way the
 * single-pin delete does.
 */
export function clearRoute() {
  if (!doc) return;
  let changed = false;
  for (const w of [...doc.route.waypoints]) {
    changed = dispatch({ type: 'removeWaypoint', payload: { id: w.id } }, { render: false }) || changed;
  }
  if (changed) deps?.requestRender();
}

/* ---------- the transitional launch bridge ---------- */

/** Below this the two sides are saying the same thing in different units. */
const SAME_DEGREES = 1e-9;   // ~0.1 mm
const SAME_ELEV_M = 0.5;     // the rail types whole feet; half a metre is noise

/**
 * Reconcile the rail's launch point into the document. Called once per render
 * pass, from app.js's update(), which is the one place every launch change in
 * the app — pin drag, map click, saved spot, live weather's elevation — has
 * already passed through.
 */
export function syncMissionFromRail() {
  if (!booted || !doc || !deps) return;
  const rail = deps.rail.readLaunch();
  if (!Number.isFinite(rail.latitude) || !Number.isFinite(rail.longitude)) return;
  const here = doc.launch;
  const moved = Math.abs(here.latitude - rail.latitude) > SAME_DEGREES
    || Math.abs(here.longitude - rail.longitude) > SAME_DEGREES;
  const elev = rail.elevationMslM;
  const elevMoved = elev != null
    && (here.elevationMslM == null || Math.abs(here.elevationMslM - elev) > SAME_ELEV_M);
  if (!moved && !elevMoved) return;
  dispatch({
    type: 'setLaunch',
    payload: { latitude: rail.latitude, longitude: rail.longitude, elevationMslM: elev },
  }, { render: false });
}

/** Put the rail where the open mission says the launch is. */
function railFromDocument() {
  if (!doc || !deps) return;
  deps.rail.writeLaunch(doc.launch);
}

/* ---------- boot, and the mission list ---------- */

/** @returns {MissionDocumentV1|null} */
function seededMission() {
  if (!deps) return null;
  try {
    return createMission({ ...deps.rail.seed(), launch: deps.rail.readLaunch() });
  } catch (e) {
    report('failed', `A new mission could not be started: ${reason(e)}`);
    return null;
  }
}

/**
 * Open the repository and the most recent mission in it, or start one seeded
 * from the rail as it stands. Async, once, at boot; every later read of the
 * document is synchronous, which is what keeps the render pass simple.
 * @returns {Promise<void>}
 */
export async function openMissionBridge() {
  if (!deps) return;
  try {
    repo = deps.repository ?? await openMissionRepository();
    storage = { ...storage, adapter: repo.adapter, durable: repo.durable };
  } catch (e) {
    repo = null;
    report('failed', `Missions cannot be stored in this browser (${reason(e)}). `
      + 'The one you are flying still works — export it before you close the tab.');
  }

  /** @type {MissionDocumentV1|null} */ let loaded = null;
  if (repo) {
    try {
      const [newest] = await repo.list();
      if (newest) loaded = await repo.get(newest.id);
    } catch (e) {
      report('failed', `Saved missions could not be read (${reason(e)}).`);
    }
  }

  booted = true;
  if (loaded) {
    doc = resolveMissionAltitudes(loaded, deps.terrainSampler ?? null).doc;
    railFromDocument();
    report('saved');
  } else {
    doc = seededMission();
    if (doc) scheduleSave();
  }
  deps.onMissionChanged?.();
  deps.requestRender();
}

/** @returns {Promise<MissionSummary[]>} newest first */
export async function listMissions() {
  await flushMission();
  const summaries = repo ? await repo.list() : [];
  // The open mission gets a row even when the store has never accepted it —
  // without one there is no export button exactly when exporting is the only
  // way to keep the plan (failed or unavailable storage).
  const open = doc;
  if (open && !summaries.some((s) => s.id === open.id)) {
    summaries.unshift({ id: open.id, title: open.title, updatedAt: open.updatedAt });
  }
  return summaries;
}

/**
 * @param {string} id
 * @returns {Promise<boolean>} false when that mission is gone or unreadable
 */
export async function openMission(id) {
  await flushMission();
  if (!repo || id === missionId()) return false;
  const next = await repo.get(id);
  if (!next) return false;
  doc = resolveMissionAltitudes(next, deps?.terrainSampler ?? null).doc;
  railFromDocument();
  report('saved');
  deps?.onMissionChanged?.();
  deps?.requestRender();
  return true;
}

/**
 * Branch the open mission. The copy becomes the working document — the same
 * thing "Save As" means everywhere else, and the reason to reach for it: the
 * next waypoint the pilot drops belongs to the copy, not to the mission they
 * just froze.
 * @returns {Promise<MissionDocumentV1|null>}
 */
export async function saveMissionCopy() {
  await flushMission();
  const id = missionId();
  if (!repo || !id) return null;
  const copy = await repo.duplicate(id);
  if (!copy) return null;
  doc = copy;
  report('saved');
  deps?.onMissionChanged?.();
  deps?.requestRender();
  return copy;
}

/** @param {string} title */
export function renameMission(title) {
  if (!dispatch({ type: 'setTitle', payload: { title } }, { render: false })) return;
  deps?.onMissionChanged?.();
}

/**
 * Delete a mission. Deleting the one that is open leaves the pilot on a fresh
 * mission at the same launch point rather than on a document that no longer
 * exists anywhere.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteMission(id) {
  await flushMission();
  if (!repo) return false;
  const gone = await repo.remove(id);
  if (!gone) return false;
  if (id === missionId()) {
    doc = seededMission();
    if (doc) scheduleSave();
    railFromDocument();
    deps?.onMissionChanged?.();
    deps?.requestRender();
  }
  return true;
}

/**
 * @param {string} id
 * @returns {Promise<string|null>} the mission as a self-contained JSON file
 */
export async function exportMission(id) {
  // The open mission exports straight from memory. This is the escape hatch
  // the header promises when the store is failing, so it cannot depend on
  // reading back a document the store may never have accepted — and memory is
  // newer than the store whenever they disagree.
  if (doc && id === doc.id) return JSON.stringify(doc, null, 2);
  await flushMission();
  return repo ? repo.exportJson(id) : null;
}

/**
 * Read a mission file in and open it. The repository re-identifies an import
 * that collides with a mission already here, so importing your own export twice
 * gives you two missions rather than silently overwriting one.
 * @param {string} text
 * @returns {Promise<Awaited<ReturnType<MissionRepository['importJson']>>|null>}
 */
export async function importMission(text) {
  await flushMission();
  if (!repo) return null;
  const result = await repo.importJson(text);
  if (result.ok) {
    doc = resolveMissionAltitudes(result.doc, deps?.terrainSampler ?? null).doc;
    railFromDocument();
    report('saved');
    deps?.onMissionChanged?.();
    deps?.requestRender();
  }
  return result;
}
