import test from 'node:test';
import assert from 'node:assert/strict';

import { DRONES } from '../src/catalog/drones.js';
import { BATTERIES } from '../src/catalog/batteries.js';
import { CLASSES, classById } from '../src/catalog/classes.js';
import {
  airDensity, discAreaM2, powerAtSpeed, dischargeSim, dischargeToSoc,
} from '../src/physics.js';
import {
  avgPowerFromFlight, clampToClass, confidence, landedSocFromMahIn,
  solveCdA, solveEtaProp,
} from '../src/calibrate.js';

// §6.2's free test: the model generates its own ground truth, so the whole
// calibration chain is verified without a single measured flight. Fly a known
// airframe at a known power, run that power through the discharge model to get
// the "flew X minutes, landed at Y%" a pilot would type, then demand the
// solvers hand back the etaProp/cdA we started from.

const env = { elevM: 250, tempC: 22, rhPct: 45 };

const moz7 = DRONES.find(d => d.id === 'moz7v2');
const cinelog = DRONES.find(d => d.id === 'cinelog30v3');
// A real catalog pack for each rig, not a fixture.
const packFor = (drone) => BATTERIES.find(b => b.fits.includes(drone.id));

function cfgFor(drone, battery, over = {}) {
  const { rho } = airDensity(env.elevM, env.tempC, env.rhPct);
  return {
    massKg: (drone.dryMassG + battery.massG) / 1000,
    rho,
    areaM2: discAreaM2(drone),
    cdA: drone.cdA,
    etaProp: drone.etaProp,
    avionicsW: drone.avionicsW,
    ...over,
  };
}

// Synthesize a flight: fly at `pW` for 60% of what the pack can take at that
// power, which lands comfortably mid-pack — no cutoff, no sag edge case.
function syntheticFlight(battery, pW) {
  const minutes = dischargeSim(battery, env.tempC, pW).deliveredWh / pW * 60 * 0.6;
  return { minutes, landedSocPct: dischargeToSoc(battery, env.tempC, pW, minutes) * 100 };
}

/* ---------- hover round-trip: recover etaProp ---------- */

for (const drone of [moz7, cinelog]) {
  test(`hover round-trip recovers ${drone.short}’s calibrated etaProp`, () => {
    const battery = packFor(drone);
    assert.ok(battery, 'no catalog pack fits this rig — the fixture is wrong');
    const pHover = powerAtSpeed(cfgFor(drone, battery), 0);
    const flight = syntheticFlight(battery, pHover);

    const got = solveEtaProp({ drone, battery, payloadG: 0, extraG: 0, env, ...flight });
    assert.ok(Math.abs(got.pAvgW - pHover) / pHover < 1e-9, `power off: ${got.pAvgW} vs ${pHover}`);
    assert.ok(Math.abs(got.etaProp - drone.etaProp) < 1e-3,
      `${drone.short}: recovered etaProp ${got.etaProp} vs ${drone.etaProp}`);
    // and it lands well inside its class range, so the clamp accepts it
    assert.equal(clampToClass(got, classById(drone.id === 'moz7v2' ? 'lr7' : 'cinewhoop3')).ok, true);
  });
}

test('the hover solve is exact to floating point, not merely to 1e-3', () => {
  // Bisection on power is the only inexact step, and it converges far below
  // the 1e-3 the design doc asks for. Pin the real precision so a regression
  // in the bracket shows up here rather than as a quietly worse fit.
  for (const drone of [moz7, cinelog]) {
    const battery = packFor(drone);
    const pHover = powerAtSpeed(cfgFor(drone, battery), 0);
    const got = solveEtaProp({ drone, battery, env, ...syntheticFlight(battery, pHover) });
    assert.ok(Math.abs(got.etaProp - drone.etaProp) < 1e-9,
      `${drone.short}: ${got.etaProp} vs ${drone.etaProp}`);
  }
});

test('mAh back in is an accepted SoC source and gives the same answer', () => {
  const battery = packFor(cinelog);
  const pHover = powerAtSpeed(cfgFor(cinelog, battery), 0);
  const { minutes, landedSocPct } = syntheticFlight(battery, pHover);
  // What a charger would have put back to reach that landed SoC.
  const mahIn = (1 - landedSocPct / 100) * battery.capAh * 1000;
  const got = solveEtaProp({ drone: cinelog, battery, env, minutes, mahIn });
  assert.ok(Math.abs(got.etaProp - cinelog.etaProp) < 1e-3);
});

/* ---------- cruise round-trip: recover cdA ---------- */

for (const drone of [moz7, cinelog]) {
  test(`cruise round-trip recovers ${drone.short}’s calibrated cdA`, () => {
    const battery = packFor(drone);
    const v = drone.cruiseMs;
    const pCruise = powerAtSpeed(cfgFor(drone, battery), v);
    const flight = syntheticFlight(battery, pCruise);

    const got = solveCdA({ drone, battery, env, airspeedMs: v, ...flight });
    assert.ok(Math.abs(got.cdA - drone.cdA) < 1e-3,
      `${drone.short}: recovered cdA ${got.cdA} vs ${drone.cdA}`);
    // The bisection bracket resolves cdA to ~1e-10 m²; 1e-3 above is the
    // design doc's bar, this is the tolerance actually earned.
    assert.ok(Math.abs(got.cdA - drone.cdA) < 1e-9, `cdA precision: ${got.cdA}`);
    assert.equal(got.cdATotalM2, got.cdA);
    assert.equal(clampToClass(got, classById(drone.id === 'moz7v2' ? 'lr7' : 'cinewhoop3')).ok, true);
  });
}

test('a ground speed plus wind converts to the airspeed that flew the leg', () => {
  const drone = moz7;
  const battery = packFor(drone);
  const vAir = 18;
  const headwindMs = 4;
  const crosswindMs = 3;
  // vg = sqrt(vAir² - cross²) - head, exactly as groundSpeedVec computes it.
  const vg = Math.sqrt(vAir * vAir - crosswindMs * crosswindMs) - headwindMs;
  const flight = syntheticFlight(battery, powerAtSpeed(cfgFor(drone, battery), vAir));

  const got = solveCdA({ drone, battery, env, speedMs: vg, headwindMs, crosswindMs, ...flight });
  assert.ok(Math.abs(got.airspeedMs - vAir) < 1e-9);
  assert.ok(Math.abs(got.cdA - drone.cdA) < 1e-9);
});

test('otherCdA is taken back off the airframe’s own drag area', () => {
  const drone = moz7;
  const battery = packFor(drone);
  const payloadCdA = 0.004;
  const cfg = cfgFor(drone, battery, { cdA: drone.cdA + payloadCdA });
  const flight = syntheticFlight(battery, powerAtSpeed(cfg, drone.cruiseMs));
  const got = solveCdA({
    drone, battery, env, airspeedMs: drone.cruiseMs, otherCdA: payloadCdA, ...flight,
  });
  assert.ok(Math.abs(got.cdA - drone.cdA) < 1e-9);
  assert.ok(Math.abs(got.cdATotalM2 - (drone.cdA + payloadCdA)) < 1e-9);
});

/* ---------- dischargeToSoc ---------- */

test('dischargeToSoc falls monotonically with both time and power', () => {
  const battery = packFor(moz7);
  let prev = 1.0000001;
  for (let m = 0; m <= 12; m += 0.5) {
    const soc = dischargeToSoc(battery, env.tempC, 200, m);
    assert.ok(soc <= prev, `time ${m} min: ${soc} > ${prev}`);
    prev = soc;
  }
  prev = 1.0000001;
  for (let p = 50; p <= 400; p += 25) {
    const soc = dischargeToSoc(battery, env.tempC, p, 8);
    assert.ok(soc <= prev, `power ${p} W: ${soc} > ${prev}`);
    prev = soc;
  }
  assert.equal(dischargeToSoc(battery, env.tempC, 200, 0), 1);
  assert.equal(dischargeToSoc(battery, env.tempC, 0, 10), 1);
});

test('flying exactly dischargeSim’s endurance lands on its stopSoc', () => {
  for (const battery of [packFor(moz7), packFor(cinelog)]) {
    const pW = battery.s * 3.7 * 10; // ~10 A, a plausible draw for either pack
    const sim = dischargeSim(battery, env.tempC, pW);
    const endurMin = sim.deliveredWh / pW * 60;
    const soc = dischargeToSoc(battery, env.tempC, pW, endurMin);
    assert.ok(Math.abs(soc * 100 - sim.stopSoc) < 1e-6,
      `${battery.short}: ${soc * 100}% vs stopSoc ${sim.stopSoc}%`);
    // ...and half that time leaves meaningfully more than half a pack's worth
    // of charge, since the OCV curve is not linear in energy.
    const half = dischargeToSoc(battery, env.tempC, pW, endurMin / 2);
    assert.ok(half > 0.4 && half < 0.7, `${battery.short}: half-flight SoC ${half}`);
  }
});

test('a pack driven past its cutoff reports the terminal SoC, not a negative one', () => {
  const battery = packFor(cinelog);
  const soc = dischargeToSoc(battery, env.tempC, 200, 60); // 200 W for an hour on a 4S 550
  assert.ok(soc >= 0 && soc <= 1);
  assert.equal(soc * 100, dischargeSim(battery, env.tempC, 200).stopSoc);
});

/* ---------- avgPowerFromFlight ---------- */

test('avgPowerFromFlight inverts dischargeToSoc', () => {
  const battery = packFor(moz7);
  for (const pW of [60, 120, 250, 400]) {
    const minutes = 6;
    const landedSocPct = dischargeToSoc(battery, env.tempC, pW, minutes) * 100;
    const got = avgPowerFromFlight({ battery, tempC: env.tempC, minutes, landedSocPct });
    assert.ok(Math.abs(got - pW) / pW < 1e-9, `${pW} W → ${got} W`);
  }
});

test('avgPowerFromFlight refuses a flight the pack cannot explain', () => {
  const battery = packFor(cinelog);
  // Emptying a 4S 550 to 5% in 30 seconds needs more power than the pack can
  // deliver — it would sag past its cutoff first, so no draw reproduces this.
  assert.equal(avgPowerFromFlight({ battery, tempC: env.tempC, minutes: 0.5, landedSocPct: 5 }), null);
  assert.equal(avgPowerFromFlight({ battery, tempC: env.tempC, minutes: 1, landedSocPct: 5 }), null);
  // The same pack drained that far over two minutes is merely a brutal flight,
  // and is solved rather than refused — the refusal is physical, not a rule.
  assert.ok(avgPowerFromFlight({ battery, tempC: env.tempC, minutes: 2, landedSocPct: 5 }) > 0);
  // Missing or nonsense inputs come back null rather than throwing.
  assert.equal(avgPowerFromFlight({ battery, tempC: env.tempC, minutes: 5 }), null);
  assert.equal(avgPowerFromFlight({ battery: null, tempC: env.tempC, minutes: 5, landedSocPct: 20 }), null);
  assert.equal(avgPowerFromFlight({ battery, tempC: env.tempC, minutes: 0, landedSocPct: 20 }), null);
});

test('landedSocFromMahIn is the charger reading, clamped', () => {
  const battery = { capAh: 0.72 };
  assert.equal(landedSocFromMahIn({ battery, mahIn: 0 }), 1);
  assert.equal(landedSocFromMahIn({ battery, mahIn: 360 }), 0.5);
  assert.equal(landedSocFromMahIn({ battery, mahIn: 900 }), 0); // tired pack, not below empty
  assert.equal(landedSocFromMahIn({ battery, mahIn: -5 }), 1);
  assert.equal(landedSocFromMahIn({ battery, mahIn: NaN }), null);
  assert.equal(landedSocFromMahIn({ battery: { capAh: 0 }, mahIn: 100 }), null);
});

/* ---------- clampToClass ---------- */

test('clampToClass passes an in-range fit through untouched', () => {
  const cls = classById('lr7');
  assert.deepEqual(clampToClass({ etaProp: 0.55 }, cls), { ok: true, field: 'etaProp', value: 0.55 });
  assert.deepEqual(clampToClass({ field: 'cdA', value: 0.042 }, cls),
    { ok: true, field: 'cdA', value: 0.042 });
});

test('clampToClass refuses an absurd fit with a physical reason', () => {
  const cls = classById('lr7');
  const high = clampToClass({ etaProp: 0.91 }, cls);
  assert.equal(high.ok, false);
  assert.equal(high.field, 'etaProp');
  assert.match(high.reason, /η = 0\.91/);
  assert.match(high.reason, /landed %/);
  assert.match(high.reason, /7" long range/);

  const low = clampToClass({ etaProp: 0.12 }, cls);
  assert.equal(low.ok, false);
  assert.match(low.reason, /below the 0\.42 floor/);
  assert.match(low.reason, /dry weight/);

  const drag = clampToClass({ cdA: 0.4 }, cls);
  assert.equal(drag.ok, false);
  assert.match(drag.reason, /0\.400 m² drag area/);
  assert.match(drag.reason, /wind/);
});

test('clampToClass refuses an unsolvable fit and an unknown field, never throws', () => {
  const cls = classById('lr7');
  const nul = clampToClass({ etaProp: null }, cls);
  assert.equal(nul.ok, false);
  assert.match(nul.reason, /cannot invert|do not describe a flight/);
  assert.equal(clampToClass({ etaProp: 0.55 }, undefined).ok, false);
  assert.equal(clampToClass({ nonsense: 3 }, cls).ok, false);
  assert.equal(clampToClass(null, cls).ok, false);
});

/* ---------- confidence gating ---------- */

test('confidence follows §6.2’s gating table', () => {
  assert.equal(confidence(0, false), 'none');
  assert.equal(confidence(0, true), 'none');
  assert.equal(confidence(1, false), 'show');
  assert.equal(confidence(2, true), 'show');   // a spread cannot buy flights
  assert.equal(confidence(3, false), 'offer');
  assert.equal(confidence(4, true), 'offer');
  assert.equal(confidence(5, true), 'default');
  assert.equal(confidence(9, true), 'default');
  assert.equal(confidence(5, false), 'offer'); // 5 flights, one speed: still offer
  assert.equal(confidence(20, false), 'offer');
  assert.equal(confidence(undefined), 'none');
  assert.equal(confidence(NaN, true), 'none');
});

/* ---------- the class table itself ---------- */

test('every class template is internally consistent', () => {
  const ids = new Set();
  for (const c of CLASSES) {
    assert.ok(c.id && !ids.has(c.id), `duplicate or missing class id: ${c.id}`);
    ids.add(c.id);
    assert.ok(c.label && c.ranges, `${c.id} is missing a label or ranges`);
    assert.ok(c.sMin >= 1 && c.sMax >= c.sMin, `${c.id} has a broken S range`);
    assert.ok(c.numRotors >= 3, `${c.id} has too few rotors`);
    assert.ok(c.cruiseMs < c.maxSpeedMs, `${c.id} cruises faster than its top speed`);
    assert.ok(['estimated', 'calibrated'].includes(c.confidence), `${c.id}: ${c.confidence}`);
    for (const key of ['etaProp', 'cdA', 'avionicsW', 'propDiaIn', 'cruiseMs', 'maxSpeedMs']) {
      const [lo, hi] = c.ranges[key];
      assert.ok(lo < hi, `${c.id}.ranges.${key} is inverted`);
      assert.ok(c[key] >= lo && c[key] <= hi,
        `${c.id}: nominal ${key} ${c[key]} sits outside its own range ${lo}–${hi}`);
    }
    assert.ok(c.ranges.dryMassG[0] < c.ranges.dryMassG[1]);
  }
  assert.equal(CLASSES.length, 6);
});

test('the two anchored classes match the calibrated built-ins exactly', () => {
  for (const [classId, droneId] of [['cinewhoop3', 'cinelog30v3'], ['lr7', 'moz7v2']]) {
    const c = classById(classId);
    const d = DRONES.find(x => x.id === droneId);
    assert.equal(c.anchoredBy, droneId);
    assert.equal(c.confidence, 'calibrated');
    assert.equal(c.etaProp, d.etaProp);
    assert.equal(c.cdA, d.cdA);
    assert.equal(c.avionicsW, d.avionicsW);
    assert.equal(c.cruiseMs, d.cruiseMs);
    assert.equal(c.maxSpeedMs, d.maxSpeedMs);
  }
  // Every other row is labeled interpolation, per §6.1.
  const estimated = CLASSES.filter(c => c.confidence === 'estimated');
  assert.equal(estimated.length, 4);
  assert.ok(estimated.every(c => c.anchoredBy === null));
});

test('the built-in airframes validate against their own class ranges', () => {
  for (const [classId, droneId] of [['cinewhoop3', 'cinelog30v3'], ['lr7', 'moz7v2']]) {
    const c = classById(classId);
    const d = DRONES.find(x => x.id === droneId);
    for (const key of ['etaProp', 'cdA', 'avionicsW', 'dryMassG', 'propDiaIn', 'cruiseMs', 'maxSpeedMs']) {
      const [lo, hi] = c.ranges[key];
      assert.ok(d[key] >= lo && d[key] <= hi, `${droneId}.${key} = ${d[key]} outside ${lo}–${hi}`);
    }
    assert.ok(d.s >= c.sMin && d.s <= c.sMax, `${droneId} cell count outside the class range`);
  }
});
