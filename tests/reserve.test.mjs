import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planMission, powerAtSpeed, dischargeSim, GUST_FACTOR_DEFAULT, HUNT_LAND_HOVER_MIN, U,
} from '../src/domain/physics.js';

/* Phase 4 item 2 (the get-home reserve in Wh) and item 4 (the gust factor as a
 * parameter). Two loadouts, because the whole complaint against the percent
 * reserve was that it scaled backwards between a big pack and a small one. */

// MOZ7 V2 + NAV 5000 6S Li-Ion: ~95 Wh, long legs (mirrors src/catalog).
const moz7 = {
  dryMassG: 843, propDiaIn: 7.5, numRotors: 4, cdA: 0.042,
  etaProp: 0.55, avionicsW: 12, maxSpeedMs: 30.5, cruiseMs: 18,
};
const nav5000 = { chem: 'liion', s: 6, capAh: 5.0, massG: 499, irPackMilliOhm: 60 };

// Cinelog30 V3 + Tattu 850 4S: ~12.6 Wh, the pack the percent reserve underserved.
const cinelog = {
  dryMassG: 168, propDiaIn: 3.0, numRotors: 4, cdA: 0.020,
  etaProp: 0.62, avionicsW: 6, maxSpeedMs: 22, cruiseMs: 11,
};
const tattu850 = { chem: 'lipo', s: 4, capAh: 0.85, massG: 92, irPackMilliOhm: 30 };

const ENV = { elevM: U.ftToM(550), tempC: U.fToC(75), rhPct: 40, windFromDeg: 170 };

function inputs(drone, battery, overrides = {}, envOverrides = {}) {
  return {
    drone, battery, payloadG: 0, extraG: 0,
    env: {
      ...ENV,
      windAvgMs: U.mphToMs(8), windGustMs: U.mphToMs(16), windMode: 'headOut',
      ...envOverrides,
    },
    landFloorPct: 20, cruiseMode: 'real', realVMs: drone.cruiseMs, overheadF: 1.05,
    ...overrides,
  };
}

const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

/* ---------- 1. the reserve is an energy, and it is the right size ---------- */

test('the reserve is reported in Wh and covers the flight home plus the hunt-and-land', () => {
  for (const [drone, battery] of [[moz7, nav5000], [cinelog, tattu850]]) {
    const r = planMission(inputs(drone, battery));
    const e = r.energy;
    assert.ok(r.radiusKm > 0, 'the fixture mission has to close');
    assert.ok(e.reserveWh > 0);
    // reserveWh is derived: what is left of the delivered energy after the legs.
    assert.ok(rel(e.reserveWh, e.deliveredWh - e.usableWh) < 1e-12);
    // getHomeWh is the reserve the doc defines — the worst-case return from this
    // turnaround, hunt-and-land included…
    assert.ok(rel(e.getHomeWh, r.legs.home.whPerKm * r.radiusKm + e.huntLandWh) < 1e-12);
    // …and the radius is capped so it still fits at the turnaround. Note this is
    // checked against the energy left when the turn is made, NOT against
    // reserveWh: a downwind-home plan lands on less than the upwind return costs,
    // and it is safe anyway because the turnaround is where the choice is made.
    const atTurnWh = e.deliveredWh - r.radiusKm * r.legs.out.whPerKm;
    assert.ok(atTurnWh >= e.getHomeWh - 1e-9,
      `${drone.propDiaIn}": ${atTurnWh.toFixed(2)} Wh at the turnaround < the ${e.getHomeWh.toFixed(2)} Wh needed`);
    // The hunt-and-land allowance is hover minutes, so it scales with the
    // aircraft and not with the pack.
    assert.ok(rel(e.huntLandWh, HUNT_LAND_HOVER_MIN * r.hover.pW / 60) < 1e-12);
  }
});

test('the small pack gets the larger share of itself, which percent had backwards', () => {
  const big = planMission(inputs(moz7, nav5000)).energy;
  const small = planMission(inputs(cinelog, tattu850)).energy;
  const shareOfHunt = (e) => e.huntLandWh / e.deliveredWh;
  assert.ok(small.huntLandWh < big.huntLandWh, 'in absolute Wh the small rig holds back less');
  // 7.4% of the 850 against 4.3% of the 6S 5000 as this model stands. The
  // direction is the claim; the 1.5× is the margin that keeps it a real result.
  assert.ok(shareOfHunt(small) > shareOfHunt(big) * 1.5,
    `hunt-and-land is ${(shareOfHunt(small) * 100).toFixed(1)}% of the small pack `
    + `vs ${(shareOfHunt(big) * 100).toFixed(1)}% of the big one`);
});

test('getHome:false makes the plan an unreserved measurement', () => {
  const planned = planMission(inputs(moz7, nav5000));
  const measured = planMission(inputs(moz7, nav5000, { getHome: false, landFloorPct: 0 }));
  assert.equal(measured.energy.huntLandWh, 0);
  assert.equal(measured.energy.getHomeWindMs, null);
  assert.equal(measured.energy.reserveBinds, 'floor');
  assert.ok(rel(measured.energy.usableWh, measured.energy.deliveredWh) < 1e-12);
  assert.ok(measured.radiusKm > planned.radiusKm);
});

/* ---------- 2. the headline wind is a real number, not a label ---------- */

// Fly the retained energy home at the wind the app claims it holds to, by the
// same integration the mission uses: solve the leg at that pure headwind and
// spend radiusKm of it. This is the check that the headline is not decorative.
function homeLegCostWh(drone, battery, plan, windMs, overrides = {}) {
  const r = planMission(inputs(drone, battery, {
    ...overrides, courseDeg: ENV.windFromDeg, gustFactor: 0,
  }, { windAvgMs: windMs, windGustMs: windMs }));
  assert.ok(r.legs.out, 'the home leg has to be flyable at the claimed wind');
  return r.legs.out.whPerKm * plan.radiusKm;
}

test('the reserve really does fly home at the headwind it claims to hold', () => {
  for (const [drone, battery] of [[moz7, nav5000], [cinelog, tattu850]]) {
    const plan = planMission(inputs(drone, battery));
    const e = plan.energy;
    const holds = e.holdsHeadwindMs;
    assert.ok(holds > 0, 'a closing mission has a headwind figure');
    // Energy still in the pack at the turnaround, less the hunt-and-land.
    const atTurnWh = e.deliveredWh - plan.radiusKm * plan.legs.out.whPerKm - e.huntLandWh;
    const costAt = homeLegCostWh(drone, battery, plan, holds);
    assert.ok(costAt <= atTurnWh + 1e-9,
      `${drone.propDiaIn}": flying home at the claimed ${holds.toFixed(2)} m/s costs `
      + `${costAt.toFixed(3)} Wh of the ${atTurnWh.toFixed(3)} Wh retained`);
    // And it is the *strongest* such wind: a stiffer one must not fit. (Skipped
    // when the figure is pinned at the airframe's own top speed — there is no
    // stronger wind the model can fly at all.)
    if (holds < plan.speedLimitMs - 1e-6) {
      const stiffer = Math.min(holds + 0.2, plan.speedLimitMs);
      assert.ok(homeLegCostWh(drone, battery, plan, stiffer) > atTurnWh,
        `${drone.propDiaIn}": ${stiffer.toFixed(2)} m/s also fits, so the figure is not the limit`);
    }
  }
});

test('when getting home is the binding constraint the headline is the planning wind', () => {
  // A big floor is easy to satisfy, so the get-home constraint binds: the
  // headline then has to converge on the wind the reserve was sized against.
  const r = planMission(inputs(moz7, nav5000, { landFloorPct: 0 }));
  assert.equal(r.energy.reserveBinds, 'getHome');
  assert.ok(rel(r.energy.holdsHeadwindMs, r.energy.getHomeWindMs) < 1e-3,
    `holds ${r.energy.holdsHeadwindMs} vs planning ${r.energy.getHomeWindMs}`);
  assert.ok(rel(r.energy.getHomeWindMs, r.wind.planningMs) < 1e-12);
});

test('a floor that holds back more than getting home needs binds instead, and holds harder', () => {
  const loose = planMission(inputs(moz7, nav5000, { landFloorPct: 0 }));
  const tight = planMission(inputs(moz7, nav5000, { landFloorPct: 40 }));
  assert.equal(tight.energy.reserveBinds, 'floor');
  assert.ok(tight.radiusKm < loose.radiusKm);
  assert.ok(tight.energy.holdsHeadwindMs > loose.energy.holdsHeadwindMs,
    'a shorter mission with more energy left must beat a stronger headwind home');
});

test('an overridden get-home wind moves the reserve, and a calmer one buys radius', () => {
  const base = planMission(inputs(moz7, nav5000, { landFloorPct: 0 }));
  const calm = planMission(inputs(moz7, nav5000, { landFloorPct: 0, getHome: { windMs: 0 } }));
  const gale = planMission(inputs(moz7, nav5000, { landFloorPct: 0, getHome: { windMs: 12 } }));
  assert.ok(calm.radiusKm > base.radiusKm);
  assert.ok(gale.radiusKm < base.radiusKm);
  assert.ok(rel(gale.energy.holdsHeadwindMs, 12) < 1e-3);
  // The hunt-and-land half is separately overridable, and zero means zero.
  const noHunt = planMission(inputs(moz7, nav5000, { landFloorPct: 0, getHome: { huntLandMin: 0 } }));
  assert.equal(noHunt.energy.huntLandWh, 0);
  assert.ok(noHunt.radiusKm > base.radiusKm);
});

test('a mission that closes outbound still closes the worst-case return', () => {
  // No new collapse cliff: the get-home leg is the blended planning wind, which
  // the outbound leg already had to beat in head/tail geometries.
  for (const windMode of ['headOut', 'tailOut']) {
    for (let mph = 0; mph <= 40; mph += 2) {
      const r = planMission(inputs(moz7, nav5000, {}, {
        windMode, windAvgMs: U.mphToMs(mph), windGustMs: U.mphToMs(mph * 1.6),
      }));
      if (r.legs.out && r.legs.back) {
        assert.ok(r.legs.home, `${windMode} at ${mph} mph: out and back close but home does not`);
        assert.ok(r.radiusKm > 0, `${windMode} at ${mph} mph: zero radius with all three legs`);
      }
    }
  }
});

test('the pack-care floor is the only reserve a hover has', () => {
  const drone = moz7, battery = nav5000;
  const r = planMission(inputs(drone, battery, { landFloorPct: 25 }));
  const cfg = r.cfg;
  const pHover = powerAtSpeed(cfg, 0);
  const expected = dischargeSim(battery, ENV.tempC, pHover).deliveredWh * 0.75 / pHover * 60;
  assert.ok(rel(r.hoverTimeMin, expected) < 1e-12);
});

/* ---------- 3. the gust factor is a parameter now ---------- */

test('the default gust factor reproduces the hardcoded blend exactly', () => {
  assert.equal(GUST_FACTOR_DEFAULT, 0.35);
  const implicit = planMission(inputs(moz7, nav5000));
  const explicit = planMission(inputs(moz7, nav5000, { gustFactor: 0.35 }));
  assert.equal(implicit.wind.planningMs, explicit.wind.planningMs);
  assert.equal(implicit.radiusKm, explicit.radiusKm);
  assert.equal(implicit.energy.reserveWh, explicit.energy.reserveWh);
  assert.equal(implicit.wind.gustFactor, 0.35);
  // The blend itself, spelled out: average + share × spread.
  const avg = U.mphToMs(8), gust = U.mphToMs(16);
  assert.ok(rel(implicit.wind.planningMs, avg + 0.35 * (gust - avg)) < 1e-12);
});

test('the gust factor spans average-only to full-gust, monotonically', () => {
  let prevWind = -1, prevRadius = Infinity;
  for (const gf of [0, 0.25, 0.35, 0.5, 0.75, 1]) {
    const r = planMission(inputs(moz7, nav5000, { gustFactor: gf }));
    assert.ok(r.wind.planningMs > prevWind, `planning wind should rise with gustFactor ${gf}`);
    assert.ok(r.radiusKm < prevRadius, `radius should fall as gustFactor rises (${gf})`);
    prevWind = r.wind.planningMs;
    prevRadius = r.radiusKm;
  }
  const off = planMission(inputs(moz7, nav5000, { gustFactor: 0 }));
  const full = planMission(inputs(moz7, nav5000, { gustFactor: 1 }));
  assert.ok(rel(off.wind.planningMs, U.mphToMs(8)) < 1e-12, '0 plans the average');
  assert.ok(rel(full.wind.planningMs, U.mphToMs(16)) < 1e-12, '1 plans the full gust');
});

test('turning the gust factor up widens the get-home reserve too', () => {
  const mild = planMission(inputs(moz7, nav5000, { gustFactor: 0.2, landFloorPct: 0 }));
  const bold = planMission(inputs(moz7, nav5000, { gustFactor: 0.9, landFloorPct: 0 }));
  assert.ok(bold.energy.getHomeWindMs > mild.energy.getHomeWindMs);
  assert.ok(bold.energy.holdsHeadwindMs > mild.energy.holdsHeadwindMs);
  assert.ok(bold.energy.reserveWh > mild.energy.reserveWh);
});

test('a calm day makes the gust factor irrelevant, not just small', () => {
  const calm = { windAvgMs: 0, windGustMs: 0 };
  const a = planMission(inputs(moz7, nav5000, { gustFactor: 0 }, calm));
  const b = planMission(inputs(moz7, nav5000, { gustFactor: 1 }, calm));
  assert.equal(a.radiusKm, b.radiusKm);
  assert.equal(a.energy.holdsHeadwindMs, b.energy.holdsHeadwindMs);
});
