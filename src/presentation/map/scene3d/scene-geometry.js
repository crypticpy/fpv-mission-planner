// scene-geometry.js — the arithmetic behind the 3D scene, with no engine in it.
//
// Everything in this file is pure: it takes the frame's numbers plus one
// injected reading of the ground and returns positions, runs and colours. No
// MapLibre, no deck.gl, no DOM — which is what lets tests/map-scene3d.test.mjs
// assert the two things a 3D route can get quietly wrong (the zoom handover and
// the altitude of a vertex nobody resolved) without a GPU.
//
// Four ideas carry the whole file.
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
//
//   *Two coordinate spaces, one set of builders.* MapLibre's viewport is
//     geospatial, so a position is `[lng, lat, z]` and the engine projects it.
//     deck's `OrbitViewport` — the standalone orthographic view — reports
//     `isGeospatial === false` and projects nothing: every layer under it is
//     `COORDINATE_SYSTEM.CARTESIAN` in local metres about an origin
//     (spike/ortho/SPIKE-VERDICT.md, "Risks"). So the frame is a parameter and
//     not a fork. A second copy of this arithmetic would be a second answer to
//     where a waypoint is, and the two would drift the first time one was fixed.

import { destination } from '../../../domain/geo.js';
import { frustumCorners } from '../../../domain/camera.js';
import { routeSpans, segmentIdOrder, worstPinIndex } from '../layers/route-layer.js';

/**
 * @typedef {import('../map-adapter.js').LatLng} LatLng
 * @typedef {import('../map-adapter.js').LatLngBounds} LatLngBounds
 * @typedef {import('../map-adapter.js').RouteWaypoint} RouteWaypoint
 * @typedef {import('../map-adapter.js').SceneSubject} SceneSubject
 * @typedef {import('../../../application/analysis/analysis-contracts.js').SegmentShot} SegmentShot
 * @typedef {import('../../../domain/mission/mission-schema.js').SegmentCamera} SegmentCamera
 * @typedef {import('../../../domain/camera.js').Point3} Point3
 */

/**
 * A deck.gl vertex, in whichever space built it: `[lng, lat, z]` under MapLibre,
 * `[eastM, northM, z]` under an OrbitViewport. Z is metres up in both.
 */
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
 * A subject, placed in the scene.
 *
 * `resolved` carries the same meaning it does on a route vertex and for the same
 * reason: a subject nobody measured is drawn on the terrain under it, and it must
 * not be possible to read a confirmed height off it.
 * @typedef {object} SceneSubject3
 * @property {'subject'} kind
 * @property {string} id
 * @property {string} name
 * @property {Position3} position
 * @property {boolean} resolved  false when the height came off the ground
 * @property {boolean} framed    the selected segment is pointed at this one
 */

/**
 * What one segment is looking at: the leg's midpoint, then the subject.
 * @typedef {object} ShotLine
 * @property {'shot'} kind
 * @property {string} segmentId
 * @property {string} subjectId
 * @property {Position3[]} path  two vertices
 * @property {boolean} resolved  both ends' heights are claims, not fallbacks
 * @property {boolean} selected
 */

/**
 * The view pyramid of the selected segment's shot: the rectangle the frame covers
 * out at the subject, plus the four edges back to the camera.
 * @typedef {object} ShotFrustum
 * @property {'frustum'} kind
 * @property {string} segmentId
 * @property {Position3} apex
 * @property {Position3[]} outline  five vertices — the four corners, closed
 * @property {Position3[][]} edges  four two-vertex paths, apex → corner
 * @property {boolean} resolved
 */

/**
 * @typedef {object} ShotGeometry
 * @property {SceneSubject3[]} subjects
 * @property {ShotLine[]} shots
 * @property {ShotFrustum|null} frustum  at most one: the selected segment's
 */

/**
 * The two fields of a `SegmentAnalysis` the shot geometry reads.
 *
 * Structural rather than the whole record on purpose — it says at the type level
 * that everything drawn below comes off what the analysis published about the
 * shot, and that nothing here is at liberty to reach for a distance or an angle
 * the pass did not hand over.
 * @typedef {object} ShotSource
 * @property {SegmentShot|null} [shot]
 * @property {SegmentCamera|null} [camera]
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
 * An `OrbitViewport`'s zoom, from the ground it has to show.
 *
 * A third numbering, and the offset above does not reach it. Leaflet and
 * MapLibre both count tiles; an orbit viewport has no pyramid behind it, so its
 * `zoom` is log2 of the scale about the target — `2 ** zoom` pixels per world
 * unit, and this scene's world unit is the metre. A 5 km mission across 1250 px
 * is zoom −2, not "z14", and handing an orbit camera a tile zoom would frame it
 * light-years out.
 *
 * Null where there is nothing to frame rather than a camera at infinity: a
 * single-waypoint mission has no extent, and the host keeps the zoom it had.
 *
 * @param {number} groundExtentM  the longer side of what must be on screen
 * @param {number} viewportPx     the matching side of the canvas, padding removed
 * @returns {number|null}
 */
export function toOrthoZoom(groundExtentM, viewportPx) {
  if (!Number.isFinite(groundExtentM) || groundExtentM <= 0) return null;
  if (!Number.isFinite(viewportPx) || viewportPx <= 0) return null;
  return Math.log2(viewportPx / groundExtentM);
}

/**
 * The inverse: how much ground, in metres, a zoom puts across a viewport.
 *
 * @param {number} orthoZoom
 * @param {number} viewportPx
 * @returns {number|null}
 */
export function orthoExtentM(orthoZoom, viewportPx) {
  if (!Number.isFinite(orthoZoom)) return null;
  if (!Number.isFinite(viewportPx) || viewportPx <= 0) return null;
  return viewportPx / 2 ** orthoZoom;
}

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
 * Which frame a position comes out in.
 *
 * Carried as a value rather than read from a flag so that the choice is made
 * once, by the host, and every builder below is handed the same answer. The
 * geographic frame is the default everywhere, and its arm of every branch is
 * arithmetically nothing — a scene built for MapLibre is the same array of
 * numbers it was before this parameter existed.
 *
 * @typedef {object} SceneSpace
 * @property {'geographic'|'cartesian'} kind
 * @property {LatLng|null} origin  the local frame's zero; null in geographic,
 *   where there is nothing to be local to
 * @property {number} mPerDegLng   metres of easting per degree of longitude at
 *   `origin`'s latitude; 0 in geographic, where nothing is projected
 * @property {number} drapeLiftM   how far a ground-hugging vertex is raised
 */

/**
 * An extent in one space's own units.
 *
 * Not named for metres, because in the geographic frame they are degrees. It is
 * the cartesian frame that asks this question — `centre` is an `OrbitView`'s
 * target and the longer side is what `toOrthoZoom` takes.
 *
 * @typedef {object} SpaceBounds
 * @property {[number, number]} min     the south-west corner
 * @property {[number, number]} max     the north-east corner
 * @property {[number, number]} centre
 * @property {number} width
 * @property {number} height
 */

/**
 * Metres per degree of latitude, on the sphere `destination` flies over.
 *
 * Measured off it rather than restated as 111,320 or 111,195, so the two cannot
 * disagree: a ring placed by `destination` at r km and then read back in a local
 * frame is r km from its centre, which is the whole point of drawing it. A
 * degree of longitude is this times cos(lat) — the equirectangular
 * approximation, exact north–south and a few centimetres out east–west over the
 * kilometres a battery buys. It is the wrong projection for a continent; nothing
 * this scene draws is one.
 */
const M_PER_DEG_LAT = 1000 / destination(0, 0, 0, 1)[0];

/** The MapLibre host's frame: `[lng, lat, z]`, and the default everywhere. */
export const GEOGRAPHIC_SPACE = /** @type {SceneSpace} */ (Object.freeze({
  kind: 'geographic',
  origin: null,
  mPerDegLng: 0,
  drapeLiftM: DRAPE_LIFT_M,
}));

/**
 * A local ENU frame about `origin`: X metres east, Y metres north, Z metres MSL
 * — times whatever exaggeration the host is drawing its terrain at, exactly as
 * in the geographic frame, which for a true-scale mesh is 1.
 *
 * The origin is the launch point, and it belongs to the host for the life of the
 * scene rather than being re-derived per frame: it is the one place in a mission
 * every other number is already measured from (the footprint sweeps from it, the
 * route starts at it), and moving it slides the whole world under a camera that
 * has not moved.
 *
 * `drapeLiftM` is zero here, and that is a reading of what the lift is for
 * rather than an omission. The two metres beat z-fighting against *MapLibre's*
 * draped terrain mesh under the cameras this scene allows; a standalone Deck
 * has no basemap to drape and builds its own mesh from its own height grid
 * (spike/ortho/SPIKE-VERDICT.md, option B), so what a ground-hugging vertex
 * needs to clear there is that mesh's business and not this frame's.
 *
 * @param {LatLng} origin
 * @returns {SceneSpace}
 */
export function cartesianSpace(origin) {
  return {
    kind: 'cartesian',
    origin: { lat: origin.lat, lng: origin.lng },
    mPerDegLng: M_PER_DEG_LAT * Math.cos(origin.lat * Math.PI / 180),
    drapeLiftM: 0,
  };
}

/**
 * A point in the space's own units: `[lng, lat]`, or metres east and north.
 *
 * @param {SceneSpace} space
 * @param {number} lng
 * @param {number} lat
 * @returns {[number, number]}
 */
export function toSpaceXY(space, lng, lat) {
  const origin = space.origin;
  if (space.kind !== 'cartesian' || !origin) return [lng, lat];
  return [(lng - origin.lng) * space.mPerDegLng, (lat - origin.lat) * M_PER_DEG_LAT];
}

/**
 * Back out again, because a click is a place on the earth wherever it landed.
 *
 * @param {SceneSpace} space
 * @param {number} x
 * @param {number} y
 * @returns {LatLng}
 */
export function fromSpaceXY(space, x, y) {
  const origin = space.origin;
  if (space.kind !== 'cartesian' || !origin) return { lat: y, lng: x };
  return {
    lat: origin.lat + y / M_PER_DEG_LAT,
    lng: origin.lng + x / space.mPerDegLng,
  };
}

/**
 * One vertex: a geographic point and a height, in the space that will draw it.
 *
 * @param {SceneSpace} space
 * @param {number} lng
 * @param {number} lat
 * @param {number} z
 * @returns {Position3}
 */
export function spacePosition(space, lng, lat, z) {
  const [x, y] = toSpaceXY(space, lng, lat);
  return [x, y, z];
}

/**
 * A geographic extent, in the space that will draw it.
 *
 * `boundsOf` stays geographic and this is the step after it, rather than a
 * second return shape on the same function: `LatLngBounds` is the vocabulary
 * `SceneHandle.fit` is written in and both hosts share it
 * (spike/ortho/SPIKE-VERDICT.md, "Integration sketch"), so a bounds that changed
 * shape with the frame would make one seam into two.
 *
 * @param {LatLngBounds} bounds
 * @param {SceneSpace} space
 * @returns {SpaceBounds}
 */
export function boundsInSpace(bounds, space) {
  const [x0, y0] = toSpaceXY(space, bounds.southWest.lng, bounds.southWest.lat);
  const [x1, y1] = toSpaceXY(space, bounds.northEast.lng, bounds.northEast.lat);
  return {
    min: [x0, y0],
    max: [x1, y1],
    centre: [(x0 + x1) / 2, (y0 + y1) / 2],
    width: x1 - x0,
    height: y1 - y0,
  };
}

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
 * @param {SceneSpace} [opts.space]  which frame the positions come out in
 * @returns {RouteGeometry}
 */
export function buildRouteGeometry(input, opts) {
  const { points, waypointCount, returnMode, worstIndex, waypoints } = input;
  const {
    segments, exaggeration, groundZAt, launchElevMslM, space = GEOGRAPHIC_SPACE,
  } = opts;

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
      position: spacePosition(space, p.lng, p.lat, (ground ?? 0) + space.drapeLiftM),
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
    position: spacePosition(space, points[0].lng, points[0].lat, (launchZ ?? 0) + space.drapeLiftM),
    resolved: launchZ != null,
  });

  for (let k = 1; k < points.length; k++) {
    const authored = worstPinIndex(k - 1, n, returnMode);
    const msl = authored != null ? mslByIndex.get(authored) : undefined;
    if (msl == null) { vertices.push(draped(points[k])); continue; }
    vertices.push({
      position: spacePosition(space, points[k].lng, points[k].lat, msl * exaggeration),
      resolved: true,
    });
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
 * The cinematic half of the scene: where the subjects stand, what each segment is
 * pointed at, and — for the one segment the pilot has open — the frame it sees.
 *
 * Nothing here is a second opinion about the shot. The distances, the bearing,
 * the elevation angle and the field of view are all read off the segment's
 * `shot` record exactly as the analysis published them (ADR 0011 §3); the only
 * arithmetic in this function is the placement that turns those numbers into
 * positions the scene can draw. `frustumCorners` is called for the outline
 * because it is the same pure domain math the pass itself used — feeding it the
 * pass's own numbers reproduces the pass's own pyramid, and re-deriving a range
 * or an angle here would let 3D and the inspector disagree about one shot.
 *
 * The apex is the leg's midpoint because that is where the record's angles were
 * measured from, and the range is the mean of the two published slant ranges —
 * the only midpoint distance those two numbers support. It runs a little long
 * where the subject sits off to one side, which draws the frame's base just past
 * the subject rather than just short of it; a pyramid that stops short of what it
 * is framing would be the misleading one.
 *
 * Outbound legs only. Under a retrace the flight home is the authored segments
 * flown backwards and carries their ids again, and one shot drawn twice is one
 * shot too many.
 *
 * @param {object} input
 * @param {readonly RouteLeg3[]} input.legs  from buildRouteGeometry, so the shot
 *   lines start on the line the scene actually drew
 * @param {readonly SceneSubject[]} input.subjects  the scene's roster
 * @param {string|null} input.selectedSegmentId
 * @param {object} opts
 * @param {Record<string, ShotSource>} opts.segments
 * @param {number} opts.exaggeration
 * @param {(lng: number, lat: number) => number|null} opts.groundZAt
 * @param {SceneSpace} [opts.space]  which frame the positions come out in
 * @returns {ShotGeometry}
 */
export function buildShotGeometry(input, opts) {
  const { legs, subjects, selectedSegmentId } = input;
  const { segments, exaggeration, groundZAt, space = GEOGRAPHIC_SPACE } = opts;

  const selected = selectedSegmentId ?? null;
  const framedId = selected ? segments?.[selected]?.shot?.subjectId ?? null : null;

  /** @type {SceneSubject3[]} */
  const placed = [];
  /** @type {Map<string, SceneSubject3>} */
  const byId = new Map();
  for (const s of subjects ?? []) {
    if (!Number.isFinite(s?.lat) || !Number.isFinite(s?.lng)) continue;
    const msl = finite(s.elevationMslM);
    const drawn = /** @type {SceneSubject3} */ ({
      kind: 'subject',
      id: s.id,
      name: s.name,
      position: spacePosition(
        space,
        s.lng,
        s.lat,
        msl != null ? msl * exaggeration : (groundZAt(s.lng, s.lat) ?? 0) + space.drapeLiftM,
      ),
      resolved: msl != null,
      framed: s.id === framedId,
    });
    placed.push(drawn);
    byId.set(s.id, drawn);
  }

  /** @type {ShotLine[]} */
  const shots = [];
  /** @type {ShotFrustum|null} */
  let frustum = null;

  for (const leg of legs ?? []) {
    const id = leg?.segmentId;
    if (!id || leg.phase !== 'out') continue;
    const source = segments?.[id];
    const shot = source?.shot;
    if (!shot) continue;
    const subject = byId.get(shot.subjectId);
    if (!subject) continue;
    const apex = midpointOf(leg.path);
    if (!apex) continue;

    const isSelected = id === selected;
    shots.push({
      kind: 'shot',
      segmentId: id,
      subjectId: shot.subjectId,
      path: [apex, subject.position],
      resolved: leg.resolved && subject.resolved,
      selected: isSelected,
    });
    if (isSelected && !frustum) {
      frustum = frustumOf(
        id, apex, shot, source?.camera ?? null, exaggeration, leg.resolved, space);
    }
  }

  return { subjects: placed, shots, frustum };
}

/** A real number or null — the one guard every published field here needs.
 * @param {number|null|undefined} v @returns {number|null} */
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Halfway along a drawn leg. Naive about the antimeridian, exactly as `boundsOf`
 * and the 2D `fit()` are, and for the same reason.
 * @param {readonly Position3[]} path
 * @returns {Position3|null}
 */
function midpointOf(path) {
  const a = path?.[0];
  const b = path?.[1];
  if (!a || !b) return null;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/**
 * One segment's view pyramid, or null where the record cannot support one — an
 * unprofiled camera has no field of view, and a leg that passes straight over its
 * subject has no bearing to it.
 *
 * The authored camera bag steers: `yawOffsetDeg` swings the frame off the subject
 * and `pitchDeg` overrides the angle the geometry would otherwise look down. Both
 * are the pilot's own numbers, so an offset frame is drawn offset rather than
 * quietly re-centred.
 *
 * @param {string} segmentId
 * @param {Position3} apex
 * @param {SegmentShot} shot
 * @param {SegmentCamera|null} camera
 * @param {number} exaggeration
 * @param {boolean} resolved
 * @param {SceneSpace} space
 * @returns {ShotFrustum|null}
 */
function frustumOf(segmentId, apex, shot, camera, exaggeration, resolved, space) {
  const bearing = finite(shot.bearingToSubjectDeg);
  if (bearing == null) return null;
  const pitch = finite(camera?.pitchDeg) ?? finite(shot.elevationAngleDeg);
  if (pitch == null) return null;
  const rangeM = meanRange(shot);
  if (rangeM == null) return null;

  const corners = frustumCorners(
    { eM: 0, nM: 0, uM: 0 },
    bearing + (finite(camera?.yawOffsetDeg) ?? 0),
    pitch,
    shot.fov,
    rangeM,
  );
  if (!corners) return null;

  const outline = corners.map((c) => cornerPosition(apex, c, exaggeration, space));
  return {
    kind: 'frustum',
    segmentId,
    apex,
    outline: [...outline, outline[0]],
    edges: outline.map((p) => [apex, p]),
    resolved,
  };
}

/**
 * How far the frame reaches, from the midpoint the angles were taken at.
 * @param {SegmentShot} shot
 * @returns {number|null}
 */
function meanRange(shot) {
  const start = finite(shot.distanceStartM);
  const end = finite(shot.distanceEndM);
  if (start != null && end != null) return (start + end) / 2;
  return start ?? end;
}

/**
 * A camera-frame offset in metres, back on the globe.
 *
 * `frustumCorners` works in local ENU metres about the camera, so the horizontal
 * part is a bearing and a distance from the apex — which is what `destination`
 * takes, in kilometres. The vertical part is a true-metre offset and picks up the
 * exaggeration the apex's own Z already carries.
 *
 * A local frame's axes are already the camera frame's own east and north, so
 * there the offset is the answer and the round trip through a geodesic is not
 * merely unnecessary but a source of disagreement about a hundred-metre frame.
 *
 * @param {Position3} apex
 * @param {Point3} corner
 * @param {number} exaggeration
 * @param {SceneSpace} space
 * @returns {Position3}
 */
function cornerPosition(apex, corner, exaggeration, space) {
  if (space.kind === 'cartesian') {
    return [apex[0] + corner.eM, apex[1] + corner.nM, apex[2] + corner.uM * exaggeration];
  }
  const horizM = Math.hypot(corner.eM, corner.nM);
  const [lat, lng] = horizM > 0
    ? destination(apex[1], apex[0], Math.atan2(corner.eM, corner.nM) * 180 / Math.PI, horizM / 1000)
    : [apex[1], apex[0]];
  return [lng, lat, apex[2] + corner.uM * exaggeration];
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
 * @param {SceneSpace} [space]  which frame the positions come out in
 * @returns {Position3[]}
 */
export function ringPositions(from, courses, radii, groundZAt, space = GEOGRAPHIC_SPACE) {
  /** @type {Position3[]} */
  const out = [];
  /* The last vertex in degrees, because that is what the collapse test is about
   * and a nanometre is not the tolerance a billionth of a degree is. */
  /** @type {[number, number]|null} */
  let last = null;
  for (let i = 0; i < courses.length; i++) {
    const r = radii[i];
    const [lat, lng] = r > 0
      ? destination(from.lat, from.lng, courses[i], r)
      : [from.lat, from.lng];
    if (last && Math.abs(last[0] - lng) < 1e-9 && Math.abs(last[1] - lat) < 1e-9) continue;
    last = [lng, lat];
    out.push(spacePosition(space, lng, lat, (groundZAt(lng, lat) ?? 0) + space.drapeLiftM));
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
