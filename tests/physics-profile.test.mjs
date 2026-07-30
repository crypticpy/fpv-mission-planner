import test from 'node:test';
import assert from 'node:assert/strict';

import { DRONES } from '../js/catalog/drones.js';
import { BATTERIES } from '../js/catalog/batteries.js';
import { CLASSES } from '../js/catalog/classes.js';
import {
  G, PROFILE_MU2, airDensity, discAreaM2, dischargeSim, dischargeToSoc,
  planMission, powerAtSpeed,
} from '../js/physics.js';
import { solveCdA, solveEtaProp } from '../js/calibrate.js';

// Phase 4 item 1: powerAtSpeed grew a speed-dependent profile-power term
// (P0·(1 + k·µ²)) and the induced-velocity tilt correction that term was masking.
// What these tests hold down, in order:
//
//   1. hover is untouched — the µ² excess and the tilt are both zero at v = 0, so
//      etaProp keeps its meaning and calibrate.js's closed-form hover solve keeps
//      recovering it exactly. This is the property the whole design hangs on.
//   2. the two new terms do what they say: the excess is exactly quadratic in the
//      edgewise flow, and the tilt makes forward flight cheaper, not dearer.
//   3. powerAtSpeed is still strictly increasing in cdA at a fixed airspeed,
//      which is the bracket solveCdA bisects inside.
//   4. the anchors still hold — the published Oscar Liang / GEPRC flight figures
//      for both calibrated built-ins, no worse than the flat-η model reproduced.
//   5. the bias is actually fixed, in the direction the design doc names: best
//      range speed down, Wh per km at cruise up.

const moz7 = DRONES.find(d => d.id === 'moz7v2');
const cinelog = DRONES.find(d => d.id === 'cinelog30v3');
const geprc720 = BATTERIES.find(b => b.id === 'geprc720');
const tattu850 = BATTERIES.find(b => b.id === 'tattu850');
const nav5000 = BATTERIES.find(b => b.id === 'nav5000');

// The MOZ7's anchor flight was flown on a 6S 6000 mAh Li-Ion, which is not a pack
// in the catalog — the closest real record is the NAV 5000. This is that record
// with the anchor's capacity and a mass and resistance scaled to match, and it
// exists only here: it is the reviewer's pack, not a shipping option.
const anchorPack6s6000 = {
  ...nav5000,
  id: 'test-anchor-6s6000',
  capAh: 6.0,
  massG: 599,
  irPackMilliOhm: nav5000.irPackMilliOhm * 5 / 6,
  maxContA: 42,
};

const ENV = { elevM: 0, tempC: 20, rhPct: 50 };

function cfgFor(drone, battery, over = {}) {
  return {
    massKg: (drone.dryMassG + battery.massG) / 1000,
    rho: airDensity(ENV.elevM, ENV.tempC, ENV.rhPct).rho,
    areaM2: discAreaM2(drone),
    cdA: drone.cdA,
    etaProp: drone.etaProp,
    avionicsW: drone.avionicsW,
    ...over,
  };
}

/**
 * The model with the tilt correction taken back out — the pre-change inflow,
 * hypot(v, vi), and everything else identical. Not a second implementation of
 * the physics: it exists so the tilt term's *sign* can be asserted rather than
 * asserted about.
 */
function untiltedPowerAtSpeed({ massKg, rho, areaM2, cdA, etaProp, avionicsW }, vMs) {
  const W = massKg * G;
  const D = 0.5 * rho * cdA * vMs * vMs;
  const T = Math.hypot(W, D);
  const vh2 = T / (2 * rho * areaM2);
  const vHover = Math.sqrt(vh2);
  let vi = vHover;
  for (let i = 0; i < 30; i++) vi = vh2 / Math.hypot(vMs, vi);
  const vEdge = vMs * (T > 0 ? W / T : 1);
  const pProfile = vHover > 0 ? PROFILE_MU2 * T * vEdge * vEdge / vHover : 0;
  return (T * vi + D * vMs + pProfile) / etaProp + avionicsW;
}

const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

/* ---------- 1. hover is untouched ---------- */

for (const [drone, battery] of [[moz7, anchorPack6s6000], [cinelog, geprc720]]) {
  test(`${drone.short}: hover power is still the closed form the η solve inverts`, () => {
    const cfg = cfgFor(drone, battery);
    const W = cfg.massKg * G;
    const closedForm = W * Math.sqrt(W / (2 * cfg.rho * cfg.areaM2));

    // The ideal reading solveEtaProp takes: no drag, unit efficiency, no avionics.
    const pIdeal = powerAtSpeed({ ...cfg, cdA: 0, etaProp: 1, avionicsW: 0 }, 0);
    assert.ok(rel(pIdeal, closedForm) < 1e-12,
      `ideal hover power ${pIdeal} is not m·g·√(m·g/2ρA) = ${closedForm}`);

    // And cdA really does drop out at v = 0, however draggy the airframe.
    assert.equal(powerAtSpeed({ ...cfg, cdA: 0 }, 0), powerAtSpeed({ ...cfg, cdA: 10 }, 0));
    assert.equal(powerAtSpeed(cfg, 0), pIdeal / drone.etaProp + drone.avionicsW);
  });

  test(`${drone.short}: a synthetic hover log still recovers etaProp exactly`, () => {
    const pHover = powerAtSpeed(cfgFor(drone, battery), 0);
    const minutes = dischargeSim(battery, ENV.tempC, pHover).deliveredWh / pHover * 60 * 0.6;
    const landedSocPct = dischargeToSoc(battery, ENV.tempC, pHover, minutes) * 100;
    const got = solveEtaProp({ drone, battery, env: ENV, minutes, landedSocPct });
    assert.ok(rel(got.etaProp, drone.etaProp) < 1e-9,
      `${drone.short}: recovered η ${got.etaProp} vs ${drone.etaProp}`);
  });
}

/* ---------- 2. the two new terms behave ---------- */

test('the profile excess is exactly quadratic in the edgewise flow', () => {
  // With no drag there is no tilt, so the edgewise flow is the airspeed itself
  // and the thrust (hence v_h) is fixed: the excess must scale as v² exactly.
  const cfg = cfgFor(moz7, anchorPack6s6000, { cdA: 0, etaProp: 1, avionicsW: 0 });
  const base = powerAtSpeed({ ...cfg, cdA: 0 }, 0);
  const excessAt = (v) => {
    const W = cfg.massKg * G;
    const vHover = Math.sqrt(W / (2 * cfg.rho * cfg.areaM2));
    let vi = vHover;
    for (let i = 0; i < 30; i++) vi = (vHover * vHover) / Math.hypot(v, vi);
    return powerAtSpeed(cfg, v) - W * vi;
  };
  const e10 = excessAt(10);
  const e20 = excessAt(20);
  assert.ok(base > 0);
  assert.ok(rel(e20, 4 * e10) < 1e-9, `doubling v did not quadruple the excess: ${e10} → ${e20}`);

  // …and it is the constant the module documents, not an accident.
  const W = cfg.massKg * G;
  const vHover = Math.sqrt(W / (2 * cfg.rho * cfg.areaM2));
  assert.ok(rel(e10, PROFILE_MU2 * W * 100 / vHover) < 1e-9);
});

test('the tilt correction makes forward flight cheaper, and only when tilted', () => {
  for (const [drone, battery] of [[moz7, anchorPack6s6000], [cinelog, geprc720]]) {
    const cfg = cfgFor(drone, battery);
    // No drag, no tilt: the corrected inflow is the uncorrected one.
    assert.equal(powerAtSpeed({ ...cfg, cdA: 0 }, 12), untiltedPowerAtSpeed({ ...cfg, cdA: 0 }, 12));
    assert.equal(powerAtSpeed(cfg, 0), untiltedPowerAtSpeed(cfg, 0));
    for (const v of [4, 9, 14, 18, 22]) {
      assert.ok(powerAtSpeed(cfg, v) < untiltedPowerAtSpeed(cfg, v),
        `${drone.short} at ${v} m/s: the tilt correction should lower induced power`);
    }
  }
});

/* ---------- 3. still invertible for cdA ---------- */

test('power is strictly increasing in cdA at a fixed airspeed', () => {
  for (const [drone, battery] of [[moz7, anchorPack6s6000], [cinelog, geprc720]]) {
    const cfg = cfgFor(drone, battery);
    for (const v of [1, 5, 9, 14, 18, 25, 40]) {
      let prev = -Infinity;
      for (let cdA = 0; cdA <= 1.2; cdA += 0.002) {
        const p = powerAtSpeed({ ...cfg, cdA }, v);
        assert.ok(p > prev, `${drone.short} at ${v} m/s: power fell at cdA ${cdA}`);
        prev = p;
      }
    }
  }
});

test('a synthetic cruise log still recovers cdA under the new model', () => {
  for (const [drone, battery] of [[moz7, anchorPack6s6000], [cinelog, geprc720]]) {
    const airspeedMs = drone.cruiseMs;
    const pW = powerAtSpeed(cfgFor(drone, battery), airspeedMs);
    const minutes = dischargeSim(battery, ENV.tempC, pW).deliveredWh / pW * 60 * 0.6;
    const landedSocPct = dischargeToSoc(battery, ENV.tempC, pW, minutes) * 100;
    const got = solveCdA({ drone, battery, env: ENV, minutes, landedSocPct, airspeedMs });
    assert.ok(rel(got.cdA, drone.cdA) < 1e-6,
      `${drone.short}: recovered cdA ${got.cdA} vs ${drone.cdA}`);
  }
});

/* ---------- 4. the anchors still hold ---------- */

// Steady flight at the airframe's calibrated hands-on cruise, no reserve and no
// maneuvering overhead: what "flew 15 km in 16 minutes" measures.
//
// `getHome: false` is what makes it a measurement rather than a plan: the pilot
// who flew 15 km flew the pack, not the pack minus a get-home margin. With the
// margin on, the anchor would read whatever margin this version happens to keep.
function anchorFlight(drone, battery, { windMs = 0, landFloorPct = 0, cruiseMode = 'real' } = {}) {
  const plan = planMission({
    drone, battery, payloadG: 0, extraG: 0,
    env: { ...ENV, windAvgMs: windMs, windGustMs: windMs, windMode: 'headOut' },
    landFloorPct, getHome: false, gustFactor: 0,
    cruiseMode, realVMs: drone.cruiseMs, overheadF: 1,
  });
  return {
    km: plan.totalKm, min: plan.timeMin, hoverMin: plan.hoverTimeMin,
    vMs: plan.legs.out.v, whPerKm: plan.legs.out.whPerKm,
  };
}

test('MOZ7 V2 still reproduces its anchor flight: ~16 min and 15+ km in wind', () => {
  // Oscar Liang: ~16 min and 15+ km on a 6S 6000 mAh Li-Ion in 15–20 mph wind
  // (7.8 m/s is the middle of that band).
  const got = anchorFlight(moz7, anchorPack6s6000, { windMs: 7.8 });
  assert.ok(got.km >= 15, `anchor range ${got.km.toFixed(2)} km fell under the published 15+ km`);
  assert.ok(got.min > 15 && got.min < 19, `anchor endurance ${got.min.toFixed(2)} min is not "~16 min"`);
  // The flat-η model this replaced reported 16.53 km / 18.85 min here. The new
  // model is 4% lower on both, which moves it toward the published ~16 min rather
  // than away from it — which is why the refit left cdA on 0.042.
  assert.ok(Math.abs(got.min - 16) < Math.abs(18.85 - 16),
    'the new model should agree with the published endurance at least as well as the old one');
  assert.ok(got.km / 16.53 > 0.94, `anchor range moved more than a few percent: ${got.km.toFixed(2)} km`);
});

test('Cinelog30 V3 still reproduces both of its anchor figures', () => {
  // GEPRC claims 8:10 on a 4S 720; the measured figure is 7–7.5 min on an 850,
  // which is the one flown with the app's default 20% landing reserve.
  const claimed = anchorFlight(cinelog, geprc720);
  assert.ok(claimed.min > 8.3 && claimed.min < 9.4,
    `720 mAh endurance ${claimed.min.toFixed(2)} min no longer brackets the 8:10 claim`);

  const measured = anchorFlight(cinelog, tattu850, { landFloorPct: 20 });
  assert.ok(measured.min >= 7 && measured.min <= 7.6,
    `850 mAh endurance ${measured.min.toFixed(2)} min left the measured 7–7.5 min window`);

  // The re-solved 0.020 m² is what keeps these where the flat-η model had them
  // (9.05 min and 7.55 min); at the old 0.018 the tilt correction alone would have
  // added 3.5% of free endurance the anchor flights never showed.
  assert.ok(rel(claimed.min, 9.05) < 0.02, `720 anchor drifted: ${claimed.min.toFixed(3)} vs 9.05`);
  assert.ok(rel(measured.min, 7.55) < 0.02, `850 anchor drifted: ${measured.min.toFixed(3)} vs 7.55`);
});

test('hover endurance is bit-identical to the flat-η model for both anchors', () => {
  // Nothing about hover changed, so these are the pre-change numbers verbatim,
  // read off the flat-η model at 1805e03 and compared at full precision.
  assert.equal(anchorFlight(moz7, anchorPack6s6000).hoverMin, 39.258659582842974);
  assert.equal(anchorFlight(cinelog, geprc720).hoverMin, 10.562331692012929);
});

/* ---------- 5. the bias the doc names is actually fixed ---------- */

// Measured against the flat-η model at codex/roadmap-phase-4 @ 1805e03 — the
// commit this change replaced — with the same catalog records and the same
// mission setup, and written down here rather than recomputed, so this test
// cannot drift along with the model it is judging.
const FLAT_ETA = {
  moz7: {
    bestRangeVMs: 12.50, whPerKmAtCruise: 5.769, rangeKm: 27.45,
    bestRangeVMsInWind: 16.50, whPerKmAtCruiseInWind: 10.181,
  },
  cinelog: { bestRangeVMs: 9.75, whPerKmAtCruise: 2.269, rangeKm: 4.91 },
};

test('best-range speed drops and Wh/km at cruise rises for both calibrated rigs', () => {
  const cases = [
    ['MOZ7 V2', moz7, anchorPack6s6000, FLAT_ETA.moz7],
    ['Cinelog30 V3', cinelog, geprc720, FLAT_ETA.cinelog],
  ];
  for (const [label, drone, battery, old] of cases) {
    const range = anchorFlight(drone, battery, { cruiseMode: 'range' });
    const cruise = anchorFlight(drone, battery);
    assert.ok(range.vMs <= old.bestRangeVMs,
      `${label}: best-range speed ${range.vMs} should not exceed the flat-η ${old.bestRangeVMs}`);
    assert.ok(cruise.whPerKm >= old.whPerKmAtCruise,
      `${label}: ${cruise.whPerKm.toFixed(3)} Wh/km at cruise should not fall below the flat-η ${old.whPerKmAtCruise}`);
    assert.ok(range.km <= old.rangeKm,
      `${label}: best-range distance ${range.km.toFixed(2)} km should not exceed the flat-η ${old.rangeKm}`);
  }
});

test('the headwind case — the one the doc cares about — moves the same way', () => {
  const range = anchorFlight(moz7, anchorPack6s6000, { windMs: 7.8, cruiseMode: 'range' });
  const cruise = anchorFlight(moz7, anchorPack6s6000, { windMs: 7.8 });
  assert.ok(range.vMs <= FLAT_ETA.moz7.bestRangeVMsInWind);
  assert.ok(cruise.whPerKm > FLAT_ETA.moz7.whPerKmAtCruiseInWind,
    `into a headwind the plan must cost more per km, not less: ${cruise.whPerKm.toFixed(3)} vs ${FLAT_ETA.moz7.whPerKmAtCruiseInWind}`);
});

test('the effect is a few percent, not a recalibration in disguise', () => {
  const cruise = anchorFlight(moz7, anchorPack6s6000);
  assert.ok(cruise.whPerKm / FLAT_ETA.moz7.whPerKmAtCruise < 1.08,
    `Wh/km at cruise moved ${((cruise.whPerKm / FLAT_ETA.moz7.whPerKmAtCruise - 1) * 100).toFixed(1)}% — too far to call a refinement`);
});

/* ---------- the class table still agrees with the built-ins ---------- */

test('the anchored class rows carry the re-solved drag areas', () => {
  const byId = new Map(CLASSES.map(c => [c.id, c]));
  assert.equal(byId.get('cinewhoop3').cdA, cinelog.cdA);
  assert.equal(byId.get('lr7').cdA, moz7.cdA);
  for (const c of CLASSES) {
    const [lo, hi] = c.ranges.cdA;
    assert.ok(c.cdA >= lo && c.cdA <= hi, `${c.id}: cdA ${c.cdA} is outside its own ${lo}–${hi} range`);
  }
});
