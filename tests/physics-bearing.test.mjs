import test from 'node:test';
import assert from 'node:assert/strict';

import { planMission, U } from '../src/domain/physics.js';

// Representative MOZ7 V2 + NAV 5000 loadout (values mirror src/data.js).
const drone = {
  dryMassG: 843, propDiaIn: 7.5, numRotors: 4, cdA: 0.028,
  etaProp: 0.55, avionicsW: 12, maxSpeedMs: 30.5, cruiseMs: 18,
};
const battery = { chem: 'liion', s: 6, capAh: 5.0, massG: 499, irPackMilliOhm: 60 };

function inputs(overrides = {}, envOverrides = {}) {
  return {
    drone, battery, payloadG: 0, extraG: 0,
    env: {
      elevM: U.ftToM(550), tempC: U.fToC(82), rhPct: 62,
      windAvgMs: U.mphToMs(11), windGustMs: U.mphToMs(21),
      windMode: 'headOut', windFromDeg: 170,
      ...envOverrides,
    },
    landFloorPct: 20, cruiseMode: 'real', realVMs: 18, manualVMs: 0,
    overheadF: 1.05,
    ...overrides,
  };
}

// The absolute-course path must reproduce the discrete relative modes exactly:
// flying straight upwind is 'headOut', straight downwind is 'tailOut',
// perpendicular is 'cross'. Exercised for both fixed-speed and best-range
// cruise so both leg constructors are covered.
for (const cruiseMode of ['real', 'range']) {
  test(`course-based wind reproduces windMode radii bit-for-bit (${cruiseMode})`, () => {
    const phi = 170;
    const cases = [
      ['headOut', phi],
      ['tailOut', phi + 180],
      ['cross', phi + 90],
      ['cross', phi - 90],
    ];
    for (const [mode, course] of cases) {
      const byMode = planMission(inputs({ cruiseMode }, { windMode: mode }));
      const byCourse = planMission(inputs({ cruiseMode, courseDeg: course }));
      assert.equal(byCourse.radiusKm, byMode.radiusKm, `${mode} vs course ${course}`);
      assert.equal(byCourse.timeMin, byMode.timeMin, `${mode} vs course ${course} (time)`);
    }
  });
}

test('lite mode changes no numbers, only skips extras', () => {
  const full = planMission(inputs({ courseDeg: 45 }));
  const lite = planMission(inputs({ courseDeg: 45, lite: true }));
  assert.equal(lite.radiusKm, full.radiusKm);
  assert.equal(lite.timeMin, full.timeMin);
  assert.equal(lite.energy.usableWh, full.energy.usableWh);
  assert.equal(lite.curve.length, 0);
  assert.equal(lite.timeline.length, 0);
  assert.equal(lite.endurance, null);
  assert.ok(full.curve.length > 0 && full.timeline.length > 0);
});

test('shared _pCache changes no numbers across a bearing sweep', () => {
  const cache = new Map();
  for (let course = 0; course < 360; course += 30) {
    const plain = planMission(inputs({ courseDeg: course, lite: true }));
    const cached = planMission(inputs({ courseDeg: course, lite: true, _pCache: cache }));
    assert.equal(cached.radiusKm, plain.radiusKm, `course ${course}`);
  }
  assert.ok(cache.size > 0);
});

test('footprint is symmetric about the wind axis', () => {
  const phi = 170;
  for (const alpha of [15, 40, 90, 125]) {
    const plus = planMission(inputs({ courseDeg: phi + alpha, lite: true }));
    const minus = planMission(inputs({ courseDeg: phi - alpha, lite: true }));
    assert.equal(plus.radiusKm, minus.radiusKm, `alpha ${alpha}`);
  }
});

test('overwhelming quartering wind yields zero, not drift speed', () => {
  // Wind far beyond the airframe's speed: no bearing may report progress.
  const gale = { windAvgMs: 40, windGustMs: 40 };
  for (let course = 0; course < 360; course += 45) {
    const r = planMission(inputs({ courseDeg: course, lite: true }, gale));
    assert.equal(r.radiusKm, 0, `course ${course}`);
  }
});

test('dashboard windMode path is unchanged when courseDeg is absent', () => {
  // Regression pin against pre-generalization behavior: the three modes still
  // order sensibly (any wind hurts an out-and-back; cross hurts least here).
  const head = planMission(inputs({}, { windMode: 'headOut' }));
  const tail = planMission(inputs({}, { windMode: 'tailOut' }));
  const cross = planMission(inputs({}, { windMode: 'cross' }));
  assert.ok(head.radiusKm > 0 && tail.radiusKm > 0 && cross.radiusKm > 0);
  assert.ok(cross.radiusKm > head.radiusKm);
  assert.ok(cross.radiusKm > tail.radiusKm);
});
