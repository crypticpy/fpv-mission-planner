// Fixture geometry for the orthographic-3D rendering spike.
//
// One module, three consumers: the tile fetcher (node), the spike page (browser,
// via vite) and the Playwright spec (node). Every number the proofs depend on
// lives here so the page cannot drift from what the spec asserts — the same
// arrangement spike/occlusion uses.
//
// Unlike the occlusion spike, the terrain here is NOT synthetic. The question
// this spike answers is "what is the right terrain-mesh path for a standalone
// deck.gl orthographic view", and a synthetic ridge would answer it for a
// mountain that does not exist. So the DEM is the real AWS Terrain Tiles
// terrarium pyramid — the very tileset src/presentation/map/tile-sources.js
// already points MapLibre at — fetched once into public/tiles/ and served
// locally thereafter, which keeps the measurements repeatable without pretending
// the data is easier to get than it is.
//
// COORDINATE SYSTEM. deck.gl's OrbitView is non-geospatial: its viewport is
// Cartesian and every layer under it must be COORDINATE_SYSTEM.CARTESIAN. So
// this file's world is *local metres east/north of ORIGIN, with Z in metres MSL*
// — not lng/lat. That conversion is the whole reason a standalone orthographic
// view cannot simply reuse the MapLibre scene's geometry unchanged, and it is
// the first thing a production integration has to own.

/** Mount Hood summit, Oregon (Cascades). 3,429 m — the relief this spike needs. */
export const ORIGIN = Object.freeze({ lat: 45.3736, lng: -121.696 });

/** Half-width of the planning box, metres. 5 km across, per the spike brief. */
export const HALF_SPAN_M = 2500;

/**
 * The terrarium pyramid levels the fetcher pulls.
 *
 * z12-z15 is not "what the mesh needs" — the mesh only reads MESH_ZOOM. It is
 * the offline-pack question made concrete: how many tiles and how many bytes is
 * a 5 km region at each level of detail. The verdict quotes those numbers.
 */
export const TILE_ZOOMS = Object.freeze([12, 13, 14, 15]);

/** Which level the mesh samples by default. ~6.7 m/px at this latitude. */
export const MESH_ZOOM = 14;

/** AWS Terrain Tiles stop at z15 — a fact about the dataset (R-DEM). */
export const TERRARIUM_MAX_ZOOM = 15;
export const TILE_SIZE = 256;

/** The production DEM endpoint, verbatim from src/presentation/map/tile-sources.js. */
export const TERRARIUM_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRARIUM_ATTRIBUTION = 'Terrain: Mapzen/AWS Terrain Tiles';

/** Default mesh resolution, samples per axis. ~19.5 m spacing over 5 km. */
export const DEFAULT_GRID = 256;

/** Terrarium: elevation_m = R*256 + G + B/256 - 32768. */
export const TERRARIUM_DECODER = Object.freeze({
  rScaler: 256,
  gScaler: 1,
  bScaler: 1 / 256,
  offset: -32768,
});

/** @param {number} r @param {number} g @param {number} b @returns {number} metres MSL */
export function decodeTerrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/* ---------------------------------------------------------------- projection */

// A local flat projection, exactly invertible, centred on ORIGIN — the same
// device spike/occlusion uses, and for the same reason: over ±2.5 km the error
// against a real geodesic is centimetres, and both the terrain and the route are
// defined through this one function, so it cannot put them in different places.
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);

/** East/north metres from ORIGIN -> [lng, lat]. */
export function offsetToLngLat(dxM, dyM) {
  return [ORIGIN.lng + dxM / M_PER_DEG_LNG, ORIGIN.lat + dyM / M_PER_DEG_LAT];
}

/** [lng, lat] -> east/north metres from ORIGIN. */
export function lngLatToOffset(lng, lat) {
  return {
    dxM: (lng - ORIGIN.lng) * M_PER_DEG_LNG,
    dyM: (lat - ORIGIN.lat) * M_PER_DEG_LAT,
  };
}

/** `[west, south, east, north]` of the planning box. */
export const BOUNDS = Object.freeze([
  ...offsetToLngLat(-HALF_SPAN_M, -HALF_SPAN_M),
  ...offsetToLngLat(HALF_SPAN_M, HALF_SPAN_M),
]);

/* -------------------------------------------------------------- tile indices */

export const lngToTileX = (lng, z) => ((lng + 180) / 360) * 2 ** z;
export const lngOfTileX = (X, z) => (X / 2 ** z) * 360 - 180;
export const latToTileY = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
};
export const latOfTileY = (Y, z) => {
  const n = Math.PI - (2 * Math.PI * Y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/**
 * The inclusive tile rectangle covering BOUNDS at a zoom.
 *
 * @param {number} z
 * @returns {{ z: number, x0: number, x1: number, y0: number, y1: number, count: number }}
 */
export function tileRange(z) {
  const [west, south, east, north] = BOUNDS;
  const x0 = Math.floor(lngToTileX(west, z));
  const x1 = Math.floor(lngToTileX(east, z));
  // Mercator Y grows southward, so the north edge gives the low index.
  const y0 = Math.floor(latToTileY(north, z));
  const y1 = Math.floor(latToTileY(south, z));
  return { z, x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
}

/** Every `{ z, x, y }` in the rectangle, row-major. */
export function tileList(z) {
  const { x0, x1, y0, y1 } = tileRange(z);
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ z, x, y });
  return out;
}

/** Ground resolution of one DEM pixel at ORIGIN's latitude, metres. */
export function metresPerPixel(z) {
  return (156543.03392 * Math.cos((ORIGIN.lat * Math.PI) / 180)) / 2 ** z / (TILE_SIZE / 256);
}

/* ------------------------------------------------------------------- mission */

/**
 * A hardcoded six-waypoint mission over the mountain, in local metres and MSL.
 *
 * Deliberately not a flat circuit: it climbs the south-west flank, crosses the
 * summit, and dives off the north-east side, so the altitude stems span 200 m to
 * 1,400 m of air and the route is genuinely occluded by the cone from about half
 * the azimuths. A route that never went behind anything would make "does the
 * mesh occlude the path" unanswerable.
 */
export const MISSION = Object.freeze({
  id: 'spike-hood-6',
  waypoints: Object.freeze([
    // Altitudes are MSL, and the spec asserts every one of them clears the
    // decoded surface. They were first written by eye against a contour map and
    // two of them were underground — wp-6 by 77 m — which is a small
    // demonstration of the thing this spike is really about: a planning view
    // that cannot tell you where the ground is will happily draw a route
    // through it.
    { id: 'wp-1', name: 'Launch climb', atM: [-2050, -1750], altM: 2450 },
    { id: 'wp-2', name: 'Ridge gate', atM: [-1250, -700], altM: 2950 },
    { id: 'wp-3', name: 'Summit pass', atM: [-150, 200], altM: 3650 },
    { id: 'wp-4', name: 'North rim', atM: [700, 1300], altM: 3400 },
    { id: 'wp-5', name: 'Dive entry', atM: [1700, 950], altM: 3000 },
    { id: 'wp-6', name: 'Pullout', atM: [2150, -300], altM: 2600 },
  ]),
});

/** The five legs, each a pickable object with a stable id. */
export const LEGS = Object.freeze(
  MISSION.waypoints.slice(0, -1).map((from, i) => {
    const to = MISSION.waypoints[i + 1];
    return Object.freeze({
      kind: 'leg',
      id: `leg-${i + 1}`,
      from: from.id,
      to: to.id,
      path: Object.freeze([
        [from.atM[0], from.atM[1], from.altM],
        [to.atM[0], to.atM[1], to.altM],
      ]),
    });
  }),
);

/** Midpoint of a leg, in world coordinates. Used by the picking proofs. */
export function legMidpoint(leg) {
  const [a, b] = leg.path;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/* --------------------------------------------------------------- camera prep */

/**
 * The default orbit camera.
 *
 * `zoom` is log2(pixels per world metre). The box is 5,000 m across; at
 * 2**-2.4 = 0.19 px/m that is ~950 px, which fills a 1280x720 viewport without
 * clipping the corners as the azimuth sweeps.
 */
export const CAMERA = Object.freeze({
  target: Object.freeze([0, 0, 2400]),
  zoom: -2.4,
  rotationX: 42,
  rotationOrbit: 215,
  minZoom: -6,
  maxZoom: 2,
});

/**
 * Two probes at opposite camera depths, for the parallel-projection proof.
 *
 * At the default azimuth the camera looks from the south-west, so the
 * south-west corner of the box is near and the north-east corner is far. A
 * vertical stem of the same world height at each must paint the same number of
 * pixels under a parallel projection and visibly different numbers under a
 * perspective one. `STEM_M` is large enough that a perspective difference
 * cannot hide inside rounding.
 */
export const DEPTH_PROBES = Object.freeze({
  near: Object.freeze([-2200, -2200, 2600]),
  far: Object.freeze([2200, 2200, 2600]),
  stemM: 600,
});

/**
 * Two markers on the summit axis: one buried inside the cone, one in clear air
 * above it. Drawn only under `?probes=1`.
 *
 * This is how the spike proves the mesh participates in the depth buffer, and it
 * exists because the obvious test does not work. Squinting at whether a route
 * "looks occluded" fails: a mountain viewed from a low angle with a
 * back-to-front triangle order looks perfectly correct without any depth test at
 * all, and the route legs here mostly fly above the ridges they cross. Two
 * markers at the same (x, y) and known heights either side of the surface are
 * unambiguous — under a working depth buffer exactly one of them can be picked,
 * and it is always the same one.
 */
export const OCCLUSION_PROBES = Object.freeze({
  atM: Object.freeze([0, 0]),
  /** Metres below the surface at atM. Deeper than any plausible mesh error. */
  buriedM: 600,
  /** Metres above it. */
  clearM: 600,
});

/** Route colour, and colours for everything the spike draws. */
export const PALETTE = Object.freeze({
  route: Object.freeze([255, 0, 255]),
  stem: Object.freeze([255, 176, 32]),
  waypoint: Object.freeze([255, 255, 255]),
  foot: Object.freeze([120, 132, 148]),
  sky: '#0a1017',
});

/**
 * Hypsometric ramp, MSL metres -> [r, g, b].
 *
 * Purely so the mesh reads as terrain in a screenshot; nothing asserts on it.
 * Stops chosen for this box: 1,300 m of forested flank up to a 3,429 m summit.
 */
export function terrainColor(elevM) {
  const stops = [
    [1200, [46, 66, 58]],
    [1800, [66, 92, 66]],
    [2400, [122, 116, 88]],
    [2900, [146, 132, 120]],
    [3200, [196, 198, 202]],
    [3450, [246, 250, 255]],
  ];
  if (elevM <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (elevM <= stops[i][0]) {
      const [e0, c0] = stops[i - 1];
      const [e1, c1] = stops[i];
      const t = (elevM - e0) / (e1 - e0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * t),
        Math.round(c0[1] + (c1[1] - c0[1]) * t),
        Math.round(c0[2] + (c1[2] - c0[2]) * t),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

/**
 * What the summit is, so a decoded mesh can be checked against the world rather
 * than against itself. USGS gives Mount Hood 11,249 ft = 3,429 m; the terrarium
 * pyramid is a 10 m 3DEP blend here, so a sampled maximum a few tens of metres
 * either side is the DEM being a DEM, not a decode bug. A decode bug is not
 * subtle: a wrong encoding puts the summit at -32,000 m or +8,000,000 m.
 */
export const SUMMIT_M = 3429;
export const SUMMIT_TOLERANCE_M = 120;
