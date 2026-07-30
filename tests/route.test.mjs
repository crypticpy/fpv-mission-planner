import test from 'node:test';
import assert from 'node:assert/strict';

import { destination, distanceKm, bearingTo } from '../src/geo.js';
import { planMission, legSolverFrom, U } from '../src/physics.js';
import { planRoute } from '../src/route.js';

/* Phase 4 item 7: waypoint/dogleg routes and loiter-at-range.
 *
 * The claim the whole feature rests on is that this is the *same* model read the
 * other way round — the footprint solves for the radius that exhausts the budget,
 * a route integrates a polyline against it. So the load-bearing test is the
 * degenerate one: a route that flies straight out to the turnaround and straight
 * back has to reproduce planMission's own numbers, not merely agree with them to
 * three figures. Everything else here is about the cases the ring cannot express:
 * a dogleg's crosswind legs, a reserve measured at an intermediate turn, and how
 * long you can sit there when you arrive. */

const AUSTIN = { lat: 30.2672, lng: -97.7431 };

// MOZ7 V2 + NAV 5000 6S Li-Ion (mirrors src/catalog, same figures reserve.test.mjs uses).
const moz7 = {
  dryMassG: 843, propDiaIn: 7.5, numRotors: 4, cdA: 0.042,
  etaProp: 0.55, avionicsW: 12, maxSpeedMs: 30.5, cruiseMs: 18,
};
const nav5000 = { chem: 'liion', s: 6, capAh: 5.0, massG: 499, irPackMilliOhm: 60 };

const WIND_FROM = 170;

function inputs(overrides = {}, envOverrides = {}) {
  return {
    drone: moz7, battery: nav5000, payloadG: 0, extraG: 0,
    env: {
      elevM: U.ftToM(550), tempC: U.fToC(75), rhPct: 40,
      windFromDeg: WIND_FROM, windMode: 'headOut',
      windAvgMs: U.mphToMs(8), windGustMs: U.mphToMs(16),
      ...envOverrides,
    },
    landFloorPct: 20, cruiseMode: 'real', realVMs: moz7.cruiseMs, overheadF: 1.05,
    ...overrides,
  };
}

/** A plan flown out on an absolute course, the way the map footprint sweeps it. */
function planOn(courseDeg, overrides = {}, envOverrides = {}) {
  return planMission({ ...inputs(overrides, envOverrides), courseDeg });
}

const wpAt = (courseDeg, km, from = AUSTIN) => {
  const [lat, lng] = destination(from.lat, from.lng, courseDeg, km);
  return { lat, lng };
};

// The route reads only the cruise policy off the inputs, and every fixture here
// overrides the plan's air or reserve rather than how it flies — so the base bag
// is the right one to hand back in.
const route = (plan, waypoints, launch = AUSTIN) =>
  planRoute(plan, { launch, waypoints, windFromDeg: WIND_FROM, inputs: inputs() });

/* ---------- 1. the degenerate route IS the radius case ---------- */

test('a straight out-and-back route reproduces the plan it was drawn on', () => {
  // Due north, so the reverse leg's bearing is exactly 180° and the wind
  // decomposition on the way home is the plan's own back-leg vector.
  const r = planOn(0);
  assert.ok(r.radiusKm > 1, 'the fixture has to actually close a mission');
  const rt = route(r, [wpAt(0, r.radiusKm)]);

  assert.equal(rt.legs.length, 2, 'one waypoint is one out leg and one leg home');
  assert.equal(rt.legs[0].phase, 'out');
  assert.equal(rt.legs[1].phase, 'home');

  const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

  // Same airspeeds and the same ground speeds planMission solved. Airspeed is
  // bit-identical — it comes straight off the cruise policy. Ground speed agrees
  // to a part in 1e13 rather than exactly, and the reason is geometry, not
  // physics: placing a waypoint due north and reading its bearing back returns
  // 1.6e-11° instead of a clean zero, so the wind decomposition picks up a
  // vanishing crosswind the plan's own vector does not have. A part in 1e13 of a
  // ground speed is a micrometre per hour.
  assert.equal(rt.legs[0].vMs, r.legs.out.v);
  assert.equal(rt.legs[1].vMs, r.legs.back.v);
  assert.ok(rel(rt.legs[0].vgMs, r.legs.out.vg) < 1e-9,
    `${rt.legs[0].vgMs} vs ${r.legs.out.vg}`);
  assert.ok(rel(rt.legs[1].vgMs, r.legs.back.vg) < 1e-9,
    `${rt.legs[1].vgMs} vs ${r.legs.back.vg}`);

  // And the same energy and clock. `usableWh` is exactly radius × round-trip
  // Wh/km, which is what integrating this polyline has to come out at.
  assert.ok(rel(rt.totalKm, r.totalKm) < 1e-9, `${rt.totalKm} vs ${r.totalKm}`);
  assert.ok(rel(rt.totalWh, r.energy.usableWh) < 1e-9, `${rt.totalWh} vs ${r.energy.usableWh}`);
  assert.ok(rel(rt.totalMin, r.timeMin) < 1e-9, `${rt.totalMin} vs ${r.timeMin}`);
});

test('the route verdict flips exactly at the turnaround the ring solved', () => {
  const r = planOn(0);
  assert.equal(route(r, [wpAt(0, r.radiusKm * 0.999)]).fits, true);
  assert.equal(route(r, [wpAt(0, r.radiusKm * 1.001)]).fits, false);
  // And it flips for the reason the plan says it should: whichever constraint
  // capped the radius is the one the over-long route runs into.
  assert.equal(route(r, [wpAt(0, r.radiusKm * 1.001)]).binds, r.energy.reserveBinds);
});

test('a route far past the footprint reports how far past, not just "no"', () => {
  const r = planOn(0);
  const rt = route(r, [wpAt(0, r.radiusKm * 3)]);
  assert.equal(rt.fits, false);
  assert.ok(rt.marginWh < 0, 'the overrun is a signed Wh figure');
  assert.ok(rt.totalWh > r.energy.usableWh);
  assert.equal(rt.loiter.wh, 0, 'and a route that overruns has no loiter budget');
});

/* ---------- 2. doglegs: the thing the ring cannot express ---------- */

test('a dogleg sums the per-leg energy, each leg on its own wind', () => {
  const r = planOn(0);
  // North 3 km, then east 2 km — the "out along the river, cut to the ridge" shape.
  const wp1 = wpAt(0, 3);
  const wp2 = wpAt(90, 2, wp1);
  const rt = route(r, [wp1, wp2]);

  assert.equal(rt.legs.length, 3);
  assert.equal(rt.legs.filter(l => l.phase === 'out').length, 2);

  // Hand-check leg 2: solve it straight off the plan's own leg solver, at the
  // bearing the geometry produces, and it must be the number the route reports.
  const course2 = bearingTo(wp1, wp2);
  const d = (course2 - WIND_FROM) * Math.PI / 180;
  const w = r.wind.planningMs;
  const solved = legSolverFrom(r, inputs())({
    head: w * Math.cos(d), cross: w * Math.abs(Math.sin(d)),
  });
  assert.ok(solved, 'the cross/tail leg has to close');
  const expectedWh = distanceKm(wp1, wp2) * solved.whPerKm;
  assert.ok(Math.abs(rt.legs[1].whLeg - expectedWh) < 1e-9, `${rt.legs[1].whLeg} vs ${expectedWh}`);

  // Totals are the sum of the parts, and the parts are all three legs.
  const sum = rt.legs.reduce((a, l) => a + l.whLeg, 0);
  assert.ok(Math.abs(rt.totalWh - sum) < 1e-12);
  assert.ok(Math.abs(rt.outWh - (rt.legs[0].whLeg + rt.legs[1].whLeg)) < 1e-12);

  // The crosswind leg really is crosswind: a bearing 90° off the wind axis is
  // all cross component and no along-track one.
  const cross = route(r, [wpAt(WIND_FROM + 90, 2)]);
  assert.equal(cross.legs[0].headMs, 0);
  assert.ok(cross.legs[0].crossMs > 0);
});

test('the return home is the direct line from the last waypoint, not the route back', () => {
  const r = planOn(0);
  const wp1 = wpAt(0, 4);
  const wp2 = wpAt(90, 4, wp1);
  const rt = route(r, [wp1, wp2]);
  const home = rt.legs.at(-1);
  assert.ok(Math.abs(home.distKm - distanceKm(wp2, AUSTIN)) < 1e-9);
  // The diagonal home is shorter than retracing the two legs — that is the whole
  // point of the assumption, and it is the leg a failsafe actually flies.
  assert.ok(home.distKm < rt.legs[0].distKm + rt.legs[1].distKm);
});

/* ---------- 3. the reserve covers the worst point, not the last one ---------- */

test('the get-home reserve is measured at the farthest point of the route', () => {
  const r = planOn(0);
  // Out a long way, then most of the way back: the last waypoint is close to
  // home, but the pack was committed at the first one.
  const far = wpAt(0, r.radiusKm * 0.9);
  const near = wpAt(0, 0.3);
  const rt = route(r, [far, near]);
  assert.equal(rt.holds.length, 2);
  assert.equal(rt.worst.index, 0, 'the outbound turn is where the reserve binds');
  assert.ok(rt.holds[0].needWh > rt.holds[1].needWh);
  assert.ok(rt.holds[0].distHomeKm > rt.holds[1].distHomeKm);
});

test('the reserve constraint is planMission’s own, written out at each turn', () => {
  const r = planOn(0);
  const rt = route(r, [wpAt(0, r.radiusKm)]);
  const hold = rt.holds[0];
  // spent + adverse return + hunt-and-land, against the delivered energy — the
  // closed form planMission solves for `rHome`, evaluated instead of inverted.
  const expected = r.radiusKm * r.legs.out.whPerKm
    + r.radiusKm * r.legs.home.whPerKm
    + r.energy.huntLandWh;
  assert.ok(Math.abs(hold.needWh - expected) / expected < 1e-9, `${hold.needWh} vs ${expected}`);
  assert.ok(rt.budget.huntLandWh > 0, 'and the hunt-and-land allowance is in it');
});

test('planning with no reserve policy leaves only the pack-care floor', () => {
  const r = planOn(0, { getHome: false });
  assert.equal(r.energy.getHomeWindMs, null);
  const rt = route(r, [wpAt(0, r.radiusKm)]);
  assert.equal(rt.binds, 'floor');
  assert.equal(rt.holds[0].homeWh, 0, 'no reserve policy, no adverse return to hold energy for');
  assert.ok(rt.fits);
});

/* ---------- 4. loiter ---------- */

test('loiter minutes are the spare energy divided by hover power', () => {
  const r = planOn(0);
  const rt = route(r, [wpAt(0, r.radiusKm * 0.5)]);
  assert.ok(rt.fits);
  assert.ok(rt.loiter.wh > 0);
  assert.equal(rt.loiter.pHoverW, r.hover.pW);
  assert.equal(rt.loiter.min, rt.loiter.wh / r.hover.pW * 60);
  assert.ok(rt.loiter.min > 0);
  // The spare is the tighter of the two constraints, and it says which.
  assert.ok(['floor', 'getHome'].includes(rt.loiter.binds));
  const floorSpare = rt.budget.floorWh - rt.totalWh;
  const homeSpare = rt.budget.deliveredWh - rt.holds.at(-1).needWh;
  assert.ok(Math.abs(rt.loiter.wh - Math.min(floorSpare, homeSpare)) < 1e-12);
});

test('a route at the full turnaround has nothing left to loiter on', () => {
  const r = planOn(0);
  const rt = route(r, [wpAt(0, r.radiusKm)]);
  assert.ok(rt.loiter.min < 1e-6, `expected ~0, got ${rt.loiter.min}`);
});

test('holding a point in wind costs more than hovering; in calm they are equal', () => {
  const calm = planOn(0, {}, { windAvgMs: 0, windGustMs: 0 });
  const calmRoute = route(calm, [wpAt(0, calm.radiusKm * 0.5)]);
  assert.equal(calmRoute.loiter.holdPw, calmRoute.loiter.pHoverW);
  assert.equal(calmRoute.loiter.holdMin, calmRoute.loiter.min);

  const windy = planOn(0, {}, { windAvgMs: U.mphToMs(25), windGustMs: U.mphToMs(35) });
  const windyRoute = route(windy, [wpAt(0, windy.radiusKm * 0.5)]);
  assert.ok(windyRoute.loiter.holdPw > windyRoute.loiter.pHoverW,
    'station-keeping in a 25 mph wind means flying at 25 mph');
  assert.ok(windyRoute.loiter.holdMin < windyRoute.loiter.min);
});

/* ---------- 5. degenerate input ---------- */

test('no waypoints is an empty route, not a crash', () => {
  const r = planOn(0);
  for (const wps of [[], null, undefined]) {
    const rt = route(r, wps);
    assert.equal(rt.empty, true);
    assert.equal(rt.legs.length, 0);
    assert.equal(rt.totalWh, 0);
    assert.equal(rt.fits, null);
    assert.equal(rt.loiter, null);
  }
  // Nonsense coordinates are dropped rather than propagated as NaN.
  assert.equal(route(r, [{ lat: NaN, lng: 0 }]).empty, true);
  // And with no launch point there is nothing to draw a route out of.
  assert.equal(planRoute(r, { launch: null, waypoints: [wpAt(0, 1)], windFromDeg: WIND_FROM }).empty, true);
});

test('a zero-length route costs nothing and loiters on the whole budget', () => {
  const r = planOn(0);
  const rt = route(r, [{ ...AUSTIN }]);
  assert.equal(rt.legs.length, 2);
  assert.equal(rt.totalKm, 0);
  assert.equal(rt.totalWh, 0);
  assert.equal(rt.totalMin, 0);
  assert.equal(rt.fits, true);
  // Nothing was spent and there is nowhere to fly home from, so the only thing
  // holding energy back is the landing floor and the hunt-and-land allowance.
  assert.ok(Math.abs(rt.loiter.wh - Math.min(
    rt.budget.floorWh,
    rt.budget.deliveredWh - rt.budget.huntLandWh)) < 1e-12);
  assert.ok(rt.loiter.min > 0);
});

test('a leg the wind beats is reported as unflyable rather than silently skipped', () => {
  // A wind past the loaded top speed: no airspeed makes headway on the upwind leg.
  const r = planOn(WIND_FROM, {}, { windAvgMs: 40, windGustMs: 40 });
  const rt = planRoute(r, {
    launch: AUSTIN, waypoints: [wpAt(WIND_FROM, 2)], windFromDeg: WIND_FROM,
  });
  assert.equal(rt.unflyable, true);
  assert.equal(rt.fits, false);
  assert.equal(rt.legs[0].whLeg, null);
  assert.equal(rt.legs[0].vgMs, null);
  // The distance and heading are still real — the pilot drew them, and the panel
  // has to be able to say which leg failed.
  assert.ok(rt.legs[0].distKm > 1);
});

/* ---------- 6. the geometry helper the routes are built on ---------- */

test('bearingTo inverts destination, and the reverse leg reads back', () => {
  for (const course of [0, 45, 90, 170, 250, 359]) {
    const p = wpAt(course, 6);
    assert.ok(Math.abs(bearingTo(AUSTIN, p) - course) < 1e-6, `out ${course}`);
    // The reverse azimuth is not the forward bearing plus 180 on a sphere: the
    // meridians converge along the leg. Over 6 km at this latitude that is a few
    // hundredths of a degree — far under the wind forecast's own resolution, and
    // it is the out-leg bearing above that the physics actually reads.
    const back = bearingTo(p, AUSTIN);
    const delta = Math.abs(((back - (course + 180)) % 360 + 540) % 360 - 180);
    assert.ok(delta < 0.05, `back ${course} → ${back} (${delta}°)`);
  }
  assert.equal(bearingTo(AUSTIN, { ...AUSTIN }), 0, 'two identical points have no bearing');
});
