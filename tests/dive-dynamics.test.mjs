// dive-dynamics.js walks a dive plan; dive.js does the mechanics. These tests
// draw that line on purpose: the arithmetic dive.js owns is re-derived here from
// its own published formulas (r = v²/(g(n−1)), sink = r(1−cos θ), the arc's r·θ)
// rather than copied out of the module, and everything else asserted is the
// bookkeeping this module adds — where each phase starts, what it is called,
// what the clock reads, and which absence produced which null.
//
// The fixture is a bowl dive: climb from the pad to an approach gate on the rim,
// descend into the bowl, climb out to a recovery gate. The dive gate is the
// lowest point of the line, which is where the pullout is flown and where the
// shipped pullout chip already measures from.

import test from 'node:test';
import assert from 'node:assert/strict';

import { G } from '../src/domain/physics.js';
import { distanceKm } from '../src/domain/geo.js';
import { diveDynamics } from '../src/domain/dive-dynamics.js';

const PAD = { latitude: 30.600, longitude: -98.100 };
const PAD_MSL = 2900;

const APPROACH = {
  id: 'g_app', kind: 'approach', latitude: 30.605, longitude: -98.105, altitudeMslM: 3100, radiusM: null,
};
const DIVE = {
  id: 'g_dive', kind: 'dive', latitude: 30.610, longitude: -98.110, altitudeMslM: 2600, radiusM: null,
};
const RECOVERY = {
  id: 'g_rec', kind: 'recovery', latitude: 30.615, longitude: -98.115, altitudeMslM: 2800, radiusM: null,
};
const ABORT = {
  id: 'g_abort', kind: 'abort', latitude: 30.608, longitude: -98.130, altitudeMslM: 3050, radiusM: null,
};

const SPEED_MS = 26;
const LOAD_G = 3;

const PLAN = {
  gates: [APPROACH, DIVE, RECOVERY],
  bailout: { name: 'Meadow', latitude: 30.620, longitude: -98.130, elevationMslM: 2500 },
  rthAltitudeMslM: 3200,
  speedMs: SPEED_MS,
  pulloutLoadG: LOAD_G,
};

/* Flat ground well under the whole line, so the baseline fixture has clearance
 * everywhere and a test about geometry is never also a test about terrain. */
const FLAT_GROUND = 2450;
const flat = () => FLAT_GROUND;

const PACK = { id: 'p6s5', chem: 'liion', s: 6, capAh: 5, massG: 700, irPackMilliOhm: 118 };
const DRONE = {
  dryMassG: 900, propDiaIn: 7.5, numRotors: 4, cdA: 0.042, etaProp: 0.72, avionicsW: 8,
  maxSpeedMs: 40, propulsion: { motorMaxA: 49.35, escMaxA: 60 },
};

/** The ground distance dive.js itself measures, re-derived from geo.js. */
const horizM = (a, b) => distanceKm(
  { lat: a.latitude, lng: a.longitude },
  { lat: b.latitude, lng: b.longitude },
) * 1000;

/** One leg's straight-line length and flight-path angle, from the definitions. */
const legOf = (a, b) => {
  const h = horizM(a, b);
  const drop = a.altitudeMslM - b.altitudeMslM;
  return { pathM: Math.hypot(drop, h), pitchDeg: -Math.atan2(drop, h) * 180 / Math.PI };
};

const PAD_POINT = { ...PAD, altitudeMslM: PAD_MSL };
const LEG_APPROACH = legOf(PAD_POINT, APPROACH);
const LEG_DIVE = legOf(APPROACH, DIVE);
const LEG_RECOVERY = legOf(DIVE, RECOVERY);

const full = (over = {}) => diveDynamics({
  dive: PLAN, launch: PAD, launchMslM: PAD_MSL, groundAt: flat, ...over,
});

/* ---------- there has to be a line ---------- */

test('no plan, or fewer than two gates, is not a line to model', () => {
  assert.equal(diveDynamics({}), null);
  assert.equal(diveDynamics({ dive: null }), null);
  assert.equal(diveDynamics({ dive: { gates: [], bailout: null, rthAltitudeMslM: null } }), null);
  assert.equal(diveDynamics({ dive: { gates: [DIVE], bailout: null, rthAltitudeMslM: null } }), null);
  assert.ok(diveDynamics({ dive: { ...PLAN, gates: [APPROACH, DIVE] } }));
});

/* ---------- the phases ---------- */

test('the phases run approach → dive → pullout → recovery, each named by the gate it ends at', () => {
  const d = full();
  assert.deepEqual(d.phases.map((p) => p.kind), ['approach', 'dive', 'pullout', 'recovery']);
  assert.deepEqual(d.phases.map((p) => p.label), [
    'Launch → approach', 'Approach → dive', 'Pullout', 'Dive → recovery',
  ]);
});

test('the abort gate is an alternate, not a phase', () => {
  const d = diveDynamics({
    dive: { ...PLAN, gates: [APPROACH, DIVE, RECOVERY, ABORT] },
    launch: PAD, launchMslM: PAD_MSL, groundAt: flat,
  });
  assert.deepEqual(d.phases.map((p) => p.kind), ['approach', 'dive', 'pullout', 'recovery']);
  // …and it does not lengthen the run either.
  assert.equal(d.totalM, full().totalM);
});

test('the station axis is path distance, laid end to end from the pad', () => {
  const [approach, dive, , recovery] = full().phases;
  assert.equal(approach.startM, 0);
  assert.equal(approach.endM, LEG_APPROACH.pathM);
  assert.equal(dive.startM, approach.endM);
  assert.equal(dive.endM, LEG_APPROACH.pathM + LEG_DIVE.pathM);
  assert.equal(recovery.startM, dive.endM);
  assert.equal(recovery.endM, LEG_APPROACH.pathM + LEG_DIVE.pathM + LEG_RECOVERY.pathM);
});

test('each leg carries its own pitch and the vertical speed that pitch implies', () => {
  const [approach, dive, , recovery] = full().phases;
  assert.equal(approach.pitchDeg, LEG_APPROACH.pitchDeg);
  assert.equal(dive.pitchDeg, LEG_DIVE.pitchDeg);
  assert.equal(recovery.pitchDeg, LEG_RECOVERY.pitchDeg);
  assert.ok(dive.pitchDeg < 0, 'the descent reads negative');
  assert.ok(approach.pitchDeg > 0 && recovery.pitchDeg > 0, 'the climbs read positive');
  assert.equal(dive.verticalSpeedMs, SPEED_MS * Math.sin(LEG_DIVE.pitchDeg * Math.PI / 180));
  assert.ok(dive.verticalSpeedMs < 0, 'descending is signed');
});

test('altitudes and clearances are the gates\' own, and clearance is altitude less ground', () => {
  const [approach, dive] = full().phases;
  assert.equal(approach.startMslM, PAD_MSL);
  assert.equal(approach.endMslM, APPROACH.altitudeMslM);
  assert.equal(dive.endMslM, DIVE.altitudeMslM);
  assert.equal(approach.startClearanceM, PAD_MSL - FLAT_GROUND);
  assert.equal(dive.endClearanceM, DIVE.altitudeMslM - FLAT_GROUND);
  assert.equal(full().groundComplete, true);
});

/* ---------- the clock ---------- */

test('the time axis exists only when a speed is stated, and is station over that speed', () => {
  const [approach, dive, pullout, recovery] = full().phases;
  assert.equal(approach.startS, 0);
  assert.equal(approach.endS, LEG_APPROACH.pathM / SPEED_MS);
  assert.equal(dive.startS, approach.endS);
  assert.equal(dive.endS, (LEG_APPROACH.pathM + LEG_DIVE.pathM) / SPEED_MS);
  assert.equal(pullout.startS, dive.endS);
  assert.equal(recovery.endS, full().totalS);
  assert.equal(full().speedMs, SPEED_MS);
});

test('no stated speed means no clock at all — not a clock at some house cruise', () => {
  const d = full({ dive: { ...PLAN, speedMs: null } });
  for (const p of d.phases) {
    assert.equal(p.startS, null);
    assert.equal(p.endS, null);
    assert.equal(p.verticalSpeedMs, null);
  }
  assert.equal(d.totalS, null);
  assert.equal(d.speedMs, null);
  assert.ok(d.totalM > 0, 'the geometry still stands without a speed');
  assert.ok(d.systems.missing.includes('no dive speed stated'));
});

/* ---------- the pullout ---------- */

/* The arc, re-derived here from dive.js's published identities rather than read
 * back out of it, so a formula that drifts in either module shows up as a diff. */
const RADIUS_M = SPEED_MS * SPEED_MS / (G * (LOAD_G - 1));
const THETA_RAD = -LEG_DIVE.pitchDeg * Math.PI / 180;
const SINK_M = RADIUS_M * (1 - Math.cos(THETA_RAD));
const ARC_M = RADIUS_M * THETA_RAD;

test('the pullout hangs at the dive gate and spans the arc it flies, not its ground run', () => {
  const d = full();
  const [, dive, pullout] = d.phases;
  assert.equal(pullout.startM, dive.endM, 'the pull begins at the dive gate');
  assert.equal(pullout.endM, dive.endM + ARC_M, 'r·θ of path, not r·sin θ of ground');
  assert.equal(pullout.startMslM, DIVE.altitudeMslM);
  assert.equal(pullout.endMslM, DIVE.altitudeMslM - SINK_M);
  assert.equal(pullout.endS, dive.endS + ARC_M / SPEED_MS, 'one speed for the whole line');
  assert.equal(d.systems.pulloutRadiusM, RADIUS_M);
  assert.equal(d.systems.pulloutSinkM, SINK_M);
  assert.equal(d.systems.pulloutLowestMslM, DIVE.altitudeMslM - SINK_M);
  assert.equal(d.systems.pulloutClearanceM, DIVE.altitudeMslM - SINK_M - FLAT_GROUND);
});

test('an arc has no single pitch, so it quotes none', () => {
  const [, , pullout] = full().phases;
  assert.equal(pullout.pitchDeg, null);
  assert.equal(pullout.verticalSpeedMs, null);
});

test('the pullout band overlaps the recovery leg rather than inventing station length', () => {
  const d = full();
  const [, , pullout, recovery] = d.phases;
  assert.equal(pullout.startM, recovery.startM, 'both begin at the dive gate');
  assert.equal(recovery.endM, LEG_APPROACH.pathM + LEG_DIVE.pathM + LEG_RECOVERY.pathM,
    'the recovery leg keeps its authored gate-to-gate geometry');
  assert.equal(d.totalM, Math.max(recovery.endM, pullout.endM));
});

test('a load of 1 g or less is no arc, and says so instead of describing one', () => {
  const d = full({ dive: { ...PLAN, pulloutLoadG: 1 } });
  assert.deepEqual(d.phases.map((p) => p.kind), ['approach', 'dive', 'recovery']);
  assert.equal(d.systems.pulloutRadiusM, null);
  assert.equal(d.systems.pulloutSinkM, null);
  assert.equal(d.systems.pulloutClearanceM, null);
  assert.ok(d.systems.missing.includes('a pullout load of 1 g or less leaves no arc to fly'));
});

/* ---------- the pad ---------- */

test('without a launch point the line starts at the approach gate and says why', () => {
  const d = diveDynamics({ dive: PLAN, groundAt: flat });
  assert.deepEqual(d.phases.map((p) => p.kind), ['dive', 'pullout', 'recovery']);
  assert.equal(d.phases[0].startM, 0, 'station zero is wherever the line actually starts');
  assert.equal(d.phases[0].startMslM, APPROACH.altitudeMslM);
  assert.ok(d.systems.missing.includes('no launch point stated'));
});

test('a launch point with no elevation is an absence too, not a sea-level pad', () => {
  const d = diveDynamics({ dive: PLAN, launch: PAD, launchMslM: null, groundAt: flat });
  assert.deepEqual(d.phases.map((p) => p.kind), ['dive', 'pullout', 'recovery']);
  assert.ok(d.systems.missing.includes('no launch elevation stated'));
});

/* ---------- the ground ---------- */

test('a hole in the terrain is carried as a hole, under every figure that needed it', () => {
  const holed = (lat) => (lat === DIVE.latitude ? null : FLAT_GROUND);
  const d = full({ groundAt: holed });
  const [, dive, pullout] = d.phases;
  assert.equal(d.groundComplete, false);
  assert.equal(dive.endClearanceM, null);
  assert.equal(pullout.startClearanceM, null);
  assert.equal(pullout.endClearanceM, null);
  assert.equal(d.systems.pulloutClearanceM, null);
  // The arc itself is unaffected: its low point is the gate less the sink, and
  // no ground figure enters that.
  assert.equal(d.systems.pulloutLowestMslM, DIVE.altitudeMslM - SINK_M);
  assert.ok(d.systems.missing.includes('no ground under the dive gate'));
});

test('no terrain source at all is stated once, and never read as clear ground', () => {
  const d = diveDynamics({ dive: PLAN, launch: PAD, launchMslM: PAD_MSL });
  assert.equal(d.groundComplete, false);
  assert.ok(d.systems.missing.includes('no terrain source for the ground under the dive line'));
  for (const p of d.phases) {
    assert.equal(p.startClearanceM, null);
    assert.equal(p.endClearanceM, null);
  }
});

/* ---------- the systems block ---------- */

test('peak vertical speed is the steepest descent the authored line commits to', () => {
  const d = full();
  const expected = SPEED_MS * Math.sin(LEG_DIVE.pitchDeg * Math.PI / 180);
  assert.equal(d.systems.peakVerticalSpeedMs, expected);
  assert.ok(d.systems.peakVerticalSpeedMs < 0);
});

test('the pull\'s draw, sag and margins are readings of the stated pack and airframe', () => {
  const d = full({ battery: PACK, drone: DRONE, tempC: 20, soc: 60, hoverPowerW: 150 });
  const s = d.systems;
  assert.equal(s.pulloutPowerW, 150 * Math.pow(LOAD_G, 1.5));
  assert.equal(s.sagDeliverable, true);
  assert.ok(s.packSagV > 0 && s.packSagV < 6 * 4.2, 'a sagged terminal voltage, under open-circuit');
  assert.ok(s.motorMarginFrac !== null && s.escMarginFrac !== null);
  assert.ok(s.motorMarginFrac < s.escMarginFrac, 'the tighter limit leaves the smaller margin');
});

test('a draw the pack cannot hold reads undeliverable and quotes no voltage', () => {
  const d = full({ battery: PACK, drone: DRONE, tempC: 20, soc: 60, hoverPowerW: 20_000 });
  assert.equal(d.systems.sagDeliverable, false);
  assert.equal(d.systems.packSagV, null, 'never a NaN dressed as a reading');
  assert.equal(d.systems.motorMarginFrac, null, 'an undeliverable draw has no margin to quote');
});

test('an airframe with no stated current limits gets no margin invented for it', () => {
  const bare = { ...DRONE, propulsion: null };
  const d = full({ battery: PACK, drone: bare, tempC: 20, soc: 60, hoverPowerW: 150 });
  assert.equal(d.systems.motorMarginFrac, null);
  assert.equal(d.systems.escMarginFrac, null);
  assert.ok(d.systems.missing.includes('no motor current limit on file for this airframe'));
  assert.ok(d.systems.missing.includes('no ESC current limit on file for this airframe'));
});

test('the flight home is charged only when every figure it needs was stated', () => {
  const home = { massKg: 1.6, etaProp: 0.72, levelPowerW: 240, rthSpeedMs: 14 };
  const d = full({ ...home, packWh: 120, spentWh: 70 });
  assert.ok(d.systems.rthWh > 0);
  assert.equal(d.systems.recoveryReserveFrac, (120 - 70 - d.systems.rthWh) / 120);
  // Drop the closing speed and the whole return figure goes, rather than being
  // computed at a speed nobody stated.
  const noSpeed = full({ ...home, rthSpeedMs: 0, packWh: 120, spentWh: 70 });
  assert.equal(noSpeed.systems.rthWh, null);
  assert.equal(noSpeed.systems.recoveryReserveFrac, null);
  assert.ok(noSpeed.systems.missing.includes('no closing speed for the flight home stated'));
});

/* ---------- the absences, named ---------- */

test('a bare spec names every input it did not get, once each', () => {
  const d = diveDynamics({ dive: PLAN });
  assert.deepEqual([...d.systems.missing].sort(), [
    'no airframe stated',
    'no all-up mass stated',
    'no battery selected',
    'no closing speed for the flight home stated',
    'no cruise power for the flight home stated',
    'no drivetrain efficiency stated',
    'no ground under the dive gate',
    'no hover power stated',
    'no launch point stated',
    'no pack temperature stated',
    'no planned mission energy stated',
    'no state of charge at the pullout stated',
    'no terrain source for the ground under the dive line',
    'no usable pack energy stated',
  ]);
  assert.equal(new Set(d.systems.missing).size, d.systems.missing.length, 'each absence once');
});

test('an unstated lost-link altitude is named, and costs the return figure', () => {
  const d = full({
    dive: { ...PLAN, rthAltitudeMslM: null },
    massKg: 1.6, etaProp: 0.72, levelPowerW: 240, rthSpeedMs: 14, packWh: 120, spentWh: 70,
  });
  assert.ok(d.systems.missing.includes('no lost-link altitude stated'));
  assert.equal(d.systems.rthWh, null);
  assert.equal(d.systems.recoveryReserveFrac, null);
});

test('a fully stated dive has nothing left to name', () => {
  const d = full({
    battery: PACK, drone: DRONE, tempC: 20, soc: 60, hoverPowerW: 150,
    massKg: 1.6, etaProp: 0.72, levelPowerW: 240, rthSpeedMs: 14, packWh: 120, spentWh: 70,
  });
  assert.deepEqual(d.systems.missing, []);
});

/* ---------- the claims this model is forbidden to make ---------- */

test('nothing in the output is a temperature, a thermal margin or a decibel', () => {
  const d = full({
    battery: PACK, drone: DRONE, tempC: 20, soc: 60, hoverPowerW: 150,
    massKg: 1.6, etaProp: 0.72, levelPowerW: 240, rthSpeedMs: 14, packWh: 120, spentWh: 70,
  });

  // The shape is pinned exactly, so no field can be added without this list
  // acknowledging it — which is how a thermal or dB field would have to arrive.
  assert.deepEqual(Object.keys(d).sort(),
    ['groundComplete', 'phases', 'speedMs', 'systems', 'totalM', 'totalS']);
  assert.deepEqual(Object.keys(d.systems).sort(), [
    'escMarginFrac', 'missing', 'motorMarginFrac', 'packSagV', 'peakVerticalSpeedMs',
    'pulloutClearanceM', 'pulloutLoadG', 'pulloutLowestMslM', 'pulloutPowerW',
    'pulloutRadiusM', 'pulloutSinkM', 'recoveryReserveFrac', 'rthWh', 'sagDeliverable',
  ]);
  assert.deepEqual(Object.keys(d.phases[0]).sort(), [
    'endClearanceM', 'endM', 'endMslM', 'endS', 'kind', 'label', 'pitchDeg',
    'startClearanceM', 'startM', 'startMslM', 'startS', 'verticalSpeedMs',
  ]);

  // …and belt with braces: no key anywhere reads as a temperature or a level in
  // dB, and no string the model emits claims either.
  const keys = [];
  const strings = [];
  const walk = (v) => {
    if (typeof v === 'string') { strings.push(v); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v)) { keys.push(k); walk(val); }
  };
  walk(d);
  for (const k of keys) {
    assert.doesNotMatch(k, /therm|temp|decibel|db$/i, `${k} names a claim this tool cannot make`);
  }
  for (const s of strings) {
    assert.doesNotMatch(s, /thermal|decibel|\bdB\b|link margin/i, `"${s}" claims a model that does not exist`);
  }
});
