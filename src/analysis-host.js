// analysis-host.js — where the analysis pipeline meets the running app.
//
// src/application/analysis/analyze.js is pure and imports no provider: the
// planner, the route integrator, the terrain profile, the link model and the
// stranded-mission sentence all arrive as injected ports (ADR 0007). Something
// has to hold those wires, and it cannot be the pipeline (it would stop being
// pure) or app.js (it is the render pass, not a composition root). This module
// is that something, and it is deliberately unlayered: it is the one place
// allowed to know both the application layer and the render modules that own
// the impure seams.
//
// It owns four things and nothing else:
//
//   the ports — built once, because which providers are wired up is part of the
//     analysis question (a null one becomes a stated `unknown` constraint);
//
//   analyzeNow() — the current mission document plus the rail's inputs, in, one
//     AnalysisSnapshot out. Every number and every warning on screen comes from
//     the object this returns;
//
//   the corridor terrain sampler (M3b) — the elevation provider, the cache it
//     consults and the newest TerrainField that came back. The pipeline is pure
//     and synchronous, so it cannot await ground; it reads whatever field is in
//     hand through an accessor port and states an unknown when there is none.
//     Sampling is kicked off *after* a snapshot exists, because the snapshot is
//     what publishes the corridor to sample;
//
//   staleness — one newestOnly() guard, keyed on the document revision and the
//     rail inputs together, that every async landing (the single-bearing terrain
//     profile, the corridor field, the live-weather fetch) checks before it
//     applies anything. Before this there were two ad-hoc sequence counters that
//     could each only see their own fetch; a launch move between the ask and the
//     answer was invisible to both.
import { planMission } from './domain/physics.js';
import { planRoute } from './domain/route.js';
import { adaptiveHalfSweep, radiusAtAlpha, fullCircle, polarAreaKm2 } from './sweep.js';
import { analyzeMission, msUntilForecastBoundary, newestOnly } from './application/analysis/analyze.js';
import { hashKey, stableStringify } from './application/analysis/analysis-contracts.js';
import { usableField } from './application/analysis/route-checks.js';
import { createElevationCache } from './application/terrain/elevation-cache.js';
import { createTerrainSampler, nearestGroundSampler } from './application/terrain/sample-corridor.js';
import { createGridSampler, gridRequestFor } from './application/terrain/sample-grid.js';
import {
  OPEN_METEO_ATTRIBUTION, createOpenMeteoElevationProvider,
} from './infrastructure/elevation/open-meteo-elevation.js';
import { openEvidenceRepository } from './infrastructure/persistence/evidence-repository.js';
import { missionDocument, reresolveAltitudes } from './mission-bridge.js';
import { state, battery, missionInputs } from './state.js';
import { activeProfile, setTurnaroundKm } from './terrain.js';
import { linkBand } from './rf.js';
import { soundingAt, windLevels, windSounding } from './windprofile.js';
import { zeroRadiusNote } from './render/dashboard.js';
import { linkStats, linkWarnings, refreshTerrain, terrainWarnings } from './render/terrain.js';

/** @typedef {import('./application/analysis/analysis-contracts.js').AnalysisRevision} AnalysisRevision */
/** @typedef {import('./application/analysis/analysis-contracts.js').AnalysisSnapshot} AnalysisSnapshot */
/** @typedef {import('./application/analysis/analysis-contracts.js').CorridorRequest} CorridorRequest */
/** @typedef {import('./application/terrain/terrain-contracts.js').TerrainField} TerrainField */
/** @typedef {import('./application/terrain/terrain-contracts.js').AdvisoryGridField} AdvisoryGridField */
/** @typedef {import('./application/terrain/terrain-contracts.js').AdvisoryGridRequest} AdvisoryGridRequest */
/** @typedef {import('./infrastructure/persistence/evidence-repository.js').EvidenceRecord} EvidenceRecord */

/** Who supplies the ground when a profile is on hand. */
const TERRAIN_SOURCE = 'Open-Meteo elevation API';

/**
 * How far either side of the track the corridor is sampled, in metres.
 *
 * M2's CorridorRequest states `corridorWidthM: 0` — the honest version of "this
 * analysis has not looked either side of the line" — and the sampler lets the
 * host ask for cross-track evidence without editing that frozen contract. 300 m
 * is a little over three Copernicus DEM posts: enough for the feature detector
 * to tell a pass from a saddle from a ridge the route merely passes, and it
 * triples the point count rather than multiplying it further.
 */
const CROSS_TRACK_OFFSET_M = 300;

/**
 * Debounce on corridor sampling, in ms. Dragging a waypoint moves the route on
 * every pointermove; the same 500 ms the single-bearing profile fetch already
 * waits, for the same reason.
 */
const SAMPLE_DEBOUNCE_MS = 500;

/**
 * The ports, built once. `plan` and `routePlan` are the pure domain functions;
 * everything below them is impure and reads module state that the render pass
 * has already settled by the time analyzeNow() runs.
 */
const PORTS = Object.freeze({
  plan: planMission,
  routePlan: planRoute,
  linkStats,
  linkWarnings,
  terrainWarnings,
  elevationProfile: activeProfile,
  strandedNote: zeroRadiusNote,
  // The footprint geometry, injected for the same reason `plan` is: src/sweep.js
  // is pure and validated but not yet on the typecheck ratchet, and a static
  // import from the pipeline would drag its unannotated body into `tsc`.
  sweepKit: { adaptiveHalfSweep, radiusAtAlpha, fullCircle, polarAreaKm2 },
});

/* ---------- the corridor's ground ---------- */

/** @type {{ update: () => void }|null} */
let hostDeps = null;
/** @type {((corridor: CorridorRequest, signal?: AbortSignal) => Promise<TerrainField>)|null} */
let sampler = null;
/** @type {TerrainField|null} */
let field = null;
/** @type {(latitude: number, longitude: number) => number|null} */
let groundLookup = () => null;
let sampling = false;
/** @type {ReturnType<typeof setTimeout>|number} */
let sampleTimer = 0;
/** @type {string|null} */
let failedCorridorSig = null;
/** @type {CorridorRequest|null} */
let lastCorridor = null;
/**
 * The resource layer beside `sampling` (ADR 0012 §3): the controller behind
 * whichever corridor fetch is actually in flight, and the signature it is
 * answering. A superseded ask aborts this rather than letting a request run
 * to completion for a route nobody is asking about any more; the signature
 * lets a render for the *same* corridor tell "still waiting" from "changed".
 * @type {AbortController|null}
 */
let sampleController = null;
/** @type {string|null} */
let inFlightSig = null;

/* ---------- the advisory grid's ground (M5) ---------- */

/** @type {((request: AdvisoryGridRequest, signal?: AbortSignal) => Promise<AdvisoryGridField>)|null} */
let gridSampler = null;
/** @type {AdvisoryGridField|null} */
let advisoryField = null;
/** Which request `advisoryField` answers. */
let heldGridSig = /** @type {string|null} */ (null);
/** The request a sample is scheduled or in flight for. */
let pendingGridSig = /** @type {string|null} */ (null);
/** A request that came back with nothing, asked once and not again. */
let failedGridSig = /** @type {string|null} */ (null);
/** The request this render pass is about, settled before the analysis runs. */
let currentGridSig = /** @type {string|null} */ (null);
/** @type {AdvisoryGridRequest|null} */
let lastGridRequest = null;
let gridSampling = false;
/** @type {ReturnType<typeof setTimeout>|number} */
let gridTimer = 0;
/** The grid sampler's own controller/in-flight signature — see sampleController above. */
/** @type {AbortController|null} */
let gridController = null;
/** @type {string|null} */
let inFlightGridSig = null;

/* ---------- forecast age (ADR 0012 §1) ---------- */

/**
 * Grace past a threshold before the re-analysis runs, in ms. The timer's whole
 * job is to land on the far side of the boundary it waited for, and firing
 * exactly at it would race millisecond rounding between the armed delay and
 * the clock the pass then reads.
 */
const FORECAST_AGE_SLACK_MS = 1000;
/** @type {ReturnType<typeof setTimeout>|number} */
let forecastAgeTimer = 0;

/**
 * Arm one wake-up for the instant the open mission's forecast age next crosses
 * a threshold (6 h / 24 h from the fetch instant — ADR 0012 §1). The app only
 * re-analyses when an input moves, and a forecast ages while nothing else
 * does: without this, a planner left open in the field never escalated from
 * caution to warning, and a boot under 6 h never gained the caution at all.
 *
 * Coarse on purpose — at most two firings per fetch, never a per-minute
 * recompute. The fired timer only asks for a render; analyzeNow() runs on that
 * pass, and the pipeline's memo key carries the age bucket, so the crossing is
 * a fresh compute rather than a cache hit. Re-armed on every pass, which is
 * what re-anchors it after a refetch or a mission switch, and disarmed when no
 * boundary lies ahead (manual/preset environments, or already past 24 h).
 *
 * @param {import('./domain/mission/mission-schema.js').MissionDocumentV1} doc
 */
function armForecastAgeTimer(doc) {
  clearTimeout(forecastAgeTimer);
  forecastAgeTimer = 0;
  const wait = msUntilForecastBoundary(doc, nowFn());
  if (wait === null) return;
  const timer = setTimeout(() => { hostDeps?.update(); }, wait + FORECAST_AGE_SLACK_MS);
  // Under Node (the test runner) an armed Timeout holds the process open for
  // hours; in the browser setTimeout returns a number and this is a no-op.
  if (typeof timer === 'object') timer.unref?.();
  forecastAgeTimer = timer;
}

/* ---------- evidence (ADR 0012 §2) ---------- */

/**
 * @type {{
 *   save: (record: EvidenceRecord) => Promise<void>,
 *   get: (id: string) => Promise<EvidenceRecord|null>,
 *   remove: (id: string) => Promise<void>,
 *   close: () => void,
 * }|null}
 */
let evidenceRepo = null;
/** ISO instant, injectable for deterministic tests — mirrors every other `d.now` here. */
let nowFn = () => new Date().toISOString();
/**
 * A record read back for the mission that just opened, waiting for the next
 * analyzeNow() pass to judge it against the corridor/grid that pass is
 * actually asking about. Set once per restore, consumed once — admitted or
 * declined, refreshField/refreshGrid each get exactly one look before
 * analyzeNow() clears it.
 * @type {EvidenceRecord|null}
 */
let pendingRestore = null;
/** Mirrors mission-bridge.js's own SAVE_DEBOUNCE_MS: coalesce a burst of samples into one write. */
const EVIDENCE_SAVE_DEBOUNCE_MS = 300;
/** @type {ReturnType<typeof setTimeout>|number} */
let evidenceSaveTimer = 0;
/** The record the armed timer will write, so a re-schedule can tell whether
 * it is coalescing the same mission's burst or stepping on a different
 * mission's last write. @type {EvidenceRecord|null} */
let pendingEvidenceSave = null;

/**
 * Persist whatever evidence is in hand right now, debounced. Called after
 * every successful corridor/grid sample publish — the payload is captured at
 * call time, not read again when the timer fires, so a mission switch in the
 * gap between scheduling and firing cannot mislabel one mission's terrain as
 * another's.
 */
function scheduleEvidenceSave() {
  const doc = missionDocument();
  if (!doc) return;
  /** @type {EvidenceRecord} */
  const record = {
    id: doc.id,
    savedAt: nowFn(),
    terrainField: field,
    advisoryGrid: advisoryField,
    profile: activeProfile(),
  };
  clearTimeout(evidenceSaveTimer);
  // Debouncing coalesces a burst for one mission; a pending write for a
  // *different* mission is not part of the burst and would be lost by the
  // clearTimeout above — flush it now instead. Its payload was captured when
  // it was scheduled, so it still describes its own mission.
  if (pendingEvidenceSave && pendingEvidenceSave.id !== record.id) {
    void evidenceRepo?.save(pendingEvidenceSave);
  }
  pendingEvidenceSave = record;
  evidenceSaveTimer = setTimeout(() => {
    pendingEvidenceSave = null;
    void evidenceRepo?.save(record);
  }, EVIDENCE_SAVE_DEBOUNCE_MS);
}

/**
 * A document just became the open one (mission-bridge.js, every path that
 * calls its own launchRestored()). Ask the evidence store whether it
 * remembers this mission's ground — a read, not a decision: admission
 * happens in refreshField/refreshGrid, against whatever corridor/grid the
 * next analyzeNow() pass is actually asking about.
 * @param {import('./domain/mission/mission-schema.js').MissionDocumentV1|null} doc
 */
export function restoreEvidenceFor(doc) {
  if (!doc) return;
  const id = doc.id;
  void (async () => {
    if (!evidenceRepo) return;
    const record = await evidenceRepo.get(id);
    if (!record) return;
    // The mission moved on again while this read was in flight; a record for
    // a mission nobody has open any more describes nothing on screen.
    if (missionDocument()?.id !== id) return;
    pendingRestore = record;
    hostDeps?.update();
  })();
}

/**
 * O-03's question (design evolution M13): does this device remember the open
 * mission's ground? A read-only look at the evidence store — admission
 * against the current corridor stays refreshField/refreshGrid's job; the
 * readiness card only reports that a record exists and when it was saved. A
 * write still sitting in the debounce window counts: it is this mission's
 * evidence and lands within the window either way.
 * @returns {Promise<{savedAt: string}|null>}
 */
export async function evidenceStatus() {
  const doc = missionDocument();
  if (!doc) return null;
  if (pendingEvidenceSave?.id === doc.id) return { savedAt: pendingEvidenceSave.savedAt };
  if (!evidenceRepo) return null;
  const record = await evidenceRepo.get(doc.id);
  // The mission moved on while the read was in flight — this record no longer
  // describes the card that asked.
  if (!record || missionDocument()?.id !== doc.id) return null;
  return { savedAt: record.savedAt };
}

/**
 * A mission was removed from the repository (mission-bridge.js's
 * deleteMission). Its evidence has no mission left to describe — remove it
 * too, best-effort: evidence-repository.js's own remove() already never
 * throws, so nothing here needs to either.
 * @param {string} id
 */
export function forgetEvidence(id) {
  // A write still waiting in the debounce window would land *after* the
  // remove below and resurrect an orphan record for a deleted mission.
  if (pendingEvidenceSave?.id === id) {
    clearTimeout(evidenceSaveTimer);
    pendingEvidenceSave = null;
  }
  void evidenceRepo?.remove(id);
}

/**
 * Wire the corridor sampler up and hand the host a way to ask for a re-render.
 *
 * Deliberately explicit rather than done at import time. Everything below this
 * line reaches the network, and a module that starts fetching the moment it is
 * imported cannot be unit-tested against the pipeline without a stub — the
 * staleness tests in tests/analysis-host.test.mjs count fetches, and they are
 * counting the single-bearing profile's. An app that never calls this analyses
 * with no field port at all, which the pipeline states as W-DATA-TERRAIN-ABSENT
 * rather than passing off as clear ground.
 *
 * @param {{ update: () => void, fetch?: typeof fetch, now?: () => string,
 *   evidenceRepository?: NonNullable<typeof evidenceRepo> }} d  `evidenceRepository`
 *   is a ready-made repo, injected for tests; production leaves it unset and
 *   this opens its own (ADR 0012 §2), the same "inject or open for real" shape
 *   mission-bridge.js's own `deps.repository` follows
 */
export function setupAnalysisHost(d) {
  hostDeps = d;
  const provider = createOpenMeteoElevationProvider({
    ...(d.fetch ? { fetch: d.fetch } : null),
    ...(d.now ? { now: d.now } : null),
  });
  // One cache for the life of the tab, owned here rather than inside the
  // sampler: a corridor that shifts by one waypoint re-asks about ground it
  // already knows, and the DEM under a fixed lat/lng does not change.
  //
  // Both samplers share it, and that is the point. The advisory grid (M5) blankets
  // the area the corridor runs a line through, so a good fraction of what one asks
  // for the other has already paid for — and the cache keys on the rounded
  // coordinate, not on who is asking.
  const cache = createElevationCache();
  sampler = createTerrainSampler({
    provider,
    cache,
    crossTrackOffsetM: CROSS_TRACK_OFFSET_M,
    ...(d.now ? { now: d.now } : null),
  });
  gridSampler = createGridSampler({ provider, cache, ...(d.now ? { now: d.now } : null) });
  nowFn = d.now ?? (() => new Date().toISOString());
  // A re-wired host is a new composition (same reasoning as the controllers
  // below): drop whatever repo the old one held and either take the injected
  // one or open a fresh real one. Fire-and-forget — a host that has not
  // finished opening its evidence store yet simply has nothing to restore,
  // which restoreEvidenceFor() already treats as the honest "no evidence".
  evidenceRepo = d.evidenceRepository ?? null;
  if (!d.evidenceRepository) {
    void openEvidenceRepository().then((repo) => { evidenceRepo = repo; }).catch(() => {});
  }
  clearTimeout(evidenceSaveTimer);
  pendingEvidenceSave = null;
  pendingRestore = null;
  // …and the forecast-age wake-up, for the same reason as the grid timer
  // below: one armed for the last composition would fire into this one.
  clearTimeout(forecastAgeTimer);
  forecastAgeTimer = 0;
  field = null;
  groundLookup = () => null;
  failedCorridorSig = null;
  lastCorridor = null;
  // A re-wired host is a new composition: a controller from the old one has
  // no fetch behind it worth keeping alive, but abort it anyway rather than
  // leaving a dangling reference nothing will ever cancel.
  sampleController?.abort();
  sampleController = null;
  inFlightSig = null;
  // The advisory grid's whole state, including anything already in flight: a
  // re-wired host is a new composition, and a timer armed for the last one would
  // fire into it carrying a request nobody asked for.
  clearTimeout(gridTimer);
  gridController?.abort();
  gridController = null;
  inFlightGridSig = null;
  advisoryField = null;
  heldGridSig = null;
  pendingGridSig = null;
  failedGridSig = null;
  currentGridSig = null;
  lastGridRequest = null;
  gridSampling = false;
}

/** The newest accepted field, for the pipeline's accessor port. */
function currentField() { return field; }

/**
 * The ground under one point, in metres MSL, or null where the corridor never
 * looked. This is what turns an `agl` waypoint altitude into an MSL figure
 * (ADR 0003) — a stable function identity so mission-bridge.js can hold it as a
 * dep across every field that lands.
 *
 * @param {number} latitude
 * @param {number} longitude
 * @returns {number|null}
 */
export function groundAt(latitude, longitude) {
  return groundLookup(latitude, longitude);
}

/** The field on hand, for the renderers that print its provenance. */
export function terrainField() { return field; }

/**
 * What identifies a corridor, for "have I already asked this?". The geometry
 * and nothing else: the mission's title moving is not a reason to re-sample the
 * ground under it.
 * @param {CorridorRequest} corridor
 * @returns {string}
 */
function corridorSignature(corridor) {
  return hashKey(stableStringify({
    mission: corridor.missionId,
    spacing: corridor.spacingM,
    width: corridor.corridorWidthM,
    at: corridor.samples.map((s) => [s.id, s.latitude.toFixed(6), s.longitude.toFixed(6)]),
  }));
}

/**
 * Ask for the ground under this corridor, unless the field in hand already
 * answers it. Debounced and idempotent, like the profile fetch beside it: a
 * landed field triggers a render, which analyses again, which arrives back here.
 *
 * @param {CorridorRequest} corridor
 */
function refreshField(corridor) {
  // Whatever ask is pending was scheduled by an older call about an older
  // corridor; this call re-decides from scratch. Left armed, a superseded timer
  // fires anyway — and because runSample reads the revision at fire time, its
  // landing self-certifies as fresh and evicts a good field for a stale one.
  clearTimeout(sampleTimer);
  if (!sampler || !corridor || corridor.samples.length === 0) return;
  lastCorridor = corridor;

  // Evidence restored for this mission (ADR 0012 §2), admitted here rather
  // than left to age out: usableField() is the identical check a live sample
  // must pass, so restored and live evidence are held to one standard, and it
  // is only reached for when the field already in hand does not answer this
  // corridor — a live sample that landed first is never overwritten by an
  // older restored one. Wrapped because a corrupt disk record must be
  // silently declined, never thrown into the boot path (ADR 0012 §2 rule b).
  if (pendingRestore?.terrainField) {
    try {
      if (!usableField(field, corridor) && usableField(pendingRestore.terrainField, corridor)) {
        field = pendingRestore.terrainField;
        groundLookup = nearestGroundSampler(field);
        failedCorridorSig = null;
        reresolveAltitudes();
      }
    } catch { /* malformed restored field: treated as absent, not a crash */ }
  }

  if (usableField(field, corridor)) return;
  const sig = corridorSignature(corridor);
  // A dead connection is asked once per question, not once per render. The
  // pipeline is already saying "not sampled" for this corridor, which is the
  // honest state to sit in until the question changes.
  if (sig === failedCorridorSig) return;
  if (sampling) {
    // A render for the exact corridor already in flight re-arms nothing —
    // that request already answers this question. A genuinely different one
    // aborts it (ADR 0012 §3): runSample's own `finally` re-asks for
    // `lastCorridor` the moment the aborted request lands, so nothing here
    // has to wait for the old network round trip to finish first.
    if (sig !== inFlightSig) sampleController?.abort();
    return;
  }
  sampleTimer = setTimeout(() => { void runSample(corridor, sig); }, SAMPLE_DEBOUNCE_MS);
}

/**
 * Sample one corridor and keep the answer — unless the mission moved on first.
 *
 * sampleCorridor() never rejects: a provider that fell over comes back as a
 * field of null elevations with a note saying why, and that is a field worth
 * keeping. `coverage: 'empty'` is not the same as no field at all, and the
 * difference is what the clearance checks read.
 *
 * @param {CorridorRequest} corridor
 * @param {string} sig
 */
async function runSample(corridor, sig) {
  if (!sampler) return;
  const asked = analysisRevision();
  sampling = true;
  inFlightSig = sig;
  const controller = new AbortController();
  sampleController = controller;
  try {
    const next = await sampler(corridor, controller.signal);
    if (!acceptAsync(asked, 'corridor terrain')) return;
    field = next;
    // Rebuilt with the field, not per lookup: nearestGroundSampler() filters the
    // sample list once and the resolver calls the result per waypoint.
    groundLookup = nearestGroundSampler(next);
    failedCorridorSig = next.provenance.coverage === 'empty' ? sig : null;
    // An `agl` altitude the document could not resolve for want of ground can be
    // resolved now. Silent when nothing was waiting on terrain, which is the
    // common case — the default frame is launch-relative.
    reresolveAltitudes();
    scheduleEvidenceSave();
  } catch (err) {
    // Silence, not failure (ADR 0012 §3): a request this host cancelled itself
    // is not a terrain outage. The sampler already keeps an AbortError from
    // reaching here in the ordinary case; this is the backstop.
    if (err?.name === 'AbortError') return;
    // Nothing else here is expected to throw; if something does, the analysis
    // keeps its energy, wind and route findings and says the ground is unknown.
    console.warn('analysis: the corridor terrain sample failed.', err);
    failedCorridorSig = sig;
  } finally {
    sampling = false;
    inFlightSig = null;
    sampleController = null;
    hostDeps?.update();
    // A corridor that changed while this one was in flight never got its own
    // timer, because `sampling` was true when it came past.
    if (lastCorridor && lastCorridor !== corridor) refreshField(lastCorridor);
  }
}

/* ---------- the advisory grid's lifecycle ---------- */

/**
 * The points the advisory grid is built around: the launch and every waypoint
 * on the document, in the `{ lat, lng }` shape sample-grid.js speaks.
 *
 * Every waypoint, not only the ones a segment references — the grid is an area
 * around what the pilot is looking at, and an orphan waypoint is still drawn on
 * the map.
 *
 * @param {import('./domain/mission/mission-schema.js').MissionDocumentV1} doc
 * @returns {{ lat: number, lng: number }[]}
 */
function gridPointsFor(doc) {
  const pts = [{ lat: doc.launch.latitude, lng: doc.launch.longitude }];
  for (const w of doc.route.waypoints ?? []) {
    if (Number.isFinite(w.latitude) && Number.isFinite(w.longitude)) {
      pts.push({ lat: w.latitude, lng: w.longitude });
    }
  }
  return pts;
}

/**
 * What identifies an advisory grid request. A deep compare of the cell list
 * without walking it: the request is a regular lattice, so its dimensions, its
 * cell size and its two corner centres determine every cell in it. Two requests
 * with this signature are the same request, cell for cell.
 *
 * @param {AdvisoryGridRequest} request
 * @returns {string}
 */
function gridSignature(request) {
  const first = request.cells[0];
  const last = request.cells[request.cells.length - 1];
  return hashKey(stableStringify({
    rows: request.rows,
    cols: request.cols,
    cell: request.cellSizeM.toFixed(1),
    nw: [first.lat.toFixed(6), first.lng.toFixed(6)],
    se: [last.lat.toFixed(6), last.lng.toFixed(6)],
  }));
}

/**
 * Settle which grid this pass is about, and ask for it if nobody has.
 *
 * Called *before* analyzeMission, where refreshField is called after — and the
 * difference is not an inconsistency. The corridor is the analysis's own output:
 * it exists once the snapshot publishes it, so sampling it any earlier would be
 * sampling a route the analysis has not agreed to. The advisory grid is built
 * from the launch and the waypoints alone, which are inputs, so it can be
 * settled first — and it has to be, or the pass that arms the fetch would report
 * "no data" for the grid it is at that moment asking for. Settled first, the
 * pipeline reads `pending` and says nothing alarming while it waits.
 *
 * @param {import('./domain/mission/mission-schema.js').MissionDocumentV1} doc
 */
function refreshGrid(doc) {
  clearTimeout(gridTimer);
  currentGridSig = null;
  if (!gridSampler) return;
  let request;
  try {
    request = gridRequestFor(gridPointsFor(doc));
  } catch {
    // A document with no usable launch. Nothing to ask about, and the pipeline
    // says so through the unwired-looking reading below rather than throwing.
    return;
  }
  const sig = gridSignature(request);
  currentGridSig = sig;
  lastGridRequest = request;

  // Evidence restored for this mission (ADR 0012 §2): gridSignature() reads
  // only rows/cols/cellSizeM and the two corner cells' lat/lng, a shape a
  // sampled AdvisoryGrid carries identically to a request, so calling it on
  // the restored grid compares it to `sig` on equal footing. Reached only
  // when nothing already held answers this exact request — the same "do not
  // overwrite a fresher in-memory sample" rule refreshField's twin follows.
  // Wrapped for the same reason: a corrupt disk record must be silently
  // declined, never thrown into the boot path (ADR 0012 §2 rule b).
  if (pendingRestore?.advisoryGrid && sig !== heldGridSig) {
    try {
      if (gridSignature(pendingRestore.advisoryGrid.grid) === sig) {
        advisoryField = pendingRestore.advisoryGrid;
        heldGridSig = sig;
      }
    } catch { /* malformed restored grid: treated as absent, not a crash */ }
  }

  // Already answered, or already asked and refused — a dead connection is asked
  // once per question, not once per render.
  if (sig === heldGridSig || sig === failedGridSig) return;
  // Marked pending before the timer is armed, and marked pending even when an
  // older sample is still in flight: from the pilot's side the answer for this
  // route is on its way either way, and "no data" is the wrong thing to say
  // about a question that has been asked.
  pendingGridSig = sig;
  if (gridSampling) {
    // An in-flight sample for this exact route picks the answer up in its own
    // `finally` — arming a second timer here would put two requests on the
    // wire for one route. A genuinely different route aborts the stale one
    // (ADR 0012 §3) instead of waiting out its round trip first.
    if (sig !== inFlightGridSig) gridController?.abort();
    return;
  }
  gridTimer = setTimeout(() => { void runGridSample(request, sig); }, SAMPLE_DEBOUNCE_MS);
}

/**
 * Sample one advisory grid and keep the answer — unless the mission moved on.
 *
 * The sampler never rejects: a provider that fell over comes back as a grid of
 * null elevations with a note saying why. That field is kept, because a grid of
 * holes is what lets the map hatch the area as missing rather than leave it
 * blank, and the advisory pass turns it into a stated W-WIND-NODATA. What the
 * `coverage: 'empty'` check buys is only that the same dead question is not
 * asked twice.
 *
 * @param {AdvisoryGridRequest} request
 * @param {string} sig
 */
async function runGridSample(request, sig) {
  if (!gridSampler) return;
  const asked = analysisRevision();
  gridSampling = true;
  inFlightGridSig = sig;
  const controller = new AbortController();
  gridController = controller;
  try {
    const next = await gridSampler(request, controller.signal);
    if (!acceptAsync(asked, 'advisory grid')) return;
    advisoryField = next;
    heldGridSig = sig;
    if (next.provenance.coverage === 'empty') failedGridSig = sig;
    scheduleEvidenceSave();
  } catch (err) {
    // Silence, not failure (ADR 0012 §3): a request this host cancelled itself
    // is not an advisory outage. The sampler already keeps an AbortError from
    // reaching here in the ordinary case; this is the backstop.
    if (err?.name === 'AbortError') return;
    // Not expected otherwise: the sampler catches its own provider failures. If
    // something else throws, the advisory says "unavailable" and the rest of
    // the analysis is untouched.
    console.warn('analysis: the advisory grid sample failed.', err);
    failedGridSig = sig;
  } finally {
    gridSampling = false;
    inFlightGridSig = null;
    gridController = null;
    if (pendingGridSig === sig) pendingGridSig = null;
    hostDeps?.update();
    // A route that moved while this one was in flight never got its own timer
    // from refreshGrid — `gridSampling` was true when it came past. But the
    // update() above re-enters refreshGrid with the flag already down, so it
    // may just have armed this very follow-up; the clear keeps the re-arm from
    // leaving two live timers fetching one route.
    if (lastGridRequest && lastGridRequest !== request) {
      const nextSig = gridSignature(lastGridRequest);
      if (nextSig !== heldGridSig && nextSig !== failedGridSig) {
        pendingGridSig = nextSig;
        const pending = lastGridRequest;
        clearTimeout(gridTimer);
        gridTimer = setTimeout(() => { void runGridSample(pending, nextSig); }, SAMPLE_DEBOUNCE_MS);
      }
    }
  }
}

/**
 * What the pipeline reads for the advisory grid: the field, but only when it is
 * the field for *this* route, and whether one is on its way.
 *
 * Holding back a grid sampled for the previous route is the whole discipline
 * here. It would draw yesterday's hills under today's plan, and every colour on
 * them would be wrong in a way nothing on screen could tell you about.
 *
 * @returns {{ field: AdvisoryGridField|null, pending: boolean }}
 */
function advisoryGridReading() {
  const sig = currentGridSig;
  return {
    field: sig && sig === heldGridSig ? advisoryField : null,
    pending: !!sig && sig === pendingGridSig,
  };
}

/**
 * Which advisory grid data is on hand, as a string — the same job
 * terrainSignature() does for the corridor, and folded into the same memo key.
 * `pending` is in it because a pass that is waiting and a pass that has given up
 * produce different snapshots from identical inputs.
 * @returns {string|null}
 */
function advisorySignature() {
  const sig = currentGridSig;
  if (!sig) return null;
  if (sig === heldGridSig && advisoryField) {
    const p = advisoryField.provenance;
    return `${sig}/${p.coverage}:${p.missing}:${p.retrievedAt ?? '-'}`;
  }
  return `${sig}/${sig === pendingGridSig ? 'pending' : 'none'}`;
}

/** The sounding and where it was fetched for, for the pipeline's port. */
function soundingReading() {
  return { levels: windSounding(), at: soundingAt() };
}

/**
 * Which terrain data is on hand, as a string. The pipeline folds this into its
 * cache key so a landed fetch invalidates the memo — both terrain sources are
 * read through ports, so nothing else about the request changes when one
 * arrives.
 *
 * Both are in it because both still feed the analysis: the single-bearing
 * profile drives the legacy terrain and link cards, and the corridor field
 * drives M3b's route-wide clearance, sightline and return checks.
 *
 * @returns {string|null}
 */
function terrainSignature() {
  const p = activeProfile();
  const profileSig = p
    ? `${p.launch.lat.toFixed(4)},${p.launch.lng.toFixed(4)}`
      + `@${Math.round(p.bearingDeg)}/${p.spanKm.toFixed(1)}x${p.points.length}`
    : null;
  const fieldSig = field
    ? `${field.missionId}@${field.revision}/${field.samples.length}`
      + `:${field.provenance.coverage}:${field.provenance.missing}`
      + `:${field.provenance.retrievedAt ?? '-'}`
    : null;
  if (!profileSig && !fieldSig) return null;
  return `${profileSig ?? '-'}|${fieldSig ?? '-'}`;
}

/**
 * The rail inputs that are not (yet) in the mission document, hashed. Half the
 * control surface now writes the document — the loadout, the environment
 * reference and the planning policy are all commands — so `updatedAt` already
 * moves for those. These are the rest: the ones that change what is planned
 * without changing what is saved.
 * @returns {string}
 */
function railSignature() {
  return hashKey(stableStringify({
    // Display units are a rail input to the *text*: the injected warning ports
    // format their sentences through units(), so a units flip changes the answer
    // even though no physics input moved. Leaving it out froze the old wording
    // in the memo while the rest of the app re-formatted (M2 review).
    units: state.units,
    drone: state.droneId,
    battery: state.batteryId,
    parallel: state.parallelPacks,
    payload: state.payloadId,
    extraG: state.extraG,
    packTempF: state.packTempF,
    scenario: state.scenarioId,
    weather: state.weatherId,
    env: state.env,
    landFloorPct: state.landFloorPct,
    gustFactorPct: state.gustFactorPct,
    cruiseAltM: state.cruiseAltM,
    cruiseMode: state.cruiseMode,
    manualMph: state.manualMph,
    linkBand: state.linkBand,
  }));
}

/** @type {ReturnType<typeof newestOnly>} */
const guard = newestOnly();
let analysed = false;

/**
 * What "newest" means to an async provider: the document revision and the rail
 * together. A fetch captures this before it goes out and hands it back on the
 * way in; anything else has been overtaken.
 * @returns {AnalysisRevision}
 */
export function analysisRevision() {
  const doc = missionDocument();
  return doc
    ? { missionId: doc.id, missionUpdatedAt: `${doc.updatedAt}#${railSignature()}` }
    : { missionId: null, missionUpdatedAt: null };
}

/**
 * Whether an async result that was asked for at `revision` may still be applied.
 *
 * A stale result is dropped rather than rendered: it describes a launch point,
 * a loadout or an hour that the pilot has already moved on from, and painting
 * it would put a number on screen that no current input produces.
 *
 * @param {AnalysisRevision} revision what analysisRevision() said at the ask
 * @param {string} label for the log line, e.g. 'terrain profile'
 * @returns {boolean}
 */
export function acceptAsync(revision, label) {
  // Boot: the repository open is still in flight, so nothing has been analysed
  // against a document yet and there is nothing newer for this to be stale
  // against. The fetch that started before the mission existed is the only
  // answer there is.
  if (!analysed || revision?.missionId == null) return true;
  if (guard.accept(revision)) return true;
  console.info(`analysis: dropped a stale ${label} — the mission moved on while it was in flight.`);
  return false;
}

/**
 * Analyse the open mission at the rail's current settings.
 *
 * Null means there is no document yet — openMissionBridge() is still opening
 * the repository, and it asks for its own render when it lands. Every other
 * caller of this gets a complete, immutable answer: no renderer downstream
 * needs to plan anything for itself.
 *
 * @returns {AnalysisSnapshot|null}
 */
export function analyzeNow() {
  const doc = missionDocument();
  if (!doc) return null;

  // Terrain plans on the air at the turnaround, not the air at the launch point,
  // and how far out the turnaround is depends (weakly) on that same air. Probe
  // once at the launch elevation, latch the radius, and let the real plan read
  // the ground under it. With no fetched profile planElevM() hands back the
  // launch elevation and this line changes nothing.
  //
  // With no pack there is no probe: planMission() answers `{ code: 'no_battery' }`
  // and reading .radiusKm off it latched `undefined` as the turnaround distance.
  // Leaving the previous radius latched is the honest fallback — no plan means
  // nothing is asking the terrain module for an elevation anyway.
  const probe = planMission({
    ...missionInputs(battery(), null, { terrain: false }), lite: true,
  });
  if (!('code' in probe)) setTurnaroundKm(probe.radiusKm);

  analysed = true;
  // One revision for both freshness checks: the guard the async landings ask,
  // and the memo key inside the pipeline. Stamping the bare doc.updatedAt into
  // the request instead would give the snapshot a revision acceptAsync always
  // calls stale, and — worse — leave every rail-only input (the units flip
  // included) invisible to the memo (M2 review).
  const revision = analysisRevision();
  guard.begin(revision);

  // Settle the advisory grid before the analysis rather than after it — see
  // refreshGrid. The corridor below is the other way round for a reason that
  // does not apply here.
  refreshGrid(doc);

  const profile = activeProfile();
  const snapshot = analyzeMission({
    doc,
    inputs: missionInputs(),
    revision,
  }, {
    ...PORTS,
    terrainSignature: terrainSignature(),
    // Null until setupAnalysisHost() runs, and the difference is load-bearing:
    // an unwired port is "nobody asked", which the pipeline already reports as
    // W-DATA-TERRAIN-ABSENT, while a wired port with nothing back is "asked and
    // not answered yet" and must never read as clear ground.
    terrainField: sampler ? currentField : null,
    windLevels,
    // M5's advisory ports, read the same way and gated the same way: an unwired
    // grid sampler is "nobody asked" (W-WIND-NODATA), a wired one with nothing
    // back yet is `pending`, and neither ever reads as clear air.
    advisorySignature: advisorySignature(),
    advisoryGrid: gridSampler ? advisoryGridReading : null,
    sounding: soundingReading,
    // Which height the planning wind was read at — but only when a live profile
    // supplied it. On a preset the env's wind is the preset's own figure and
    // belongs to no level, and saying "80 m" about it would be an invention.
    windLevelM: windLevels() ? state.cruiseAltM : null,
    // The band the pilot picked, so the route-wide sightline check runs the same
    // wavelength as the card. linkBand() falls back to the default band rather
    // than answering null, so this is always a number.
    linkGhz: linkBand(state.linkBand).ghz,
    // The single-bearing profile is Open-Meteo elevation data too, and CC BY 4.0
    // travels with it wherever it is shown (task #47). The corridor field carries
    // its own licence line in its provenance; this fills in for the profile,
    // which is fetched by src/terrain.js and has no provenance block of its own.
    // The two can only ever name the same provider, so there is nothing here for
    // them to disagree about.
    ...(profile
      ? { provenance: { terrainSource: TERRAIN_SOURCE, terrainAttribution: OPEN_METEO_ATTRIBUTION } }
      : null),
  });

  // Ask for the ground along the leg this plan actually flies (debounced, and a
  // no-op while the profile on hand still answers the question). With no pack
  // there is no radius to profile, which is what the null plan says.
  if (snapshot.plan) refreshTerrain(snapshot.plan.radiusKm);
  // …and the ground under the whole corridor, which is a question about the
  // route rather than about the pack: a mission with waypoints and no battery
  // still has terrain under it, and the clearance answer does not wait on a
  // plan. The corridor comes off the snapshot because the snapshot is what
  // publishes it — sampling before this point would be sampling a route the
  // analysis had not yet agreed to.
  refreshField(snapshot.corridor);
  // The forecast ages while every other input holds still, so the next
  // re-analysis cannot wait on an edit: wake once at the next 6 h / 24 h
  // boundary (ADR 0012 §1), and not at all when none lies ahead.
  armForecastAgeTimer(doc);
  // Consumed either way: refreshGrid and refreshField above each had their one
  // look at whatever was restored for this mission. Admitted or declined, a
  // stale reference sitting in module state forever is only confusing —
  // clearing it is what makes this a one-shot restore rather than a standing
  // override that could reassert itself on a later pass.
  pendingRestore = null;
  return snapshot;
}
