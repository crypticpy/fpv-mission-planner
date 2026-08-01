import test from 'node:test';
import assert from 'node:assert/strict';

import { COORDINATE_SYSTEM } from '@deck.gl/core';

import { cartesianSpace } from '../src/presentation/map/scene3d/scene-geometry.js';
import { buildSceneLayers } from '../src/presentation/map/scene3d/scene-layers.js';

/* The deck.gl layer array, asserted without a GPU.
 *
 * Constructing a deck layer is pure — it validates and merges props and touches
 * no device — so the one thing this file is for can be checked in node: which
 * props every layer carries, and which it does not.
 *
 * That second half is the point. The standalone orthographic view needs two
 * additions on every layer it draws (a Cartesian coordinate system, because its
 * viewport is not geospatial, and explicit depth state, because a standalone
 * Deck on WebGL inherits none). Both are wrong for the MapLibre host, which has
 * worked since M7 precisely because MapLibre configured depth and projected
 * lng/lat itself. Neither addition announces itself when it lands in the wrong
 * place: the picture stays plausible and the route is drawn through the
 * mountain. So the geographic assertions below are absence assertions, and they
 * were written and run against the source before the parameter existed. */

const LAUNCH = { lat: 30.2672, lng: -97.7431 };

/** Two waypoints, half a kilometre out and back. */
const WAYPOINTS = [
  { id: 'w0', lat: 30.2712, lng: -97.7431 },
  { id: 'w1', lat: 30.2712, lng: -97.7381 },
];

/** Numbered channels rather than the theme's: nothing here is about colour. */
const palette = () => ({
  route: [1, 1, 1],
  routeCritical: [2, 2, 2],
  accent: [3, 3, 3],
  casing: [4, 4, 4],
  unresolved: [5, 5, 5],
  ringPlanned: [6, 6, 6],
  ringBest: [7, 7, 7],
  launch: [8, 8, 8],
  worst: [9, 9, 9],
  markerBorder: [10, 10, 10],
  label: [11, 11, 11],
  advisory: { ridge: [12, 12, 12] },
});

/**
 * A frame with one of everything in it, so every layer this scene can build is
 * in the array under test rather than only the ones a sparse mission produces.
 */
const frame = () => ({
  snapshot: {
    route: {
      empty: false,
      points: [LAUNCH, ...WAYPOINTS.map(({ lat, lng }) => ({ lat, lng }))],
      waypointCount: 2,
      returnMode: 'direct',
      worst: { index: 1 },
      fits: true,
    },
    segments: {
      s0: {
        index: 0,
        altitudeMslM: 420,
        shot: {
          subjectId: 'sub-1',
          distanceStartM: 90,
          distanceEndM: 110,
          bearingToSubjectDeg: 45,
          elevationAngleDeg: -5,
          fov: { hDeg: 90, vDeg: 60 },
        },
        camera: null,
      },
      s1: { index: 1, altitudeMslM: 440, shot: null, camera: null },
    },
    footprint: {
      launch: LAUNCH,
      courses: [0, 90, 180, 270],
      radii: [1, 1, 1, 1],
      byCourse: [1, 1, 1, 1],
      bestCourses: [0, 90, 180, 270],
      bestRadii: [1.2, 1.2, 1.2, 1.2],
      bestByCourse: [1.2, 1.2, 1.2, 1.2],
    },
    advisories: {
      status: 'ready',
      grid: { rows: 1, cols: 1, cellSizeM: 200, cells: [{ ...LAUNCH, elevM: 300 }] },
      forcing: { cells: [{ classId: 'ridge' }] },
    },
  },
  waypoints: WAYPOINTS,
  subjects: [{ id: 'sub-1', name: 'The barn', lat: 30.2732, lng: -97.7401, elevationMslM: 340 }],
  launch: LAUNCH,
  routeMode: true,
  advisoryVisible: true,
  selectedSegmentId: 's0',
  env: { elevM: 300 },
});

/** Flat ground at 300 m, as MapLibre would report it. */
const ctx = (over = {}) => ({
  palette: palette(),
  exaggeration: 1,
  groundZAt: () => 300,
  ...over,
});

/** Every layer this frame produces, in the order deck is handed them. */
const EVERY_LAYER = [
  'advisory-zones',
  'footprint-best',
  'footprint-planned-casing',
  'footprint-planned',
  'route-casing',
  'route-selected',
  'route-air',
  'shot-frustum',
  'shot-lines',
  'subjects',
  'subject-labels',
  'launch',
  'waypoints',
  'waypoint-labels',
];

test('the frame under test really does build one of every layer', () => {
  // Otherwise the assertions below would pass over a scene with three layers in
  // it and say nothing about the rest.
  assert.deepEqual(buildSceneLayers(frame(), ctx()).map((l) => l.id), EVERY_LAYER);
});

test('a MapLibre-hosted layer names no coordinate system and no depth state', () => {
  for (const layer of buildSceneLayers(frame(), ctx())) {
    // deck's own default, which under a geospatial viewport means lng/lat — the
    // projection MapLibre and deck have agreed on since M7.
    assert.equal(layer.props.coordinateSystem, COORDINATE_SYSTEM.DEFAULT, layer.id);
    // Empty, not "depth off": interleaved mode inherits the depth state MapLibre
    // configured for its own terrain pass, and naming one here would override it.
    assert.deepEqual(layer.props.parameters, {}, layer.id);
  }
});

test('the launch pad is drawn at lng/lat, lifted off the terrain', () => {
  const [launch] = buildSceneLayers(frame(), ctx()).filter((l) => l.id === 'launch');
  assert.deepEqual(launch.props.data, [{
    kind: 'launch',
    position: [LAUNCH.lng, LAUNCH.lat, 302],
  }]);
});

/* ---------- the same scene, under an orbit viewport ---------- */

/** The local frame the standalone view draws in, zeroed on the launch point. */
const orthoCtx = () => ctx({ space: cartesianSpace(LAUNCH) });

test('the local frame draws the same scene, layer for layer', () => {
  // A projection that collapsed a ring or emptied a path would show up as a
  // missing layer rather than as a wrong one.
  assert.deepEqual(buildSceneLayers(frame(), orthoCtx()).map((l) => l.id), EVERY_LAYER);
});

test('every layer under the orbit viewport names its frame and its depth state', () => {
  for (const layer of buildSceneLayers(frame(), orthoCtx())) {
    // The viewport is not geospatial: without this the positions are read as
    // lng/lat and the whole mission is drawn inside one metre.
    assert.equal(layer.props.coordinateSystem, COORDINATE_SYSTEM.CARTESIAN, layer.id);
    // A standalone Deck on WebGL applies no depth state of its own, so the last
    // layer drawn wins every overlap and the route is painted over the terrain.
    assert.deepEqual(layer.props.parameters, {
      depthWriteEnabled: true,
      depthCompare: 'less-equal',
    }, layer.id);
  }
});

test('the launch pad is the origin of the local frame, sitting on the ground', () => {
  const [launch] = buildSceneLayers(frame(), orthoCtx()).filter((l) => l.id === 'launch');
  // Zero east, zero north, and the terrain height with no drape lift on it.
  assert.deepEqual(launch.props.data, [{ kind: 'launch', position: [0, 0, 300] }]);

  // The rest of the scene is metres about that origin: the waypoints are a few
  // hundred out, not a fraction of a degree.
  const [pins] = buildSceneLayers(frame(), orthoCtx()).filter((l) => l.id === 'waypoints');
  for (const pin of pins.props.data) {
    const [x, y] = pin.position;
    assert.ok(Math.hypot(x, y) > 100 && Math.hypot(x, y) < 2000, `${x},${y}`);
  }
});
