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
// The launch point lives here too: every consumer that used to read it off the
// rail — the physics inputs, the weather client, the terrain probe, the saved
// spots — reads it back from this module, and every control that moves it
// raises `setLaunch` at its own call site.
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

/** Where a mission is flown from. */
/** @typedef {{ latitude: number, longitude: number, elevationMslM: number|null }} LaunchPoint */

/**
 * @typedef {object} BridgeDeps
 * @property {() => Omit<CreateMissionOptions, 'launch'> & { launch: LaunchPoint }} seed
 *   a whole mission's worth of starting state — loadout snapshots, environment
 *   reference, planning policy and the launch point — for a mission being
 *   created now. Supplied by the caller because it is the rail's business, not
 *   this module's.
 * @property {(launch: LaunchPoint) => void} [onLaunchRestored] a document just
 *   became the open one; put the map pin and the rail's elevation field where it
 *   says the launch is
 * @property {(doc: MissionDocumentV1) => void} [onMissionOpened] fires
 *   alongside `onLaunchRestored`, at the same four moments — a document just
 *   became the open one, which is also the moment analysis-host.js's evidence
 *   restore (ADR 0012 §2) has something to ask the store about
 * @property {(id: string) => void} [onMissionRemoved] a mission was removed
 *   from the repository — its evidence (ADR 0012 §2) has no mission left to
 *   describe
 * @property {() => void} requestRender          app.js's update()
 * @property {() => void} [onMissionChanged]     the open mission's identity or title moved
 * @property {(state: MissionStorageState) => void} [onStorage]
 * @property {TerrainSampler|null} [terrainSampler] M3 supplies a real one; until
 *   then launch-relative altitudes resolve and AGL ones honestly do not
 * @property {MissionRepository} [repository]  tests inject a failing store here;
 *   the app always lets `openMissionBridge` open the real one
 * @property {StorageManager} [storage]  defaults to navigator.storage; tests
 *   inject a stub `estimate()` (ADR 0012 §5)
 */

/**
 * What the missions fold says about where this mission lives.
 * @typedef {object} MissionStorageState
 * @property {'memory'|'indexeddb'|null} adapter
 * @property {boolean} durable      false means session-only: nothing survives the tab
 * @property {boolean|null} persisted  navigator.storage.persist()'s answer, or null
 * @property {'idle'|'pending'|'saved'|'failed'} save
 * @property {string} message       pilot-facing; '' when there is nothing to say
 * @property {boolean|null} nearFull  navigator.storage.estimate() said usage is
 *   at or above STORAGE_NEAR_FULL_RATIO of quota; null when the estimate is
 *   unavailable or the call itself threw (ADR 0012 §5) — a browser that
 *   cannot answer gets no claim, not a false "plenty of room"
 */

/** Long enough to coalesce a drag, short enough that a fast reload keeps the edit. */
const SAVE_DEBOUNCE_MS = 300;

/** At or above this fraction of quota, the banner warns before writes start failing (ADR 0012 §5). */
const STORAGE_NEAR_FULL_RATIO = 0.8;

/**
 * How much editing an auto checkpoint is allowed to cover (M14, H-04). The
 * debounced save keeps the live record current; the history only needs a
 * trail of restore points, and one every five minutes bounds what a bad edit
 * session can cost to five minutes of work.
 */
const CHECKPOINT_INTERVAL_MS = 5 * 60_000;

/** @type {BridgeDeps|null} */ let deps = null;
/** @type {MissionRepository|null} */ let repo = null;
/** @type {MissionDocumentV1|null} */ let doc = null;
/** @type {Promise<void>|null} */ let inflight = null;
let dirty = false;
let saveTimer = 0;
let lastCheckpointAt = 0; // wall-clock ms of the last checkpoint attempt
/** The most recent checkpoint write, still possibly in flight — most callers
 *  fire and forget, so a read of the history right behind one (the Library
 *  rendering after an import) must have something to await or it races the
 *  write it is trying to show. Never rejects: recordCheckpoint absorbs
 *  refusals into a console line. @type {Promise<void>} */
let checkpointInFlight = Promise.resolve();

/** @type {MissionStorageState} */
let storage = { adapter: null, durable: false, persisted: null, save: 'idle', message: '', nearFull: null };

/**
 * Ask the browser how full its storage is, and fold the answer into the
 * banner. Cheap enough to call at bridge open and after every save receipt
 * rather than on a timer — polling for a number that only writes can move
 * would be busywork between them.
 *
 * `estimate()` missing, throwing, or answering something that is not two
 * finite numbers is treated the same as a browser with no opinion: no claim,
 * not a guess that there is plenty of room (ADR 0012 §5).
 */
async function refreshStorageEstimate() {
  const sm = deps?.storage ?? globalThis.navigator?.storage;
  if (!sm || typeof sm.estimate !== 'function') return;
  try {
    // Defaulted rather than left possibly-undefined: StorageEstimate's own
    // fields are optional, and a default of NaN keeps the finite-check below
    // the one place that decides "unusable", instead of `tsc` doing it twice.
    const { usage = NaN, quota = NaN } = await sm.estimate();
    if (!Number.isFinite(usage) || !Number.isFinite(quota) || quota <= 0) return;
    storage = { ...storage, nearFull: usage / quota >= STORAGE_NEAR_FULL_RATIO };
    deps?.onStorage?.(storage);
  } catch {
    // A locked-down or private-browsing context can throw here; silence is
    // the honest answer (ADR 0012 §5), not a save failure and not a claim.
  }
}

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
  // shows its message only inside the red failed state), and it is not a finding
  // about the mission either: the rail simply keeps the value the reducer would
  // not take, and the pilot sees their own number unchanged.
  console.warn(`mission: ${w.message}`);
}

/* ---------- persistence ---------- */

/**
 * Ask the repository to record a version checkpoint, without letting a refusal
 * become a storage failure: the checkpoint API answers in data, and the only
 * audience for a refused one is the console. Most callers fire and forget
 * (`void`); the one that must sequence two checkpoints of the same mission
 * (restore) awaits the returned promise instead, so the two never race for
 * the same `seq`. The `typeof` guard keeps older injected test repositories
 * (which predate versioning) valid doubles.
 * @param {MissionDocumentV1} snapshot
 * @param {import('./infrastructure/persistence/mission-repository.js').VersionKind} kind
 * @returns {Promise<void>}
 */
function recordCheckpoint(snapshot, kind) {
  if (!repo || typeof repo.checkpoint !== 'function') return Promise.resolve();
  lastCheckpointAt = Date.now();
  checkpointInFlight = repo.checkpoint(snapshot, kind).then((res) => {
    if (!res.ok) console.warn(`mission: checkpoint not recorded — ${res.message}`);
  });
  return checkpointInFlight;
}

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
    void refreshStorageEstimate(); // especially worth knowing right after a failure
    return;
  }
  // The auto-checkpoint cadence rides the save receipts: only a confirmed
  // write can be worth remembering, and between writes there is nothing new.
  if (Date.now() - lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) void recordCheckpoint(snapshot, 'auto');
  if (dirty) scheduleSave(); // a new edit landed while the write was in flight
  void refreshStorageEstimate(); // after every save receipt (ADR 0012 §5)
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
 * Where this mission is flown from, or null before one is open. The source of
 * truth for every consumer that used to read the launch point off the rail.
 * @returns {LaunchPoint|null}
 */
export function missionLaunch() { return doc ? { ...doc.launch } : null; }

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

/**
 * Re-resolve the open mission's altitudes against whatever the terrain sampler
 * knows now.
 *
 * A waypoint authored `agl` cannot be turned into a metres-MSL figure until
 * something has sampled the ground under it, and that sampling is a network
 * round trip that lands long after the command that created the waypoint. Until
 * it does, resolveMissionAltitudes() correctly refuses to invent a number and
 * the analysis carries a stated unknown. This is the other half: when the ground
 * arrives, the document gets its figures without the pilot having to touch
 * anything.
 *
 * Not a command, and deliberately not a save: nothing the pilot authored has
 * changed, so `updatedAt` stays put (an async landing that bumped the revision
 * would make every in-flight fetch stale against itself) and there is nothing
 * new to persist — `resolvedMslM` is derived, and re-derived on load.
 *
 * @returns {boolean} whether any altitude's resolved figure moved
 */
export function reresolveAltitudes() {
  if (!doc) return false;
  const next = resolveMissionAltitudes(doc, deps?.terrainSampler ?? null).doc;
  // Structural sharing is the change detector: resolveMissionAltitudes() hands
  // back the identical segment object when its figure did not move.
  const same = next.route.returnPolicy === doc.route.returnPolicy
    && next.route.segments.every((seg, i) => seg === doc?.route.segments[i]);
  if (same) return false;
  doc = next;
  return true;
}

/* ---------- route commands (raised by src/presentation/map/map-view.js through its deps) ---------- */

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

/* ---------- boot, and the mission list ---------- */

/**
 * Put the map pin and the rail where the open mission says the launch is —
 * and tell analysis-host.js a document just became the open one, which is
 * also the moment its evidence restore (ADR 0012 §2) has something to ask
 * about. Called at exactly the five places a document changes identity:
 * boot's loaded branch, openMission, importMission's applied branch,
 * deleteMission's reseed branch, and restoreMissionVersion's applied branch.
 */
function launchRestored() {
  if (!doc || !deps) return;
  deps.onLaunchRestored?.({ ...doc.launch });
  deps.onMissionOpened?.(doc);
}

/** @returns {MissionDocumentV1|null} */
function seededMission() {
  if (!deps) return null;
  try {
    return createMission(deps.seed());
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

  if (loaded) {
    doc = resolveMissionAltitudes(loaded, deps.terrainSampler ?? null).doc;
    launchRestored();
    report('saved');
    // The session-start restore point (H-04): whatever this session does to
    // the mission, the state it opened at stays reachable. Deduped against
    // the newest version, so an untouched reopen records nothing.
    void recordCheckpoint(doc, 'auto');
  } else {
    doc = seededMission();
    if (doc) scheduleSave();
  }
  deps.onMissionChanged?.();
  deps.requestRender();
  void refreshStorageEstimate(); // at bridge open (ADR 0012 §5)
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
  launchRestored();
  report('saved');
  void recordCheckpoint(doc, 'auto'); // the open-moment restore point, deduped
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
  // "Save a copy" is the one deliberate save gesture this app has; the copy's
  // history starts with it as a manual checkpoint.
  void recordCheckpoint(copy, 'manual');
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
  deps?.onMissionRemoved?.(id);
  if (id === missionId()) {
    doc = seededMission();
    if (doc) scheduleSave();
    launchRestored();
    deps?.onMissionChanged?.();
    deps?.requestRender();
  }
  return true;
}

/**
 * Records the repository could not read as missions, still on disk (ADR
 * 0005's quarantine; ADR 0012 §5 gives them a UI). Read-only: the only
 * affordance the missions fold offers for one of these is downloading the raw
 * contents back out — no repair, no delete, because the recovery path is
 * export, fix, re-import, and destroying the only copy is not a button.
 * @returns {Promise<import('./infrastructure/persistence/mission-repository.js').QuarantineEnvelope[]>}
 */
export async function listQuarantined() {
  return repo ? repo.quarantined() : [];
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
  // The document being navigated away from gets a restore point before the
  // import replaces it as the open one (deduped, so usually a no-op).
  if (doc) void recordCheckpoint(doc, 'auto');
  const result = await repo.importJson(text);
  if (result.ok) {
    doc = resolveMissionAltitudes(result.doc, deps?.terrainSampler ?? null).doc;
    launchRestored();
    report('saved');
    // The import itself is an event worth a named version: the file's
    // contents as they arrived, before this session edits them.
    void recordCheckpoint(doc, 'import');
    deps?.onMissionChanged?.();
    deps?.requestRender();
  }
  return result;
}

/* ---------- version history (M14, L-04/H-04) ---------- */

/**
 * The stored history of one mission, newest first.
 * @param {string} id
 * @returns {Promise<import('./infrastructure/persistence/mission-repository.js').VersionSummary[]>}
 */
export async function listMissionVersions(id) {
  await flushMission(); // the flush's own save receipt may fire a cadence checkpoint…
  await checkpointInFlight; // …so wait for whichever checkpoint is mid-write before reading
  if (!repo || typeof repo.versions !== 'function') return [];
  return repo.versions(id);
}

/**
 * Make a stored version the live document and open it. The repository records
 * the restore as a new checkpoint — the version restored from is never
 * deleted, so a restore can itself be undone by restoring past it.
 * @param {string} id @param {string} versionId
 * @returns {Promise<Awaited<ReturnType<MissionRepository['restoreVersion']>>|null>}
 */
export async function restoreMissionVersion(id, versionId) {
  await flushMission();
  if (!repo || typeof repo.restoreVersion !== 'function') return null;
  // The document being replaced gets a restore point first, the same courtesy
  // importMission pays its outgoing document — otherwise edits made since the
  // last cadence checkpoint would exist nowhere once the restore overwrites
  // the live record. Awaited, unlike every other call: the repository is about
  // to record the restore itself for this same mission, and two concurrent
  // checkpoints would race for one `seq`.
  if (doc) await recordCheckpoint(doc, 'auto');
  /** @type {Awaited<ReturnType<MissionRepository['restoreVersion']>>} */
  let result;
  try {
    result = await repo.restoreVersion(id, versionId);
  } catch (e) {
    // The restore's save failed the same way any save can (full disk, …);
    // the open document is untouched and the banner explains.
    report('failed', reason(e));
    return { ok: false, errors: [{ path: '', code: 'E-VERSION-WRITE', message: reason(e) }] };
  }
  if (result.ok) {
    doc = resolveMissionAltitudes(result.doc, deps?.terrainSampler ?? null).doc;
    dirty = false; // the repository just wrote exactly this document
    lastCheckpointAt = Date.now(); // the repository just recorded the restore
    launchRestored();
    report('saved');
    deps?.onMissionChanged?.();
    deps?.requestRender();
  }
  return result;
}
