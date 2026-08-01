// ortho-view-state.js — the orthographic host's camera arithmetic, with no
// engine in it.
//
// A sibling of scene-geometry.js and split from ortho-scene.js for the same
// reason that file is split from scene.js: `ortho-scene.js` imports
// `@deck.gl/core` at module scope, so node cannot load it, and the numbers that
// can be silently wrong in an orthographic host are all here rather than there.
// A camera two zoom levels out looks like a camera; a mesh placed 4 km from its
// own height field looks like terrain. Both are testable arithmetic, and neither
// is testable through a `Deck`.
//
// Three things live here, and they are the three the spike's verdict named as
// production's own work (spike/ortho/SPIKE-VERDICT.md, "Integration sketch").
//
//   *A third zoom numbering.* Leaflet counts 256 px tiles, MapLibre counts 512
//     — one level apart, which is `SCENE_ZOOM_OFFSET`. An `OrbitViewport` has no
//     pyramid behind it at all: its `zoom` is log2 of the scale about the target,
//     `2 ** zoom` pixels per world metre. The bridge between that and Leaflet's
//     numbering is derived below rather than guessed, because the failure is a
//     pilot who leaves 3D and lands at 4× the zoom they were flying at.
//
//   *The grid origin is not the launch point.* The scene's local frame is ENU
//     about the launch (`cartesianSpace`); the height grid's own frame is ENU
//     about the centre of the DEM lattice, which is wherever the covering tiles
//     happened to fall. The two are a fixed translation apart, and every use of
//     it — the mesh's model matrix and the ground query behind picking — is
//     composed from one `gridPlacement`, so they cannot drift.
//
//   *The projection is a value, not a mode.* `OrbitView` and
//     `OrbitView({orthographic: true})` take the same `OrbitViewState`, so
//     toggling is a re-render with a different view instance and the state passed
//     straight through. 'top' is the orthographic one with the elevation angle
//     pinned; nothing else about the camera moves, so the pilot keeps the azimuth
//     they were orbiting at.

import { destination } from '../../../domain/geo.js';
import { boundsInSpace, cartesianSpace, toOrthoZoom, toSpaceXY } from './scene-geometry.js';

/**
 * @typedef {import('../map-adapter.js').LatLng} LatLng
 * @typedef {import('../map-adapter.js').LatLngBounds} LatLngBounds
 * @typedef {import('./scene-geometry.js').SceneSpace} SceneSpace
 * @typedef {import('./scene-geometry.js').SpaceBounds} SpaceBounds
 */

/**
 * The camera an `OrbitView` is driven by.
 *
 * Restated here rather than imported from `@deck.gl/core` so that this module
 * stays loadable in node — and it is a small enough vocabulary that restating it
 * is honest: `target` in world metres, `zoom` in log2 pixels per metre,
 * `rotationOrbit` the azimuth about +Z and `rotationX` the elevation above the
 * horizon.
 *
 * @typedef {object} OrbitViewState
 * @property {[number, number, number]} target
 * @property {number} zoom
 * @property {number} rotationX
 * @property {number} rotationOrbit
 * @property {number} [minZoom]
 * @property {number} [maxZoom]
 */

/**
 * Which camera the pilot is looking through.
 *
 * Three values and not a boolean, because the honest label for the third is
 * neither of the other two: 'top' is an orthographic camera looking straight
 * down, which is the view a plan is checked against, and the chrome has to be
 * able to say so.
 *
 * @typedef {'orthographic'|'perspective'|'top'} OrthoProjection
 */

/**
 * Straight down. deck measures `rotationX` up from the horizon, so 90° is the
 * nadir — and pinning it is the whole of what 'top' means.
 */
export const TOP_ROTATION_X = 90;

/**
 * Where the camera starts, before anything has been fitted.
 *
 * `rotationOrbit: 0` is north up, which is the orientation every other surface
 * in the app draws the mission in. The tilt is well off the nadir because a
 * ridge that reads as a ridge is the reason to be in this view at all, and well
 * off the horizon because a planning camera that has to look *past* the terrain
 * to see the route is a camera nobody plans in.
 *
 * The zoom stops are the useful span of an orbit camera over a mission: at 1000
 * px of canvas, `minZoom` is 64 km across and `maxZoom` is 125 m across.
 */
export const ORTHO_CAMERA = Object.freeze({
  rotationX: 55,
  rotationOrbit: 0,
  minZoom: -6,
  maxZoom: 3,
});

/** Whether a projection draws with parallel rays. Two of the three do. */
/** @param {OrthoProjection} projection @returns {boolean} */
export const isOrthographic = (projection) => projection !== 'perspective';

/**
 * The camera as a projection wants it.
 *
 * Only 'top' changes anything, and it changes exactly one field: the azimuth,
 * the zoom and the target are the pilot's and survive the toggle. Leaving 'top'
 * does not restore the tilt it replaced, which is deliberate — the camera a
 * pilot is looking through is where they left it, and springing back to an
 * angle they did not choose is the more surprising of the two behaviours.
 *
 * @param {OrbitViewState} viewState
 * @param {OrthoProjection} projection
 * @returns {OrbitViewState}
 */
export function projectedViewState(viewState, projection) {
  if (projection !== 'top') return { ...viewState };
  return { ...viewState, rotationX: TOP_ROTATION_X };
}

/* ---------- the third zoom numbering ---------- */

/** WGS84 equatorial circumference, metres — Web Mercator's own constant. */
const EARTH_CIRCUMFERENCE_M = 40075016.686;

/** Web Mercator's own poles. Past them the projection has no answer to give. */
const MAX_MERCATOR_LAT = 85.051129;

/** Leaflet's tile, in pixels. The 256 that makes its zoom a different number. */
const FLAT_TILE_PX = 256;

/**
 * The bridge between Leaflet's zoom and an `OrbitViewport`'s, derived rather
 * than fitted.
 *
 * At Leaflet zoom `z` and latitude `lat`, one screen pixel is
 * `C·cos(lat) / (256·2^z)` metres of ground. An orbit camera at zoom `o` puts
 * `2^o` pixels on one world metre, so a pixel is `2^-o` metres. Setting the two
 * equal and taking logs leaves one viewport-independent constant per latitude:
 *
 *     flatZoom = orthoZoom + log2(C·cos(lat) / 256)
 *
 * — which at the equator is 17.2555, and is what makes "the same picture" the
 * same size in both engines. Nothing about canvas size appears in it; that
 * belongs to `toOrthoZoom`, which is how much ground has to *fit*, and this is
 * how the two numberings name the same scale.
 *
 * Latitude is the middle of the screen in both directions, which is the latitude
 * Leaflet's own scale bar is computed at. The local frame's metre is fixed at
 * its origin's latitude instead, and over the kilometres a battery buys the two
 * differ by less than a pixel.
 *
 * @param {number} orthoZoom
 * @param {number} lat
 * @returns {number|null} null where there is no scale to convert
 */
export function toFlatZoomFromOrtho(orthoZoom, lat) {
  const bridge = zoomBridge(lat);
  if (bridge == null || !Number.isFinite(orthoZoom)) return null;
  return orthoZoom + bridge;
}

/**
 * The inverse, for a camera handed a zoom the 2D map was flying at.
 * @param {number} flatZoom
 * @param {number} lat
 * @returns {number|null}
 */
export function toOrthoZoomFromFlat(flatZoom, lat) {
  const bridge = zoomBridge(lat);
  if (bridge == null || !Number.isFinite(flatZoom)) return null;
  return flatZoom - bridge;
}

/** @param {number} lat @returns {number|null} */
function zoomBridge(lat) {
  if (!Number.isFinite(lat)) return null;
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  return Math.log2(EARTH_CIRCUMFERENCE_M * Math.cos((clamped * Math.PI) / 180) / FLAT_TILE_PX);
}

/* ---------- the mission's ground ---------- */

/**
 * The smallest box the terrain is ever loaded over.
 *
 * A mission with one waypoint has no extent, and a mesh the size of its own
 * route is a mesh with nothing around it — no ridge to the north to explain the
 * wind, no valley the return leg crosses. Five kilometres is the spike's
 * measured box: 12 tiles and 1.34 MB at z14.
 */
export const MIN_GROUND_SPAN_M = 5000;

/** Ground beyond the outermost point, so a fitted view does not end at the mesh's edge. */
export const GROUND_MARGIN_M = 500;

/**
 * A mission's extent, grown into the box the terrain is loaded over.
 *
 * The corners are walked out with the same geodesic the footprint rings are
 * placed by rather than by dividing metres into a restated degree — one answer
 * about where a kilometre north of here is, in a file that also has to agree
 * with `cartesianSpace` about it.
 *
 * @param {LatLngBounds} bounds
 * @param {{ minSpanM?: number, marginM?: number }} [o]
 * @returns {LatLngBounds}
 */
export function padBounds(bounds, { minSpanM = MIN_GROUND_SPAN_M, marginM = GROUND_MARGIN_M } = {}) {
  const centre = {
    lat: (bounds.southWest.lat + bounds.northEast.lat) / 2,
    lng: (bounds.southWest.lng + bounds.northEast.lng) / 2,
  };
  const span = boundsInSpace(bounds, cartesianSpace(centre));
  const halfX = Math.max(Math.abs(span.width) / 2 + marginM, minSpanM / 2);
  const halfY = Math.max(Math.abs(span.height) / 2 + marginM, minSpanM / 2);

  const [north] = destination(centre.lat, centre.lng, 0, halfY / 1000);
  const [south] = destination(centre.lat, centre.lng, 180, halfY / 1000);
  const [, east] = destination(centre.lat, centre.lng, 90, halfX / 1000);
  const [, west] = destination(centre.lat, centre.lng, 270, halfX / 1000);
  return { southWest: { lat: south, lng: west }, northEast: { lat: north, lng: east } };
}

/**
 * Whether a loaded box still holds the mission that has grown inside it.
 *
 * The question a re-load is decided by, and it is asked about the *padded* box:
 * a route that has crept to the edge of the mesh is a route the pilot is
 * planning over a cliff of missing ground.
 *
 * @param {LatLngBounds|null} outer
 * @param {LatLngBounds} inner
 * @returns {boolean}
 */
export function boundsCover(outer, inner) {
  if (!outer) return false;
  return outer.southWest.lat <= inner.southWest.lat
    && outer.southWest.lng <= inner.southWest.lng
    && outer.northEast.lat >= inner.northEast.lat
    && outer.northEast.lng >= inner.northEast.lng;
}

/* ---------- the grid's own frame ---------- */

/**
 * The translation between the scene's frame and the height grid's, plus the two
 * compositions that use it.
 *
 * @typedef {object} GridPlacement
 * @property {[number, number]} offset  the grid's origin, in the scene's metres
 * @property {(lng: number, lat: number) => [number, number]} toGridXY
 * @property {(x: number, y: number) => [number, number]} fromGridXY
 */

/**
 * Where a height grid sits in a scene's local frame.
 *
 * `cartesianSpace` is ENU about the *launch*, because that is what every other
 * number in a mission is measured from. `buildTerrainGrid` returns a lattice
 * centred on whatever the covering DEM tiles clipped to, which is a different
 * point — typically a kilometre or two away. Both facts are load-bearing and
 * neither is negotiable, so the translation between them is computed once, here,
 * and handed to the two places that need it: the mesh's model matrix, which
 * slides the terrain into the scene's frame, and the ground query behind
 * picking, which slides a scene position back into the grid's.
 *
 * Getting this wrong does not fail: it draws a plausible mountain range a
 * kilometre from the mission, with a route standing on ground that is somewhere
 * else entirely.
 *
 * @param {SceneSpace} space
 * @param {LatLng} gridOrigin
 * @returns {GridPlacement}
 */
export function gridPlacement(space, gridOrigin) {
  const [ox, oy] = toSpaceXY(space, gridOrigin.lng, gridOrigin.lat);
  return {
    offset: [ox, oy],
    toGridXY: (lng, lat) => {
      const [x, y] = toSpaceXY(space, lng, lat);
      return [x - ox, y - oy];
    },
    fromGridXY: (x, y) => [x + ox, y + oy],
  };
}

/**
 * The mesh's model matrix: the grid's offset, and the terrain slider.
 *
 * Column-major, as every GL matrix is. Exaggeration is a Z scale on the *matrix*
 * rather than a rebuild of the vertex buffer, which is what makes the slider free
 * — a 35,000-vertex mesh is rebuilt once per grid, never per frame — and it is
 * the same multiplier `groundZReader` applies, so the drawn surface and the
 * queried surface are the same surface at every setting.
 *
 * A non-uniform scale does not carry to the normals: at 2× the lighting is that
 * of the true slope rather than of the stretched one. That is cosmetic and it is
 * the trade the slider is worth — the alternative is recomputing 35,000 normals
 * on every drag of it.
 *
 * @param {readonly [number, number]} offset
 * @param {number} exaggeration
 * @returns {number[]}
 */
export function terrainModelMatrix([ox, oy], exaggeration) {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, exaggeration, 0,
    ox, oy, 0, 1,
  ];
}

/**
 * The ground under a geographic point, in the scene's own drawn units.
 *
 * The composition the whole host stands on, in one place because it has to agree
 * with itself in three: the terrain draws at `meshZ × exaggeration`, the route's
 * stems are drawn down to whatever this returns, and a pick is rejected as
 * "below the ground" by comparing against it. Two of those disagreeing is a
 * waypoint hovering over the hill it is standing on.
 *
 * Null where the grid is silent — off the lattice, or over a hole nobody
 * decoded. Absence is a value (ADR 0008), and the geometry already knows to draw
 * a vertex it cannot place as unresolved rather than at sea level.
 *
 * @param {object} o
 * @param {GridPlacement} o.placement
 * @param {(x: number, y: number) => number|null} o.sample  `groundAt` bound to a grid
 * @param {() => number} o.exaggeration  read per call: the slider moves, the mesh does not
 * @returns {(lng: number, lat: number) => number|null}
 */
export function groundZReader({ placement, sample, exaggeration }) {
  return (lng, lat) => {
    const [x, y] = placement.toGridXY(lng, lat);
    const z = sample(x, y);
    return z == null || !Number.isFinite(z) ? null : z * exaggeration();
  };
}

/* ---------- framing ---------- */

/**
 * The camera that puts an extent on screen: where to look, and how far out.
 *
 * The limiting axis wins — the zoom that fits the width and the zoom that fits
 * the height are both computed and the smaller is taken, which is what "fit"
 * means and what `fitBounds` does in both other engines. Padding is removed from
 * the canvas before the arithmetic rather than added to the extent after it, so
 * a 24 px margin is 24 px at every zoom.
 *
 * `zoom` comes back null on an extent with no size — a single-waypoint mission —
 * and the host keeps the zoom it had. A camera at infinity is not a framing.
 *
 * @param {SpaceBounds} extent  in the scene's metres
 * @param {{ width: number, height: number, paddingPx?: number, centreZ?: number }} canvas
 * @returns {{ target: [number, number, number], zoom: number|null }}
 */
export function fitViewState(extent, { width, height, paddingPx = 0, centreZ = 0 }) {
  const target = /** @type {[number, number, number]} */
    ([extent.centre[0], extent.centre[1], centreZ]);
  const zoomX = toOrthoZoom(Math.abs(extent.width), width - 2 * paddingPx);
  const zoomY = toOrthoZoom(Math.abs(extent.height), height - 2 * paddingPx);
  if (zoomX == null && zoomY == null) return { target, zoom: null };
  if (zoomX == null) return { target, zoom: zoomY };
  if (zoomY == null) return { target, zoom: zoomX };
  return { target, zoom: Math.min(zoomX, zoomY) };
}
