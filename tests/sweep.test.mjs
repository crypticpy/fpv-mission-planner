import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SWEEP_STEP_DEG, REFINE_MAX_DEPTH, REFINE_MAX_RAYS,
  alphaOffAxis, adaptiveHalfSweep, radiusAtAlpha, fullCircle, polarAreaKm2,
} from '../src/sweep.js';
import { planMission, U } from '../src/domain/physics.js';

/* Phase 4 item 10: the footprint sweep refines itself across the collapse cliff
 * instead of drawing a 5°-wide ramp over it. Most of this is geometry over a
 * synthetic sampler; the last block puts the real mission model behind it. */

const BASE_RAYS = 180 / SWEEP_STEP_DEG + 1; // 0…180 inclusive
const counted = (fn) => {
  const calls = [];
  const sample = (a) => { calls.push(a); return fn(a); };
  return { sample, calls };
};

/* ---------- 1. the base grid, unchanged where nothing is happening ---------- */

test('a smooth footprint gets the base grid and not one ray more', () => {
  for (const f of [
    () => 5,                                     // a circle: calm air
    (a) => 5 + 2 * Math.cos(a * Math.PI / 180),  // the ordinary wind-shifted egg
  ]) {
    const { sample, calls } = counted(f);
    const s = adaptiveHalfSweep(sample);
    assert.equal(s.extraRays, 0);
    assert.equal(calls.length, BASE_RAYS);
    assert.equal(s.angles.length, BASE_RAYS);
    assert.equal(s.angles[0], 0);
    assert.equal(s.angles.at(-1), 180);
    for (let i = 1; i < s.angles.length; i++) assert.ok(s.angles[i] > s.angles[i - 1]);
  }
});

test('rounding-scale disagreement is noise, not a cliff', () => {
  // A fan pinched to a few metres flips sign between rays at 100% relative
  // change; REFINE_MIN_KM is what stops the whole budget going into it.
  const { sample } = counted((a) => (a % 10 === 0 ? 0.001 : 0.03));
  assert.equal(adaptiveHalfSweep(sample).extraRays, 0);
});

/* ---------- 2. a cliff gets the rays, and only near the cliff ---------- */

test('a collapse in one sector is bisected there and nowhere else', () => {
  const cliffAt = 97.3;
  const { sample, calls } = counted((a) => (a < cliffAt ? 5 : 0));
  const s = adaptiveHalfSweep(sample);
  assert.equal(s.extraRays, REFINE_MAX_DEPTH, 'one interval, one bisection per depth');
  assert.equal(calls.length, BASE_RAYS + REFINE_MAX_DEPTH);
  const refined = s.angles.filter(a => !Number.isInteger(a));
  assert.equal(refined.length, REFINE_MAX_DEPTH);
  for (const a of refined) {
    assert.ok(a > 95 && a < 100, `refined ray at ${a} is outside the cliff interval`);
  }
  // Each bisection halves the bracket, so the last ray lands within
  // 5°/2^depth of the true edge — the polygon hugs the cliff to that accuracy.
  const resolution = SWEEP_STEP_DEG / 2 ** REFINE_MAX_DEPTH;
  const edge = Math.max(...s.angles.filter(a => radiusAtAlpha(s, a) > 0));
  assert.ok(cliffAt - edge < SWEEP_STEP_DEG,
    `the last live ray is ${(cliffAt - edge).toFixed(3)}° short of the cliff`);
  assert.ok(cliffAt - edge <= SWEEP_STEP_DEG - resolution + 1e-9);
});

test('refinement is spent sharpest-first and never past the budget', () => {
  // Every base interval disagrees hard: the queue is far bigger than the budget.
  const { sample, calls } = counted((a) => ((a / SWEEP_STEP_DEG) % 2 === 0 ? 5 : 0.5));
  const s = adaptiveHalfSweep(sample);
  assert.equal(s.extraRays, REFINE_MAX_RAYS);
  assert.equal(calls.length, BASE_RAYS + REFINE_MAX_RAYS);
  assert.equal(s.angles.length, BASE_RAYS + REFINE_MAX_RAYS);
  assert.equal(s.radii.length, s.angles.length);
});

test('the budget and the threshold are both real knobs', () => {
  const cliff = (a) => (a < 97.3 ? 5 : 0);
  assert.equal(adaptiveHalfSweep(cliff, { maxRays: 0 }).extraRays, 0);
  assert.equal(adaptiveHalfSweep(cliff, { maxDepth: 1 }).extraRays, 1);
  assert.equal(adaptiveHalfSweep(cliff, { maxDepth: 6 }).extraRays, 6);
  // A threshold above 1 can never be exceeded — no relative change is > 100%.
  assert.equal(adaptiveHalfSweep(cliff, { relThreshold: 1.01 }).extraRays, 0);
  // …and one at the floor refines the ordinary egg too.
  assert.ok(adaptiveHalfSweep((a) => 5 + 2 * Math.cos(a * Math.PI / 180),
    { relThreshold: 0.001 }).extraRays > 0);
});

/* ---------- 3. reading a radius back out ---------- */

test('interpolation is exact at the samples and linear between them', () => {
  const s = adaptiveHalfSweep((a) => a / 10);
  for (let i = 0; i < s.angles.length; i++) {
    assert.equal(radiusAtAlpha(s, s.angles[i]), s.radii[i]);
  }
  assert.ok(Math.abs(radiusAtAlpha(s, 12.5) - 1.25) < 1e-12);
  // Clamped, not wrapped: alpha only ever means an offset from the wind axis.
  assert.equal(radiusAtAlpha(s, -30), s.radii[0]);
  assert.equal(radiusAtAlpha(s, 400), s.radii.at(-1));
});

test('alphaOffAxis folds any course into 0…180 off the wind axis', () => {
  assert.equal(alphaOffAxis(170, 170), 0);
  assert.equal(alphaOffAxis(350, 170), 180);
  assert.equal(alphaOffAxis(260, 170), 90);
  assert.equal(alphaOffAxis(80, 170), 90);
  assert.equal(alphaOffAxis(10, 350), 20);
  assert.equal(alphaOffAxis(-10, 350), 0);
});

/* ---------- 4. the circle the map actually draws ---------- */

test('the full circle mirrors the half-sweep and keeps the refined rays', () => {
  const windFrom = 170;
  const s = adaptiveHalfSweep((a) => (a < 97.3 ? 5 : 0));
  const c = fullCircle(s, windFrom);
  assert.equal(c.byCourse.length, 360);
  // Symmetric about the wind axis, because the wind decomposition only sees
  // cos and |sin| of the offset.
  for (const off of [7, 33, 90, 140]) {
    const plus = c.byCourse[(windFrom + off) % 360];
    const minus = c.byCourse[(windFrom - off + 360) % 360];
    assert.equal(plus, minus, `offset ${off}`);
  }
  // The polygon carries the 1° grid plus both mirror images of every refined ray.
  const refined = s.angles.filter(a => !Number.isInteger(a));
  assert.ok(refined.length > 0);
  assert.equal(c.courses.length, 360 + refined.length * 2);
  for (const a of refined) {
    assert.ok(c.courses.includes((windFrom + a) % 360), `+${a} missing from the polygon`);
    assert.ok(c.courses.includes((windFrom - a + 360) % 360), `-${a} missing from the polygon`);
  }
  for (let i = 1; i < c.courses.length; i++) assert.ok(c.courses[i] > c.courses[i - 1]);
  assert.equal(c.radii.length, c.courses.length);
});

test('the refined polygon hugs the cliff the base grid ramps over', () => {
  // The whole point of item 10. The 5° grid draws a ramp: 4 km of reach at 96°,
  // 2 km at 98°, 1 km at 99° — every one of them a heading the sampler says is
  // dead. Refinement pushes the ramp down to the last fraction of a degree.
  const windFrom = 0;
  const cliffAt = 97.3;
  const cliff = (a) => (a < cliffAt ? 5 : 0);
  const coarseHalf = adaptiveHalfSweep(cliff, { maxRays: 0 });
  const fineHalf = adaptiveHalfSweep(cliff);

  // Phantom reach past the cliff: gone by 98°, where the base grid still claims
  // 2 km. And no reach lost on the live side, where the base grid has already
  // started ramping down.
  assert.ok(radiusAtAlpha(coarseHalf, 98) > 1.5);
  assert.equal(radiusAtAlpha(fineHalf, 98), 0);
  assert.equal(radiusAtAlpha(fineHalf, 96), 5);
  assert.ok(radiusAtAlpha(coarseHalf, 96) < 4.5);

  // In area terms the ramp cuts both ways, so the claim is accuracy rather than
  // tightness: the refined polygon is at least twice as close to the wedge the
  // cliff really cuts, and neither overstates it.
  const coarse = fullCircle(coarseHalf, windFrom);
  const fine = fullCircle(fineHalf, windFrom);
  const aCoarse = polarAreaKm2(coarse.courses, coarse.radii);
  const aFine = polarAreaKm2(fine.courses, fine.radii);
  const truth = 2 * (cliffAt / 360) * Math.PI * 25; // both mirrored wedges
  assert.ok(aFine <= truth + 1e-9 && aCoarse <= truth + 1e-9);
  assert.ok(Math.abs(aFine - truth) * 2 < Math.abs(aCoarse - truth),
    `refined error ${(aFine - truth).toFixed(4)} vs base ${(aCoarse - truth).toFixed(4)} km²`);
});

test('polar area is the shoelace, at any spacing, and ignores dead wedges', () => {
  const circle = { courses: [], radii: [] };
  for (let c = 0; c < 360; c++) { circle.courses.push(c); circle.radii.push(3); }
  const area = polarAreaKm2(circle.courses, circle.radii);
  assert.ok(Math.abs(area - Math.PI * 9) / (Math.PI * 9) < 1e-3, `${area} vs ${Math.PI * 9}`);
  // Non-uniform spacing is handled by Δθ, not assumed away.
  const half = { courses: circle.courses.filter((_, i) => i % 2 === 0), radii: [] };
  half.radii = half.courses.map(() => 3);
  assert.ok(Math.abs(polarAreaKm2(half.courses, half.radii) - Math.PI * 9) / (Math.PI * 9) < 5e-3);
  // A pinched sector contributes nothing rather than a sliver.
  const pinched = { courses: circle.courses, radii: circle.radii.map((r, i) => (i < 180 ? r : 0)) };
  const pinchedArea = polarAreaKm2(pinched.courses, pinched.radii);
  assert.ok(Math.abs(pinchedArea - Math.PI * 9 / 2) / (Math.PI * 9 / 2) < 1e-2);
});

/* ---------- 5. behind the real mission model ---------- */

const moz7 = {
  dryMassG: 843, propDiaIn: 7.5, numRotors: 4, cdA: 0.042,
  etaProp: 0.55, avionicsW: 12, maxSpeedMs: 30.5, cruiseMs: 18,
};
const nav5000 = { chem: 'liion', s: 6, capAh: 5.0, massG: 499, irPackMilliOhm: 60 };
const WIND_FROM = 0;

// The same sampler map.js builds: one lite plan per heading, sharing a power memo.
function modelSweep(windMs, cruiseMode = 'real') {
  const cache = new Map();
  let calls = 0;
  const s = adaptiveHalfSweep((alpha) => {
    calls++;
    return planMission({
      drone: moz7, battery: nav5000, payloadG: 0, extraG: 0,
      env: {
        elevM: U.ftToM(550), tempC: U.fToC(75), rhPct: 40,
        windAvgMs: windMs, windGustMs: windMs, windFromDeg: WIND_FROM,
      },
      landFloorPct: 20, cruiseMode, realVMs: moz7.cruiseMs, overheadF: 1.05,
      courseDeg: WIND_FROM + alpha, lite: true, _pCache: cache,
    }).radiusKm;
  });
  return { ...s, calls };
}

test('calm air costs the base grid exactly, at both cruise policies', () => {
  for (const cruiseMode of ['real', 'range']) {
    for (const windMs of [0, 2, 8]) {
      const s = modelSweep(windMs, cruiseMode);
      assert.equal(s.extraRays, 0, `${cruiseMode} at ${windMs} m/s spent rays on nothing`);
      assert.equal(s.calls, BASE_RAYS);
      assert.ok(s.radii.every(r => r > 0));
    }
  }
});

test('a wind that collapses one sector gets the rays inside that sector', () => {
  // 17.6 m/s against an 18 m/s hands-on cruise: the upwind sector cannot be
  // flown out and back at all, the crosswind sector can, and the boundary
  // between them is a hard edge in the polygon.
  const s = modelSweep(17.6, 'real');
  const zeros = s.radii.filter(r => r === 0).length;
  assert.ok(zeros > 0 && zeros < s.radii.length,
    `expected a partial collapse, got ${zeros}/${s.radii.length} dead rays`);
  assert.ok(s.extraRays > 0 && s.extraRays <= REFINE_MAX_RAYS);
  assert.equal(s.calls, BASE_RAYS + s.extraRays);

  // Every extra ray sits in an interval whose endpoints straddle the collapse,
  // or whose radii disagree sharply — i.e. next to a live/dead boundary rather
  // than sprinkled around the smooth part of the fan.
  const edges = [];
  for (let i = 0; i < s.angles.length - 1; i++) {
    if ((s.radii[i] === 0) !== (s.radii[i + 1] === 0)) edges.push((s.angles[i] + s.angles[i + 1]) / 2);
  }
  assert.ok(edges.length >= 2, 'a collapsed sector has two boundaries');
  const resolution = SWEEP_STEP_DEG / 2 ** REFINE_MAX_DEPTH;
  for (const e of edges) {
    // Each boundary has been narrowed below the base spacing.
    const i = s.angles.findIndex(a => a > e);
    assert.ok(s.angles[i] - s.angles[i - 1] <= SWEEP_STEP_DEG / 2 + 1e-9,
      `boundary at ${e.toFixed(2)}° is still ${(s.angles[i] - s.angles[i - 1]).toFixed(3)}° wide`);
    assert.ok(s.angles[i] - s.angles[i - 1] >= resolution - 1e-9);
  }
});

test('the collapse edge the refined sweep finds is where the model really breaks', () => {
  const s = modelSweep(17.6, 'real');
  // Walk out from the wind axis to the first live ray, then check the model
  // agrees: one base step earlier is dead, and the ray itself flies.
  const firstLive = s.angles.find(a => radiusAtAlpha(s, a) > 0);
  assert.ok(firstLive > 0, 'the upwind axis itself should be dead in this wind');
  const direct = (alpha) => planMission({
    drone: moz7, battery: nav5000, payloadG: 0, extraG: 0,
    env: {
      elevM: U.ftToM(550), tempC: U.fToC(75), rhPct: 40,
      windAvgMs: 17.6, windGustMs: 17.6, windFromDeg: WIND_FROM,
    },
    landFloorPct: 20, cruiseMode: 'real', realVMs: moz7.cruiseMs, overheadF: 1.05,
    courseDeg: WIND_FROM + alpha, lite: true,
  }).radiusKm;
  assert.ok(direct(firstLive) > 0);
  assert.equal(direct(firstLive - SWEEP_STEP_DEG / 2 ** REFINE_MAX_DEPTH), 0);
});

test('the sweep stays inside its budget however hostile the wind', () => {
  for (const cruiseMode of ['real', 'range']) {
    for (let w = 0; w <= 34; w += 0.4) {
      const s = modelSweep(w, cruiseMode);
      assert.ok(s.extraRays <= REFINE_MAX_RAYS, `${cruiseMode} at ${w}: ${s.extraRays} extra rays`);
      assert.equal(s.calls, BASE_RAYS + s.extraRays);
    }
  }
});
