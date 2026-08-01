import test from 'node:test';
import assert from 'node:assert/strict';

import { profileModelFrom } from '../src/components/elevation-profile.js';

/* The elevation profile, minus its DOM (M10 wave C).
 *
 * The silhouette is SVG paths and is checked in the browser. What is worth
 * asserting here is what the model *claims*: which field it will trust, where
 * a segment's stretch of the x axis begins and ends, and what happens where
 * the data has holes. The tests lean on the second kind of failure the segment
 * inspector's tests name — showing an absence as a fact. A missing sample must
 * come out as a hole, a stale field as "pending", an empty one as "no data";
 * flat ground invented over any of them is how a chart puts a plan into a
 * hill. */

const seg = (id, index, over = {}) => ({
  segmentId: id, index, intent: 'transit', distanceKm: 1, groundSpeedMs: 13,
  timeMin: 1.5, flightWh: 10, holdWh: 0, energyWh: 10, holdS: 0,
  altitudeMslM: 140, vertical: null, clearance: null, ...over,
});

const station = (id, distanceKm, segmentId, groundMslM, over = {}) => ({
  id, stationId: id, track: 'centre', lat: 0, lng: 0, distanceKm, bearingDeg: 0,
  segmentId, groundMslM, slopeDeg: null, aspectDeg: null, gradientBasis: null,
  source: groundMslM == null ? 'missing' : 'provider', ...over,
});

function fieldOf(samples, over = {}) {
  return {
    missionId: 'm1', revision: 'r1', samples,
    byId: Object.fromEntries(samples.map((s) => [s.id, s])),
    features: [], launchGroundMslM: 100,
    provenance: {
      source: 'test', dataset: null, resolutionM: 30, attribution: '© Test DEM',
      retrievedAt: null, spacingM: 500, corridorWidthM: 0,
      requested: samples.length, cacheHits: 0, fetched: samples.length,
      missing: 0, coverage: 'complete', notes: [],
    },
    ...over,
  };
}

const SAMPLES = [
  station('seg_a:0', 0, 'seg_a', 100),
  station('seg_a:1', 0.5, 'seg_a', 110),
  station('seg_a:2', 1.0, 'seg_a', 118),
  station('seg_b:1', 1.5, 'seg_b', 126),
  station('seg_b:2', 2.0, 'seg_b', 121),
];

/** The request those stations answer — corridor samples wear latitude/longitude. */
const CORRIDOR_SAMPLES = SAMPLES.map((s) => ({
  id: s.id, latitude: s.lat, longitude: s.lng,
  distanceKm: s.distanceKm, bearingDeg: s.bearingDeg, segmentId: s.segmentId,
}));

const snapshot = (over = {}) => ({
  corridor: { missionId: 'm1', revision: 'r1', samples: CORRIDOR_SAMPLES, spacingM: 500, corridorWidthM: 0 },
  segments: {
    seg_a: seg('seg_a', 0, { altitudeMslM: 140 }),
    seg_b: seg('seg_b', 1, { altitudeMslM: 160 }),
  },
  ...over,
});

test('no authored route is "no-route", whatever the field says', () => {
  const m = profileModelFrom(snapshot({ segments: {} }), fieldOf(SAMPLES));
  assert.equal(m.state, 'no-route');
});

test('a field that does not answer these points is "pending" — never stale ground', () => {
  assert.equal(profileModelFrom(snapshot(), null).state, 'pending');
  const otherMission = fieldOf(SAMPLES, { missionId: 'm2' });
  assert.equal(profileModelFrom(snapshot(), otherMission).state, 'pending');
  // Ids are positional, so a moved launch re-uses them over different ground —
  // the gate is the coordinates, per usableField.
  const moved = fieldOf(SAMPLES.map((s) => ({ ...s, lat: s.lat + 0.001 })));
  assert.equal(profileModelFrom(snapshot(), moved).state, 'pending');
  // But the revision alone moving — a rename, a weather refresh — keeps the
  // ground: same mission, same points, same profile.
  const renamed = fieldOf(SAMPLES, { revision: 'r0' });
  assert.equal(profileModelFrom(snapshot(), renamed).state, 'ready');
});

test('a field nobody answered is "unavailable", not a flat profile', () => {
  const empty = fieldOf(SAMPLES.map((s) => station(s.id, s.distanceKm, s.segmentId, null)));
  empty.provenance.coverage = 'empty';
  assert.equal(profileModelFrom(snapshot(), empty).state, 'unavailable');
});

test('ready: centreline only, spans butted in authored order, planned from launch', () => {
  const withLateral = [...SAMPLES, {
    ...station('seg_a:1~L', 0.5, 'seg_a', 300), stationId: 'seg_a:1', track: 'left',
  }];
  const m = profileModelFrom(snapshot(), fieldOf(withLateral));
  assert.equal(m.state, 'ready');
  // The lateral sample is evidence about a station, not a station: 5 points, not 6.
  assert.equal(m.ground.length, 5);
  assert.equal(m.totalKm, 2);
  assert.deepEqual(m.spans, [
    { segmentId: 'seg_a', x0: 0, x1: 1.0 },
    { segmentId: 'seg_b', x0: 1.0, x1: 2.0 },
  ]);
  // Launch at its own ground, then one point per waypoint at the planned MSL.
  assert.deepEqual(m.planned.map((p) => [p.x, p.y]), [[0, 100], [1.0, 140], [2.0, 160]]);
  assert.equal(m.holes, null);
  assert.equal(m.attribution, '© Test DEM');
});

test('a missing sample is a hole in the ground line, and counted out loud', () => {
  const samples = SAMPLES.map((s) => (s.id === 'seg_b:1'
    ? station(s.id, s.distanceKm, s.segmentId, null)
    : s));
  const field = fieldOf(samples);
  field.provenance.coverage = 'partial';
  field.provenance.missing = 1;
  const m = profileModelFrom(snapshot(), field);
  assert.equal(m.state, 'ready');
  assert.equal(m.ground[3].y, null);
  assert.deepEqual(m.holes, { missing: 1, total: 5 });
});

test('a segment with no planned altitude leaves a gap, not an invented height', () => {
  const s = snapshot();
  s.segments.seg_a = seg('seg_a', 0, { altitudeMslM: null });
  const m = profileModelFrom(s, fieldOf(SAMPLES));
  assert.equal(m.planned[1].y, null);
  assert.equal(m.planned[2].y, 160);
});

test('the badge is the worst clearance the analysis measured, at its own station', () => {
  const s = snapshot();
  s.segments.seg_a = seg('seg_a', 0, {
    clearance: { minM: 80, atSampleId: 'seg_a:1', checked: 3, missing: 0 },
  });
  s.segments.seg_b = seg('seg_b', 1, {
    clearance: { minM: 25, atSampleId: 'seg_b:1', checked: 2, missing: 0 },
  });
  const m = profileModelFrom(s, fieldOf(SAMPLES));
  assert.equal(m.worst.minM, 25);
  assert.equal(m.worst.x, 1.5);
  assert.equal(m.worst.tone, 'serious'); // under the 30 m warning line
  assert.equal(m.worst.groundMslM, 126);
});

test('clearance tones: into the ground is critical, above the line is good', () => {
  const at = (minM) => {
    const s = snapshot();
    s.segments.seg_b = seg('seg_b', 1, {
      clearance: { minM, atSampleId: 'seg_b:2', checked: 2, missing: 0 },
    });
    return profileModelFrom(s, fieldOf(SAMPLES)).worst;
  };
  assert.equal(at(-5).tone, 'critical');
  assert.equal(at(0).tone, 'critical');
  assert.equal(at(30).tone, 'good');
  // A clearance measured at a station nobody answered has nowhere to stand.
  const s = snapshot();
  s.segments.seg_b = seg('seg_b', 1, {
    clearance: { minM: 10, atSampleId: 'nowhere', checked: 1, missing: 4 },
  });
  assert.equal(profileModelFrom(s, fieldOf(SAMPLES)).worst, null);
});
