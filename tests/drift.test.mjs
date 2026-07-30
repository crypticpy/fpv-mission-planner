import test from 'node:test';
import assert from 'node:assert/strict';

import { DRONES } from '../js/catalog/drones.js';
import { BATTERIES } from '../js/catalog/batteries.js';
import {
  airDensity, discAreaM2, powerAtSpeed, dischargeSim, dischargeToSoc, planMission, U,
} from '../js/physics.js';
import { saveFlightLog, fitForDrone, setCalibrationApplied, calibratedDrone } from '../js/flightlog.js';
import { driftPoints, driftSummary, rangeBandKm } from '../js/drift.js';
import { niceTicks } from '../js/charts.js';

// §6.2's drift chart and hero band, against the same free ground truth the
// solvers get: the model generates flights for an airframe that is *not* the
// catalog's, the logbook stores them, and the drift between what those flights
// burned and what the catalog predicts has to shrink to nothing when the pilot's
// own numbers are applied. That shrinking is the whole argument the chart makes.

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
const packs = BATTERIES;

// The airframe the flights were really flown on: the catalog's rig with 40% more
// drag than the table thinks. Efficiency is left at the catalog's, so a
// cruise-only logbook's cdA fit is the only thing that has to move.
const draggy = { ...moz7, cdA: moz7.cdA * 1.4 };

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

function flightAt(pW, frac) {
  const minutes = dischargeSim(pack, env.tempC, pW).deliveredWh / pW * 60 * frac;
  return { minutes, landedSocPct: dischargeToSoc(pack, env.tempC, pW, minutes) * 100 };
}

let seq = 0;
const base = () => ({
  id: `drift-${++seq}`, droneId: moz7.id, batteryId: pack.id,
  tempC: env.tempC, elevM: env.elevM, rhPct: env.rhPct,
});

function hoverLog(frac, over = {}, rig = draggy) {
  const pW = powerAtSpeed(cfg(rig, pack), 0);
  return { ...base(), kind: 'hover', ...flightAt(pW, frac), ...over };
}

function cruiseLog(speedMs, frac, over = {}, rig = draggy) {
  const pW = powerAtSpeed(cfg(rig, pack), speedMs);
  return {
    ...base(), kind: 'cruise', avgSpeedMs: speedMs, windMs: 0, windRelation: 'mixed',
    ...flightAt(pW, frac), ...over,
  };
}

/**
 * Two hovers and three cruise legs at two speeds — enough to earn the switch.
 * Every one of them flown on exactly the same rig, so the fit lands on the truth
 * and the residuals are the model's error alone.
 */
function seedLogbook() {
  globalThis.localStorage = makeStorage();
  for (const log of [
    hoverLog(0.5), hoverLog(0.65),
    cruiseLog(12, 0.5), cruiseLog(12, 0.7), cruiseLog(18, 0.6),
  ]) {
    assert.ok(saveFlightLog(log), 'the storage gate refused a flight the model generated');
  }
}

/**
 * The same logbook with the rig varying flight to flight, the way a real one
 * does — a different battery strapped on differently, a slightly bent arm. A fit
 * only has a σ to put a band around when its flights disagree, so the band tests
 * need this rather than the noiseless fixture above.
 */
function seedSpread() {
  globalThis.localStorage = makeStorage();
  for (const k of [0.96, 1, 1.04]) {
    assert.ok(saveFlightLog(hoverLog(0.55, {}, { ...moz7, etaProp: moz7.etaProp * k })));
  }
  for (const [speed, k] of [[12, 1.3], [15, 1.4], [18, 1.5]]) {
    assert.ok(saveFlightLog(cruiseLog(speed, 0.6, {}, { ...moz7, cdA: moz7.cdA * k })));
  }
}

/* ---------- the drift chart's points ---------- */

test('a cruise leg is plotted against the model at its own conditions', () => {
  seedLogbook();
  const fit = fitForDrone(moz7);
  const pts = driftPoints({ drone: moz7, solves: fit.solves, batteries: packs });
  assert.equal(pts.length, 3, 'hover tests have no km and must not be on a Wh/km chart');
  for (const p of pts) {
    assert.equal(p.log.kind, 'cruise');
    // Both sides are the same power ÷ the same ground speed, so the residual is
    // the power model's error and nothing else.
    const solve = fit.solves.find(s => s.log.id === p.log.id);
    assert.ok(Math.abs(p.actualWhPerKm - solve.pAvgW / (3.6 * p.log.avgSpeedMs)) < 1e-9);
    assert.equal(p.residualWhPerKm, p.actualWhPerKm - p.predictedWhPerKm);
    assert.ok(p.predictedWhPerKm > 0);
  }
  // Sorted by the speed they were flown at, which is the chart's x axis.
  assert.deepEqual(pts.map(p => p.airspeedMs), [12, 12, 18]);
});

test('the residuals shrink to nothing when the pilot’s own numbers are applied', () => {
  seedLogbook();
  const fit = fitForDrone(moz7);
  // Five flights across two speeds clear the bar on their own — the tier is the
  // logbook's business, all this needs is a fit worth applying.
  assert.equal(fit.tier, 'default');

  // Flying the catalog: it under-predicts, because the real rig is draggier.
  const before = driftSummary(driftPoints({ drone: moz7, solves: fit.solves, batteries: packs }));
  assert.equal(before.n, 3);
  assert.ok(before.signedPct > 4, `expected a visible drift, got ${before.signedPct}%`);
  assert.ok(before.meanSignedWhPerKm > 0);
  assert.ok(Math.abs(before.absPct - before.signedPct) < 1e-9, 'all three legs should be off the same way');

  // Flying the fit: the same flights, the same solves, the model moved onto them.
  setCalibrationApplied(moz7.id, true);
  const applied = calibratedDrone(moz7);
  assert.ok(applied.calibration, 'the switch did not take');
  const after = driftSummary(driftPoints({ drone: applied, solves: fit.solves, batteries: packs }));
  assert.equal(after.n, before.n);
  assert.ok(Math.abs(after.signedPct) < 1,
    `applying the fit left ${after.signedPct}% of drift on the table`);
  assert.ok(after.absPct < before.absPct / 4);
});

test('nothing the fit refused, and nothing without a pack, reaches the chart', () => {
  seedLogbook();
  // A leg that says it landed on more than it took off with: stored, because it
  // happened, and refused by the solver.
  saveFlightLog(cruiseLog(15, 0.6, { landedSocPct: 99.5 }));
  // …and one on a pack that is no longer in the list.
  saveFlightLog(cruiseLog(15, 0.6, { batteryId: 'sold-it' }));
  const fit = fitForDrone(moz7);
  const pts = driftPoints({ drone: moz7, solves: fit.solves, batteries: packs });
  assert.ok(fit.nRefused >= 1, 'the fixture stopped being refusable');
  assert.equal(pts.length, 3);
});

test('an empty logbook draws no chart, and neither does a hover-only one', () => {
  globalThis.localStorage = makeStorage();
  assert.deepEqual(driftPoints({ drone: moz7, solves: fitForDrone(moz7).solves, batteries: packs }), []);
  saveFlightLog(hoverLog(0.6));
  assert.deepEqual(driftPoints({ drone: moz7, solves: fitForDrone(moz7).solves, batteries: packs }), []);
  assert.equal(driftSummary([]), null);
});

test('a residual axis of all-but-exact zeros still ticks in finite time', () => {
  // The path this closes, found in the browser: cruise legs all flown on the
  // same rig, fit applied. The fit lands on that rig to the last bit, so the
  // model reproduces every leg and the residuals are zero to within rounding —
  // but not identically zero, so an axis that reads a 1e-15 span as real asks
  // for tens of millions of gridlines. Four million DOM nodes and a dead tab,
  // for a chart whose honest content is "the model is on your flights".
  globalThis.localStorage = makeStorage();
  for (const [speed, frac] of [[10, 0.5], [16, 0.6], [22, 0.6]]) {
    assert.ok(saveFlightLog(cruiseLog(speed, frac)));
  }
  setCalibrationApplied(moz7.id, true);
  const fit = fitForDrone(moz7);
  const applied = calibratedDrone(moz7);
  const pts = driftPoints({ drone: applied, solves: fit.solves, batteries: packs });
  assert.equal(pts.length, 3);
  const resids = pts.map(p => p.residualWhPerKm);
  assert.ok(resids.every(r => Math.abs(r) < 1e-9), `residuals should be negligible: ${resids}`);
  assert.ok(resids.some(r => r !== 0),
    'the fixture needs one residual that is tiny but not identically zero');

  // Exactly what renderDriftChart passes: yMin off the lowest point, yMax off
  // the highest, with the zero line's own two ends in the same pool.
  const lows = [...resids, 0];
  const ticks = niceTicks(Math.min(...lows) * 1.15, Math.max(...lows));
  assert.ok(ticks.length <= 8, `${ticks.length} ticks on a degenerate axis`);
  assert.ok(ticks.every(Number.isFinite));
  // Every other axis in the app is unaffected: a real span — including a
  // genuinely small one — still ticks exactly the way it always did.
  assert.deepEqual(niceTicks(0, 25), [0, 10, 20]);
  assert.deepEqual(niceTicks(0, 1), [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepEqual(niceTicks(18, 24), [18, 20, 22, 24]);
  assert.deepEqual(niceTicks(-5, 5), [-4, -2, 0, 2, 4]);
  assert.deepEqual(niceTicks(0, 0.001), [0, 0.0002, 0.0004, 0.0006, 0.0008, 0.001]);
});

/* ---------- the hero band ---------- */

const baseInputs = (drone) => ({
  drone,
  battery: pack,
  payloadG: 0,
  payloadCdA: 0,
  extraG: 0,
  env: {
    elevM: env.elevM, tempC: env.tempC, rhPct: env.rhPct,
    windAvgMs: U.mphToMs(3), windGustMs: U.mphToMs(5),
    windMode: 'headOut', windFromDeg: 170,
  },
  reservePct: 20,
  cruiseMode: 'real',
  realVMs: drone.cruiseMs,
  overheadF: 1.05,
});

/** Applied fit, spread fixture — what the band is computed from. */
function appliedSpread() {
  seedSpread();
  setCalibrationApplied(moz7.id, true);
  const applied = calibratedDrone(moz7);
  assert.ok(applied.calibration, 'the switch did not take');
  assert.ok(applied.calibration.etaProp.band > 0, 'the fixture stopped disagreeing with itself');
  assert.ok(applied.calibration.cdA.band > 0);
  return applied;
}

test('the band brackets the plan it qualifies', () => {
  const applied = appliedSpread();
  const inputs = baseInputs(applied);
  const band = rangeBandKm(inputs, applied.calibration);
  assert.ok(band, 'an applied fit with a band reported none');
  assert.ok(band.loKm < band.hiKm);
  assert.equal(band.nFlights, applied.calibration.nFlights);

  const mid = planMission({ ...inputs, lite: true }).radiusKm;
  assert.ok(band.loKm <= mid + 1e-9 && mid <= band.hiKm + 1e-9,
    `the headline fell outside its own band: ${band.loKm} … ${mid} … ${band.hiKm}`);
});

test('the pessimistic corner is low efficiency with high drag, not one field at a time', () => {
  const applied = appliedSpread();
  const inputs = baseInputs(applied);
  const cal = applied.calibration;
  const band = rangeBandKm(inputs, cal);

  // All four corners of the ±σ box, by hand. The documented pairing has to be
  // the two extreme ones: the mixed corners — inefficient *and* slippery, or
  // efficient *and* draggy — are rigs nobody flies, and quoting them would
  // understate the spread the pilot's own flights show.
  const at = (etaSign, cdaSign) => planMission({
    ...inputs,
    drone: {
      ...applied,
      etaProp: applied.etaProp + etaSign * cal.etaProp.band,
      cdA: applied.cdA + cdaSign * cal.cdA.band,
    },
    lite: true,
  }).radiusKm;
  const worst = at(-1, +1);
  const best = at(+1, -1);
  const mixedA = at(-1, -1);
  const mixedB = at(+1, +1);
  assert.ok(Math.abs(band.loKm - worst) < 1e-9, `low end ${band.loKm} is not (η−σ, CdA+σ) ${worst}`);
  assert.ok(Math.abs(band.hiKm - best) < 1e-9, `high end ${band.hiKm} is not (η+σ, CdA−σ) ${best}`);
  for (const mixed of [mixedA, mixedB]) {
    assert.ok(mixed > worst && mixed < best, `${mixed} is outside the reported band`);
  }
});

test('no band means no band: nothing to report, and nothing invented', () => {
  seedSpread();
  const inputs = baseInputs(moz7);
  // Not applied at all — the overlay carries no calibration block.
  assert.equal(rangeBandKm(inputs, undefined), null);
  assert.equal(rangeBandKm(inputs, null), null);
  // Applied, but every field's spread is zero (one flight per field would do it).
  assert.equal(rangeBandKm(inputs, { etaProp: { value: 0.5, band: 0, n: 1 }, cdA: null, nFlights: 1 }), null);
  assert.equal(rangeBandKm({ ...inputs, drone: null }, { etaProp: { value: 0.5, band: 0.02, n: 3 } }), null);
});

test('a spread wider than physics allows is clamped to physics, not to nonsense', () => {
  const applied = appliedSpread();
  const inputs = baseInputs(applied);

  // σ as wide as the drag figure itself: the optimistic corner would be a
  // frictionless airframe. Clamped to very-nearly-zero drag, both ends are still
  // a real out-and-back radius.
  const wideDrag = rangeBandKm(inputs, {
    ...applied.calibration,
    etaProp: { value: applied.etaProp, band: 0.03, n: 5 },
    cdA: { value: applied.cdA, band: applied.cdA * 1.05, n: 5 },
  });
  assert.ok(wideDrag, 'a clampable spread reported no band');
  assert.ok(wideDrag.loKm > 0 && isFinite(wideDrag.loKm));
  assert.ok(wideDrag.hiKm > wideDrag.loKm && isFinite(wideDrag.hiKm));
  const slippery = planMission({
    ...inputs,
    drone: { ...applied, etaProp: applied.etaProp + 0.03, cdA: 1e-4 },
    lite: true,
  }).radiusKm;
  assert.ok(Math.abs(wideDrag.hiKm - slippery) < 1e-9,
    `the high end is off a negative drag area, not the clamp: ${wideDrag.hiKm} vs ${slippery}`);

  // And the same for efficiency: a rig already at 85% with a ±20-point σ would be
  // quoted at 105% efficient. It gets quoted at 90%.
  const high = { ...applied, etaProp: 0.85 };
  const wideEta = rangeBandKm({ ...inputs, drone: high }, {
    ...applied.calibration,
    etaProp: { value: high.etaProp, band: 0.2, n: 5 },
    cdA: null,
  });
  assert.ok(wideEta, 'a clampable efficiency spread reported no band');
  const capped = planMission({ ...inputs, drone: { ...high, etaProp: 0.9 }, lite: true }).radiusKm;
  assert.ok(Math.abs(wideEta.hiKm - capped) < 1e-9,
    `the high end is off a >100% efficient rotor: ${wideEta.hiKm} vs ${capped}`);
});

test('a low end that could not fly home is no band at all, not a zero', () => {
  const applied = appliedSpread();
  // σ wide enough that the pessimistic corner is a 10%-efficient rig dragging
  // five times its own drag area: it cannot close an out-and-back at all. A
  // "0.0–14.2 mi" headline would read as a range, so there is no headline.
  const band = rangeBandKm(baseInputs(applied), {
    ...applied.calibration,
    etaProp: { value: applied.etaProp, band: 0.9, n: 5 },
    cdA: { value: applied.cdA, band: applied.cdA * 4, n: 5 },
  });
  assert.equal(band, null);
});
