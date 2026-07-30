import test from 'node:test';
import assert from 'node:assert/strict';

import { DRONES } from '../src/catalog/drones.js';
import { BATTERIES } from '../src/catalog/batteries.js';
import { airDensity, discAreaM2, powerAtSpeed, dischargeSim, dischargeToSoc } from '../src/domain/physics.js';
import {
  loadFlightLogs, logsForDrone, saveFlightLog, deleteFlightLog, normalizeLog,
  fitForDrone, appliedState, setCalibrationApplied, clearCalibrationApplied,
  calibratedDrone, solveLog,
} from '../src/flightlog.js';
// The form's own parse, so the string the pilot types off the OSD is tested
// where it is read rather than in a fixture that could drift from it.
import { parseFlightTime } from '../src/render/flightlog.js';

// Same free ground truth §6.2 buys the solvers (see calibrate.test.mjs): the
// model generates the flight a pilot would have typed, the logbook stores it,
// and the aggregate has to hand back the number we started from — this time
// through storage, the class clamp, the mean, and the overlay.

// Same Map-backed localStorage stub the store and registry tests use. store.js
// resolves globalThis.localStorage lazily on every call, so swapping this in
// between tests is enough.
function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

const env = { elevM: 250, tempC: 22, rhPct: 45 };
const moz7 = DRONES.find(d => d.id === 'moz7v2');
const pack = BATTERIES.find(b => b.fits.includes('moz7v2'));

function cfg(drone, battery) {
  const { rho } = airDensity(env.elevM, env.tempC, env.rhPct);
  return {
    massKg: (drone.dryMassG + battery.massG) / 1000,
    rho,
    areaM2: discAreaM2(drone),
    cdA: drone.cdA,
    etaProp: drone.etaProp,
    avionicsW: drone.avionicsW,
  };
}

/**
 * A flight the pilot could have typed: fly at `pW` for `frac` of everything the
 * pack can give at that power, and record what the OSD would have said on
 * landing. `frac` well below 1 keeps it mid-pack, away from the sag cutoff.
 */
function flightAt(pW, frac) {
  const minutes = dischargeSim(pack, env.tempC, pW).deliveredWh / pW * 60 * frac;
  return { minutes, landedSocPct: dischargeToSoc(pack, env.tempC, pW, minutes) * 100 };
}

let seq = 0;
function hoverLog(frac, over = {}) {
  const pW = powerAtSpeed(cfg(moz7, pack), 0);
  return {
    id: `log-${++seq}`, droneId: moz7.id, batteryId: pack.id, kind: 'hover',
    ...flightAt(pW, frac), tempC: env.tempC, elevM: env.elevM, rhPct: env.rhPct, ...over,
  };
}

function cruiseLog(speedMs, frac, over = {}) {
  const pW = powerAtSpeed(cfg(moz7, pack), speedMs);
  return {
    id: `log-${++seq}`, droneId: moz7.id, batteryId: pack.id, kind: 'cruise',
    avgSpeedMs: speedMs, windMs: 0, windRelation: 'mixed',
    ...flightAt(pW, frac), tempC: env.tempC, elevM: env.elevM, rhPct: env.rhPct, ...over,
  };
}

/* ---------- storage ---------- */

test('a logged flight round-trips through storage unchanged', () => {
  globalThis.localStorage = makeStorage();
  const written = hoverLog(0.6, { mahIn: 2100, notes: 'new props', at: '2026-07-20T18:30' });
  const stored = saveFlightLog(written);
  assert.ok(stored, 'the gate rejected a flight the model itself generated');
  const [back] = logsForDrone(moz7.id);
  assert.equal(back.id, written.id);
  assert.equal(back.minutes, written.minutes);
  assert.equal(back.mahIn, 2100);
  assert.equal(back.at, '2026-07-20T18:30');
  assert.equal(back.notes, 'new props');
  // Absent optionals come back as nulls or documented defaults, never undefined:
  // the solvers read them without a fallback.
  assert.equal(back.distanceKm, null);
  assert.equal(back.windMs, 0);
  assert.equal(back.windRelation, 'mixed');
  assert.equal(back.payloadG, 0);
});

test('the storage gate drops records a solver could not read, one at a time', () => {
  const good = normalizeLog(hoverLog(0.6));
  assert.ok(good);
  const bad = [
    ['no id', { id: '' }],
    ['no pack', { batteryId: '' }],
    ['not a kind of flight', { kind: 'ferry' }],
    ['no flight time', { minutes: null }],
    ['a flight time of zero', { minutes: 0 }],
    ['no charge reading at all', { landedSocPct: null, mahIn: null }],
    ['a landed % off the scale', { landedSocPct: 140, mahIn: null }],
    ['no temperature', { tempC: null }],
    ['a cruise leg with no speed', { kind: 'cruise', avgSpeedMs: null }],
  ];
  for (const [why, over] of bad) {
    assert.equal(normalizeLog(hoverLog(0.6, over)), null, `accepted a flight with ${why}`);
  }
  // …and one bad entry in the store does not take the good ones with it.
  globalThis.localStorage = makeStorage({
    'fpv:v1:flight-logs': [hoverLog(0.6), { id: 'junk' }, hoverLog(0.5)],
  });
  assert.equal(loadFlightLogs().length, 2);
});

test('logs for a drone that no longer exists are skipped, not fatal', () => {
  globalThis.localStorage = makeStorage();
  saveFlightLog(hoverLog(0.6));
  saveFlightLog(hoverLog(0.5, { droneId: 'a-rig-the-pilot-deleted' }));
  // Both are still stored — a log is a record of something that happened.
  assert.equal(loadFlightLogs().length, 2);
  // …but nothing asks for the orphan, and the surviving rig's fit ignores it.
  assert.equal(logsForDrone(moz7.id).length, 1);
  assert.equal(fitForDrone(moz7).nLogs, 1);
});

test('a flight on a pack that has been deleted is refused with a reason, not a crash', () => {
  globalThis.localStorage = makeStorage();
  saveFlightLog(hoverLog(0.6, { batteryId: 'pack-i-threw-away' }));
  const fit = fitForDrone(moz7);
  assert.equal(fit.nFlights, 0);
  assert.equal(fit.nRefused, 1);
  assert.match(fit.solves[0].reason, /no longer in your list/);
});

/* ---------- aggregation ---------- */

test('three hover flights aggregate to the airframe’s true etaProp, tightly', () => {
  globalThis.localStorage = makeStorage();
  for (const frac of [0.4, 0.6, 0.75]) saveFlightLog(hoverLog(frac));
  const fit = fitForDrone(moz7);
  assert.equal(fit.nFlights, 3);
  assert.ok(Math.abs(fit.etaProp.value - moz7.etaProp) < 1e-3,
    `fitted ${fit.etaProp.value} vs true ${moz7.etaProp}`);
  assert.ok(fit.etaProp.band < 1e-3, `band ${fit.etaProp.band} is not tight`);
  assert.equal(fit.etaProp.n, 3);
  assert.equal(fit.cdA, null); // no cruise legs: nothing pins drag yet
});

test('a cruise leg is fitted against the hover flights’ efficiency, and recovers cdA', () => {
  globalThis.localStorage = makeStorage();
  for (const frac of [0.4, 0.6, 0.75]) saveFlightLog(hoverLog(frac));
  saveFlightLog(cruiseLog(18, 0.6));
  const fit = fitForDrone(moz7);
  assert.equal(fit.etaPinned, true);
  assert.ok(Math.abs(fit.cdA.value - moz7.cdA) < 1e-3,
    `fitted cdA ${fit.cdA.value} vs true ${moz7.cdA}`);
  assert.equal(fit.speedSpreadOk, true); // a hover and an 18 m/s leg are two speeds
});

test('a cruise leg with no hover flights behind it says whose efficiency it leaned on', () => {
  globalThis.localStorage = makeStorage();
  saveFlightLog(cruiseLog(18, 0.6));
  const fit = fitForDrone(moz7);
  assert.equal(fit.etaPinned, false);
  assert.equal(fit.nFlights, 1);
  assert.equal(fit.speedSpreadOk, false); // one speed is not two
});

test('an absurd flight is refused with a physical reason and never enters the mean', () => {
  globalThis.localStorage = makeStorage();
  for (const frac of [0.4, 0.6, 0.75]) saveFlightLog(hoverLog(frac));
  const clean = fitForDrone(moz7);
  // Two minutes and 20% of the pack gone: that is far more power than a 7-inch
  // long-range rig can be hovering at, so the implied efficiency is absurd.
  saveFlightLog(hoverLog(0.6, { minutes: 2, landedSocPct: 80, mahIn: null }));
  const fit = fitForDrone(moz7);
  assert.equal(fit.nLogs, 4);
  assert.equal(fit.nFlights, 3, 'the absurd flight got into the fit');
  assert.equal(fit.nRefused, 1);
  assert.equal(fit.etaProp.value, clean.etaProp.value, 'the mean moved');
  const refused = fit.solves.find(s => !s.ok);
  assert.ok(refused.reason && refused.reason.length > 20, 'refusal came back without a reason');
  // The value is still reported — the pilot is told what the flight implied and
  // why it is not believable, not just that it was thrown out.
  assert.ok(Number.isFinite(refused.value));
});

/* ---------- the confidence gate ---------- */

test('the gate opens at one, three and five flights, and not before', () => {
  globalThis.localStorage = makeStorage();
  assert.equal(fitForDrone(moz7).tier, 'none');

  saveFlightLog(hoverLog(0.4));
  assert.equal(fitForDrone(moz7).tier, 'show');
  assert.equal(appliedState(fitForDrone(moz7)).usable, false);

  saveFlightLog(hoverLog(0.5));
  assert.equal(fitForDrone(moz7).tier, 'show');

  saveFlightLog(hoverLog(0.6));
  assert.equal(fitForDrone(moz7).tier, 'offer');
  const offered = appliedState(fitForDrone(moz7));
  assert.equal(offered.usable, true);
  assert.equal(offered.on, false, 'a 3-flight fit applied itself');

  saveFlightLog(hoverLog(0.7));
  saveFlightLog(hoverLog(0.75));
  // Five flights, but all of them hovers — one speed, so still only offered.
  assert.equal(fitForDrone(moz7).speedSpreadOk, false);
  assert.equal(fitForDrone(moz7).tier, 'offer');

  saveFlightLog(cruiseLog(18, 0.6));
  const fit = fitForDrone(moz7);
  assert.equal(fit.tier, 'default');
  const applied = appliedState(fit);
  assert.equal(applied.on, true);
  // §6.2's "never silently": the one-time default-on is flagged for the status
  // line to say out loud.
  assert.equal(applied.announced, true);
  assert.equal(applied.chosen, false);
});

test('the pilot’s own decision outranks the default, in both directions', () => {
  globalThis.localStorage = makeStorage();
  for (const frac of [0.4, 0.5, 0.6, 0.7, 0.75]) saveFlightLog(hoverLog(frac));
  saveFlightLog(cruiseLog(18, 0.6));
  const fit = fitForDrone(moz7);
  assert.equal(fit.tier, 'default');

  setCalibrationApplied(moz7.id, false);
  const off = appliedState(fit);
  assert.equal(off.on, false);
  assert.equal(off.chosen, true);
  assert.equal(off.announced, false, 'still announcing a default the pilot overrode');

  setCalibrationApplied(moz7.id, true);
  assert.equal(appliedState(fit).on, true);
  assert.equal(appliedState(fit).announced, false, 'announced a switch the pilot threw');

  clearCalibrationApplied(moz7.id);
  assert.equal(appliedState(fit).chosen, false);
});

test('a stored yes cannot apply a fit that has not earned the gate', () => {
  globalThis.localStorage = makeStorage();
  saveFlightLog(hoverLog(0.6));
  setCalibrationApplied(moz7.id, true);
  const fit = fitForDrone(moz7);
  assert.equal(fit.tier, 'show');
  assert.equal(appliedState(fit).on, false);
  assert.equal(calibratedDrone(moz7).etaProp, moz7.etaProp);
});

/* ---------- the overlay ---------- */

test('the overlay carries the fit only when applied, and never touches the catalog', () => {
  globalThis.localStorage = makeStorage();
  // Three flights at an efficiency that is not the catalog's, so "did the
  // overlay happen" is answerable by reading one number.
  const rig = { ...moz7, etaProp: 0.47 };
  for (const frac of [0.4, 0.6, 0.75]) {
    const pW = powerAtSpeed(cfg(rig, pack), 0);
    saveFlightLog({
      id: `log-x${frac}`, droneId: moz7.id, batteryId: pack.id, kind: 'hover',
      ...flightAt(pW, frac), tempC: env.tempC, elevM: env.elevM, rhPct: env.rhPct,
    });
  }
  const fit = fitForDrone(moz7);
  assert.equal(fit.tier, 'offer');
  assert.ok(Math.abs(fit.etaProp.value - 0.47) < 1e-3);

  // Offered but not accepted: the plan still flies the catalog's numbers.
  const before = calibratedDrone(moz7);
  assert.equal(before.etaProp, moz7.etaProp);
  assert.equal(before.calibration, undefined);

  setCalibrationApplied(moz7.id, true);
  const after = calibratedDrone(moz7);
  assert.ok(Math.abs(after.etaProp - 0.47) < 1e-3, `overlay etaProp ${after.etaProp}`);
  assert.deepEqual(after.calibration.fields, ['etaProp']);
  assert.equal(after.calibration.nFlights, 3);
  // Everything not fitted is still the record's own.
  assert.equal(after.cdA, moz7.cdA);
  assert.equal(after.dryMassG, moz7.dryMassG);
  // And the shared catalog literal every other consumer reads is untouched.
  assert.equal(moz7.etaProp, DRONES.find(d => d.id === 'moz7v2').etaProp);
  assert.equal('calibration' in moz7, false, 'the overlay wrote onto the catalog record');
});

test('emptying the logbook takes the fit and the overlay with it', () => {
  globalThis.localStorage = makeStorage();
  const ids = [];
  for (const frac of [0.4, 0.6, 0.75]) {
    const log = hoverLog(frac);
    ids.push(log.id);
    saveFlightLog(log);
  }
  setCalibrationApplied(moz7.id, true);
  assert.ok(calibratedDrone(moz7).calibration);

  for (const id of ids) deleteFlightLog(id);
  assert.equal(logsForDrone(moz7.id).length, 0);
  assert.equal(fitForDrone(moz7).tier, 'none');
  assert.equal(calibratedDrone(moz7).etaProp, moz7.etaProp);
});

/* ---------- the OSD timer ---------- */

test('the armed timer parses as m:ss or as plain minutes', () => {
  assert.equal(parseFlightTime('7:20'), 7 + 20 / 60);
  assert.equal(parseFlightTime('12:05'), 12 + 5 / 60);
  assert.equal(parseFlightTime(' 7:20 '), 7 + 20 / 60);
  assert.equal(parseFlightTime('7'), 7);
  assert.equal(parseFlightTime('7.33'), 7.33);
  assert.equal(parseFlightTime('7:60'), null, 'sixty seconds is a minute');
  assert.equal(parseFlightTime(''), null);
  assert.equal(parseFlightTime('soon'), null);
  assert.equal(parseFlightTime('0'), null);
});

/* ---------- one flight, end to end ---------- */

test('solveLog inverts a single stored flight back to the airframe it was flown on', () => {
  globalThis.localStorage = makeStorage();
  const log = normalizeLog(hoverLog(0.6));
  const got = solveLog(log, moz7);
  assert.equal(got.ok, true);
  assert.equal(got.field, 'etaProp');
  assert.ok(Math.abs(got.value - moz7.etaProp) < 1e-3);
  assert.equal(got.airspeedMs, 0);
});
