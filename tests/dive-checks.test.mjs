// dive-checks.js judges what dive-dynamics.js modelled. These tests hold both
// halves of every threshold — the value that fires and the neighbouring value
// that does not — because a check that only ever gets tested from the failing
// side is a check nobody knows the edge of.
//
// Most of them run against a hand-built DiveDynamics rather than a real one.
// That is deliberate: dive-checks reads the *contract*, and feeding it a
// synthetic systems block is the only way to sit a margin exactly on 0.10 or a
// clearance exactly on 30 m. The last test in the file closes the loop by
// running the real model into the real checks, so the two shapes cannot drift
// apart unnoticed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { G } from '../src/domain/physics.js';
import { diveDynamics } from '../src/domain/dive-dynamics.js';
import { diveChecks } from '../src/application/analysis/dive-checks.js';
import {
  DIVE_CURRENT_MARGIN_FRAC, DIVE_PULLOUT_CLEARANCE_WARN_M,
} from '../src/application/analysis/analysis-contracts.js';
import { CONSTRAINT_CODES, finalizeConstraints } from '../src/application/analysis/constraints.js';

/* ---------- fixtures ---------- */

const PLAN = {
  gates: [],
  bailout: { name: 'Meadow', latitude: 30.620, longitude: -98.130, elevationMslM: 2500 },
  rthAltitudeMslM: 3200,
  speedMs: 26,
  pulloutLoadG: 3,
};

/* Pad, then the three flown gates. Ground is 2450 under every one of them, so
 * the highest ground the line answers with is 2450 m MSL. */
const POINTS = [
  { mslM: 2900, clearanceM: 450 },
  { mslM: 3100, clearanceM: 650 },
  { mslM: 2600, clearanceM: 150 },
  { mslM: 2800, clearanceM: 350 },
];
const HIGHEST_GROUND_MSL = 2450;

const KINDS = ['approach', 'dive', 'recovery'];

/** Leg phases from a list of chain points, the shape the model produces. */
const phasesFrom = (points) => {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    out.push({
      kind: KINDS[i - 1], label: KINDS[i - 1], startM: (i - 1) * 100, endM: i * 100,
      startS: null, endS: null,
      startMslM: points[i - 1].mslM, endMslM: points[i].mslM,
      pitchDeg: null, verticalSpeedMs: null,
      startClearanceM: points[i - 1].clearanceM, endClearanceM: points[i].clearanceM,
    });
  }
  return out;
};

const systems = (over = {}) => ({
  peakVerticalSpeedMs: -14.6, pulloutLoadG: 3, pulloutRadiusM: 34.5, pulloutSinkM: 6,
  pulloutClearanceM: 144, pulloutLowestMslM: 2594, pulloutPowerW: 780,
  packSagV: 21.2, sagDeliverable: true, motorMarginFrac: 0.5, escMarginFrac: 0.6,
  rthWh: 12, recoveryReserveFrac: 0.4, missing: [], ...over,
});

const dynamics = (sysOver = {}, over = {}) => ({
  phases: phasesFrom(over.points ?? POINTS),
  systems: systems(sysOver),
  totalM: 300, totalS: null, groundComplete: true, speedMs: 26, ...over,
});

/** Every code one run raises, in order. */
const codesOf = (spec) => diveChecks(spec).map((d) => d.code);

/** The whole check pass over the baseline, with one thing changed. */
const run = (sysOver = {}, over = {}, spec = {}) => codesOf({
  dive: PLAN, dynamics: dynamics(sysOver, over), landFloorFrac: 0.2, ...spec,
});

const textOf = (spec, code) => {
  const found = diveChecks(spec).find((d) => d.code === code);
  assert.ok(found, `${code} did not fire`);
  return found.text;
};

/* ---------- the quiet case ---------- */

test('a dive that clears everything raises nothing at all', () => {
  assert.deepEqual(run(), []);
});

test('no dive plan is not a finding — there is nothing to say anything about', () => {
  assert.deepEqual(codesOf({ dive: null, dynamics: null, landFloorFrac: 0.2 }), []);
  assert.deepEqual(codesOf({}), []);
});

/* ---------- the pullout against the ground ---------- */

test('the pullout bottoming out at or below the ground is critical, and its edge is zero', () => {
  assert.deepEqual(run({ pulloutClearanceM: -12 }), ['W-DIVE-PULLOUT-GROUND']);
  assert.deepEqual(run({ pulloutClearanceM: 0 }), ['W-DIVE-PULLOUT-GROUND'],
    'level with the ground is into the ground');
  assert.deepEqual(run({ pulloutClearanceM: 0.5 }), ['W-DIVE-PULLOUT-THIN'],
    'the first metre above the ground is thin, not fatal');
});

test('thin clearance runs up to the warn threshold and stops there', () => {
  assert.equal(DIVE_PULLOUT_CLEARANCE_WARN_M, 30);
  assert.deepEqual(run({ pulloutClearanceM: 29.999 }), ['W-DIVE-PULLOUT-THIN']);
  assert.deepEqual(run({ pulloutClearanceM: 30 }), [], 'the threshold itself is clear');
  assert.deepEqual(run({ pulloutClearanceM: 31 }), []);
});

test('both pullout-clearance messages name the metres that triggered them', () => {
  const spec = { dive: PLAN, dynamics: dynamics({ pulloutClearanceM: -12.4 }), landFloorFrac: 0.2 };
  assert.match(textOf(spec, 'W-DIVE-PULLOUT-GROUND'), /12 m below the ground/);
  assert.match(textOf(spec, 'W-DIVE-PULLOUT-GROUND'), /sinks 6 m/);
  const thin = { dive: PLAN, dynamics: dynamics({ pulloutClearanceM: 18.2 }), landFloorFrac: 0.2 };
  assert.match(textOf(thin, 'W-DIVE-PULLOUT-THIN'), /by 18 m/);
  assert.match(textOf(thin, 'W-DIVE-PULLOUT-THIN'), /under the 30 m/);
});

test('an unchecked arc is an unknown, named by whichever figure is absent', () => {
  const unchecked = { pulloutRadiusM: null, pulloutSinkM: null, pulloutClearanceM: null };
  const bare = { ...PLAN, speedMs: null, pulloutLoadG: null };
  assert.deepEqual(
    codesOf({ dive: bare, dynamics: dynamics(unchecked), landFloorFrac: 0.2 }),
    ['W-DIVE-PULLOUT-UNSTATED'],
  );
  assert.match(
    textOf({ dive: bare, dynamics: dynamics(unchecked), landFloorFrac: 0.2 }, 'W-DIVE-PULLOUT-UNSTATED'),
    /neither a speed nor a pullout load/,
  );
  const noSpeed = { ...PLAN, speedMs: null };
  assert.match(
    textOf({ dive: noSpeed, dynamics: dynamics(unchecked), landFloorFrac: 0.2 }, 'W-DIVE-PULLOUT-UNSTATED'),
    /a 3 g pullout load but no speed/,
  );
  const noLoad = { ...PLAN, pulloutLoadG: null };
  assert.match(
    textOf({ dive: noLoad, dynamics: dynamics(unchecked), landFloorFrac: 0.2 }, 'W-DIVE-PULLOUT-UNSTATED'),
    /26 m\/s but no pullout load/,
  );
});

test('a stated 1 g load is not an unstated one, and still leaves nothing checked', () => {
  const flat = { ...PLAN, pulloutLoadG: 1 };
  const unchecked = { pulloutRadiusM: null, pulloutSinkM: null, pulloutClearanceM: null };
  assert.deepEqual(
    codesOf({ dive: flat, dynamics: dynamics(unchecked), landFloorFrac: 0.2 }),
    ['W-DIVE-PULLOUT-UNSTATED'],
  );
  assert.match(
    textOf({ dive: flat, dynamics: dynamics(unchecked), landFloorFrac: 0.2 }, 'W-DIVE-PULLOUT-UNSTATED'),
    /A pullout load of 1 g leaves no arc/,
  );
});

test('an arc over ground nobody sampled is one finding, not two', () => {
  // The clearance is unknown and the terrain code below already says so; a
  // pullout code repeating it would be the same hole twice in one rail.
  assert.deepEqual(
    run({ pulloutClearanceM: null }, { groundComplete: false }),
    ['W-DIVE-GROUND-UNKNOWN'],
  );
});

/* ---------- what the pull asks of the machine ---------- */

test('a draw the pack cannot hold fires, and a deliverable one does not', () => {
  assert.deepEqual(run({ sagDeliverable: false, packSagV: null }), ['W-DIVE-SAG-LIMITED']);
  assert.deepEqual(run({ sagDeliverable: true }), []);
  assert.deepEqual(run({ sagDeliverable: null }), [], 'unknown deliverability is not a failure');
  assert.match(
    textOf({ dive: PLAN, dynamics: dynamics({ sagDeliverable: false }), landFloorFrac: 0.2 },
      'W-DIVE-SAG-LIMITED'),
    /780 W/,
  );
});

test('the current margins fire at the threshold and clear just above it', () => {
  assert.equal(DIVE_CURRENT_MARGIN_FRAC, 0.10);
  assert.deepEqual(run({ motorMarginFrac: 0.10 }), ['W-DIVE-MOTOR-MARGIN'], 'at the line is on it');
  assert.deepEqual(run({ motorMarginFrac: 0.11 }), []);
  assert.deepEqual(run({ escMarginFrac: 0.10 }), ['W-DIVE-ESC-MARGIN']);
  assert.deepEqual(run({ escMarginFrac: 0.11 }), []);
  assert.deepEqual(run({ motorMarginFrac: null, escMarginFrac: null }), [],
    'no stated limit, no finding about a margin against it');
});

test('a margin says which side of the ceiling it is on, in whole percent', () => {
  const under = { dive: PLAN, dynamics: dynamics({ motorMarginFrac: 0.04 }), landFloorFrac: 0.2 };
  assert.match(textOf(under, 'W-DIVE-MOTOR-MARGIN'), /leaves 4% of the motors' rated current unused/);
  assert.match(textOf(under, 'W-DIVE-MOTOR-MARGIN'), /under the 10%/);
  const over = { dive: PLAN, dynamics: dynamics({ escMarginFrac: -0.22 }), landFloorFrac: 0.2 };
  assert.match(textOf(over, 'W-DIVE-ESC-MARGIN'), /past the ESCs' rated current by 22%/);
});

/* ---------- getting home afterward ---------- */

test('the reserve is short only below the floor the mission set', () => {
  assert.deepEqual(run({ recoveryReserveFrac: 0.19 }), ['W-DIVE-RESERVE-SHORT']);
  assert.deepEqual(run({ recoveryReserveFrac: 0.20 }), [], 'exactly at the floor is not below it');
  assert.deepEqual(run({ recoveryReserveFrac: 0.21 }), []);
  assert.deepEqual(run({ recoveryReserveFrac: null }), [], 'an uncomputed reserve is not a short one');
  assert.deepEqual(run({ recoveryReserveFrac: 0.05 }, {}, { landFloorFrac: null }), [],
    'no stated floor, nothing to be under');
});

test('the reserve message names both percentages, and reads plainly when it goes negative', () => {
  const short = { dive: PLAN, dynamics: dynamics({ recoveryReserveFrac: 0.12 }), landFloorFrac: 0.2 };
  assert.match(textOf(short, 'W-DIVE-RESERVE-SHORT'), /12% of the pack is left/);
  assert.match(textOf(short, 'W-DIVE-RESERVE-SHORT'), /under the 20%/);
  const over = { dive: PLAN, dynamics: dynamics({ recoveryReserveFrac: -0.08 }), landFloorFrac: 0.2 };
  assert.match(textOf(over, 'W-DIVE-RESERVE-SHORT'), /commit 8% more than the pack delivers/);
  assert.match(textOf(over, 'W-DIVE-RESERVE-SHORT'), /does not close/);
});

/* ---------- the ground under the line ---------- */

test('a lost-link altitude at or below the highest ground on the line is critical', () => {
  const at = { ...PLAN, rthAltitudeMslM: HIGHEST_GROUND_MSL };
  assert.deepEqual(codesOf({ dive: at, dynamics: dynamics(), landFloorFrac: 0.2 }),
    ['W-DIVE-RTH-BELOW-TERRAIN']);
  const above = { ...PLAN, rthAltitudeMslM: HIGHEST_GROUND_MSL + 1 };
  assert.deepEqual(codesOf({ dive: above, dynamics: dynamics(), landFloorFrac: 0.2 }), []);
  const none = { ...PLAN, rthAltitudeMslM: null };
  assert.deepEqual(codesOf({ dive: none, dynamics: dynamics(), landFloorFrac: 0.2 }), [],
    'an unstated lost-link altitude is not a low one');
});

test('the lost-link message names both heights in metres MSL', () => {
  const spec = {
    dive: { ...PLAN, rthAltitudeMslM: 2400 }, dynamics: dynamics(), landFloorFrac: 0.2,
  };
  assert.match(textOf(spec, 'W-DIVE-RTH-BELOW-TERRAIN'), /2400 m MSL/);
  assert.match(textOf(spec, 'W-DIVE-RTH-BELOW-TERRAIN'), /2450 m MSL/);
});

test('ground the line never got an answer for is counted, not glossed', () => {
  const holed = [POINTS[0], POINTS[1], { mslM: 2600, clearanceM: null }, POINTS[3]];
  const spec = {
    dive: PLAN,
    dynamics: dynamics({ pulloutClearanceM: null }, { groundComplete: false, points: holed }),
    landFloorFrac: 0.2,
  };
  assert.deepEqual(codesOf(spec), ['W-DIVE-GROUND-UNKNOWN']);
  assert.match(textOf(spec, 'W-DIVE-GROUND-UNKNOWN'), /1 of the 4 points/);
  assert.match(textOf(spec, 'W-DIVE-GROUND-UNKNOWN'), /unsurveyed rather than clear/);
});

test('an unknown lost-link comparison is not a pass either — a hole hides the high ground', () => {
  // Every clearance null means no ground answered at all, so nothing can be
  // compared against the lost-link altitude and only the terrain code fires.
  const blind = POINTS.map((p) => ({ ...p, clearanceM: null }));
  const spec = {
    dive: { ...PLAN, rthAltitudeMslM: 100 },
    dynamics: dynamics({ pulloutClearanceM: null }, { groundComplete: false, points: blind }),
    landFloorFrac: 0.2,
  };
  assert.deepEqual(codesOf(spec), ['W-DIVE-GROUND-UNKNOWN']);
  assert.match(textOf(spec, 'W-DIVE-GROUND-UNKNOWN'), /4 of the 4 points/);
});

/* ---------- the bailout ---------- */

test('a dive plan with nowhere to break off to says so, at advisory', () => {
  const spec = { dive: { ...PLAN, bailout: null }, dynamics: dynamics(), landFloorFrac: 0.2 };
  assert.deepEqual(codesOf(spec), ['W-DIVE-NO-BAILOUT']);
  assert.equal(diveChecks(spec)[0].severity, 'advisory');
  assert.deepEqual(run(), [], 'a named bailout raises nothing');
});

test('the bailout question is asked of a plan too short to model', () => {
  // One gate is not a line, so `dynamics` is null — and the pilot is still
  // drawing, which is exactly when this is worth saying.
  assert.deepEqual(
    codesOf({ dive: { ...PLAN, bailout: null }, dynamics: null, landFloorFrac: 0.2 }),
    ['W-DIVE-NO-BAILOUT'],
  );
});

/* ---------- the family as a whole ---------- */

test('every code this module emits is registered, and every registered dive code is emitted', () => {
  const emitted = new Set([
    ...run({ pulloutClearanceM: -1 }),
    ...run({ pulloutClearanceM: 10 }),
    ...codesOf({
      dive: { ...PLAN, speedMs: null, bailout: null, rthAltitudeMslM: 100 },
      dynamics: dynamics(
        { pulloutRadiusM: null, pulloutClearanceM: null, sagDeliverable: false,
          motorMarginFrac: 0, escMarginFrac: 0, recoveryReserveFrac: 0.01 },
        { groundComplete: false },
      ),
      landFloorFrac: 0.2,
    }),
  ]);
  const registered = Object.keys(CONSTRAINT_CODES).filter((c) => c.startsWith('W-DIVE-'));
  assert.equal(registered.length, 10);
  assert.deepEqual([...emitted].sort(), registered.slice().sort());
});

test('every draft is mission-anchored and survives finalisation', () => {
  const drafts = diveChecks({
    dive: { ...PLAN, bailout: null },
    dynamics: dynamics({ pulloutClearanceM: -4 }),
    landFloorFrac: 0.2,
  });
  for (const d of drafts) {
    assert.deepEqual(d.anchor, { scope: 'mission', refId: null });
    assert.ok(d.explanation.baseline, 'a code with no baseline explains nothing');
  }
  const finalized = finalizeConstraints(drafts);
  assert.equal(finalized.length, drafts.length);
  for (const c of finalized) assert.ok(c.id.startsWith('W-DIVE-'));
});

test('no message claims a temperature, a thermal margin or a link margin in dB', () => {
  const everything = diveChecks({
    dive: { ...PLAN, speedMs: null, bailout: null, rthAltitudeMslM: 100 },
    dynamics: dynamics(
      { pulloutRadiusM: null, pulloutClearanceM: null, sagDeliverable: false,
        motorMarginFrac: -0.3, escMarginFrac: 0, recoveryReserveFrac: -0.1 },
      { groundComplete: false },
    ),
    landFloorFrac: 0.2,
  });
  assert.ok(everything.length >= 7, 'the sweep has to actually reach the messages');
  for (const d of everything) {
    assert.doesNotMatch(d.text, /thermal|decibel|\bdB\b|°C|link margin/i,
      `"${d.text}" claims a model that does not exist`);
  }
});

/* ---------- the real model, end to end ---------- */

const PAD = { latitude: 30.600, longitude: -98.100 };
const REAL_PLAN = {
  ...PLAN,
  gates: [
    { id: 'a', kind: 'approach', latitude: 30.605, longitude: -98.105, altitudeMslM: 3100, radiusM: null },
    { id: 'd', kind: 'dive', latitude: 30.610, longitude: -98.110, altitudeMslM: 2600, radiusM: null },
    { id: 'r', kind: 'recovery', latitude: 30.615, longitude: -98.115, altitudeMslM: 2800, radiusM: null },
  ],
};

/** The arc the real model will fly, from dive.js's own identities. */
const realSink = () => {
  const d = diveDynamics({ dive: REAL_PLAN, launch: PAD, launchMslM: 2900, groundAt: () => 2450 });
  const pitchDeg = d.phases.find((p) => p.kind === 'dive').pitchDeg;
  const r = 26 * 26 / (G * (3 - 1));
  return r * (1 - Math.cos(-pitchDeg * Math.PI / 180));
};

test('the real model feeds the real checks, and the thresholds land where they say', () => {
  const sinkM = realSink();
  const under = (target) => diveDynamics({
    dive: REAL_PLAN,
    launch: PAD,
    launchMslM: 2900,
    // Ground set so the pullout's low point clears the dive gate by exactly
    // `target` metres; everywhere else stays far below the line.
    groundAt: (lat) => (lat === REAL_PLAN.gates[1].latitude ? 2600 - sinkM - target : 2400),
  });
  assert.deepEqual(codesOf({ dive: REAL_PLAN, dynamics: under(120), landFloorFrac: 0.2 }), []);
  assert.deepEqual(
    codesOf({ dive: REAL_PLAN, dynamics: under(12), landFloorFrac: 0.2 }),
    ['W-DIVE-PULLOUT-THIN'],
  );
  assert.deepEqual(
    codesOf({ dive: REAL_PLAN, dynamics: under(-3), landFloorFrac: 0.2 }),
    ['W-DIVE-PULLOUT-GROUND'],
  );
});
