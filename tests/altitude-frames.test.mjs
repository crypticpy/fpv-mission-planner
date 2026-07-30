import test from 'node:test';
import assert from 'node:assert/strict';

import { convertAltitude } from '../src/domain/mission/altitude.js';
import { ALTITUDE_REFERENCES } from '../src/domain/mission/mission-schema.js';

/* convertAltitude: three frames, six directions, one arithmetic site.
 *
 * M3 needs the reverse of what resolveAltitude does. Clearance over a corridor
 * sample is the cruise height expressed as AGL *at that sample*, and the number
 * a pilot reads back is launch-relative — both are conversions away from MSL,
 * which nothing before M3 had to do. ADR 0003's rule does not change direction
 * with them: a conversion missing its ground or its launch elevation produces
 * null and a reason, never a plausible-looking number. */

/** A site 200 m up, with 512 m of hill under the point in question. */
const CONTEXT = { launchElevMslM: 200, terrainElevMslM: 512 };

/* ---------- the six directions ---------- */

for (const [from, to, value, expected] of /** @type {const} */ ([
  ['msl', 'msl', 600, 600],
  ['msl', 'launchRelative', 600, 400],
  ['msl', 'agl', 600, 88],
  ['launchRelative', 'msl', 400, 600],
  ['launchRelative', 'launchRelative', 400, 400],
  ['launchRelative', 'agl', 400, 88],
  ['agl', 'msl', 88, 600],
  ['agl', 'launchRelative', 88, 400],
  ['agl', 'agl', 88, 88],
])) {
  test(`${value} m ${from} is ${expected} m ${to}`, () => {
    assert.deepEqual(convertAltitude({ value, from, to, ...CONTEXT }),
      { value: expected, resolved: true });
  });
}

test('every pair of frames is covered above', () => {
  assert.deepEqual([...ALTITUDE_REFERENCES], ['launchRelative', 'agl', 'msl'],
    'a fourth frame means three more rows in the table above');
});

test('a round trip through any frame comes back to the number it started as', () => {
  for (const from of ALTITUDE_REFERENCES) {
    for (const to of ALTITUDE_REFERENCES) {
      const there = convertAltitude({ value: 137.5, from, to, ...CONTEXT });
      const back = convertAltitude({ value: there.value, from: to, to: from, ...CONTEXT });
      assert.equal(back.value, 137.5, `${from} -> ${to} -> ${from}`);
    }
  }
});

/* ---------- clearance, which is what this is really for ---------- */

test('clearance over a sample is this function with to: agl', () => {
  // There is deliberately no separate clearance helper. One subtraction site
  // is one place the sign can be wrong.
  const clearance = (cruiseMslM, groundMslM) => convertAltitude({
    value: cruiseMslM, from: 'msl', to: 'agl', terrainElevMslM: groundMslM,
  });
  assert.equal(clearance(600, 512).value, 88);
  assert.equal(clearance(600, 640).value, -40, 'flying into a hill is a negative number, not a zero');
  assert.equal(clearance(600, 0).value, 600, 'ground at sea level is a measurement');
  assert.equal(clearance(30, -52).value, 82, 'Death Valley is a place');
});

test('clearance over ground nobody has is unknown, never clear', () => {
  // The exit gate's line: an unknown clearance can never be presented as a
  // clear one, so the only honest answer is null with the reason attached.
  for (const terrainElevMslM of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, '512']) {
    const verdict = convertAltitude({
      value: 600, from: 'msl', to: 'agl', launchElevMslM: 200, terrainElevMslM,
    });
    assert.deepEqual(verdict,
      { value: null, resolved: false, reason: 'missing-terrain-sample' },
      `terrainElevMslM: ${String(terrainElevMslM)}`);
    assert.notEqual(verdict.value, 0);
  }
});

/* ---------- what is missing, and what it is called ---------- */

test('a launch-relative answer with no launch elevation is unresolved, not sea level', () => {
  for (const launchElevMslM of [null, undefined, Number.NaN, '200']) {
    assert.deepEqual(
      convertAltitude({ value: 600, from: 'msl', to: 'launchRelative', launchElevMslM }),
      { value: null, resolved: false, reason: 'missing-launch-elevation' });
  }
});

test('an elevation of zero is an answer; a missing one is not', () => {
  assert.deepEqual(
    convertAltitude({ value: 80, from: 'msl', to: 'launchRelative', launchElevMslM: 0 }),
    { value: 80, resolved: true }, 'a beach launch really is at 0 m MSL');
  assert.deepEqual(convertAltitude({ value: 80, from: 'msl', to: 'agl', terrainElevMslM: 0 }),
    { value: 80, resolved: true });
});

test('a missing input on the way in is named as precisely as one on the way out', () => {
  assert.equal(
    convertAltitude({ value: 45, from: 'agl', to: 'msl', launchElevMslM: 200 }).reason,
    'missing-terrain-sample', 'the AGL height had no ground to stand on');
  assert.equal(
    convertAltitude({ value: 80, from: 'launchRelative', to: 'msl', terrainElevMslM: 512 }).reason,
    'missing-launch-elevation');
});

test('a frame nobody defined resolves to nothing, in either position', () => {
  assert.deepEqual(
    convertAltitude({ value: 600, from: 'msl', to: 'aboveTheTrees', ...CONTEXT }),
    { value: null, resolved: false, reason: 'unknown-reference' });
  assert.deepEqual(
    convertAltitude({ value: 600, from: 'flightLevel', to: 'msl', ...CONTEXT }),
    { value: null, resolved: false, reason: 'unknown-reference' });
  assert.equal(convertAltitude({ value: 600, from: 'msl', ...CONTEXT }).reason, 'unknown-reference');
});

test('a height that is not a number is bad-authored, whatever else is known', () => {
  for (const value of [null, undefined, '600', Number.NaN, Number.POSITIVE_INFINITY, {}]) {
    assert.deepEqual(convertAltitude({ value, from: 'msl', to: 'agl', ...CONTEXT }),
      { value: null, resolved: false, reason: 'bad-authored' }, `value: ${String(value)}`);
  }
});

test('no spec at all is a reason, not a crash', () => {
  assert.deepEqual(convertAltitude(undefined),
    { value: null, resolved: false, reason: 'unknown-reference' });
  assert.deepEqual(convertAltitude(null),
    { value: null, resolved: false, reason: 'unknown-reference' });
});

test('value is null exactly when resolved is false', () => {
  const specs = [
    { value: 600, from: 'msl', to: 'agl', ...CONTEXT },
    { value: 600, from: 'msl', to: 'agl' },
    { value: 600, from: 'agl', to: 'launchRelative', launchElevMslM: 200 },
    { value: '600', from: 'msl', to: 'msl' },
    { value: 600, from: 'msl', to: 'orbit' },
    { value: 0, from: 'msl', to: 'msl' },
  ];
  for (const spec of specs) {
    const verdict = convertAltitude(spec);
    assert.equal(verdict.resolved, verdict.value !== null, JSON.stringify(spec));
    assert.equal('reason' in verdict, !verdict.resolved, JSON.stringify(spec));
  }
});

test('convertAltitude never writes to the spec it was handed', () => {
  const spec = { value: 600, from: 'msl', to: 'agl', ...CONTEXT };
  const snapshot = structuredClone(spec);
  convertAltitude(spec);
  assert.deepEqual(spec, snapshot);
});
