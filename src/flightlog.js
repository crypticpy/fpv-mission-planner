// flightlog.js — the logbook, the fit it adds up to, and the one switch that
// applies it (§6.2). calibrate.js knows how to invert a single flight; this
// module owns the parts that make a pile of flights into an airframe number a
// pilot can decide to trust: persistence, the two-step aggregation, the
// confidence gate, and the overlay `state.drone()` reads.
//
// The trust rules from §6.2, and where each one lives here:
//   - Never silently apply a fit → `calibratedDrone()` returns the record
//     untouched unless `appliedState()` says the switch is on, and the only
//     things that turn it on are `setCalibrationApplied()` and the announced
//     one-time default at the 'default' tier.
//   - Confidence gating → `fit.tier`, straight out of calibrate.confidence().
//   - Refuse absurd solutions → clampToClass judges every solve. A refused
//     flight is still stored (it happened) and still listed, with its reason,
//     but it is not in the mean.
//   - The overlay never mutates a catalog record: it spreads a new object.
//
// Layering: this module reads storage and the hardware registry, and is read by
// state.js. It must never import state.js or anything under render/ — every
// flight carries the conditions it was flown in, so nothing here needs the
// control rail's current opinion about the weather.

import { get as storeGet, set as storeSet } from './store.js';
import { allBatteries } from './registry.js';
import { classForDrone } from './catalog/classes.js';
import { clampToClass, confidence, solveCdA, solveEtaProp } from './calibrate.js';

const LOGS_KEY = 'flight-logs';
const APPLIED_KEY = 'calibration-applied';

// Two accepted flights whose airspeeds differ by at least this much are §6.2's
// "two speeds" — enough separation that drag and efficiency stop trading off
// against each other in the fit. A hover test (0 m/s) plus any real cruise leg
// clears it, which is exactly the pair the doc tells pilots to go fly.
const SPEED_SPREAD_MS = 3;

// Relative humidity barely moves air density, so a log that never recorded it
// is planned at the middling value rather than discarded.
const DEFAULT_RH_PCT = 50;

export const KINDS = ['hover', 'cruise'];
export const WIND_RELATIONS = ['mixed', 'head', 'tail', 'cross'];

/* ---------- the record ---------- */

/**
 * Sanitize one stored flight. Per-record, like loadSpots() and
 * loadCustomDrones(): one corrupt entry is dropped and the rest of the logbook
 * survives. Everything tested here is something a solver reads without a
 * fallback, so anything that gets through can be inverted — or honestly
 * refused, which is a different thing from being unparseable.
 *
 * A log references its drone and pack by id and never embeds them: the pilot
 * who re-weighs a pack wants every flight on it to re-solve, and a log whose
 * drone has been deleted is skipped harmlessly (nothing ever asks for it).
 */
export function normalizeLog(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const inRange = (v, lo, hi) => (num(v) !== null && v >= lo && v <= hi ? v : null);

  const id = str(raw.id);
  const droneId = str(raw.droneId);
  const batteryId = str(raw.batteryId);
  const kind = KINDS.includes(raw.kind) ? raw.kind : null;
  const minutes = inRange(raw.minutes, 0.05, 240);
  if (!id || !droneId || !batteryId || !kind || minutes === null) return null;

  // One of the two charge readings has to be there or there is no landed state
  // of charge, and without that there is no average power and no fit.
  const mahIn = inRange(raw.mahIn, 0, 60000);
  const landedSocPct = inRange(raw.landedSocPct, 0, 100);
  if (mahIn === null && landedSocPct === null) return null;

  const tempC = inRange(raw.tempC, -50, 60);
  if (tempC === null) return null;

  // A cruise leg with no ground speed is a hover test that flew somewhere:
  // there is no airspeed to invert drag at, so the record cannot mean what it
  // claims to.
  const avgSpeedMs = inRange(raw.avgSpeedMs, 0.1, 100);
  if (kind === 'cruise' && avgSpeedMs === null) return null;

  return {
    id,
    droneId,
    batteryId,
    kind,
    minutes,
    mahIn,
    landedSocPct,
    // The loadout the flight was flown with, snapshotted at save time: mass
    // moves the solve, and a camera's drag area has to come back off a cruise
    // fit or it lands on the airframe.
    payloadG: inRange(raw.payloadG, 0, 5000) ?? 0,
    payloadCdA: inRange(raw.payloadCdA, 0, 0.5) ?? 0,
    extraG: inRange(raw.extraG, 0, 5000) ?? 0,
    avgSpeedMs,
    distanceKm: inRange(raw.distanceKm, 0.001, 500),
    windMs: inRange(raw.windMs, 0, 60) ?? 0,
    windRelation: WIND_RELATIONS.includes(raw.windRelation) ? raw.windRelation : 'mixed',
    tempC,
    elevM: inRange(raw.elevM, -450, 9000) ?? 0,
    rhPct: inRange(raw.rhPct, 0, 100) ?? DEFAULT_RH_PCT,
    // Local wall-clock 'YYYY-MM-DDTHH:mm', or null. Never a UTC instant: it is
    // what the pilot's clock said, and it is what the weather archive is asked
    // about (same wall-clock discipline as weather.js's forecast hours).
    at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str(raw.at)) ? str(raw.at).slice(0, 16) : null,
    notes: str(raw.notes).slice(0, 240),
    // What the solve said at save time, kept for the list even when the fit is
    // later recomputed against different numbers. `{ field, value, ok, reason }`.
    solved: normalizeSolved(raw.solved),
  };
}

function normalizeSolved(s) {
  if (!s || typeof s !== 'object') return null;
  const value = typeof s.value === 'number' && Number.isFinite(s.value) ? s.value : null;
  return {
    field: s.field === 'etaProp' || s.field === 'cdA' ? s.field : null,
    value,
    ok: s.ok === true,
    reason: typeof s.reason === 'string' ? s.reason : null,
  };
}

/* ---------- persistence ---------- */

// Bumped by every write here, so the fit cache below cannot serve a stale mean
// after a save or a delete.
let logVersion = 0;

export function loadFlightLogs() {
  const raw = storeGet(LOGS_KEY, []);
  return Array.isArray(raw) ? raw.map(normalizeLog).filter(Boolean) : [];
}

/** This airframe's flights, newest first — the logbook reads as a stack. */
export function logsForDrone(droneId) {
  return loadFlightLogs()
    .filter(l => l.droneId === droneId)
    .sort((a, b) => (b.at || '').localeCompare(a.at || '') || b.id.localeCompare(a.id));
}

/** Upsert by id. Returns the stored record, or null when it wasn't a flight. */
export function saveFlightLog(log) {
  const clean = normalizeLog(log);
  if (!clean) return null;
  const list = loadFlightLogs().filter(l => l.id !== clean.id);
  list.push(clean);
  storeSet(LOGS_KEY, list);
  logVersion++;
  return clean;
}

export function deleteFlightLog(id) {
  storeSet(LOGS_KEY, loadFlightLogs().filter(l => l.id !== id));
  logVersion++;
}

/** Unique enough for a logbook one pilot types into by hand. */
export function newLogId() {
  return `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/* ---------- solving one flight ---------- */

/**
 * The along-track and across-track wind a cruise leg flew in. The form asks how
 * the leg sat in the wind rather than for a signed component, because that is
 * the question a pilot can answer — and because 'mixed' (out and back) is the
 * commonest honest answer: the headwind on the way out is the tailwind on the
 * way home, so the average along-track component is zero.
 */
function windComponents(log) {
  const w = log.windMs || 0;
  if (log.windRelation === 'head') return { headwindMs: w, crosswindMs: 0 };
  if (log.windRelation === 'tail') return { headwindMs: -w, crosswindMs: 0 };
  if (log.windRelation === 'cross') return { headwindMs: 0, crosswindMs: w };
  return { headwindMs: 0, crosswindMs: 0 };
}

/**
 * Invert one flight against `drone`, and judge the answer against the airframe's
 * class ranges. `etaPin` replaces the record's own etaProp for a cruise solve —
 * §6.2's second step, where drag is fitted against the efficiency the hover
 * tests already established rather than against the catalog's guess.
 *
 * Returns `{ field, value, ok, reason, airspeedMs, pAvgW }` — clampToClass's own
 * shape, plus what the flight is worth knowing for the list.
 */
export function solveLog(log, drone, etaPin = null) {
  const battery = allBatteries().find(b => b.id === log.batteryId);
  if (!battery) {
    return {
      field: log.kind === 'hover' ? 'etaProp' : 'cdA',
      value: null,
      ok: false,
      airspeedMs: null,
      pAvgW: null,
      reason: 'the pack this flight was flown on is no longer in your list, and the solve needs its capacity and weight — add it back to bring this flight into the fit.',
    };
  }
  const cls = classForDrone(drone);
  const shared = {
    battery,
    payloadG: log.payloadG,
    extraG: log.extraG,
    env: { elevM: log.elevM, tempC: log.tempC, rhPct: log.rhPct },
    minutes: log.minutes,
    landedSocPct: log.landedSocPct,
    mahIn: log.mahIn,
  };
  if (log.kind === 'hover') {
    const got = solveEtaProp({ ...shared, drone });
    return { ...clampToClass(got, cls), airspeedMs: 0, pAvgW: got.pAvgW };
  }
  const { headwindMs, crosswindMs } = windComponents(log);
  const got = solveCdA({
    ...shared,
    drone: Number.isFinite(etaPin) ? { ...drone, etaProp: etaPin } : drone,
    speedMs: log.avgSpeedMs,
    headwindMs,
    crosswindMs,
    otherCdA: log.payloadCdA,
  });
  return { ...clampToClass(got, cls), airspeedMs: got.airspeedMs, pAvgW: got.pAvgW };
}

/* ---------- the fit ---------- */

/**
 * Mean and band for a set of accepted solves. The band is the population
 * standard deviation, not the min/max spread: with three flights those are the
 * same gesture, and past three the min/max is dragged around by whichever
 * flight had the worst charger reading, while σ keeps reporting the width of
 * the cluster. One flight has no spread to report, so its band is 0 — and one
 * flight never reaches a tier that shows a band anyway.
 */
function meanAndBand(values) {
  const n = values.length;
  const mean = values.reduce((a, v) => a + v, 0) / n;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  return { value: mean, band: Math.sqrt(variance), n };
}

// A fit costs a couple of hundred discharge integrations per flight, and
// state.drone() is read dozens of times per render pass. The key is everything
// the answer depends on — the drone's own physics fields, the logbook verbatim,
// and the packs those flights were flown on — so re-weighing a pack or editing
// a rig moves the fit on the next read without any invalidation call.
const fitCache = new Map();
const FIT_CACHE_MAX = 24;

function fitKey(drone, logs) {
  const ids = new Set(logs.map(l => l.batteryId));
  const packs = allBatteries().filter(b => ids.has(b.id))
    .map(b => `${b.id}~${b.capAh}~${b.massG}~${b.irPackMilliOhm}~${b.chem}~${b.s}~${b.p}~${b.maxContA}`)
    .join(',');
  const rig = [
    drone.id, drone.classId, drone.dryMassG, drone.etaProp, drone.cdA,
    drone.avionicsW, drone.propDiaIn, drone.numRotors, drone.ducted,
  ].join('~');
  return `${logVersion}|${rig}|${packs}|${JSON.stringify(logs)}`;
}

/**
 * Everything this airframe's logbook adds up to. Two passes, in §6.2's order:
 * hover tests pin efficiency with drag out of the picture, then cruise legs are
 * re-solved against that fitted efficiency to pin drag. With no hover tests on
 * record the cruise legs are solved against the airframe's existing etaProp and
 * `etaPinned` comes back false, so the UI can say which number the drag fit is
 * leaning on.
 *
 * Returns:
 *   `etaProp` / `cdA` — `{ value, band, n }` or null
 *   `solves`          — one entry per log, refusals included, in list order
 *   `nFlights`        — accepted flights, which is what the tier counts
 *   `nRefused`        — logged but left out, with reasons on `solves`
 *   `speedSpreadOk`   — §6.2's "across two speeds"
 *   `tier`            — 'none' | 'show' | 'offer' | 'default'
 */
export function fitForDrone(drone) {
  if (!drone) return emptyFit(null);
  const logs = logsForDrone(drone.id);
  if (!logs.length) return emptyFit(drone.id);
  const key = fitKey(drone, logs);
  const hit = fitCache.get(key);
  if (hit) return hit;

  const solveAll = (kind, etaPin) => logs
    .filter(l => l.kind === kind)
    .map(l => ({ log: l, ...solveLog(l, drone, etaPin) }));

  const hover = solveAll('hover', null);
  const hoverOk = hover.filter(s => s.ok);
  const etaProp = hoverOk.length ? meanAndBand(hoverOk.map(s => s.value)) : null;

  const cruise = solveAll('cruise', etaProp ? etaProp.value : null);
  const cruiseOk = cruise.filter(s => s.ok);
  const cdA = cruiseOk.length ? meanAndBand(cruiseOk.map(s => s.value)) : null;

  const accepted = [...hoverOk, ...cruiseOk];
  const speeds = accepted.map(s => s.airspeedMs).filter(Number.isFinite);
  const speedSpreadOk = speeds.length > 1
    && Math.max(...speeds) - Math.min(...speeds) >= SPEED_SPREAD_MS;

  const byId = new Map([...hover, ...cruise].map(s => [s.log.id, s]));
  const fit = {
    droneId: drone.id,
    solves: logs.map(l => byId.get(l.id)),
    etaProp,
    cdA,
    etaPinned: !!etaProp,
    nLogs: logs.length,
    nFlights: accepted.length,
    nRefused: logs.length - accepted.length,
    speedSpreadOk,
    tier: confidence(accepted.length, speedSpreadOk),
  };
  if (fitCache.size >= FIT_CACHE_MAX) fitCache.clear();
  fitCache.set(key, fit);
  return fit;
}

function emptyFit(droneId) {
  return {
    droneId,
    solves: [],
    etaProp: null,
    cdA: null,
    etaPinned: false,
    nLogs: 0,
    nFlights: 0,
    nRefused: 0,
    speedSpreadOk: false,
    tier: 'none',
  };
}

/* ---------- the switch ---------- */

function appliedMap() {
  const raw = storeGet(APPLIED_KEY, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/** Record the pilot's decision for one airframe. Explicit, either way. */
export function setCalibrationApplied(droneId, on) {
  if (!droneId) return;
  const map = appliedMap();
  map[droneId] = !!on;
  storeSet(APPLIED_KEY, map);
}

/** Forget the decision — used when the airframe's logbook is emptied. */
export function clearCalibrationApplied(droneId) {
  const map = appliedMap();
  if (!(droneId in map)) return;
  delete map[droneId];
  storeSet(APPLIED_KEY, map);
}

/**
 * Whether this fit is being applied, and why.
 *
 * A fit below the 'offer' tier is never applied, whatever is stored: one or two
 * flights are a data point, not a calibration. Above it, a stored decision wins
 * outright. With no stored decision the 'default' tier is on — §6.2's "5+ across
 * two speeds: default on" — and `announced` is true, which is the status line's
 * cue to say so out loud. The moment the pilot touches the switch either way, a
 * decision is stored, the default stops applying, and the announcement stops:
 * nothing is ever applied without the line that says it was.
 */
export function appliedState(fit) {
  const usable = fit.tier === 'offer' || fit.tier === 'default';
  const stored = appliedMap()[fit.droneId];
  const chosen = typeof stored === 'boolean';
  if (!usable) return { on: false, chosen, announced: false, usable };
  if (chosen) return { on: stored, chosen, announced: false, usable };
  return { on: fit.tier === 'default', chosen, announced: fit.tier === 'default', usable };
}

/* ---------- the overlay ---------- */

const overlayCache = new Map();

/**
 * The record the planner should fly: `drone` with the pilot's own etaProp and
 * cdA in place of the catalog's, when and only when the switch is on.
 *
 * Never mutates its argument — a catalog record is a module-scope literal
 * shared by every consumer in the app, and writing to one would calibrate the
 * MOZ7 for everybody who ever looks at it. The returned copy carries a
 * `calibration` block so the provenance copy can say whose numbers these are
 * without recomputing the fit.
 */
export function calibratedDrone(drone) {
  if (!drone) return drone;
  const fit = fitForDrone(drone);
  const applied = appliedState(fit);
  if (!applied.on || (!fit.etaProp && !fit.cdA)) return drone;
  const key = `${fitKey(drone, logsForDrone(drone.id))}|on`;
  const hit = overlayCache.get(key);
  if (hit) return hit;
  const out = { ...drone };
  const fields = [];
  if (fit.etaProp) { out.etaProp = fit.etaProp.value; fields.push('etaProp'); }
  if (fit.cdA) { out.cdA = fit.cdA.value; fields.push('cdA'); }
  out.calibration = {
    fields,
    nFlights: fit.nFlights,
    tier: fit.tier,
    etaProp: fit.etaProp,
    cdA: fit.cdA,
    announced: applied.announced,
  };
  if (overlayCache.size >= FIT_CACHE_MAX) overlayCache.clear();
  overlayCache.set(key, out);
  return out;
}
