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
import { state, drone, loadoutBattery, payload } from './state.js';
import { dispatch } from './mission-bridge.js';
import { launchPoint } from './weather.js';
import { loadMapState, saveMapState } from './store.js';
import { setLaunchPoint } from './map.js';
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
    aircraft: aircraftSnapshot(flying, { calibrated: flying.calibration != null }),
    battery: batt ? batterySnapshot(batt) : null,
    payload: payloadSnapshot(payload(), { extraG: state.extraG }),
  };
}

/** The rail's weather, in SI, labelled with where it came from. */
function environmentReference() {
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
    provenance: null,
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

/** The weather the plan is being flown against, and where it came from. */
export function pushEnvironment() {
  dispatch({ type: 'setEnvironmentReference', payload: environmentReference() }, QUIET);
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
