// scene-geometry.js — the arithmetic behind the 3D scene, with no engine in it.
//
// Everything in this file is pure: it takes the frame's numbers plus one
// injected reading of the ground and returns positions, runs and colours. No
// MapLibre, no deck.gl, no DOM — which is what lets tests/map-scene3d.test.mjs
// assert the two things a 3D route can get quietly wrong (the zoom handover and
// the altitude of a vertex nobody resolved) without a GPU.
//
// Three ideas carry the whole file.
//
//   *The zoom offset is real, not cosmetic.* Leaflet counts a zoom level as
//     256 px of world per tile; MapLibre's camera counts 512. The same view is
//     therefore one level apart in the two numbering systems, and a handover
//     that forgets it lands the pilot at 2× or ½× with no warning.
//
//   *Exaggeration multiplies everything or it multiplies nothing.* MapLibre
//     scales terrain elevation about sea level, and deck.gl draws our vertices
//     at whatever Z we hand it. Draw a route at true MSL over a 2× mesh and it
//     sinks into the hills. So every Z below is `metresMsl * exaggeration`, and
//     the ground readings coming back in are already exaggerated (MapLibre's
//     `queryTerrainElevation` applies it) and are passed straight through.
//
//   *Unknown is not an altitude.* A vertex whose MSL never resolved is drawn on
//     the ground, and the segments touching it are flagged so the scene can draw
//     them in a muted style. It must never be possible to read a confirmed
//     height off a leg the analysis could not place.

import { destination } from '../../../domain/geo.js';
import { routeSpans, segmentIdOrder, worstPinIndex } from '../layers/route-layer.js';

/**
 * @typedef {import('../map-adapter.js').LatLng} LatLng
 * @typedef {import('../map-adapter.js').LatLngBounds} LatLngBounds
 * @typedef {import('../map-adapter.js').RouteWaypoint} RouteWaypoint
 */

/** A deck.gl vertex: longitude, latitude, metres up — in that order. */
/** @typedef {[number, number, number]} Position3 */

/**
 * One vertex of the flown line.
 * @typedef {object} RouteVertex
 * @property {Position3} position
 * @property {boolean} resolved  false when `position[2]` came off the ground
 *   rather than off a planned altitude
 */

/**
 * A stretch of line whose vertices agree about whether their height is known.
 * @typedef {object} PathRun
 * @property {Position3[]} path
 * @property {boolean} resolved
 * @property {'out'|'home'} phase
 */

/**
 * One hop of the drawn line, on its own, carrying the segment it is.
 *
 * Kept beside `runs` rather than replacing them: the runs are what the scene
 * draws, merged so a stretch of confirmed altitude is one unbroken line, and
 * splitting them per leg would restart the line at every waypoint. The legs are
 * what the scene *picks* — one datum per authored segment, so a click comes back
 * with an id rather than with a run of several.
 * @typedef {object} RouteLeg3
 * @property {'leg'} kind
 * @property {string|null} segmentId  null on a hop nobody authored — a direct
 *   return is flown but never drawn, so there is nothing to open
 * @property {Position3[]} path  two vertices
 * @property {boolean} resolved
 * @property {'out'|'home'} phase
 */

/**
 * A numbered pin, ready to draw and to pick.
 * @typedef {object} RoutePin
 * @property {'waypoint'} kind
 * @property {string} id
 * @property {number} index
 * @property {Position3} position
 * @property {boolean} resolved
 * @property {boolean} worst
 * @property {string} label
 */

/**
 * @typedef {object} RouteGeometry
 * @property {RouteVertex[]} vertices  the integrator's points, launch first
 * @property {PathRun[]} runs
 * @property {RouteLeg3[]} legs  one per authored segment hop, for picking
 * @property {RoutePin[]} pins
 * @property {number} count  authored waypoints actually drawn
 */

/**
 * Leaflet's zoom minus MapLibre's, for the same picture.
 *
 * Leaflet's world is `256 * 2^zoom` pixels across. MapLibre's camera is defined
 * on 512 px tiles — `transform.worldSize = 512 * 2^zoom` — whatever tile size
 * the raster sources happen to use. One level, every time, in both directions.
 */
export const SCENE_ZOOM_OFFSET = 1;

/** Leaflet's zoom → MapLibre's. @param {number} flatZoom @returns {number} */
export const toSceneZoom = (flatZoom) => flatZoom - SCENE_ZOOM_OFFSET;

/** MapLibre's zoom → Leaflet's. @param {number} sceneZoom @returns {number} */
export const toFlatZoom = (sceneZoom) => sceneZoom + SCENE_ZOOM_OFFSET;

/**
 * How far above the sampled surface anything ground-draped is drawn.
 *
 * Two metres, and it is not a fudge for a wrong elevation: a path lying exactly
 * on the terrain mesh z-fights with it, which reads as a flickering dashed line
 * rather than as a line on the ground. Small enough to be invisible at every
 * camera this scene allows, large enough to win the depth test.
 */
export const DRAPE_LIFT_M = 2;

/**
 * The route as three drawable things: vertices, runs of line between them, and
 * the pins on the authored waypoints.
 *
 * The mirror arithmetic is not repeated here. A retrace hands the integrator
 * `[w0…w(n-1), w(n-2)…w0]`, so a point past the turn is a waypoint being flown
 * for the second time and must take that waypoint's altitude and its pin —
 * which is exactly the mapping `worstPinIndex` already computes for the reserve
 * highlight, so it is imported rather than written again.
 *
 * @param {object} input
 * @param {{ lat: number, lng: number }[]} input.points  the integrator's own list
 * @param {number} input.waypointCount   what the pilot authored, before doubling
 * @param {string} input.returnMode
 * @param {number|null|undefined} input.worstIndex  index into the integrator's list
 * @param {readonly RouteWaypoint[]} input.waypoints  the document's, with ids
 * @param {object} opts
 * @param {Record<string, { index: number, altitudeMslM: number|null }>} opts.segments
 * @param {number} opts.exaggeration
 * @param {(lng: number, lat: number) => number|null} opts.groundZAt  already
 *   exaggerated, as MapLibre reports it
 * @param {number|null} opts.launchElevMslM  true MSL, used only if the ground is silent
 * @returns {RouteGeometry}
 */
export function buildRouteGeometry(input, opts) {
  const { points, waypointCount, returnMode, worstIndex, waypoints } = input;
  const { segments, exaggeration, groundZAt, launchElevMslM } = opts;

  const empty = /** @type {RouteGeometry} */
    ({ vertices: [], runs: [], legs: [], pins: [], count: 0 });
  if (!Array.isArray(points) || points.length < 2) return empty;
  const n = Math.min(waypointCount, points.length - 1);
  if (n < 1) return empty;

  /** Authored waypoint index → the MSL the analysis resolved for its leg. */
  /** @type {Map<number, number>} */
  const mslByIndex = new Map();
  for (const seg of Object.values(segments ?? {})) {
    if (typeof seg?.altitudeMslM === 'number' && Number.isFinite(seg.altitudeMslM)) {
      mslByIndex.set(seg.index, seg.altitudeMslM);
    }
  }

  /** @param {{ lat: number, lng: number }} p @returns {RouteVertex} */
  const draped = (p) => {
    const ground = groundZAt(p.lng, p.lat);
    return {
      position: [p.lng, p.lat, (ground ?? 0) + DRAPE_LIFT_M],
      resolved: false,
    };
  };

  /** @type {RouteVertex[]} */
  const vertices = [];

  /* The launch pad sits on the ground by definition, so a terrain reading is
   * the answer rather than a fallback. `elevM` — the elevation the whole plan
   * was solved at — stands in only while the DEM under the pin is still loading;
   * either way the launch is a known place, so it is `resolved`. */
  const launchGround = groundZAt(points[0].lng, points[0].lat);
  const launchFallback = typeof launchElevMslM === 'number' && Number.isFinite(launchElevMslM)
    ? launchElevMslM * exaggeration
    : null;
  const launchZ = launchGround ?? launchFallback;
  vertices.push({
    position: [points[0].lng, points[0].lat, (launchZ ?? 0) + DRAPE_LIFT_M],
    resolved: launchZ != null,
  });

  for (let k = 1; k < points.length; k++) {
    const authored = worstPinIndex(k - 1, n, returnMode);
    const msl = authored != null ? mslByIndex.get(authored) : undefined;
    if (msl == null) { vertices.push(draped(points[k])); continue; }
    vertices.push({ position: [points[k].lng, points[k].lat, msl * exaggeration], resolved: true });
  }

  /* The same split the 2D layer draws: everything up to the far waypoint is the
   * line the pilot authored, everything after it is the flight home — which
   * under a retrace is the whole outbound line again, and under a direct return
   * is one hop. */
  const runs = [
    ...runsOf(vertices.slice(0, n + 1), 'out'),
    ...runsOf([...vertices.slice(n), vertices[0]], 'home'),
  ];

  /* The same hops again, unmerged and named, because a pick has to come back
   * with one segment. `routeSpans` is the 2D layer's own arithmetic, so the two
   * engines cannot disagree about which line is which leg. Every hop is here,
   * including the ones no segment owns — this is what the scene draws, and a
   * route with a hop missing from it would be a route with a gap. */
  /** @type {RouteLeg3[]} */
  const legs = [];
  const order = segmentIdOrder(segments);
  for (const span of routeSpans({
    pointCount: points.length, waypointCount: n, returnMode, segmentIds: order,
  })) {
    const from = vertices[span.a];
    const to = vertices[span.b];
    if (!from || !to) continue;
    legs.push({
      kind: 'leg',
      segmentId: span.segmentId,
      path: [from.position, to.position],
      resolved: from.resolved && to.resolved,
      phase: span.phase,
    });
  }

  const worst = worstPinIndex(worstIndex, n, returnMode);
  /** @type {RoutePin[]} */
  const pins = [];
  for (let i = 0; i < n; i++) {
    const id = waypoints[i]?.id;
    if (!id) continue;
    // points[0] is the launch, so vertices[i + 1] and waypoints[i] are the same
    // place — both came off the same document in the same pass.
    const v = vertices[i + 1];
    pins.push({
      kind: 'waypoint',
      id,
      index: i,
      position: v.position,
      resolved: v.resolved,
      worst: worst === i,
      label: String(i + 1),
    });
  }

  return { vertices, runs, legs, pins, count: n };
}

/**
 * Consecutive vertices grouped by whether the line between them is a claim.
 *
 * A segment is only as trustworthy as its worse end: touch one unresolved vertex
 * and the whole segment is drawn muted, because "we know where this leg starts
 * but not where it ends" is not a height the pilot can fly.
 *
 * @param {RouteVertex[]} vs
 * @param {'out'|'home'} phase
 * @returns {PathRun[]}
 */
function runsOf(vs, phase) {
  /** @type {PathRun[]} */
  const runs = [];
  for (let i = 0; i + 1 < vs.length; i++) {
    const resolved = vs[i].resolved && vs[i + 1].resolved;
    const last = runs[runs.length - 1];
    if (last && last.resolved === resolved) last.path.push(vs[i + 1].position);
    else runs.push({ resolved, phase, path: [vs[i].position, vs[i + 1].position] });
  }
  return runs;
}

/**
 * A polar ring as a closed, ground-hugging path.
 *
 * The rings are a statement about distance over the ground, not about height, so
 * every vertex takes the terrain's own elevation. A zero radius collapses to the
 * launch point rather than being dropped — a partly collapsed footprint is drawn
 * pinched against its own centre, which is what it is.
 *
 * @param {LatLng} from
 * @param {readonly number[]} courses
 * @param {readonly number[]} radii
 * @param {(lng: number, lat: number) => number|null} groundZAt
 * @returns {Position3[]}
 */
export function ringPositions(from, courses, radii, groundZAt) {
  /** @type {Position3[]} */
  const out = [];
  for (let i = 0; i < courses.length; i++) {
    const r = radii[i];
    const [lat, lng] = r > 0
      ? destination(from.lat, from.lng, courses[i], r)
      : [from.lat, from.lng];
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev[0] - lng) < 1e-9 && Math.abs(prev[1] - lat) < 1e-9) continue;
    out.push([lng, lat, (groundZAt(lng, lat) ?? 0) + DRAPE_LIFT_M]);
  }
  // A PathLayer draws an open line; the 2D ring is a polygon and closes itself.
  if (out.length > 1) out.push([...out[0]]);
  return out;
}

/**
 * The extent of a set of points, or null when there are none.
 *
 * Deliberately naive about the antimeridian: so is `fit()` on the 2D adapter,
 * and a footprint that straddles 180° is a fourteen-hour flight.
 *
 * @param {readonly {lat: number, lng: number}[]} points
 * @returns {LatLngBounds|null}
 */
export function boundsOf(points) {
  let south = Infinity; let north = -Infinity;
  let west = Infinity; let east = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lng)) continue;
    south = Math.min(south, p.lat); north = Math.max(north, p.lat);
    west = Math.min(west, p.lng); east = Math.max(east, p.lng);
  }
  if (!Number.isFinite(south)) return null;
  return { southWest: { lat: south, lng: west }, northEast: { lat: north, lng: east } };
}

/**
 * A CSS colour token as the `[r, g, b]` deck.gl wants.
 *
 * The 3D scene is themed by the same custom properties the 2D overlays are
 * (src/themes.js writes them onto the root element), but deck.gl takes numbers,
 * not `var(--series-2)`. Hex and `rgb()`/`rgba()` are the only two forms
 * themes.js ever emits; anything else falls back rather than guessing, because a
 * mis-parsed colour is a route drawn in the wrong verdict's colour.
 *
 * @param {string|null|undefined} value
 * @param {[number, number, number]} fallback
 * @returns {[number, number, number]}
 */
export function parseCssRgb(value, fallback) {
  const v = (value ?? '').trim();

  const hex = /^#([0-9a-f]+)$/i.exec(v);
  if (hex) {
    const h = hex[1];
    const full = (h.length === 3 || h.length === 4)
      ? h.slice(0, 3).split('').map((c) => c + c).join('')
      : (h.length === 6 || h.length === 8) ? h.slice(0, 6) : null;
    if (full) {
      return [
        parseInt(full.slice(0, 2), 16),
        parseInt(full.slice(2, 4), 16),
        parseInt(full.slice(4, 6), 16),
      ];
    }
    return fallback;
  }

  const fn = /^rgba?\(([^)]*)\)$/i.exec(v);
  if (fn) {
    const parts = fn[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return [
        Math.max(0, Math.min(255, Math.round(parts[0]))),
        Math.max(0, Math.min(255, Math.round(parts[1]))),
        Math.max(0, Math.min(255, Math.round(parts[2]))),
      ];
    }
  }

  return fallback;
}
