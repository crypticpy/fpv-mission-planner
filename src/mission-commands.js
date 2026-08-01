// mission-commands.js — the control rail's state, projected into commands on
// the mission document.
//
// One direction only. src/mission-bridge.js owns the document and knows nothing
// about src/state.js, which is what keeps it checkable under `strict`; this is
// the other side of that boundary — the small projections that turn "the pilot
// changed a control" into a command, and the one restore path that puts the map
// pin back where a reopened mission says the launch is.
//
// There is no read-back and no per-render reconciliation. M1b kept the rail and
// the document in step through a bridge that ran once per render pass and
// guessed, by comparing coordinates, whether anything had moved; every control
// that can move the launch now says so at its own call site instead. What is
// left here is a projection, not a synchroniser: nothing in this file reads the
// document to decide what to write.
//
// Snapshots, not references (ADR 0002): the loadout records are deep-copied by
// the reducer on the way in, so a catalog edit next month cannot reach into a
// mission that was planned and saved today.
import { aircraftSnapshot, batterySnapshot, payloadSnapshot } from './domain/mission/mission-schema.js';
import { missionReduce } from './domain/mission/mission-reducer.js';
import { ROUTE_TEMPLATES, templateCommands } from './domain/mission/route-templates.js';
import { state, drone, loadoutBattery, payload } from './state.js';
import { dispatch, missionDocument } from './mission-bridge.js';
import { launchPoint } from './weather.js';
import { loadMapState, saveMapState } from './store.js';
import { setLaunchPoint, setMissionEditor } from './presentation/map/map-view.js';
import { populateControls } from './render/controls.js';
import { U } from './domain/physics.js';

/* Every raiser here is called from a control handler that renders on its own
   way out, so none of them asks the bridge for a second render pass. */
const QUIET = { render: false };

/* ---------- the projections ---------- */

/** 'Mission 2026-07-30 14:32' — sortable, and says when without pretending to say where. */
function defaultTitle(at = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `Mission ${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} `
    + `${p(at.getHours())}:${p(at.getMinutes())}`;
}

/** The three loadout slots as the document embeds them. */
function loadout() {
  const flying = drone();
  const batt = loadoutBattery();
  return {
    // The calibration overlay stamps `calibration` on the record it returns and
    // nothing else in the catalog carries that field, so this is the test for
    // "these numbers are the pilot's own flights rather than the spec sheet's".
    aircraft: aircraftSnapshot(flying, {
      calibrated: flying.calibration != null,
      nFlights: flying.calibration?.nFlights ?? null,
    }),
    battery: batt ? batterySnapshot(batt) : null,
    payload: payloadSnapshot(payload(), { extraG: state.extraG }),
  };
}

/**
 * The rail's weather, in SI, labelled with where it came from.
 *
 * `provenance` (ADR 0012 §1) is the fetch bag `fetchLiveEnv`/`fetchArchiveEnv`
 * stamp on the way in — additive, and null by default: a manual or preset
 * environment has no fetch to be honest about, so it keeps the null this
 * function has always written for them.
 *
 * @param {{ source: string, retrievedAt: string, validAt: string|null }|null} [provenance]
 */
function environmentReference(provenance = null) {
  const env = state.env;
  const source = state.weatherId === 'live' ? 'live'
    : state.weatherId === 'custom' ? 'manual'
    : 'preset';
  return {
    source,
    presetId: source === 'preset' ? state.weatherId : null,
    capturedAt: new Date().toISOString(),
    values: {
      temperatureC: U.fToC(env.tempF),
      relativeHumidityPct: env.rhPct,
      windAvgMs: U.mphToMs(env.windMph),
      windGustMs: U.mphToMs(env.gustMph),
      windFromDeg: env.windFromDeg,
      elevationMslM: U.ftToM(env.elevFt),
    },
    provenance,
  };
}

/** The knobs that say how much margin the plan is asked to hold. */
function planningPolicy() {
  return {
    reserve: { landFloorPct: state.landFloorPct },
    gustFactor: state.gustFactorPct / 100,
    windLevel: state.cruiseAltM,
    radioBand: state.linkBand,
  };
}

/**
 * The launch point as the document spells it.
 *
 * The elevation always travels with it: `setLaunch` reads an absent
 * `elevationMslM` as "this site's elevation is unknown" and drops every resolved
 * launch-relative altitude, so omitting the field the rail already holds would
 * throw away a number nobody asked to discard.
 *
 * @param {{ lat: number, lng: number }} [pt] defaults to where the launch is now
 */
function launchOf(pt = launchPoint()) {
  const elevFt = state.env.elevFt;
  return {
    latitude: pt.lat,
    longitude: pt.lng,
    elevationMslM: Number.isFinite(elevFt) ? U.ftToM(elevFt) : null,
  };
}

/** Everything a mission being created now takes from the rail. */
export function missionSeed() {
  return {
    title: defaultTitle(),
    launch: launchOf(),
    ...loadout(),
    environmentReference: environmentReference(),
    planningPolicy: planningPolicy(),
  };
}

/* ---------- the raisers (called from the control handlers in app.js) ---------- */

/** The rig, the pack and the payload as they now stand. */
export function pushLoadout() {
  dispatch({ type: 'snapshotLoadout', payload: loadout() }, QUIET);
}

/**
 * The weather the plan is being flown against, and where it came from.
 * @param {{ source: string, retrievedAt: string, validAt: string|null }|null} [provenance]
 *   the fetch bag from `fetchLiveEnv`/`fetchArchiveEnv`; omitted (null) for a
 *   manual or preset environment, which have no fetch to be honest about.
 */
export function pushEnvironment(provenance = null) {
  dispatch({ type: 'setEnvironmentReference', payload: environmentReference(provenance) }, QUIET);
}

/** Reserve floor, gust factor, wind level, radio band. */
export function pushPolicy() {
  dispatch({ type: 'setPlanningPolicy', payload: planningPolicy() }, QUIET);
}

/**
 * Move the launch point on the document — the pin, a saved spot, "use my
 * location", and the elevation a live fetch resolves for the point it was made
 * for. Every one of those raises this itself; nothing reconciles afterwards.
 *
 * @param {{ lat: number, lng: number }} [pt] defaults to where the launch is now
 */
export function pushLaunch(pt = launchPoint()) {
  dispatch({ type: 'setLaunch', payload: launchOf(pt) }, QUIET);
}

/**
 * Put the rail where a just-opened mission says the launch is — on boot, and
 * whenever another mission is opened, imported, or deleted out from under the
 * one on screen.
 *
 * Storage first, then the map: src/weather.js falls back to the saved point
 * whenever no document is open, and the map may not have initialized yet
 * (setLaunchPoint no-ops until it has, and initMap reads the same saved point).
 * The elevation applies unless live weather owns the environment, which is the
 * rule flyToSpot already uses — live is about to fetch the real elevation for
 * this point anyway.
 *
 * @param {{ latitude: number, longitude: number, elevationMslM: number|null }} launch
 */
export function restoreLaunch(launch) {
  const pt = { lat: launch.latitude, lng: launch.longitude };
  const saved = loadMapState();
  saveMapState({ ...pt, zoom: saved?.zoom ?? 13, baseLayer: saved?.baseLayer ?? 'satellite' });
  if (launch.elevationMslM != null && state.weatherId !== 'live') {
    // The rail types whole feet, so this is the precision the document's launch
    // elevation round-trips at.
    state.env.elevFt = Math.round(U.mToFt(launch.elevationMslM));
    populateControls();
  }
  setLaunchPoint(pt);
}

/* ---------- the segment editor's port (M7, ADR 0011 §5) ---------- */
//
// The map got its first editing surface below the launch point in M7: an intent
// picker, an altitude, a subject, a camera. Those commands have to travel the
// same way every other command in this file does — through the bridge, from
// outside presentation/ — and the map cannot import the bridge itself without
// becoming a second writer.
//
// So this file registers a port with the map instead. It is the one place in the
// module that reads the document, and the header's rule survives that: it reads
// to *project*, never to decide what to write. `scene.subjects` is a roster of
// places, and no derived number can stand in for a place — the analysis publishes
// what a shot is, not where its subject stands (ADR 0011 §3), so a marker has to
// come from here. The camera profile and the templates are the same case: they
// are authored state that no pass computes.
//
// The one thing the port does that a plain `dispatch` cannot is *say why not*.
// `dispatch` answers a rejected command with `false` and logs the reducer's
// explanation to the console, which is the right shape for a control that was
// only ever driven by the rail's own validated inputs and the wrong shape for a
// pilot typing an orbit radius. Since `missionReduce` is pure and a rejection
// leaves the document identical, the reason can be recovered by running the same
// command against the same document again and keeping the warning — a second
// reduction whose result is discarded, and which cannot have a side effect
// because the first one did not have one either.

/**
 * @typedef {import('./presentation/map/map-adapter.js').SceneSubject} SceneSubject
 * @typedef {import('./presentation/map/segment-editor.js').SceneProjection} SceneProjection
 * @typedef {import('./presentation/map/segment-editor.js').EditResult} EditResult
 */

/** The cinematic half of the open document, in the shape the map reads. */
function sceneProjection() {
  const scene = missionDocument()?.scene;
  return {
    subjects: (scene?.subjects ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      lat: s.latitude,
      lng: s.longitude,
      // Carried, not defaulted: a subject nobody has measured is not a subject at
      // sea level with a one-metre radius, and 3D has to tell those apart.
      elevationMslM: s.elevationMslM ?? null,
      radiusM: s.radiusM ?? null,
    })),
    cameraProfile: scene?.cameraProfile ?? null,
    templates: (scene?.templates ?? []).map((t) => ({ ...t })),
    dive: projectDive(scene?.dive),
  };
}

/**
 * The dive plan in the map's coordinate vocabulary, or null when the mission
 * carries none. Gates are authored geometry the same way subjects are — no
 * pass computes where a recovery gate stands — and the two profile numbers ride
 * along carried, not defaulted, because the pullout-clearance chip may only
 * speak from authored state (ADR 0008).
 * @param {*} dive
 * @returns {import('./presentation/map/map-adapter.js').DiveProjection|null}
 */
function projectDive(dive) {
  if (!dive) return null;
  return {
    gates: (dive.gates ?? []).map((g) => ({
      id: g.id,
      kind: g.kind,
      lat: g.latitude,
      lng: g.longitude,
      altitudeMslM: g.altitudeMslM,
      radiusM: g.radiusM ?? null,
    })),
    bailout: dive.bailout
      ? {
        name: dive.bailout.name,
        lat: dive.bailout.latitude,
        lng: dive.bailout.longitude,
        elevationMslM: dive.bailout.elevationMslM ?? null,
      }
      : null,
    rthAltitudeMslM: dive.rthAltitudeMslM ?? null,
    speedMs: dive.speedMs ?? null,
    pulloutLoadG: dive.pulloutLoadG ?? null,
  };
}

/**
 * One command in, and either "it landed" or the reducer's own sentence about why
 * it did not.
 * @param {object} command
 * @returns {EditResult}
 */
function raiseEdit(command) {
  if (dispatch(command)) return { ok: true, message: null };
  return { ok: false, message: rejectionReason(command) };
}

/**
 * Why the bridge would not take that command, in the reducer's words rather than
 * a paraphrase — the same rule the warning rail follows for a constraint's text
 * (ADR 0008): the producer knows which field it refused.
 * @param {object} command
 * @returns {string}
 */
function rejectionReason(command) {
  const doc = missionDocument();
  if (!doc) return 'No mission is open yet — nothing to edit.';
  /** @type {string|null} */
  let message = null;
  missionReduce(doc, command, { onWarning: (w) => { message ??= w.message; } });
  return message ?? 'That command left the mission unchanged.';
}

/**
 * The dive workspace's authored context: the aircraft the mission snapshotted
 * (which the analysis deliberately does not republish) and the template row,
 * each template carrying the reason it would decline right now — so the map can
 * disable a chip with the same sentence applying it would have answered with.
 * @returns {{ aircraftName: string|null, templates: { id: string, label: string, hint: string, blocked: string|null }[] }}
 */
function diveWorkspace() {
  const doc = missionDocument();
  return {
    aircraftName: doc?.aircraftSnapshot?.name ?? null,
    templates: ROUTE_TEMPLATES.map((t) => {
      const plan = doc ? templateCommands(t.id, doc) : { blocked: 'No mission is open yet — nothing to edit.' };
      return { id: t.id, label: t.label, hint: t.hint, blocked: plan.blocked ?? null };
    }),
  };
}

/**
 * Seeds one template through the same dispatch every hand edit takes: each
 * command either lands or, on the first refusal, the whole application stops
 * and answers with the reducer's own sentence. Set-by-kind gate commands make
 * a partial dive application safe to re-run; the waypoint templates are guarded
 * against partial state by refusing non-empty routes in the first place.
 * @param {string} id
 * @returns {EditResult}
 */
function applyTemplate(id) {
  const doc = missionDocument();
  if (!doc) return { ok: false, message: 'No mission is open yet — nothing to edit.' };
  const plan = templateCommands(id, doc);
  if (plan.blocked) return { ok: false, message: plan.blocked };
  for (const command of plan.commands ?? []) {
    if (!dispatch(command)) return { ok: false, message: rejectionReason(command) };
  }
  return { ok: true, message: null };
}

/* Registered at import rather than from a setup call: app.js imports this module
   for its raisers, the map's own setter is a no-op until the map exists, and the
   port holds no state that needs a boot order. */
setMissionEditor({ scene: sceneProjection, raise: raiseEdit, dive: diveWorkspace, applyTemplate });
