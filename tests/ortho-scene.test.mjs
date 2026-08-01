import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ORTHO_CAMERA,
  TOP_ROTATION_X,
  boundsCover,
  fitViewState,
  gridPlacement,
  groundZReader,
  isOrthographic,
  padBounds,
  projectedViewState,
  terrainModelMatrix,
  toFlatZoomFromOrtho,
  toOrthoZoomFromFlat,
} from '../src/presentation/map/scene3d/ortho-view-state.js';
import {
  boundsInSpace,
  cartesianSpace,
  toSpaceXY,
} from '../src/presentation/map/scene3d/scene-geometry.js';

/* The orthographic host's arithmetic, tested where a GPU cannot reach.
 *
 * ortho-scene.js itself imports `@deck.gl/core` at module scope and cannot be
 * loaded here at all; that is why the numbers below live in ortho-view-state.js
 * rather than beside the `Deck` that uses them. Each of the three groups is a
 * failure that looks like success on screen: a mesh placed a kilometre from the
 * route standing on it still looks like terrain, a camera two zoom levels out
 * still looks like a camera, and a perspective view labelled Orthographic is
 * simply a lie a screenshot cannot catch. */

/* ---------- the grid's frame against the launch's ---------- */

/* The wrinkle in one sentence: the scene draws in metres about the *launch*, and
 * the height grid answers in metres about the centre of whatever DEM lattice the
 * covering tiles clipped to. Everything below is the same offset, read three
 * ways — the mesh's matrix, a query going out, and a query coming back. */

const LAUNCH = { lat: 39.6, lng: -105.4 };
/* Deliberately not the launch, and not adjacent to it: a real z14 lattice centre
 * lands a kilometre or two off, which is exactly far enough to draw a plausible
 * mountain over the wrong valley. */
const GRID_ORIGIN = { lat: 39.615, lng: -105.42 };

test('the grid is placed by the offset between its origin and the launch', () => {
  const space = cartesianSpace(LAUNCH);
  const placement = gridPlacement(space, GRID_ORIGIN);
  const [ox, oy] = toSpaceXY(space, GRID_ORIGIN.lng, GRID_ORIGIN.lat);

  // West and north of the launch, so the offset is negative east and positive north.
  assert.ok(ox < -1000, `expected the lattice well west of the launch, got ${ox} m`);
  assert.ok(oy > 1000, `expected the lattice well north of the launch, got ${oy} m`);
  assert.deepEqual(placement.offset, [ox, oy]);

  // The launch itself, asked of the grid, is the negated offset — the one number
  // a mesh drawn in the wrong place would get wrong.
  const [gx, gy] = placement.toGridXY(LAUNCH.lng, LAUNCH.lat);
  assert.ok(Math.abs(gx + ox) < 1e-6);
  assert.ok(Math.abs(gy + oy) < 1e-6);
});

test('a point survives the round trip through the grid frame', () => {
  const space = cartesianSpace(LAUNCH);
  const placement = gridPlacement(space, GRID_ORIGIN);
  const at = { lat: 39.58, lng: -105.37 };

  const [gx, gy] = placement.toGridXY(at.lng, at.lat);
  const [x, y] = placement.fromGridXY(gx, gy);
  const [wantX, wantY] = toSpaceXY(space, at.lng, at.lat);
  assert.ok(Math.abs(x - wantX) < 1e-9);
  assert.ok(Math.abs(y - wantY) < 1e-9);
});

test('the mesh matrix translates by the same offset it queries by', () => {
  const space = cartesianSpace(LAUNCH);
  const placement = gridPlacement(space, GRID_ORIGIN);
  const m = terrainModelMatrix(placement.offset, 1);

  // Column-major: the translation is the last column, and it is the offset.
  assert.equal(m.length, 16);
  assert.equal(m[12], placement.offset[0]);
  assert.equal(m[13], placement.offset[1]);
  assert.equal(m[14], 0);
  // A vertex at the grid's own origin therefore draws at the grid's origin.
  assert.deepEqual([m[0], m[5], m[10]], [1, 1, 1]);
});

test('what the mesh draws and what a pick reads are the same surface', () => {
  const space = cartesianSpace(LAUNCH);
  const placement = gridPlacement(space, GRID_ORIGIN);

  /* A height field with a slope, so a placement error shows up as a wrong
   * height rather than as the same height everywhere: 1500 m at the lattice
   * centre, rising a metre per 10 m east. */
  const sample = (x, y) => (
    Math.abs(x) > 4000 || Math.abs(y) > 4000 ? null : 1500 + x / 10);

  let exaggeration = 1;
  const groundZAt = groundZReader({ placement, sample, exaggeration: () => exaggeration });

  const at = { lat: 39.6, lng: -105.39 };
  const [gx] = placement.toGridXY(at.lng, at.lat);
  const meshZ = 1500 + gx / 10;

  // The mesh's Z scale and the reader's multiplier are one number, so the drawn
  // surface and the queried surface agree at every setting of the slider.
  for (const x of [1, 1.75, 2.5]) {
    exaggeration = x;
    const m = terrainModelMatrix(placement.offset, x);
    assert.ok(Math.abs(groundZAt(at.lng, at.lat) - meshZ * m[10]) < 1e-6,
      `mesh and query disagree at ${x}x`);
  }

  // Off the lattice the answer is absence, not sea level (ADR 0008).
  const far = { lat: 39.6, lng: -105.0 };
  assert.equal(groundZAt(far.lng, far.lat), null);
});

/* ---------- the third zoom numbering ---------- */

test('the flat zoom bridge round-trips at two latitudes', () => {
  for (const lat of [30.2672, 61.2181]) {
    for (const orthoZoom of [-6, -2.5, 0, 1.75, 3]) {
      const flat = toFlatZoomFromOrtho(orthoZoom, lat);
      assert.ok(flat != null);
      assert.ok(Math.abs(toOrthoZoomFromFlat(flat, lat) - orthoZoom) < 1e-9,
        `round trip lost ${orthoZoom} at lat ${lat}`);
    }
  }
});

test('the bridge is the derived constant, not a fitted one', () => {
  // C·cos(0)/256 = 156543.03 m per pixel at zoom 0, and log2 of it is 17.2555.
  assert.ok(Math.abs(toFlatZoomFromOrtho(0, 0) - 17.2555) < 1e-3);
  // A metre of ground is fewer pixels of screen the further north it is, so the
  // same picture is a *higher* Leaflet zoom at latitude.
  const equator = toFlatZoomFromOrtho(0, 0);
  const arctic = toFlatZoomFromOrtho(0, 61.2181);
  assert.ok(arctic < equator);
  // cos(60°) = 1/2, which is exactly one zoom level.
  assert.ok(Math.abs(toFlatZoomFromOrtho(0, 60) - (equator - 1)) < 1e-6);
});

test('a zoom with no scale behind it converts to nothing', () => {
  assert.equal(toFlatZoomFromOrtho(Number.NaN, 30), null);
  assert.equal(toOrthoZoomFromFlat(14, Number.NaN), null);
  // Past Mercator's own poles the latitude is clamped rather than refused: a
  // camera at 89° is a camera, and there is still a picture to size.
  assert.ok(Number.isFinite(toFlatZoomFromOrtho(0, 89)));
});

/* ---------- the projection toggle ---------- */

test('top-down pins the tilt and keeps the azimuth the pilot orbited to', () => {
  /** @type {any} */
  const flying = {
    target: [120, -340, 1500],
    zoom: -1.25,
    rotationX: ORTHO_CAMERA.rotationX,
    rotationOrbit: 137,
    minZoom: ORTHO_CAMERA.minZoom,
    maxZoom: ORTHO_CAMERA.maxZoom,
  };

  const top = projectedViewState(flying, 'top');
  assert.equal(top.rotationX, TOP_ROTATION_X);
  assert.equal(top.rotationOrbit, 137);
  assert.deepEqual(top.target, flying.target);
  assert.equal(top.zoom, flying.zoom);
  // The camera handed in is not the camera handed back: a state mutated in place
  // is one deck never sees change.
  assert.equal(flying.rotationX, ORTHO_CAMERA.rotationX);

  // And 'top' is orthographic — the label the chrome reads has to say so.
  assert.equal(isOrthographic('top'), true);
  assert.equal(isOrthographic('orthographic'), true);
  assert.equal(isOrthographic('perspective'), false);
});

test('swapping ortho for perspective moves nothing about the camera', () => {
  /** @type {any} */
  const state = {
    target: [-40.5, 900, 220],
    zoom: 0.5,
    rotationX: 42,
    rotationOrbit: -80,
    minZoom: -6,
    maxZoom: 3,
  };
  // The whole toggle: the same OrbitViewState through a view instance with a
  // different `orthographic` flag. Every field survives, in both directions.
  assert.deepEqual(projectedViewState(state, 'perspective'), state);
  assert.deepEqual(projectedViewState(state, 'orthographic'), state);
  assert.notEqual(projectedViewState(state, 'orthographic'), state);
});

/* ---------- the ground the terrain is loaded over ---------- */

test('a mission with no extent still gets a mission-sized box', () => {
  const at = { lat: 39.6, lng: -105.4 };
  const padded = padBounds({ southWest: at, northEast: at });
  const span = boundsInSpace(padded, cartesianSpace(at));
  // The 5 km floor, to within the geodesic's own rounding.
  assert.ok(Math.abs(Math.abs(span.width) - 5000) < 5, `width ${span.width}`);
  assert.ok(Math.abs(Math.abs(span.height) - 5000) < 5, `height ${span.height}`);
  assert.ok(boundsCover(padded, { southWest: at, northEast: at }));
});

test('a route wider than the floor gets its own margin', () => {
  const bounds = { southWest: { lat: 39.5, lng: -105.5 }, northEast: { lat: 39.7, lng: -105.2 } };
  const padded = padBounds(bounds);
  const centre = { lat: 39.6, lng: -105.35 };
  const span = boundsInSpace(padded, cartesianSpace(centre));
  const raw = boundsInSpace(bounds, cartesianSpace(centre));
  // 500 m of ground on each side, so the route never ends at the mesh's edge.
  assert.ok(Math.abs(Math.abs(span.width) - (Math.abs(raw.width) + 1000)) < 5);
  assert.ok(Math.abs(Math.abs(span.height) - (Math.abs(raw.height) + 1000)) < 5);
  assert.ok(boundsCover(padded, bounds));
  // And the box that is already loaded is not reloaded for a route inside it.
  assert.ok(boundsCover(padded, padded));
  assert.equal(boundsCover(null, bounds), false);
  assert.equal(boundsCover(bounds, padded), false);
});

/* ---------- framing ---------- */

test('a fit takes the axis that limits it, and the padding it was given', () => {
  const extent = {
    min: /** @type {[number, number]} */ ([-1000, -250]),
    max: /** @type {[number, number]} */ ([1000, 250]),
    centre: /** @type {[number, number]} */ ([0, 0]),
    width: 2000,
    height: 500,
  };
  const wide = fitViewState(extent, { width: 800, height: 800, paddingPx: 24, centreZ: 1500 });
  assert.deepEqual(wide.target, [0, 0, 1500]);
  // 2000 m across 752 usable pixels is the tighter of the two axes.
  assert.ok(wide.zoom != null);
  assert.ok(Math.abs(wide.zoom - Math.log2(752 / 2000)) < 1e-9);

  // Padding is taken off the canvas, so more of it is a wider view.
  const tight = fitViewState(extent, { width: 800, height: 800, paddingPx: 0 });
  assert.ok(tight.zoom > wide.zoom);
  assert.deepEqual(tight.target, [0, 0, 0]);
});

test('an extent with no size is a target without a zoom', () => {
  const point = {
    min: /** @type {[number, number]} */ ([12, -8]),
    max: /** @type {[number, number]} */ ([12, -8]),
    centre: /** @type {[number, number]} */ ([12, -8]),
    width: 0,
    height: 0,
  };
  const fitted = fitViewState(point, { width: 800, height: 600, paddingPx: 24 });
  assert.deepEqual(fitted.target, [12, -8, 0]);
  // Null rather than infinity: the host keeps the zoom it was already at.
  assert.equal(fitted.zoom, null);
});
