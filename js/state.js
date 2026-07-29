// state.js — the control surface's state, its session persistence, and the
// selection helpers that read it. Owns nothing about rendering: the render
// modules import this, never the other way round.
import {
  DRONES, PAYLOADS, WEATHER, SCENARIOS,
  allBatteries, allManufacturers,
} from './data.js';
import { compatible, compatibleBatteries as dronePacks } from './registry.js';
import { get as storeGet, set as storeSet } from './store.js';
import { parallelBattery, U } from './physics.js';
import { unitSystem } from './units.js';

export const state = {
  view: 'dash', // 'dash' | 'map'
  units: 'imperial',
  droneId: 'moz7v2',
  manufacturerId: 'all',
  batteryId: 'nav5000',
  parallelPacks: false,
  payloadId: 'naked',
  extraG: 0,
  weatherId: 'live', // 'live' | preset id | 'custom' — live is the boot default
  scenarioId: 'longrange',
  env: { elevFt: 800, tempF: 75, rhPct: 40, windMph: 3, gustMph: 5, windFromDeg: 170, windMode: 'headOut' },
  reservePct: 20,
  cruiseMode: 'real',
  manualMph: 40,
  speedMetric: 'radius',
  detail: 'full', // 'full' | 'beginner' — how much of the physics is on screen
};

export const beginner = () => state.detail === 'beginner';

/* ---------- session persistence ---------- */

export function saveSession() {
  storeSet('session', state);
}

/**
 * Restore the control surface, all-or-nothing: any unknown id or out-of-range
 * number discards the whole blob, because a half-restored loadout reads as a
 * plan for a rig the pilot never selected. Returns the saved view, if valid.
 *
 * `detail` is the one exception: it is a view preference, not part of the plan,
 * so it falls back to 'full' on its own rather than voiding a blob written
 * before the toggle existed.
 */
export function restoreSession() {
  const s = storeGet('session', null);
  if (!s || typeof s !== 'object' || !s.env || typeof s.env !== 'object') return null;
  const env = s.env;
  const num = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  const savedDrone = DRONES.find(d => d.id === s.droneId);
  const batt = allBatteries().find(b => b.id === s.batteryId && compatible(savedDrone, b));
  const ok = savedDrone
    && batt
    && (s.manufacturerId === 'all'
      || (batt.manufacturerId === s.manufacturerId && allManufacturers().some(m => m.id === s.manufacturerId)))
    && PAYLOADS.some(p => p.id === s.payloadId)
    && SCENARIOS.some(x => x.id === s.scenarioId)
    && (s.weatherId === 'live' || s.weatherId === 'custom' || WEATHER.some(w => w.id === s.weatherId))
    && ['imperial', 'metric'].includes(s.units)
    && ['dash', 'map'].includes(s.view)
    && ['real', 'range', 'manual'].includes(s.cruiseMode)
    && ['radius', 'time'].includes(s.speedMetric)
    && ['headOut', 'tailOut', 'cross'].includes(env.windMode)
    && typeof s.parallelPacks === 'boolean'
    && num(s.extraG, 0, 500) && num(s.reservePct, 10, 40) && num(s.manualMph, 5, 120)
    && num(env.elevFt, -1500, 30000) && num(env.tempF, -60, 140) && num(env.rhPct, 0, 100)
    && num(env.windMph, 0, 120) && num(env.gustMph, 0, 160) && num(env.windFromDeg, 0, 359);
  if (!ok) return null;
  Object.assign(state, {
    units: s.units, droneId: s.droneId, manufacturerId: s.manufacturerId, batteryId: s.batteryId,
    parallelPacks: s.parallelPacks, payloadId: s.payloadId, extraG: s.extraG,
    weatherId: s.weatherId, scenarioId: s.scenarioId, reservePct: s.reservePct,
    cruiseMode: s.cruiseMode, manualMph: s.manualMph, speedMetric: s.speedMetric,
    detail: ['full', 'beginner'].includes(s.detail) ? s.detail : 'full',
    env: {
      elevFt: env.elevFt, tempF: env.tempF, rhPct: env.rhPct, windMph: env.windMph,
      gustMph: env.gustMph, windFromDeg: env.windFromDeg, windMode: env.windMode,
    },
  });
  return s.view;
}

export function drone() { return DRONES.find(d => d.id === state.droneId); }
export function droneBatteries() {
  return dronePacks(drone());
}
export function compatibleBatteries() {
  const batts = droneBatteries();
  return state.manufacturerId === 'all'
    ? batts
    : batts.filter(b => b.manufacturerId === state.manufacturerId);
}
export function battery() {
  const list = compatibleBatteries();
  return list.find(b => b.id === state.batteryId) || list[0];
}
export function manufacturer(id) {
  return allManufacturers().find(m => m.id === id);
}
export function payload() { return PAYLOADS.find(p => p.id === state.payloadId) || PAYLOADS[0]; }
export function scenario() { return SCENARIOS.find(s => s.id === state.scenarioId) || SCENARIOS[0]; }
export function units() { return unitSystem(state.units); }
export function loadoutBattery(batt = battery()) {
  // Nothing in the registry fits this rig. Hand back null rather than a shell
  // object, so missionInputs() passes a falsy battery and planMission answers
  // with its handled `no_battery` code instead of doing arithmetic on holes.
  if (!batt) return null;
  if (!state.parallelPacks) return { ...batt, packCount: 1, extraCdA: 0 };
  const d = drone();
  return parallelBattery(batt, 2, {
    harnessMassG: d.parallelHarnessMassG || 0,
    extraCdA: d.parallelPackCdA || 0,
  });
}

export function missionInputs(batt = battery(), envOverride = null) {
  const env = envOverride || state.env;
  const configuredBatt = loadoutBattery(batt);
  return {
    drone: drone(),
    battery: configuredBatt,
    payloadG: payload().massG,
    payloadCdA: payload().cdA,
    extraG: state.extraG,
    env: {
      elevM: U.ftToM(env.elevFt),
      tempC: U.fToC(env.tempF),
      rhPct: env.rhPct,
      windAvgMs: U.mphToMs(env.windMph),
      windGustMs: U.mphToMs(env.gustMph),
      windFromDeg: env.windFromDeg,
      windMode: env.windMode,
    },
    reservePct: state.reservePct,
    cruiseMode: state.cruiseMode,
    realVMs: drone().cruiseMs * scenario().speedFactor,
    manualVMs: U.mphToMs(state.manualMph),
    overheadF: scenario().overheadFactor,
  };
}

// The cruise modes that ask the pilot to think in airspeed rather than in flying
// style. Beginner mode drops both and plans the realistic cruise.
export const EXPERT_CRUISE_MODES = ['range', 'manual'];
