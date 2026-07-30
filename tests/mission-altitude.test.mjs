import test from 'node:test';
import assert from 'node:assert/strict';

import { createMission } from '../src/domain/mission/mission-schema.js';
import { missionReduce } from '../src/domain/mission/mission-reducer.js';
import {
  resolveAltitude, resolveMissionAltitudes, displayAltitude,
} from '../src/domain/mission/altitude.js';

/* ADR 0003 in one line: an altitude nobody can resolve is null, never 0. Most
 * of what follows is that sentence applied to each frame and each missing
 * input, because "0 m MSL" through a 400 m ridge is the failure this module was
 * written to make impossible. */

const AUSTIN = { latitude: 30.2672, longitude: -97.7431, elevationMslM: 168 };

function harness() {
  let ids = 0;
  let ticks = 0;
  return {
    idgen: (prefix) => `${prefix}_${++ids}`,
    now: () => new Date(Date.UTC(2026, 6, 30, 12, 0, ticks++)).toISOString(),
  };
}

const alt = (authored, reference, resolvedMslM = null) => ({ authored, reference, resolvedMslM });

/* ---------- one altitude at a time ---------- */

test('an MSL height is already the answer', () => {
  assert.deepEqual(resolveAltitude(alt(400, 'msl')), { resolvedMslM: 400, resolved: true });
  assert.deepEqual(
    resolveAltitude(alt(400, 'msl'), { launchElevMslM: 168, terrainElevMslM: 300 }),
    { resolvedMslM: 400, resolved: true },
    'and it does not care what else is known');
});

test('a launch-relative height is the launch elevation plus the number the pilot typed', () => {
  assert.deepEqual(
    resolveAltitude(alt(80, 'launchRelative'), { launchElevMslM: 168 }),
    { resolvedMslM: 248, resolved: true });
});

test('an AGL height is the ground under the point plus the number the pilot typed', () => {
  assert.deepEqual(
    resolveAltitude(alt(45, 'agl'), { launchElevMslM: 168, terrainElevMslM: 512 }),
    { resolvedMslM: 557, resolved: true });
});

test('a launch-relative height with no launch elevation is unresolved, not sea level', () => {
  const verdict = resolveAltitude(alt(80, 'launchRelative'), {});
  assert.deepEqual(verdict, { resolvedMslM: null, resolved: false, reason: 'missing-launch-elevation' });
  assert.notEqual(verdict.resolvedMslM, 0);
});

test('an AGL height with no terrain sample is unresolved, not sea level', () => {
  for (const context of [
    { launchElevMslM: 168 },
    { launchElevMslM: 168, terrainElevMslM: null },
    { launchElevMslM: 168, terrainElevMslM: undefined },
    { launchElevMslM: 168, terrainElevMslM: Number.NaN },
    { launchElevMslM: 168, terrainElevMslM: '512' },
  ]) {
    const verdict = resolveAltitude(alt(45, 'agl'), context);
    assert.deepEqual(verdict, { resolvedMslM: null, resolved: false, reason: 'missing-terrain-sample' });
  }
});

test('a launch elevation of zero is an answer; a launch elevation of null is not', () => {
  assert.deepEqual(resolveAltitude(alt(80, 'launchRelative'), { launchElevMslM: 0 }),
    { resolvedMslM: 80, resolved: true }, 'a beach launch really is at 0 m MSL');
  assert.equal(resolveAltitude(alt(80, 'launchRelative'), { launchElevMslM: null }).resolved, false);
});

test('terrain below sea level resolves rather than being mistaken for missing', () => {
  assert.deepEqual(resolveAltitude(alt(30, 'agl'), { terrainElevMslM: -52 }),
    { resolvedMslM: -22, resolved: true }, 'Death Valley is a place');
});

for (const [label, value, reason] of [
  ['null', null, 'no-altitude'],
  ['undefined', undefined, 'no-altitude'],
  ['a bare number', 80, 'no-altitude'],
  ['a string', '80 m', 'no-altitude'],
  ['an altitude with no authored figure', { reference: 'msl' }, 'bad-authored'],
  ['an authored figure that is text', alt('80', 'msl'), 'bad-authored'],
  ['an authored figure that is NaN', alt(Number.NaN, 'msl'), 'bad-authored'],
  ['an authored figure that is Infinity', alt(Number.POSITIVE_INFINITY, 'msl'), 'bad-authored'],
  ['a frame nobody defined', alt(80, 'aboveTheTrees'), 'unknown-reference'],
  ['no frame at all', { authored: 80 }, 'unknown-reference'],
]) {
  test(`${label} resolves to null with reason '${reason}'`, () => {
    const verdict = resolveAltitude(value, { launchElevMslM: 168, terrainElevMslM: 512 });
    assert.deepEqual(verdict, { resolvedMslM: null, resolved: false, reason });
  });
}

test('resolveAltitude never writes to the altitude it was handed', () => {
  const altitude = alt(80, 'launchRelative');
  resolveAltitude(altitude, { launchElevMslM: 168 });
  assert.deepEqual(altitude, { authored: 80, reference: 'launchRelative', resolvedMslM: null });
});

/* ---------- a whole mission ---------- */

/** launch → wpt(agl 45) → wpt(launchRelative 80) → wpt(msl 400). */
function threeFrames(deps, launch = AUSTIN) {
  const wp = (latitude, longitude, altitude) => ({ type: 'addWaypoint', payload: { latitude, longitude, altitude } });
  return [
    wp(30.30, -97.80, { authored: 45, reference: 'agl' }),
    wp(30.40, -97.90, { authored: 80, reference: 'launchRelative' }),
    wp(30.50, -98.00, { authored: 400, reference: 'msl' }),
  ].reduce((doc, c) => missionReduce(doc, c, deps), createMission({ launch, title: 'Three frames' }, deps));
}

/** A DEM that knows the hill country and nothing else. */
const HILLS = { '30.3,-97.8': 512, '30.4,-97.9': 604, '30.5,-98': 655 };
const hillSampler = (lat, lon) => HILLS[`${lat},${lon}`] ?? null;

test('resolveMissionAltitudes fills each frame from the input that frame needs', () => {
  const deps = harness();
  const { doc, resolvedCount, unresolved } = resolveMissionAltitudes(threeFrames(deps), hillSampler);
  assert.deepEqual(doc.route.segments.map((s) => s.altitude.resolvedMslM), [557, 248, 400]);
  assert.equal(resolvedCount, 3);
  assert.deepEqual(unresolved, []);
});

test('the authored figures are never touched', () => {
  const deps = harness();
  const { doc } = resolveMissionAltitudes(threeFrames(deps), hillSampler);
  assert.deepEqual(doc.route.segments.map((s) => [s.altitude.authored, s.altitude.reference]),
    [[45, 'agl'], [80, 'launchRelative'], [400, 'msl']]);
});

test('resolveMissionAltitudes does not mutate the document it was given', () => {
  const deps = harness();
  const before = threeFrames(deps);
  const snapshot = structuredClone(before);
  const { doc } = resolveMissionAltitudes(before, hillSampler);
  assert.deepEqual(before, snapshot);
  assert.notEqual(doc, before);
});

test('with no sampler at all, only the frames that need no terrain resolve', () => {
  const deps = harness();
  const { doc, resolvedCount, unresolved } = resolveMissionAltitudes(threeFrames(deps));
  assert.deepEqual(doc.route.segments.map((s) => s.altitude.resolvedMslM), [null, 248, 400]);
  assert.equal(resolvedCount, 2);
  assert.deepEqual(unresolved, [{
    segmentId: 'seg_3', path: 'route.segments[0].altitude', reference: 'agl', reason: 'missing-terrain-sample',
  }]);
});

test('with no launch elevation, launch-relative goes unresolved and nothing becomes zero', () => {
  const deps = harness();
  const doc = threeFrames(deps, { latitude: 30.2672, longitude: -97.7431 });
  const { doc: resolved, unresolved } = resolveMissionAltitudes(doc, hillSampler);
  assert.deepEqual(resolved.route.segments.map((s) => s.altitude.resolvedMslM), [557, null, 400]);
  assert.deepEqual(unresolved.map((u) => u.reason), ['missing-launch-elevation']);
  assert.equal(unresolved[0].segmentId, 'seg_5');
});

test('a sampler with a hole in its coverage leaves that leg unresolved and the rest alone', () => {
  const deps = harness();
  const sparse = (lat, lon) => (lat === 30.3 ? null : hillSampler(lat, lon));
  const { doc, unresolved } = resolveMissionAltitudes(threeFrames(deps), sparse);
  assert.equal(doc.route.segments[0].altitude.resolvedMslM, null);
  assert.deepEqual(unresolved.map((u) => u.path), ['route.segments[0].altitude']);
});

test('a sampler that throws degrades the mission instead of taking the caller down', () => {
  const deps = harness();
  const angry = () => { throw new Error('DEM provider is offline'); };
  const { doc, unresolved } = resolveMissionAltitudes(threeFrames(deps), angry);
  assert.equal(doc.route.segments[0].altitude.resolvedMslM, null);
  assert.equal(unresolved[0].reason, 'missing-terrain-sample');
  assert.equal(doc.route.segments[1].altitude.resolvedMslM, 248, 'the frames that need no DEM are unharmed');
});

test('the sampler is asked only about the points that need terrain', () => {
  const deps = harness();
  const asked = [];
  resolveMissionAltitudes(threeFrames(deps), (lat, lon) => {
    asked.push([lat, lon]);
    return hillSampler(lat, lon);
  });
  assert.deepEqual(asked, [[30.3, -97.8]], 'one AGL leg, sampled at its arrival point, once');
});

test('a resolved figure that can no longer be justified is cleared, not left standing', () => {
  const deps = harness();
  const { doc } = resolveMissionAltitudes(threeFrames(deps), hillSampler);
  assert.equal(doc.route.segments[0].altitude.resolvedMslM, 557);

  // The terrain snapshot went away — the previous answer must not survive it.
  const { doc: after, unresolved } = resolveMissionAltitudes(doc, null);
  assert.equal(after.route.segments[0].altitude.resolvedMslM, null, 'a stale MSL figure is the bug this prevents');
  assert.equal(unresolved.length, 1);
});

test('re-resolving with the same answers returns the same objects', () => {
  const deps = harness();
  const { doc } = resolveMissionAltitudes(threeFrames(deps), hillSampler);
  const { doc: again } = resolveMissionAltitudes(doc, hillSampler);
  assert.deepEqual(again.route.segments, doc.route.segments);
  doc.route.segments.forEach((seg, i) => {
    assert.equal(again.route.segments[i], seg, `segment ${i} is shared, not rebuilt`);
  });
});

test('an empty route resolves to an empty answer rather than an error', () => {
  const deps = harness();
  const { doc, resolvedCount, unresolved } = resolveMissionAltitudes(createMission({ launch: AUSTIN }, deps), hillSampler);
  assert.deepEqual(doc.route.segments, []);
  assert.equal(resolvedCount, 0);
  assert.deepEqual(unresolved, []);
});

/* ---------- the flight home ---------- */

test('a return altitude is resolved like any other, against the launch point', () => {
  const deps = harness();
  const doc = missionReduce(threeFrames(deps), {
    type: 'setReturnPolicy', payload: { mode: 'direct', altitude: { authored: 120, reference: 'launchRelative' } },
  }, deps);
  const { doc: resolved, resolvedCount } = resolveMissionAltitudes(doc, hillSampler);
  assert.equal(resolved.route.returnPolicy.altitude.resolvedMslM, 288);
  assert.equal(resolvedCount, 4);
});

test('an unresolvable return altitude is reported under its own name', () => {
  const deps = harness();
  const doc = missionReduce(createMission({ launch: { latitude: 30.2672, longitude: -97.7431 } }, deps), {
    type: 'setReturnPolicy', payload: { mode: 'direct', altitude: { authored: 120, reference: 'launchRelative' } },
  }, deps);
  const { unresolved } = resolveMissionAltitudes(doc, hillSampler);
  assert.deepEqual(unresolved, [{
    segmentId: 'returnPolicy', path: 'route.returnPolicy.altitude',
    reference: 'launchRelative', reason: 'missing-launch-elevation',
  }]);
});

test('a return policy with no altitude of its own is left alone', () => {
  const deps = harness();
  const doc = threeFrames(deps);
  const { doc: resolved } = resolveMissionAltitudes(doc, hillSampler);
  assert.equal(resolved.route.returnPolicy.altitude, null);
  assert.equal(resolved.route.returnPolicy, doc.route.returnPolicy);
});

/* ---------- what a pilot reads ---------- */

test('displayAltitude speaks the frame the pilot authored in', () => {
  assert.equal(displayAltitude(alt(80, 'launchRelative')), '80 m above launch');
  assert.equal(displayAltitude(alt(45, 'agl')), '45 m AGL');
  assert.equal(displayAltitude(alt(400, 'msl')), '400 m MSL');
});

test('displayAltitude never quotes the resolved MSL figure back at the pilot', () => {
  assert.equal(displayAltitude(alt(80, 'launchRelative', 248)), '80 m above launch',
    'the pilot typed 80, and 248 is the model\'s number');
});

test('displayAltitude rounds to a tenth of a metre', () => {
  assert.equal(displayAltitude(alt(80.44, 'msl')), '80.4 m MSL');
  assert.equal(displayAltitude(alt(80.46, 'msl')), '80.5 m MSL');
  assert.equal(displayAltitude(alt(-12.5, 'msl')), '-12.5 m MSL');
});

test('displayAltitude says so when there is nothing to display', () => {
  assert.equal(displayAltitude(null), 'no altitude');
  assert.equal(displayAltitude(undefined), 'no altitude');
  assert.equal(displayAltitude({}), 'no altitude');
  assert.equal(displayAltitude(alt('80', 'msl')), 'no altitude');
  assert.equal(displayAltitude(alt(80, 'aboveTheTrees')), '80 m', 'a height in an unknown frame is still a height');
});
