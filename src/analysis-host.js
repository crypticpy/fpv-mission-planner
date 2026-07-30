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
// It owns three things and nothing else:
//
//   the ports — built once, because which providers are wired up is part of the
//     analysis question (a null one becomes a stated `unknown` constraint);
//
//   analyzeNow() — the current mission document plus the rail's inputs, in, one
//     AnalysisSnapshot out. Every number and every warning on screen comes from
//     the object this returns;
//
//   staleness — one newestOnly() guard, keyed on the document revision and the
//     rail inputs together, that both async landings (the terrain profile fetch
//     and the live-weather fetch) check before they apply anything. Before this
//     there were two ad-hoc sequence counters that could each only see their
//     own fetch; a launch move between the ask and the answer was invisible to
//     both.
import { planMission } from './domain/physics.js';
import { planRoute } from './domain/route.js';
import { analyzeMission, newestOnly } from './application/analysis/analyze.js';
import { hashKey, stableStringify } from './application/analysis/analysis-contracts.js';
import { missionDocument } from './mission-bridge.js';
import { state, battery, missionInputs } from './state.js';
import { activeProfile, setTurnaroundKm } from './terrain.js';
import { zeroRadiusNote } from './render/dashboard.js';
import { linkStats, linkWarnings, refreshTerrain, terrainWarnings } from './render/terrain.js';

/** @typedef {import('./application/analysis/analysis-contracts.js').AnalysisRevision} AnalysisRevision */
/** @typedef {import('./application/analysis/analysis-contracts.js').AnalysisSnapshot} AnalysisSnapshot */

/** Who supplies the ground when a profile is on hand. */
const TERRAIN_SOURCE = 'Open-Meteo elevation API';

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
});

/**
 * Which elevation profile is on hand, as a string. The pipeline folds this into
 * its cache key so a landed fetch invalidates the memo — the profile is read
 * through a port, so nothing else about the request changes when it arrives.
 * @returns {string|null}
 */
function terrainSignature() {
  const p = activeProfile();
  if (!p) return null;
  return `${p.launch.lat.toFixed(4)},${p.launch.lng.toFixed(4)}`
    + `@${Math.round(p.bearingDeg)}/${p.spanKm.toFixed(1)}x${p.points.length}`;
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
  setTurnaroundKm(planMission({
    ...missionInputs(battery(), null, { terrain: false }), lite: true,
  }).radiusKm);

  analysed = true;
  // One revision for both freshness checks: the guard the async landings ask,
  // and the memo key inside the pipeline. Stamping the bare doc.updatedAt into
  // the request instead would give the snapshot a revision acceptAsync always
  // calls stale, and — worse — leave every rail-only input (the units flip
  // included) invisible to the memo (M2 review).
  const revision = analysisRevision();
  guard.begin(revision);

  const profile = activeProfile();
  const snapshot = analyzeMission({
    doc,
    inputs: missionInputs(),
    revision,
  }, {
    ...PORTS,
    terrainSignature: terrainSignature(),
    ...(profile ? { provenance: { terrainSource: TERRAIN_SOURCE } } : null),
  });

  // Ask for the ground along the leg this plan actually flies (debounced, and a
  // no-op while the profile on hand still answers the question). With no pack
  // there is no radius to profile, which is what the null plan says.
  if (snapshot.plan) refreshTerrain(snapshot.plan.radiusKm);
  return snapshot;
}
