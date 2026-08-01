import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DRAPE_LIFT_M,
  GEOGRAPHIC_SPACE,
  SCENE_ZOOM_OFFSET,
  boundsInSpace,
  boundsOf,
  buildRouteGeometry,
  buildShotGeometry,
  cartesianSpace,
  fromSpaceXY,
  orthoExtentM,
  parseCssRgb,
  ringPositions,
  toFlatZoom,
  toOrthoZoom,
  toSceneZoom,
  toSpaceXY,
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

/* ---------- the shot geometry (M7 wave D) ---------- */

/* Two failures are what these guard.
 *
 * A subject nobody measured drawn as though somebody had — the same class of
 * mistake as an unresolved leg drawn at a plausible altitude, and the reason
 * `resolved` travels beside every position in this file.
 *
 * And the scene quietly disagreeing with the inspector about one shot. Every
 * number below comes off the segment's `shot` record; if this file ever starts
 * deriving a range or an angle of its own, one of these stops matching the
 * arithmetic it was hand-derived from. */

/** A leg of the drawn line, in the shape buildRouteGeometry hands over. */
const leg = (over = {}) => ({
  kind: 'leg',
  segmentId: 'seg-0',
  path: [[0, 0, 100], [0.002, 0, 100]],
  resolved: true,
  phase: 'out',
  ...over,
});

/** A shot record with every field populated; each test spoils the one it is about. */
const shotOf = (over = {}) => ({
  subjectId: 'sub-1',
  subjectName: 'The barn',
  distanceStartM: 90,
  distanceEndM: 110,
  bearingToSubjectDeg: 0,
  elevationAngleDeg: 0,
  screenDirection: 'left-to-right',
  framingStart: 0.2,
  framingEnd: 0.3,
  subjectRadiusM: 12,
  fov: { hDeg: 90, vDeg: 90 },
  ...over,
});

const subject = (over = {}) => ({
  id: 'sub-1', name: 'The barn', lat: 0.001, lng: 0.001,
  elevationMslM: 220, radiusM: 12, ...over,
});

/* Trigonometry through a geodesic and back does not land on round numbers; a
 * metre-scale tolerance is far tighter than anything these assertions are about. */
const near = (a, b) => Math.abs(a - b) < 1e-6;

test('a measured subject stands at its own height and an unmeasured one on the ground', () => {
  const g = buildShotGeometry({
    legs: [],
    subjects: [subject(), subject({ id: 'sub-2', name: 'The mast', elevationMslM: null })],
    selectedSegmentId: null,
  }, { segments: {}, exaggeration: 2, groundZAt: flatGround(2) });

  // The same rule the route vertices follow: MSL times the exaggeration, because
  // MapLibre scales the mesh about sea level and reports it back already scaled.
  assert.deepEqual(g.subjects[0].position, [0.001, 0.001, 440]);
  assert.equal(g.subjects[0].resolved, true);

  // 100 m of ground at 2× is 200, plus the lift that keeps it off the mesh.
  assert.deepEqual(g.subjects[1].position, [0.001, 0.001, 200 + DRAPE_LIFT_M]);
  assert.equal(g.subjects[1].resolved, false,
    'nobody measured this one — it must not read as a height');
});

test('the subject the open segment frames is the one lit up', () => {
  const g = buildShotGeometry({
    legs: [],
    subjects: [subject(), subject({ id: 'sub-2', name: 'The mast' })],
    selectedSegmentId: 'seg-0',
  }, {
    segments: { 'seg-0': { shot: shotOf() } },
    exaggeration: 1,
    groundZAt: flatGround(),
  });
  assert.deepEqual(g.subjects.map((s) => s.framed), [true, false]);
});

test('a shot line leaves the middle of the leg it belongs to', () => {
  const g = buildShotGeometry({
    legs: [leg()],
    subjects: [subject()],
    selectedSegmentId: null,
  }, {
    segments: { 'seg-0': { shot: shotOf() } },
    exaggeration: 1,
    groundZAt: flatGround(),
  });

  assert.equal(g.shots.length, 1);
  assert.deepEqual(g.shots[0].path[0], [0.001, 0, 100], 'halfway along the drawn leg');
  assert.deepEqual(g.shots[0].path[1], g.subjects[0].position);
  assert.equal(g.shots[0].subjectId, 'sub-1');
  assert.equal(g.shots[0].selected, false);
});

test('a shot is as resolved as its worse end', () => {
  const both = (legOver, subjectOver) => buildShotGeometry({
    legs: [leg(legOver)],
    subjects: [subject(subjectOver)],
    selectedSegmentId: null,
  }, {
    segments: { 'seg-0': { shot: shotOf() } },
    exaggeration: 1,
    groundZAt: flatGround(),
  }).shots[0].resolved;

  assert.equal(both({}, {}), true);
  assert.equal(both({ resolved: false }, {}), false, 'the leg end is a guess');
  assert.equal(both({}, { elevationMslM: null }), false, 'the subject end is a guess');
});

test('the flight home does not draw the outbound shot a second time', () => {
  // Under a retrace the way back carries the authored segment ids again, so a
  // builder that took every leg would hang two lines off one shot.
  const g = buildShotGeometry({
    legs: [leg(), leg({ phase: 'home', path: [[0.002, 0, 100], [0, 0, 100]] })],
    subjects: [subject()],
    selectedSegmentId: null,
  }, {
    segments: { 'seg-0': { shot: shotOf() } },
    exaggeration: 1,
    groundZAt: flatGround(),
  });
  assert.equal(g.shots.length, 1);
});

test('a segment with nothing to film, and a shot whose subject is gone, draw nothing', () => {
  const nothing = (input, segments) => buildShotGeometry({
    subjects: [subject()], selectedSegmentId: null, ...input,
  }, { segments, exaggeration: 1, groundZAt: flatGround() });

  assert.deepEqual(nothing({ legs: [leg()] }, { 'seg-0': { shot: null } }).shots, []);
  assert.deepEqual(nothing({ legs: [leg()] }, {}).shots, []);
  assert.deepEqual(nothing({ legs: [leg({ segmentId: null })] }, {}).shots, []);
  assert.deepEqual(
    nothing({ legs: [leg()] }, { 'seg-0': { shot: shotOf({ subjectId: 'sub-9' }) } }).shots, [],
    'no marker to draw the line to');
});

/* ---------- the view pyramid ---------- */

test('the frustum is the open segment’s alone', () => {
  const build = (selectedSegmentId) => buildShotGeometry({
    legs: [leg(), leg({ segmentId: 'seg-1', path: [[0.002, 0, 100], [0.004, 0, 100]] })],
    subjects: [subject()],
    selectedSegmentId,
  }, {
    segments: { 'seg-0': { shot: shotOf() }, 'seg-1': { shot: shotOf() } },
    exaggeration: 1,
    groundZAt: flatGround(),
  });

  assert.equal(build(null).frustum, null, 'nothing open, nothing to outline');
  assert.equal(build('seg-0').frustum.segmentId, 'seg-0');
  assert.equal(build('seg-1').frustum.segmentId, 'seg-1');
});

test('the frame’s corners are the domain’s own, placed on the globe', () => {
  // Hand-derived. Apex is the leg midpoint at [0.001, 0, 100]; the record says
  // the subject bears due north at 90 m and 110 m from the two ends, so the mean
  // range is 100 m, and a 90° field of view puts tan(45°) × 100 = 100 m of half
  // width and half height on the frame at that range.
  const g = buildShotGeometry({
    legs: [leg()],
    subjects: [subject()],
    selectedSegmentId: 'seg-0',
  }, {
    segments: { 'seg-0': { shot: shotOf(), camera: null } },
    exaggeration: 2,
    groundZAt: flatGround(2),
  });
  const f = g.frustum;

  assert.deepEqual(f.apex, [0.001, 0, 100]);
  assert.equal(f.outline.length, 5, 'four corners and the closing vertex');
  assert.deepEqual(f.outline[4], f.outline[0]);
  assert.equal(f.edges.length, 4);
  for (let i = 0; i < 4; i++) assert.deepEqual(f.edges[i], [f.apex, f.outline[i]]);

  // 100 m above and below the apex, and the vertical offset picks up the same
  // exaggeration the apex's own Z already carries.
  const [tl, tr, br, bl] = f.outline;
  assert.ok(near(tl[2], 300) && near(tr[2], 300), 'the top pair, 200 scaled metres up');
  assert.ok(near(br[2], -100) && near(bl[2], -100), 'the bottom pair, the same below');

  // Ordered top-left, top-right, bottom-right, bottom-left as seen from behind a
  // camera looking north: left is west of the apex, right is east of it, and all
  // four are north of it. The horizontal spread is metres and does not scale.
  assert.ok(tl[0] < 0.001 && bl[0] < 0.001, 'the left pair is west');
  assert.ok(tr[0] > 0.001 && br[0] > 0.001, 'the right pair is east');
  assert.ok(f.outline.slice(0, 4).every((p) => p[1] > 0), 'the frame is out in front');
  assert.ok(Math.abs((0.001 - tl[0]) - (tr[0] - 0.001)) < 1e-9, 'symmetric about the axis');
});

test('the authored camera swings the frame rather than being quietly ignored', () => {
  const build = (camera) => buildShotGeometry({
    legs: [leg()], subjects: [subject()], selectedSegmentId: 'seg-0',
  }, {
    segments: { 'seg-0': { shot: shotOf(), camera } },
    exaggeration: 1,
    groundZAt: flatGround(),
  }).frustum;

  // A 90° yaw offset on a due-north shot points the frame due east: every corner
  // moves east of the apex, and the frame straddles the new axis rather than the
  // old one — left of an east-facing camera is north, right of it is south.
  const swung = build({ pitchDeg: null, yawOffsetDeg: 90, orbit: null });
  const corners = swung.outline.slice(0, 4);
  assert.ok(corners.every((p) => p[0] > 0.001), 'east of the apex');
  assert.ok(near(corners.reduce((s, p) => s + p[1], 0) / 4, 0), 'centred on the new axis');
  assert.ok(corners[0][1] > 0 && corners[1][1] < 0, 'left is north, right is south');

  // An authored pitch overrides the elevation angle the geometry would look down.
  const level = build(null);
  const down = build({ pitchDeg: -30, yawOffsetDeg: null, orbit: null });
  assert.ok(down.outline[0][2] < level.outline[0][2], 'the whole frame tips down');
});

test('a frame the record cannot support is left undrawn rather than invented', () => {
  const build = (shotOver) => buildShotGeometry({
    legs: [leg()], subjects: [subject()], selectedSegmentId: 'seg-0',
  }, {
    segments: { 'seg-0': { shot: shotOf(shotOver) } },
    exaggeration: 1,
    groundZAt: flatGround(),
  }).frustum;

  assert.equal(build({ fov: null }), null, 'no camera profile, no field of view');
  assert.equal(build({ bearingToSubjectDeg: null }), null, 'the leg passes over the subject');
  assert.equal(build({ elevationAngleDeg: null }), null);
  assert.equal(build({ distanceStartM: null, distanceEndM: null }), null);
  // One end is enough to say how far the frame reaches.
  assert.ok(build({ distanceStartM: null }) !== null);
  // And the shot line is still drawn — losing the pyramid is not losing the shot.
  assert.equal(buildShotGeometry({
    legs: [leg()], subjects: [subject()], selectedSegmentId: 'seg-0',
  }, {
    segments: { 'seg-0': { shot: shotOf({ fov: null }) } },
    exaggeration: 1,
    groundZAt: flatGround(),
  }).shots.length, 1);
});

test('an empty scene is empty rather than absent', () => {
  const g = buildShotGeometry({ legs: [], subjects: [], selectedSegmentId: null },
    { segments: {}, exaggeration: 1, groundZAt: flatGround() });
  assert.deepEqual(g, { subjects: [], shots: [], frustum: null });
});

/* ---------- the frame the positions come out in (M12 wave B) ---------- */

/* The builders learned a second coordinate space for the standalone
 * orthographic view, whose viewport is not geospatial and reads plain metres.
 * Everything above this line is the first space, and the first thing to prove is
 * that it did not move: the test below was written and run against the source
 * before the parameter existed, and it is a whole geometry rather than a spot
 * check because "the MapLibre scene is unchanged" is the claim being made. */

test('with no space named, a geometry is the lng/lat one it has always been', () => {
  const geometry = buildRouteGeometry({
    points: points(2),
    waypointCount: 2,
    returnMode: 'direct',
    worstIndex: 1,
    waypoints: waypoints(2),
  }, {
    // Only the first leg resolved, so both the altitude branch and the
    // ground-draped one are in the answer.
    segments: { s0: { index: 0, altitudeMslM: 250 } },
    exaggeration: 1,
    groundZAt: flatGround(),
    launchElevMslM: 100,
  });

  // Longitude, latitude, metres up — and the two metres of drape lift on every
  // vertex that came off the ground rather than off a solved altitude.
  const launch = [0, 0, 100 + DRAPE_LIFT_M];
  const w0 = [1, 0, 250];
  const w1 = [2, 0, 100 + DRAPE_LIFT_M];

  assert.deepEqual(geometry, {
    vertices: [
      { position: launch, resolved: true },
      { position: w0, resolved: true },
      { position: w1, resolved: false },
    ],
    runs: [
      { resolved: true, phase: 'out', path: [launch, w0] },
      { resolved: false, phase: 'out', path: [w0, w1] },
      { resolved: false, phase: 'home', path: [w1, launch] },
    ],
    legs: [
      { kind: 'leg', segmentId: 's0', path: [launch, w0], resolved: true, phase: 'out' },
      { kind: 'leg', segmentId: null, path: [w0, w1], resolved: false, phase: 'out' },
      { kind: 'leg', segmentId: null, path: [w1, launch], resolved: false, phase: 'home' },
    ],
    pins: [
      { kind: 'waypoint', id: 'w0', index: 0, position: w0, resolved: true, worst: false, label: '1' },
      { kind: 'waypoint', id: 'w1', index: 1, position: w1, resolved: false, worst: true, label: '2' },
    ],
    count: 2,
  });
});

/* Metres per degree of latitude, restated from the sphere rather than read off
 * the module: a projection checked against its own constant checks nothing. */
const M_PER_DEG = (6371000 * Math.PI) / 180;

/** Within a millimetre — floating point, not approximation, is the tolerance. */
const closeTo = (a, b, tol = 1e-3) => Math.abs(a - b) < tol;

test('a local frame is metres east and north of the launch point', () => {
  const space = cartesianSpace({ lat: 30, lng: -97 });

  // A degree of latitude is the same length everywhere on a sphere.
  const [, north] = toSpaceXY(space, -97, 31);
  assert.ok(closeTo(north, M_PER_DEG), `${north} m north`);

  // A degree of longitude is that times the cosine of the latitude — 96.6 km at
  // 30° north, and getting this wrong stretches the whole scene east–west by
  // 15% with nothing on screen to say so.
  const [east] = toSpaceXY(space, -96, 30);
  assert.ok(closeTo(east, M_PER_DEG * Math.cos(Math.PI / 6)), `${east} m east`);

  // The origin is the frame's zero, exactly.
  assert.deepEqual(toSpaceXY(space, -97, 30), [0, 0]);
  // South and west are negative: this is ENU, not a distance.
  const [w, s] = toSpaceXY(space, -98, 29);
  assert.ok(w < 0 && s < 0);
});

test('a click comes back off the local frame as the place on earth it was', () => {
  const places = [
    { lat: 30.2672, lng: -97.7431 },
    { lat: 30.3, lng: -97.7 },
    { lat: 30.2, lng: -97.8 },
    { lat: 61.2181, lng: -149.9003 },
  ];
  for (const space of [GEOGRAPHIC_SPACE, cartesianSpace({ lat: 30.2672, lng: -97.7431 })]) {
    for (const p of places) {
      const [x, y] = toSpaceXY(space, p.lng, p.lat);
      const back = fromSpaceXY(space, x, y);
      assert.ok(closeTo(back.lat, p.lat, 1e-9) && closeTo(back.lng, p.lng, 1e-9),
        `${space.kind}: ${back.lat},${back.lng}`);
    }
  }
  // And the geographic frame is a pass-through rather than a projection at 1.0.
  assert.deepEqual(toSpaceXY(GEOGRAPHIC_SPACE, -97.7431, 30.2672), [-97.7431, 30.2672]);
});

test('a ring drawn at one kilometre is one kilometre across the local frame', () => {
  const from = { lat: 30, lng: -97 };
  const space = cartesianSpace(from);
  const ring = ringPositions(from, [0, 90, 180, 270], [1, 1, 1, 1], () => 400, space);

  assert.equal(ring.length, 5, 'four vertices and the closing repeat');
  for (const [x, y, z] of ring) {
    // The radius survives the round trip through `destination` and back out of
    // the projection — the reason the metres-per-degree constant is measured off
    // that same sphere rather than restated.
    assert.ok(closeTo(Math.hypot(x, y), 1000, 1), `${Math.hypot(x, y)} m from centre`);
    // Ground height, and nothing added to it: the two metres of drape lift are
    // MapLibre's z-fight, and there is no MapLibre here.
    assert.equal(z, 400);
  }
});

test('in the local frame a route is metres, and only a solved altitude is MSL', () => {
  const input = {
    points: points(2),
    waypointCount: 2,
    returnMode: 'direct',
    worstIndex: 1,
    waypoints: waypoints(2),
  };
  const opts = {
    segments: { s0: { index: 0, altitudeMslM: 250 } },
    exaggeration: 1,
    groundZAt: flatGround(),
    launchElevMslM: 100,
  };
  // The launch point is the origin, so the fixture's waypoints are one and two
  // degrees due east of it at the equator, where a degree of longitude is a
  // degree of latitude.
  const cartesian = buildRouteGeometry(input, { ...opts, space: cartesianSpace(points(2)[0]) });
  const [launch, w0, w1] = cartesian.vertices.map((v) => v.position);

  assert.ok(closeTo(w0[0], M_PER_DEG) && closeTo(w1[0], 2 * M_PER_DEG), 'east in metres');
  assert.deepEqual([launch[0], launch[1], w0[1], w1[1]], [0, 0, 0, 0], 'nothing off the axis');

  // Z is metres MSL in both frames, and the drape lift is the difference: the
  // resolved vertex is at its own altitude either way, and the two that came off
  // the terrain sit on it here and two metres over it under MapLibre.
  const geographic = buildRouteGeometry(input, opts).vertices.map((v) => v.position);
  assert.deepEqual([launch[2], w0[2], w1[2]], [100, 250, 100]);
  assert.deepEqual(geographic.map((p) => p[2]), [100 + DRAPE_LIFT_M, 250, 100 + DRAPE_LIFT_M]);

  // Everything that is not a position is the same answer in both frames.
  assert.deepEqual(cartesian.vertices.map((v) => v.resolved), [true, true, false]);
  assert.equal(cartesian.count, 2);
  assert.deepEqual(cartesian.pins.map((p) => p.label), ['1', '2']);
});

test('the frustum is the same pyramid in the local frame, without the geodesic', () => {
  const space = cartesianSpace({ lat: 0, lng: 0 });
  const build = (over) => buildShotGeometry({
    legs: [leg(over.leg ?? {})], subjects: [subject()], selectedSegmentId: 'seg-0',
  }, {
    segments: { 'seg-0': { shot: shotOf() } },
    exaggeration: 1,
    groundZAt: flatGround(),
    space: over.space,
  });

  const geographic = build({});
  // The same leg, handed over in the frame the caller is drawing in: the apex is
  // the midpoint of whatever path it was given.
  const local = build({ space, leg: { path: [[0, 0, 100], [0.002 * M_PER_DEG, 0, 100]] } });

  // A measured subject stands at its own height in metres east and north.
  assert.deepEqual(local.subjects[0].position.map((n) => Math.round(n * 1e3) / 1e3),
    [Math.round(0.001 * M_PER_DEG * 1e3) / 1e3, Math.round(0.001 * M_PER_DEG * 1e3) / 1e3, 220]);

  // And every corner of the frame lands where the geodesic put it, read in the
  // other frame's units — the flat offset is not a different pyramid.
  assert.equal(local.frustum.outline.length, geographic.frustum.outline.length);
  geographic.frustum.outline.forEach((want, i) => {
    const [x, y] = toSpaceXY(space, want[0], want[1]);
    const got = local.frustum.outline[i];
    assert.ok(closeTo(got[0], x, 0.01) && closeTo(got[1], y, 0.01), `corner ${i}: ${got}`);
    assert.equal(got[2], want[2], `corner ${i} height`);
  });
});

/* ---------- the third zoom numbering ---------- */

test('an orbit zoom is the scale that puts the mission across the viewport', () => {
  // 5 km of ground across 1250 px is 0.25 px per metre — log2(1/4) = −2. Not a
  // tile zoom, and a level away from being one is a factor of two in scale.
  assert.equal(toOrthoZoom(5000, 1250), -2);
  assert.equal(orthoExtentM(-2, 1250), 5000);
  // One metre per pixel is zoom 0, whatever the viewport.
  assert.equal(toOrthoZoom(800, 800), 0);

  for (const [m, px] of [[250, 1000], [5000, 1250], [1, 1], [37000, 640]]) {
    assert.ok(closeTo(orthoExtentM(toOrthoZoom(m, px), px), m, 1e-6), `${m} m over ${px} px`);
  }

  // Nothing to frame is no answer rather than a camera at infinity.
  for (const bad of [0, -1, NaN, Infinity]) {
    assert.equal(toOrthoZoom(bad, 1000), null);
    assert.equal(toOrthoZoom(1000, bad), null);
  }
  assert.equal(orthoExtentM(NaN, 1000), null);
  assert.equal(orthoExtentM(0, 0), null);
});

test('an extent in the local frame is what the orbit camera is framed on', () => {
  const from = { lat: 30, lng: -97 };
  const bounds = boundsOf([from, { lat: 30.01, lng: -96.99 }]);
  const extent = boundsInSpace(bounds, cartesianSpace(from));

  assert.deepEqual(extent.min, [0, 0], 'the origin is the south-west corner here');
  assert.ok(closeTo(extent.height, 0.01 * M_PER_DEG), `${extent.height} m tall`);
  assert.ok(closeTo(extent.width, 0.01 * M_PER_DEG * Math.cos(Math.PI / 6)));
  assert.deepEqual(extent.centre, [extent.width / 2, extent.height / 2]);

  // And in the geographic frame it is the same extent in degrees, so the one
  // `boundsOf` both hosts share does not have to change shape.
  const degrees = boundsInSpace(bounds, GEOGRAPHIC_SPACE);
  assert.deepEqual(degrees.min, [-97, 30]);
  assert.ok(closeTo(degrees.width, 0.01, 1e-9) && closeTo(degrees.height, 0.01, 1e-9));
});
