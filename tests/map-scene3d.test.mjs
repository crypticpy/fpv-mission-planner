import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DRAPE_LIFT_M,
  SCENE_ZOOM_OFFSET,
  boundsOf,
  buildRouteGeometry,
  parseCssRgb,
  ringPositions,
  toFlatZoom,
  toSceneZoom,
} from '../src/presentation/map/scene3d/scene-geometry.js';

/* The arithmetic behind the 3D scene, tested where it can be: without a GPU.
 *
 * Two of these are the reason the file exists. The zoom conversion is the
 * handover between two engines that count zoom levels differently, and getting
 * it wrong lands the pilot at twice or half the scale they left — with no error
 * anywhere. The altitude resolution decides whether a leg is drawn as a
 * confirmed height or as an admission that nobody knows; drawing an unresolved
 * leg at a plausible-looking altitude is the one failure in this whole feature
 * that could put an aircraft into a hill. */

/* ---------- the zoom handover ---------- */

test('the two engines are exactly one zoom level apart', () => {
  // Leaflet's world is 256 * 2^z pixels across; MapLibre's camera is defined on
  // 512 px tiles whatever the raster sources use. Same picture, one level apart.
  assert.equal(SCENE_ZOOM_OFFSET, 1);
  assert.equal(toSceneZoom(14), 13);
  assert.equal(toFlatZoom(13), 14);
});

test('a round trip through the other engine lands where it left', () => {
  for (const z of [3, 9.5, 12, 18, 21]) {
    assert.equal(toFlatZoom(toSceneZoom(z)), z);
    assert.equal(toSceneZoom(toFlatZoom(z)), z);
  }
});

/* ---------- the altitude of a vertex ---------- */

/** Flat ground at 100 m, as MapLibre would report it: already exaggerated. */
const flatGround = (exaggeration = 1) => () => 100 * exaggeration;

/** Nothing sampled yet — every tile still loading. */
const noGround = () => null;

/** @param {number} n */
const waypoints = (n) => Array.from({ length: n }, (_, i) => ({ id: `w${i}`, lat: 0, lng: i + 1 }));

/** The integrator's own point list for a direct out-and-back over `n` waypoints. */
const points = (n) => [
  { lat: 0, lng: 0 },
  ...Array.from({ length: n }, (_, i) => ({ lat: 0, lng: i + 1 })),
];

test('a resolved leg is drawn at its own altitude, scaled with the terrain', () => {
  const geometry = buildRouteGeometry({
    points: points(2),
    waypointCount: 2,
    returnMode: 'direct',
    worstIndex: null,
    waypoints: waypoints(2),
  }, {
    segments: {
      s0: { index: 0, altitudeMslM: 250 },
      s1: { index: 1, altitudeMslM: 300 },
    },
    exaggeration: 2,
    groundZAt: flatGround(2),
    launchElevMslM: 100,
  });

  // MapLibre multiplies the mesh about sea level and reports the exaggerated
  // height back, so an altitude drawn at its true MSL would sink into the hills.
  assert.deepEqual(geometry.vertices[1].position, [1, 0, 500]);
  assert.deepEqual(geometry.vertices[2].position, [2, 0, 600]);
  assert.ok(geometry.vertices.every((v) => v.resolved));
  assert.ok(geometry.runs.every((r) => r.resolved));
});

test('an unresolved leg is drawn on the ground and says so', () => {
  const geometry = buildRouteGeometry({
    points: points(2),
    waypointCount: 2,
    returnMode: 'direct',
    worstIndex: null,
    waypoints: waypoints(2),
  }, {
    // The second segment never resolved — no terrain under it, or no altitude set.
    segments: { s0: { index: 0, altitudeMslM: 250 } },
    exaggeration: 1,
    groundZAt: flatGround(),
    launchElevMslM: 100,
  });

  assert.equal(geometry.vertices[1].resolved, true);
  assert.equal(geometry.vertices[2].resolved, false);
  assert.deepEqual(geometry.vertices[2].position, [2, 0, 100 + DRAPE_LIFT_M]);

  // A segment is only as trustworthy as its worse end: the leg into the unknown
  // waypoint must not be drawn as a confirmed altitude either.
  const unknown = geometry.vertices[2].position;
  const touching = geometry.runs.filter((r) => r.path.some((p) => p === unknown));
  assert.equal(touching.length, 2, 'the leg in and the leg home both touch it');
  assert.ok(touching.every((r) => !r.resolved),
    'every run touching an unresolved vertex is flagged unresolved');
  // …and the leg that does not touch it keeps its altitude.
  assert.ok(geometry.runs.some((r) => r.resolved));
});

test('a null altitude never becomes sea level', () => {
  const geometry = buildRouteGeometry({
    points: points(1),
    waypointCount: 1,
    returnMode: 'direct',
    worstIndex: null,
    waypoints: waypoints(1),
  }, {
    segments: { s0: { index: 0, altitudeMslM: null } },
    exaggeration: 1,
    groundZAt: flatGround(),
    launchElevMslM: 100,
  });
  // Not 0: the ground under it is 100 m and that is where "unknown" is drawn.
  assert.equal(geometry.vertices[1].position[2], 100 + DRAPE_LIFT_M);
  assert.equal(geometry.vertices[1].resolved, false);
});

test('with no terrain sampled yet the launch pad is honest about it', () => {
  const geometry = buildRouteGeometry({
    points: points(1),
    waypointCount: 1,
    returnMode: 'direct',
    worstIndex: null,
    waypoints: waypoints(1),
  }, {
    segments: { s0: { index: 0, altitudeMslM: 200 } },
    exaggeration: 1,
    groundZAt: noGround,
    // The elevation the whole plan was solved at stands in until a DEM tile lands.
    launchElevMslM: 120,
  });
  assert.deepEqual(geometry.vertices[0].position, [0, 0, 120 + DRAPE_LIFT_M]);
  assert.equal(geometry.vertices[0].resolved, true);
});

test('a retrace reuses the outbound altitude and the outbound pin', () => {
  // Two authored waypoints become [w0, w1, w0] on the way to the integrator.
  const geometry = buildRouteGeometry({
    points: [...points(2), { lat: 0, lng: 1 }],
    waypointCount: 2,
    returnMode: 'retrace',
    // The integrator was handed [w0, w1, w0]; index 2 is the second pass over w0.
    worstIndex: 2,
    waypoints: waypoints(2),
  }, {
    segments: {
      s0: { index: 0, altitudeMslM: 250 },
      s1: { index: 1, altitudeMslM: 300 },
    },
    exaggeration: 1,
    groundZAt: flatGround(),
    launchElevMslM: 100,
  });

  // The second pass over w0 is flown at w0's altitude, not dropped to the ground.
  assert.deepEqual(geometry.vertices[3].position, [1, 0, 250]);
  assert.equal(geometry.pins.length, 2, 'one pin per authored waypoint, never per pass');
  // worstIndex 3 is the return pass over w0, and the pin that lights up is w0's.
  assert.deepEqual(geometry.pins.map((p) => p.worst), [true, false]);
});

test('the split is the same one the 2D layer draws', () => {
  const geometry = buildRouteGeometry({
    points: points(3),
    waypointCount: 3,
    returnMode: 'direct',
    worstIndex: null,
    waypoints: waypoints(3),
  }, {
    segments: {
      s0: { index: 0, altitudeMslM: 200 },
      s1: { index: 1, altitudeMslM: 200 },
      s2: { index: 2, altitudeMslM: 200 },
    },
    exaggeration: 1,
    groundZAt: flatGround(),
    launchElevMslM: 100,
  });
  const out = geometry.runs.filter((r) => r.phase === 'out');
  const home = geometry.runs.filter((r) => r.phase === 'home');
  assert.equal(out.length, 1);
  assert.equal(out[0].path.length, 4, 'launch plus three waypoints');
  assert.equal(home.length, 1);
  assert.equal(home[0].path.length, 2, 'a direct return is one hop');
});

test('an empty or degenerate route draws nothing rather than guessing', () => {
  const nothing = { segments: {}, exaggeration: 1, groundZAt: flatGround(), launchElevMslM: 0 };
  for (const input of [
    { points: [], waypointCount: 0, returnMode: 'direct', worstIndex: null, waypoints: [] },
    { points: points(1), waypointCount: 0, returnMode: 'direct', worstIndex: null, waypoints: [] },
  ]) {
    const geometry = buildRouteGeometry(input, nothing);
    assert.deepEqual(geometry.runs, []);
    assert.deepEqual(geometry.legs, []);
    assert.deepEqual(geometry.pins, []);
    assert.equal(geometry.count, 0);
  }
});

/* ---------- the leg a pick comes back with ---------- */

test('every hop is its own datum, and each one knows which segment it is', () => {
  // The runs above are merged so a stretch of confirmed altitude draws as one
  // unbroken line; the legs are the same geometry unmerged, because deck.gl
  // hands a pick back the *datum* under the cursor and a run of three legs
  // cannot name which one was clicked.
  const geometry = buildRouteGeometry({
    points: points(3),
    waypointCount: 3,
    returnMode: 'direct',
    worstIndex: null,
    waypoints: waypoints(3),
  }, {
    segments: {
      s0: { index: 0, altitudeMslM: 200 },
      s1: { index: 1, altitudeMslM: 200 },
      s2: { index: 2, altitudeMslM: 200 },
    },
    exaggeration: 1,
    groundZAt: flatGround(),
    launchElevMslM: 100,
  });

  assert.equal(geometry.runs.length, 2, 'the drawn line is still merged');
  assert.deepEqual(geometry.legs.map((l) => l.segmentId), ['s0', 's1', 's2', null]);
  assert.ok(geometry.legs.every((l) => l.kind === 'leg' && l.path.length === 2));
  // The hop home under a direct return is flown and drawn but never authored:
  // it is in the array so the line has no gap, and carries no id so a click on
  // it opens nothing.
  assert.deepEqual(geometry.legs.map((l) => l.phase), ['out', 'out', 'out', 'home']);
  assert.deepEqual(geometry.legs[3].path, [geometry.vertices[3].position, geometry.vertices[0].position]);
});

test('a leg is only as resolved as its worse end', () => {
  const geometry = buildRouteGeometry({
    points: points(2),
    waypointCount: 2,
    returnMode: 'direct',
    worstIndex: null,
    waypoints: waypoints(2),
  }, {
    // The second segment never resolved, so both legs touching w1 are unknown.
    segments: { s0: { index: 0, altitudeMslM: 250 } },
    exaggeration: 1,
    groundZAt: flatGround(),
    launchElevMslM: 100,
  });
  assert.deepEqual(geometry.legs.map((l) => l.resolved), [true, false, false]);
});

/* ---------- rings and extents ---------- */

test('a ring closes itself and hugs the terrain', () => {
  const ring = ringPositions(
    { lat: 30, lng: -97 },
    [0, 90, 180, 270],
    [1, 1, 1, 1],
    () => 400,
  );
  assert.equal(ring.length, 5, 'four points and the closing repeat');
  assert.deepEqual(ring[0], ring[4]);
  assert.ok(ring.every(([, , z]) => z === 400 + DRAPE_LIFT_M));
});

test('a collapsed sector pinches against the launch point instead of closing across it', () => {
  const from = { lat: 30, lng: -97 };
  const ring = ringPositions(from, [0, 90, 180, 270], [1, 0, 0, 1], () => 0);
  // The two zero radii are the same point, so only one of them is kept — but the
  // collapse is still drawn, because a footprint that has partly collapsed is a
  // specific answer rather than a gap.
  const atLaunch = ring.filter(([lng, lat]) => lng === from.lng && lat === from.lat);
  assert.equal(atLaunch.length, 1);
});

test('bounds cover every finite point, and nothing else', () => {
  assert.equal(boundsOf([]), null);
  assert.equal(boundsOf([{ lat: NaN, lng: 0 }]), null);
  assert.deepEqual(
    boundsOf([{ lat: 1, lng: 2 }, { lat: -3, lng: 8 }, { lat: 0, lng: 0 }]),
    { southWest: { lat: -3, lng: 0 }, northEast: { lat: 1, lng: 8 } },
  );
});

/* ---------- the theme, as numbers ---------- */

test('the theme’s colours survive the trip into deck.gl', () => {
  const fallback = /** @type {[number, number, number]} */ ([1, 2, 3]);
  assert.deepEqual(parseCssRgb('#ff784f', fallback), [255, 120, 79]);
  assert.deepEqual(parseCssRgb('  #FF784F ', fallback), [255, 120, 79]);
  assert.deepEqual(parseCssRgb('#f84', fallback), [255, 136, 68]);
  assert.deepEqual(parseCssRgb('rgb(255, 120, 79)', fallback), [255, 120, 79]);
  assert.deepEqual(parseCssRgb('rgba(255, 120, 79, 0.5)', fallback), [255, 120, 79]);
});

test('an unreadable colour falls back rather than guessing', () => {
  const fallback = /** @type {[number, number, number]} */ ([1, 2, 3]);
  // A route drawn in a mis-parsed colour is a route drawn in the wrong verdict.
  for (const bad of ['', null, undefined, 'var(--series-2)', 'tomato', '#12345', 'rgb(1,2)']) {
    assert.deepEqual(parseCssRgb(bad, fallback), fallback, `${bad}`);
  }
});
