import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FEATURE_THRESHOLDS, TERRAIN_FEATURE_KINDS, detectFeatures, gradientAt, gradients,
} from '../src/domain/terrain/terrain-features.js';
import {
  cliffDem, corridorThroughOrigin, flatDem, missingTile, pointAt, ridgeDem, saddleDem, valleyDem,
} from './fixtures/synthetic-dem.mjs';

/* The classifier, alone. Everything here is a plain array of stations in and a
 * list of named shapes out — no provider, no cache, no promise. The fixtures
 * are analytic surfaces, so each test can name the *station* a feature must
 * land on rather than hoping one turned up somewhere.
 *
 * The rule under most of these assertions: a gap is not a shape. Where the
 * ground is unknown the classifier says nothing, and says nothing about the
 * steps either side of it. */

/**
 * Stations across a fixture surface, built independently of the sampling
 * service — if the two ever disagree about what "the ground beside station 6"
 * means, one of these suites fails.
 *
 * @param {(lat: number, lng: number) => number|null} dem
 * @param {{ bearingDeg: number, lengthM?: number, steps?: number, offsetM?: number }} spec
 */
function stationsAcross(dem, spec) {
  const offsetM = spec.offsetM ?? 0;
  const corridor = corridorThroughOrigin({
    bearingDeg: spec.bearingDeg, lengthM: spec.lengthM ?? 2400, steps: spec.steps ?? 12,
  });
  return corridor.samples.map((s) => {
    const at = { lat: s.latitude, lng: s.longitude };
    const left = offsetM > 0 ? pointAt(at, (s.bearingDeg + 270) % 360, offsetM) : null;
    const right = offsetM > 0 ? pointAt(at, (s.bearingDeg + 90) % 360, offsetM) : null;
    return {
      id: s.id,
      distanceKm: s.distanceKm,
      bearingDeg: s.bearingDeg,
      groundMslM: dem(s.latitude, s.longitude),
      leftMslM: left ? dem(left.lat, left.lng) : null,
      rightMslM: right ? dem(right.lat, right.lng) : null,
      lateralOffsetM: offsetM,
    };
  });
}

/** A hand-built run of stations 100 m apart on a due-north course. */
function line(elevations, options = {}) {
  const spacingM = options.spacingM ?? 100;
  return elevations.map((groundMslM, i) => ({
    id: `seg_1:${i}`,
    distanceKm: (i * spacingM) / 1000,
    bearingDeg: options.bearingDeg ?? 0,
    groundMslM,
    leftMslM: options.leftMslM?.[i] ?? null,
    rightMslM: options.rightMslM?.[i] ?? null,
    lateralOffsetM: options.lateralOffsetM ?? 0,
  }));
}

/* ---------- 1. slope and aspect ---------- */

test('a rising course reads its slope and points its aspect back downhill', () => {
  const stations = line([100, 110, 120, 130]);
  const at = gradientAt(stations, 1);
  assert.equal(Math.round(at.slopeDeg * 100) / 100, 5.71, '10 m over 100 m is 5.71°');
  assert.equal(at.aspectDeg, 180, 'flying north up a slope, downhill is south');
  assert.equal(at.basis, 'along-track');
});

test('a falling course points its aspect the way it is going', () => {
  const stations = line([130, 120, 110, 100]);
  assert.equal(gradientAt(stations, 1).aspectDeg, 0);
});

test('flat ground has a slope of zero and no aspect at all', () => {
  const at = gradientAt(line([200, 200, 200]), 1);
  assert.equal(at.slopeDeg, 0);
  assert.equal(at.aspectDeg, null, 'level ground has no downhill direction to name');
});

test('the ends of a corridor are one-sided, not unknown', () => {
  const stations = line([100, 110, 120]);
  assert.equal(Math.round(gradientAt(stations, 0).slopeDeg * 100) / 100, 5.71);
  assert.equal(Math.round(gradientAt(stations, 2).slopeDeg * 100) / 100, 5.71);
});

test('a gradient is never taken across a gap', () => {
  // The station either side of the hole still has one known neighbour, so it
  // gets a one-sided answer. The hole itself gets nothing.
  const stations = line([100, 110, null, 130, 140]);
  assert.equal(gradientAt(stations, 2).slopeDeg, null, 'the gap has no slope');
  assert.equal(gradientAt(stations, 2).basis, null);
  const before = gradientAt(stations, 1);
  assert.equal(Math.round(before.slopeDeg * 100) / 100, 5.71, 'measured back to 0, not across to 3');
  const after = gradientAt(stations, 3);
  assert.equal(Math.round(after.slopeDeg * 100) / 100, 5.71, 'measured forward to 4');
});

test('an isolated known station has no gradient to report', () => {
  assert.deepEqual(gradientAt(line([null, 110, null]), 1),
    { slopeDeg: null, aspectDeg: null, basis: null });
});

test('lateral samples turn the gradient two-dimensional', () => {
  // Level along track, rising to the right: the steepest descent is 90° left of
  // the course, and the basis says lateral evidence is what produced it.
  const stations = line([110, 110, 110], {
    leftMslM: [100, 100, 100], rightMslM: [120, 120, 120], lateralOffsetM: 100,
  });
  const at = gradientAt(stations, 1);
  assert.equal(Math.round(at.slopeDeg * 100) / 100, 5.71);
  assert.equal(at.aspectDeg, 270, 'flying north with the ground rising east, downhill is west');
  assert.equal(at.basis, 'cross-track');
});

test('gradients() answers for every station in order', () => {
  const all = gradients(line([100, 110, 120]));
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((g) => g.aspectDeg), [180, 180, 180]);
});

/* ---------- 2. the fixture surfaces ---------- */

test('flat ground produces no features whatsoever', () => {
  const found = detectFeatures(stationsAcross(flatDem({ elevM: 210 }), { bearingDeg: 0 }));
  assert.deepEqual(found, [], 'a classifier that finds a ridge on a plain is reading its own noise');
});

test('a route across a ridge finds the ridge, on the station that is on the crest', () => {
  const found = detectFeatures(stationsAcross(ridgeDem({ axisDeg: 90 }), { bearingDeg: 0 }));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'ridge');
  assert.equal(found[0].sampleId, 'seg_1:6', 'the middle station is the one on the origin');
  assert.ok(found[0].reliefM > 50, `a 150 m Gaussian crest stands well clear: ${found[0].reliefM}`);
  assert.equal(found[0].basis, 'along-track', 'no lateral samples were taken');
  assert.equal(found[0].throughId, null);
});

test('a route across a valley finds the valley, and its relief is negative', () => {
  const found = detectFeatures(stationsAcross(valleyDem({ axisDeg: 90 }), { bearingDeg: 0 }));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'valley');
  assert.equal(found[0].sampleId, 'seg_1:6');
  assert.ok(found[0].reliefM < -50, 'a valley sits below its neighbours');
});

test('flying the crest line through a col is a saddle', () => {
  // East along the ridge that joins two peaks: the col is low along track and
  // high across it.
  const found = detectFeatures(stationsAcross(saddleDem(), {
    bearingDeg: 90, steps: 6, offsetM: 400,
  }));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'saddle');
  assert.equal(found[0].sampleId, 'seg_1:3');
  assert.equal(found[0].basis, 'cross-track', 'the lateral samples are what named it');
});

test('crossing the same col transversely is a pass', () => {
  // North across the crest, through its lowest point: high along track, low
  // across it. Same surface, same col, different thing to a pilot.
  const found = detectFeatures(stationsAcross(saddleDem(), {
    bearingDeg: 0, steps: 6, offsetM: 400,
  }));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'pass');
  assert.equal(found[0].sampleId, 'seg_1:3');
  assert.equal(found[0].basis, 'cross-track');
});

test('without lateral samples the same col is only ever a ridge or a valley', () => {
  // This is the honest degradation, and it is why `basis` exists: one line of
  // ground cannot tell a col from a summit, so the vocabulary shrinks rather
  // than the confidence growing.
  const north = detectFeatures(stationsAcross(saddleDem(), { bearingDeg: 0, steps: 6 }));
  assert.deepEqual(north.map((f) => f.kind), ['ridge']);
  assert.equal(north[0].basis, 'along-track');
  const east = detectFeatures(stationsAcross(saddleDem(), { bearingDeg: 90, steps: 6 }));
  assert.deepEqual(east.map((f) => f.kind), ['valley']);
  assert.equal(east[0].basis, 'along-track');
});

test('a step in the ground is a cliff, reported on the near side of it', () => {
  const stations = stationsAcross(cliffDem({ dropM: 80, atEastM: 25 }), {
    bearingDeg: 90, lengthM: 600, steps: 12,
  });
  const found = detectFeatures(stations);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'cliff');
  assert.equal(found[0].sampleId, 'seg_1:6', 'the station before the drop');
  assert.equal(found[0].throughId, 'seg_1:7', 'and the one after it');
  assert.equal(Math.round(found[0].reliefM), -80, 'the ground falls away ahead');
  assert.ok(found[0].slopeDeg > 50, `80 m over 50 m is steep: ${found[0].slopeDeg}`);
});

test('a missing tile removes the feature under it and invents nothing', () => {
  // The crest station is inside the hole. Without it there is no evidence of a
  // ridge — and the stations either side must not be joined across the gap to
  // manufacture one.
  const dem = missingTile(ridgeDem({ axisDeg: 90 }), {
    eastFromM: -5000, eastToM: 5000, northFromM: -100, northToM: 100,
  });
  const stations = stationsAcross(dem, { bearingDeg: 0 });
  assert.equal(stations[6].groundMslM, null, 'the fixture really does have a hole in it');
  assert.deepEqual(detectFeatures(stations), []);
});

/* ---------- 3. thresholds ---------- */

test('a bump smaller than the relief threshold is not a ridge', () => {
  const stations = line([200, 203, 200]);
  assert.deepEqual(detectFeatures(stations), [], '3 m is inside the DEM’s own error');
  const lowered = detectFeatures(stations, { minReliefM: 2 });
  assert.deepEqual(lowered.map((f) => f.kind), ['ridge']);
  assert.equal(lowered[0].reliefM, 3);
});

test('a cliff has to be both steep and tall', () => {
  const gentle = line([400, 380], { spacingM: 100 });   // 20 m over 100 m: 11°
  assert.deepEqual(detectFeatures(gentle), [], 'tall enough, nowhere near steep enough');

  const small = line([400, 390], { spacingM: 10 });     // 10 m over 10 m: 45°
  assert.deepEqual(detectFeatures(small), [], 'steep enough, but a 10 m step is a bank');

  const real = line([400, 380], { spacingM: 20 });      // 20 m over 20 m: 45°
  assert.deepEqual(detectFeatures(real).map((f) => f.kind), ['cliff']);
});

test('the thresholds and the kinds are a stated contract', () => {
  assert.deepEqual(DEFAULT_FEATURE_THRESHOLDS,
    { minReliefM: 5, cliffMinSlopeDeg: 35, cliffMinDropM: 15 });
  assert.deepEqual(TERRAIN_FEATURE_KINDS.slice(), ['ridge', 'valley', 'saddle', 'pass', 'cliff']);
  assert.ok(Object.isFrozen(DEFAULT_FEATURE_THRESHOLDS));
});

test('features come back frozen and in along-track order', () => {
  // Two ridges and the valley between them, so order is observable.
  const stations = line([200, 260, 200, 140, 200, 260, 200]);
  const found = detectFeatures(stations);
  assert.deepEqual(found.map((f) => f.kind), ['ridge', 'valley', 'ridge']);
  assert.deepEqual(found.map((f) => f.sampleId), ['seg_1:1', 'seg_1:3', 'seg_1:5']);
  const distances = found.map((f) => f.distanceKm);
  assert.deepEqual(distances.slice().sort((a, b) => a - b), distances);
  assert.ok(found.every((f) => Object.isFrozen(f)));
});
