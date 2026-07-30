import test from 'node:test';
import assert from 'node:assert/strict';

import { UNIT_SYSTEMS, unitSystem } from '../src/units.js';

test('metric display conversions use km and km/h', () => {
  const metric = UNIT_SYSTEMS.metric;
  assert.equal(metric.distanceFromKm(10), 10);
  assert.equal(metric.speedFromMs(10), 36);
  assert.equal(metric.burnFromWhPerKm(6), 6);
});

test('imperial display conversions use mi and mph', () => {
  const imperial = UNIT_SYSTEMS.imperial;
  assert.ok(Math.abs(imperial.distanceFromKm(10) - 6.21371) < 1e-6);
  assert.ok(Math.abs(imperial.speedFromMs(10) - 22.3693629) < 1e-6);
  assert.ok(Math.abs(imperial.burnFromWhPerKm(6) - 9.656067) < 1e-6);
});

test('metric speed inputs round-trip through canonical mph state', () => {
  const metric = UNIT_SYSTEMS.metric;
  assert.ok(Math.abs(metric.speedToMph(metric.speedFromMph(42)) - 42) < 1e-9);
});

test('unknown unit systems safely fall back to imperial', () => {
  assert.equal(unitSystem('unknown').id, 'imperial');
});

test('area conversions square the linear factor', () => {
  assert.equal(UNIT_SYSTEMS.metric.areaFromKm2(10), 10);
  assert.ok(Math.abs(UNIT_SYSTEMS.imperial.areaFromKm2(10) - 3.86101919641) < 1e-6);
});
