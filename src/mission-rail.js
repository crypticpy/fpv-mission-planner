// mission-rail.js — the transitional adapter between the control rail and the
// mission document (M1b only; M2 deletes this file).
//
// src/mission-bridge.js owns the document and knows nothing about src/state.js,
// which is what lets it sit under `strict` in tsconfig's include list. This is
// the other half: the rail-shaped functions the bridge is handed at boot. Two
// jobs, and only two —
//
//   readLaunch/writeLaunch — the launch point still lives on the rail (the `map`
//     key in src/store.js, plus the elevation field in state.env) because five
//     consumers still read it there. This keeps the rail and the document saying
//     the same thing, in whichever direction the change came from.
//
//   seed — a mission being created now takes a snapshot of the loadout, the
//     weather reference and the planning policy as the rail has them. Snapshots,
//     not references (ADR 0002): a catalog edit next month must not reach into a
//     saved mission. Deliberately *not* re-synced on later renders — opening a
//     mission flown on another rig and silently overwriting its loadout with
//     today's is the drift this file exists to avoid. Keeping the two in step
//     while a mission is open is M2's job, once the analysis pipeline reads the
//     document rather than the rail.
import { aircraftSnapshot, batterySnapshot, payloadSnapshot } from './domain/mission/mission-schema.js';
import { state, drone, loadoutBattery, payload } from './state.js';
import { launchPoint } from './weather.js';
import { loadMapState, saveMapState } from './store.js';
import { setLaunchPoint } from './map.js';
import { U } from './domain/physics.js';

let deps = null; // injected by app.js: { populateControls }

export function setupMissionRail(d) { deps = d; }

/** Where the rail thinks the launch point is, in the document's units. */
function readLaunch() {
  const pt = launchPoint();
  const elevFt = state.env.elevFt;
  return {
    latitude: pt.lat,
    longitude: pt.lng,
    elevationMslM: Number.isFinite(elevFt) ? U.ftToM(elevFt) : null,
  };
}

/**
 * Put the rail where the mission says the launch is — on boot, and whenever
 * another mission is opened.
 *
 * Storage first, then the map: src/weather.js reads the launch point out of
 * storage, and the map may not have initialized yet (setLaunchPoint no-ops until
 * it has, and initMap reads the same saved point). The elevation applies unless
 * live weather owns the environment, which is the rule flyToSpot already uses —
 * live is about to fetch the real elevation for this point anyway.
 */
function writeLaunch(launch) {
  const pt = { lat: launch.latitude, lng: launch.longitude };
  const saved = loadMapState();
  saveMapState({ ...pt, zoom: saved?.zoom ?? 13, baseLayer: saved?.baseLayer ?? 'satellite' });
  if (launch.elevationMslM != null && state.weatherId !== 'live') {
    // The rail speaks whole feet, so this is the precision the document's launch
    // elevation round-trips at while the bridge is in place.
    state.env.elevFt = Math.round(U.mToFt(launch.elevationMslM));
    deps?.populateControls?.();
  }
  setLaunchPoint(pt);
}

/** 'Mission 2026-07-30 14:32' — sortable, and says when without pretending to say where. */
function defaultTitle(at = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `Mission ${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} `
    + `${p(at.getHours())}:${p(at.getMinutes())}`;
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

/** Everything but the launch point that a new mission takes from the rail. */
function seed() {
  const flying = drone();
  const batt = loadoutBattery();
  return {
    title: defaultTitle(),
    // The overlay stamps `calibration` on the record it returns and nothing else
    // in the catalog carries that field, so this is the test for "these numbers
    // are the pilot's own flights rather than the spec sheet's".
    aircraft: aircraftSnapshot(flying, { calibrated: flying.calibration != null }),
    battery: batt ? batterySnapshot(batt) : null,
    payload: payloadSnapshot(payload(), { extraG: state.extraG }),
    environmentReference: environmentReference(),
    planningPolicy: {
      reserve: { landFloorPct: state.landFloorPct },
      gustFactor: state.gustFactorPct / 100,
      windLevel: state.cruiseAltM,
      radioBand: state.linkBand,
    },
  };
}

/** The whole of what src/mission-bridge.js is allowed to know about the rail. */
export const railPort = { readLaunch, writeLaunch, seed };
