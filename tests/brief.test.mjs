import test from 'node:test';
import assert from 'node:assert/strict';

import { planMission, U } from '../src/domain/physics.js';
import { planRoute } from '../src/domain/route.js';
import { adaptiveHalfSweep, fullCircle, polarAreaKm2 } from '../src/sweep.js';
import { destination } from '../src/domain/geo.js';
import { unitSystem } from '../src/domain/units.js';
import { DRONES } from '../src/catalog/drones.js';
import { BATTERIES } from '../src/catalog/batteries.js';
import { buildBrief, formatDecimal, formatDegMin, MAX_CHECKLIST, CARDINALS } from '../src/brief.js';

/* Phase 4 item 8: the exportable mission brief.
 *
 * The brief is the one artifact that leaves the app — printed, saved as a PDF,
 * handed to a spotter — so the thing worth testing is that it cannot quietly
 * disagree with the screen it came off. Every number on it is either lifted from
 * the plan or arithmetic on the plan, and the tests below pin exactly that: the
 * radius figures are the sweep's own, the Wh column closes against
 * deliveredWh, the turnaround is the outbound leg formatted, and the derived
 * checklist only says a thing when it is true of *this* flight.
 *
 * The SVG plate is deliberately absent from here — it is DOM, it lives in
 * src/render/brief.js, and it draws from the same footprint object this file
 * already exercises. */

const AUSTIN = { lat: 30.2672, lng: -97.7431 };

// MOZ7 V2 + NAV 5000 6S Li-Ion, the same fixture route.test.mjs and
// reserve.test.mjs plan against.
const moz7 = {
  name: 'MOZ7 V2',
  dryMassG: 843, propDiaIn: 7.5, numRotors: 4, cdA: 0.042,
  etaProp: 0.55, avionicsW: 12, maxSpeedMs: 30.5, cruiseMs: 18,
};
const nav5000 = { name: 'NAV 5000 6S', chem: 'liion', s: 6, capAh: 5.0, massG: 499, irPackMilliOhm: 60 };

const WIND_FROM = 170;
const u = unitSystem('imperial');

function env(overrides = {}) {
  return {
    elevM: U.ftToM(550), tempC: U.fToC(75), rhPct: 40,
    windFromDeg: WIND_FROM, windMode: 'headOut',
    windAvgMs: U.mphToMs(8), windGustMs: U.mphToMs(16),
    ...overrides,
  };
}

function inputs(overrides = {}, envOverrides = {}) {
  return {
    drone: moz7, battery: nav5000, payloadG: 0, extraG: 0,
    env: env(envOverrides),
    landFloorPct: 20, cruiseMode: 'real', realVMs: moz7.cruiseMs, overheadF: 1.05,
    ...overrides,
  };
}

/** The plan on the planned course — what the dashboard shows. */
function planFor(overrides = {}, envOverrides = {}) {
  const base = inputs(overrides, envOverrides);
  return planMission({ ...base, courseDeg: base.env.windFromDeg });
}

/** The map's own footprint object, built the way src/map.js builds it. */
function footprintFor(overrides = {}, envOverrides = {}) {
  const base = inputs(overrides, envOverrides);
  const cache = new Map();
  const half = adaptiveHalfSweep((alpha) => planMission({
    ...base, cruiseMode: base.cruiseMode, courseDeg: base.env.windFromDeg + alpha, lite: true, _pCache: cache,
  }).radiusKm);
  const real = fullCircle(half, base.env.windFromDeg);
  return {
    launch: { ...AUSTIN },
    windFromDeg: base.env.windFromDeg,
    plannedCourseDeg: base.env.windFromDeg,
    courses: real.courses.slice(),
    radii: real.radii.slice(),
    byCourse: real.byCourse.slice(),
    bestByCourse: real.byCourse.slice(),
    areaKm2: polarAreaKm2(real.courses, real.radii),
  };
}

/** render/dashboard.js's legTimes, which app.js hands the brief. */
function legTimes(r) {
  const { out, back } = r.legs;
  if (!out || !back || !(r.radiusKm > 0)) return null;
  return {
    outMin: r.radiusKm / (out.vg * 3.6) * 60,
    backMin: r.radiusKm / (back.vg * 3.6) * 60,
  };
}

// The imperial display units are the ones a US pilot prints, so the fixtures
// read in miles; the model underneath is metric either way.
const mi = (km) => km * 0.621371;

function brief(extra = {}, overrides = {}, envOverrides = {}) {
  const plan = planFor(overrides, envOverrides);
  return {
    plan,
    b: buildBrief({
      plan,
      warnings: plan.warnings,
      footprint: footprintFor(overrides, envOverrides),
      launch: AUSTIN,
      drone: moz7, battery: nav5000,
      env: { windFromDeg: WIND_FROM, windMode: 'headOut', windMph: 8, gustMph: 16, tempF: 75, rhPct: 40 },
      times: legTimes(plan),
      units: u,
      now: new Date('2026-07-04T09:00:00'),
      ...extra,
    }),
  };
}

/* ---------- 1. the reach figures are the plan's, not a second opinion ---------- */

test('headline radius is the plan radius in display units', () => {
  const { plan, b } = brief();
  assert.ok(plan.radiusKm > 0);
  assert.equal(b.reach.ok, true);
  assert.equal(b.reach.radiusKm, plan.radiusKm);
  assert.equal(b.reach.radiusText, `${mi(plan.radiusKm).toFixed(1)} mi`);
});

test('cardinal reach is read off the sweep, and the planned course is the longest', () => {
  const fp = footprintFor();
  const { b } = brief({ footprint: fp });
  assert.equal(b.cardinals.length, CARDINALS.length);
  for (const c of b.cardinals) {
    assert.equal(c.km, fp.byCourse[c.deg]);
    assert.equal(c.text, `${mi(c.km).toFixed(1)} mi`);
  }
  // The wind axis is the expensive one either way round: crosswind out-and-back
  // reaches farther than straight up it (170° ≈ S) or straight down it.
  const at = (label) => b.cardinals.find(c => c.label === label).km;
  assert.ok(at('E') > at('S'));
  assert.ok(at('W') > at('S'));
  assert.ok(at('E') > at('N'));
});

test('a plan that will not lift prints WILL NOT FLY rather than a radius', () => {
  // Needs a rig with real thrust data behind it — the no-lift verdict comes off
  // the thrust model, not the energy budget.
  const plan = planMission({
    drone: DRONES.find(d => d.id === 'cinelog30v3'),
    battery: BATTERIES.find(b => b.id === 'gnb850lr'),
    payloadG: 207, payloadCdA: 0.010, extraG: 500,
    env: env({ elevM: U.ftToM(10_000), tempC: U.fToC(45), rhPct: 30, windAvgMs: U.mphToMs(15), windGustMs: U.mphToMs(25) }),
    landFloorPct: 20, cruiseMode: 'real', realVMs: 18, overheadF: 1.05,
    courseDeg: WIND_FROM,
  });
  assert.equal(plan.flight.code, 'no_lift');
  const b = buildBrief({
    plan, warnings: plan.warnings, launch: AUSTIN,
    env: { windFromDeg: WIND_FROM, windMode: 'headOut' },
    times: null, units: u, now: new Date('2026-07-04T09:00:00'),
  });
  assert.equal(b.reach.ok, false);
  assert.equal(b.reach.radiusText, 'WILL NOT FLY');
  assert.equal(b.clock.ok, false);
  assert.ok(b.warnings.some(w => w.text.startsWith('WILL NOT FLY:')));
});

/* ---------- 2. the Wh column closes ---------- */

test('out + home + held back is what the pack delivers', () => {
  const { plan, b } = brief();
  const e = plan.energy;
  assert.ok(Math.abs(b.energy.checkWh - e.deliveredWh) < 1e-9);
  assert.ok(Math.abs((b.energy.outWh + b.energy.backWh) - e.usableWh) < 1e-9);
});

test('the energy rows quote the plan\'s own Wh figures', () => {
  const { plan, b } = brief();
  const e = plan.energy;
  const row = (label) => b.energy.rows.find(r => r.label.startsWith(label));
  assert.equal(row('In the pack').value, `${e.packWh.toFixed(1)} Wh`);
  assert.equal(row('Delivered').value, `${e.deliveredWh.toFixed(1)} Wh`);
  assert.equal(row('Held back').value, `${e.reserveWh.toFixed(1)} Wh`);
  assert.equal(row('Land floor').value, `${(e.deliveredWh * e.landFloorPct / 100).toFixed(1)} Wh`);
  assert.equal(row('Out leg').value, `${(plan.radiusKm * plan.legs.out.whPerKm).toFixed(1)} Wh`);
  assert.equal(row('Home leg').value, `${(plan.radiusKm * plan.legs.back.whPerKm).toFixed(1)} Wh`);
});

test('the get-home row appears only when a get-home reserve is being held', () => {
  const { plan, b } = brief();
  const has = b.energy.rows.some(r => r.label === 'Get home');
  assert.equal(has, plan.energy.getHomeWh > 0);
});

/* ---------- 3. the clock is the headline ---------- */

test('turnaround is the outbound leg as mm:ss, landing is the whole flight', () => {
  const { plan, b } = brief();
  const times = legTimes(plan);
  const mmss = (min) => {
    const s = Math.round(min * 60);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  assert.equal(b.clock.ok, true);
  assert.equal(b.clock.turn, mmss(times.outMin));
  assert.equal(b.clock.land, mmss(plan.timeMin));
  assert.match(b.clock.headline, new RegExp(`turned around by ${b.clock.turn} on the timer`));
  // No launch hour known offline: elapsed still stands, wall time simply absent.
  assert.equal(b.clock.wall, null);
});

test('wall time rides along when the forecast knows the launch hour', () => {
  const plan = planFor();
  const launchAt = new Date('2026-07-04T18:30:00');
  const b = buildBrief({
    plan, warnings: plan.warnings, footprint: footprintFor(), launch: AUSTIN,
    drone: moz7, battery: nav5000, env: { windFromDeg: WIND_FROM, windMode: 'headOut' },
    times: legTimes(plan), launchAt, units: u, now: new Date('2026-07-04T09:00:00'),
  });
  assert.ok(b.clock.wall);
  assert.equal(b.clock.wall.launch, launchAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  const land = new Date(launchAt.getTime() + plan.timeMin * 60000);
  assert.equal(b.clock.wall.land, land.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
});

test('a footprint that collapses has no turnaround to print', () => {
  const plan = planFor({}, { windAvgMs: U.mphToMs(60), windGustMs: U.mphToMs(70) });
  const b = buildBrief({
    plan, warnings: plan.warnings, launch: AUSTIN, drone: moz7, battery: nav5000,
    env: { windFromDeg: WIND_FROM, windMode: 'headOut' },
    times: legTimes(plan), units: u, now: new Date('2026-07-04T09:00:00'),
  });
  assert.equal(b.clock.ok, false);
  assert.equal(b.clock.turn, '—');
  assert.match(b.clock.headline, /No turnaround/);
});

/* ---------- 4. coordinates in both forms ---------- */

test('launch coordinates print decimal and degrees-decimal-minutes', () => {
  const { b } = brief();
  assert.equal(b.launch.decimal, '30.26720, -97.74310');
  assert.equal(b.launch.degMin, "N30°16.032' W097°44.586'");
});

test('the hemisphere letters follow the sign, and both halves stay padded', () => {
  assert.equal(formatDecimal(-33.8688, 151.2093), '-33.86880, 151.20930');
  assert.equal(formatDegMin(-33.8688, 151.2093), "S33°52.128' E151°12.558'");
  assert.equal(formatDegMin(9.5, -8.25), "N09°30.000' W008°15.000'");
});

/* ---------- 5. warnings travel verbatim ---------- */

test('warnings print worst-first, unedited, capped with a held count', () => {
  const plan = planFor();
  const warnings = [
    { level: 'warning', text: 'w1' }, { level: 'critical', text: 'c1' },
    { level: 'serious', text: 's1' }, { level: 'warning', text: 'w2' },
    { level: 'critical', text: 'c2' }, { level: 'warning', text: 'w3' },
  ];
  const b = buildBrief({
    plan, warnings, launch: AUSTIN, drone: moz7, battery: nav5000,
    env: { windFromDeg: WIND_FROM, windMode: 'headOut' },
    times: legTimes(plan), units: u, now: new Date('2026-07-04T09:00:00'),
  });
  assert.deepEqual(b.warnings.map(w => w.text), ['c1', 'c2', 's1', 'w1']);
  assert.equal(b.warningsHeld, 2);
});

/* ---------- 6. the route section, only when there is a route ---------- */

test('no route drawn means no route section', () => {
  const { b } = brief();
  assert.equal(b.route, null);
  assert.ok(!b.checklist.some(c => /Waypoints flown/.test(c)));
});

test('a drawn route prints its legs, its verdict and the failsafe note', () => {
  const plan = planFor();
  const wp = (courseDeg, km) => {
    const [lat, lng] = destination(AUSTIN.lat, AUSTIN.lng, courseDeg, km);
    return { lat, lng };
  };
  const route = planRoute(plan, {
    launch: AUSTIN,
    waypoints: [wp(170, plan.radiusKm * 0.4), wp(90, plan.radiusKm * 0.4)],
    windFromDeg: WIND_FROM,
    inputs: inputs(),
  });
  const b = buildBrief({
    plan, warnings: plan.warnings, footprint: footprintFor(), launch: AUSTIN, route,
    drone: moz7, battery: nav5000, env: { windFromDeg: WIND_FROM, windMode: 'headOut' },
    times: legTimes(plan), units: u, now: new Date('2026-07-04T09:00:00'),
  });
  assert.ok(b.route);
  assert.equal(b.route.legs.length, route.legs.length);
  assert.equal(b.route.legs[0].name, 'Launch → 1');
  assert.equal(b.route.legs.at(-1).name, '2 → home');
  assert.equal(b.route.totalKm, route.totalKm);
  assert.match(b.route.verdict, route.fits ? /^Fits:/ : /^Does not fit:/);
  assert.match(b.route.note, /direct from the last waypoint/);
  assert.ok(b.checklist.some(c => /Waypoints flown/.test(c)));
});

/* ---------- 7. the checklist is derived, not boilerplate ---------- */

test('the cold-pack line appears only when the packs are actually cold', () => {
  const warm = brief({}, {}, { tempC: U.fToC(75) });
  assert.equal(warm.plan.temps.cold, false);
  assert.ok(!warm.b.checklist.some(c => /Packs warm/.test(c)));

  const cold = brief({}, {}, { tempC: U.fToC(28) });
  assert.equal(cold.plan.temps.cold, true);
  assert.ok(cold.b.checklist.some(c => /Packs warm/.test(c)));
});

test('the checklist always leads with the timer and stays inside its cap', () => {
  const { b } = brief();
  assert.match(b.checklist[0], new RegExp(`turn at ${b.clock.turn}`));
  assert.ok(b.checklist.length <= MAX_CHECKLIST);
  assert.ok(b.checklist.length >= 3);
});

test('the gust line turns on with the gusts, not with the average wind', () => {
  const calm = brief({}, {}, {});
  assert.ok(!calm.b.checklist.some(c => /Gusts are a big share/.test(c)));
  const gusty = brief({ env: { windFromDeg: WIND_FROM, windMode: 'headOut', windMph: 8, gustMph: 34 } });
  assert.ok(gusty.b.checklist.some(c => /Gusts are a big share/.test(c)));
});

/* ---------- 8. beginner mode drops expert figures rather than inventing them ---------- */

test('the link line, the terrain line and the cruise level are absent in beginner mode', () => {
  const plan = planFor();
  const link = {
    band: { label: '1.3 GHz' }, blocked: true, clearKm: plan.radiusKm * 0.5,
    losBlockKm: 3, fresnelBlockKm: 1, legKm: plan.radiusKm,
  };
  // Both of these sit behind full-only cards — the RF band picker and the
  // terrain profile — so neither may reach paper a beginner cannot check.
  const terrain = {
    legKm: plan.radiusKm, launchElevM: 170, turnaroundElevM: 210, planAltM: 120, cruiseAltM: 120,
    climbM: 40, minClearanceM: 60, minClearanceAtKm: 2.1, maxElevM: 260, maxElevAtKm: 3.4, turnClearanceM: 80,
  };
  const common = {
    plan, warnings: plan.warnings, launch: AUSTIN, link, terrain, cruiseAltM: 120,
    drone: moz7, battery: nav5000, env: { windFromDeg: WIND_FROM, windMode: 'headOut' },
    times: legTimes(plan), units: u, now: new Date('2026-07-04T09:00:00'),
  };
  const full = buildBrief({ ...common, expert: true });
  assert.match(full.linkLine, /1\.3 GHz/);
  assert.match(full.terrainLine, /^Terrain:/);
  assert.match(full.loadout, /120 m cruise/);
  assert.ok(full.checklist.some(c => /Video quits/.test(c)));
  // The RTH check quotes the profile's high ground when the profile is on screen.
  assert.ok(full.checklist.some(c => /RTH altitude above the/.test(c)));

  const beginnerBrief = buildBrief({ ...common, expert: false });
  assert.equal(beginnerBrief.linkLine, null);
  assert.equal(beginnerBrief.terrainLine, null);
  assert.ok(!/cruise/.test(beginnerBrief.loadout));
  assert.ok(!beginnerBrief.checklist.some(c => /Video quits/.test(c)));
  // The RTH check survives, in the wording that quotes no chart.
  assert.ok(beginnerBrief.checklist.some(c => /RTH altitude is above everything/.test(c)));
  // Everything a beginner *can* act on is still there.
  assert.equal(beginnerBrief.clock.turn, full.clock.turn);
  assert.equal(beginnerBrief.reach.radiusText, full.reach.radiusText);
});

/* ---------- 9. the brief still builds with nothing but a plan ---------- */

test('offline, with no footprint, route, terrain or link, the brief survives', () => {
  const plan = planFor();
  const b = buildBrief({ plan, units: u, times: legTimes(plan), now: new Date('2026-07-04T09:00:00') });
  assert.equal(b.launch, null);
  assert.deepEqual(b.cardinals, []);
  assert.equal(b.terrainLine, null);
  assert.equal(b.route, null);
  assert.equal(b.clock.ok, true);
  assert.ok(b.energy.rows.length >= 6);
  assert.ok(b.checklist.length >= 3);
});
