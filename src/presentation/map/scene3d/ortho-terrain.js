// ortho-terrain.js — the ground under the orthographic view: terrarium tiles in,
// a triangle mesh and a height query out.
//
// The M12 engine spike (spike/ortho/SPIKE-VERDICT.md) asked whether the
// orthographic planning view should take its terrain from `@deck.gl/geo-layers`'
// `TerrainLayer` or build the mesh itself. It measured the second, and not on
// frame time — the two are indistinguishable on a real GPU. Three structural
// findings decided it, and two of them are why this file is shaped the way it is:
//
//   *The mesh has to be ours to query.* deck's picking pass is not depth-correct
//     against terrain — measured on two GPUs, a click on a mountainside returns a
//     waypoint buried inside the mountain. The fix is to reject a hit whose world
//     Z is below the ground at that XY, which needs the height field
//     analytically. `groundAt()` at the bottom of this file *is* that fix; it is
//     not a convenience.
//
//   *The grid is the thing worth keeping.* A decoded height field is a plain
//     `Float32Array` plus bounds, which is the `AdvisoryGrid` shape at a
//     different density (`src/application/terrain/terrain-contracts.js`) and can
//     ride the same persistence and the same provenance discipline when offline
//     regions become real. `TerrainLayer`'s Martini mesh lives inside the layer.
//
// This is a *denser, separate* grid, not the advisory one. `sample-grid.js` caps
// at 24×24 with a 120 m floor because that is Copernicus GLO-90's real
// resolution; a render mesh wants ~26 m. The vocabulary transfers — rows, cols,
// cellSizeM, elevM, row-major, row 0 northernmost — and the instance does not.
//
// Four things to hold on to while reading:
//
//   *Coordinate system.* `OrbitViewport` is not geospatial, so every layer under
//     it is `COORDINATE_SYSTEM.CARTESIAN`: local metres east/north of the grid's
//     own `origin`, with **Z in metres MSL, unexaggerated**. `groundAt()` and the
//     mesh share that frame exactly, which is the only reason a stem drawn on the
//     ground stands on the ground.
//
//   *Absence is a value, not sea level* (ADR 0008). A cell nobody could decode —
//     a tile that 404'd, a hole in the pyramid — is `NaN` in `elevM`, never 0.
//     `groundAt()` answers `null` there and over the edge, the mesh emits no
//     triangle touching it, and the provenance says how many there were.
//
//   *The pure half is separate from the browser half.* `decodeTileHeights()` and
//     `buildTerrainGrid()` take bytes and return numbers; only `loadTerrainGrid()`
//     touches `fetch`, `createImageBitmap` and a canvas. Node has no canvas, and
//     the arithmetic that can be silently wrong is all on the pure side.
//
//   *Depth state is not free on a standalone Deck.* deck's `LayersPass` applies
//     its default draw parameters only when the device is WebGPU; on WebGL it
//     inherits luma.gl's pipeline defaults, which include no depth test at all.
//     Every existing deck usage in this app is interleaved through
//     `MapboxOverlay`, where MapLibre has already configured depth — so this has
//     never come up and a standalone view hits it on day one. It fails silently:
//     a back-to-front triangle order looks correctly occluded without any depth
//     test. Hence `DEPTH_PARAMETERS`, set on the layer here and owed by the host
//     on the `Deck` itself.

import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';

import {
  TERRAIN_DEM_ATTRIBUTION,
  TERRAIN_DEM_MAX_ZOOM,
  TERRAIN_DEM_TILE_SIZE,
  TERRAIN_DEM_URL,
  decodeTerrarium,
} from '../tile-sources.js';

/**
 * @typedef {import('../map-adapter.js').LatLng} LatLng
 * @typedef {import('../map-adapter.js').LatLngBounds} LatLngBounds
 * @typedef {import('../../../application/terrain/terrain-contracts.js').TerrainCoverage} TerrainCoverage
 */

/**
 * Which pyramid level the mesh reads.
 *
 * Measured: a 5 km box is 12 tiles and 1.34 MB at z14 (6.7 m/px), and 42 tiles
 * and 4.37 MB at z15 for detail no orthographic overview resolves.
 */
export const MESH_ZOOM = 14;

/**
 * The render grid's target spacing. Not a resolution claim about the DEM — it is
 * the decimation the mesh can afford, and the actual `cellSizeM` lands on a whole
 * number of DEM pixels near it (see `buildTerrainGrid`).
 */
export const TARGET_CELL_SIZE_M = 26;

/**
 * The depth state a standalone `Deck` does not set for itself.
 *
 * Exported because the host owes the same object on the `Deck` — the draw pass
 * reads deck-level parameters and the picking pass reads `layer.props.parameters`,
 * so setting one is half a fix.
 */
export const DEPTH_PARAMETERS = Object.freeze({
  depthWriteEnabled: true,
  depthCompare: /** @type {const} */ ('less-equal'),
});

/** WGS84 equatorial circumference, metres — Web Mercator's own constant. */
const EARTH_CIRCUMFERENCE_M = 40075016.686;

/** Lit like rock rather than plastic; the mesh is one flat colour plus normals. */
const TERRAIN_MATERIAL = Object.freeze({
  ambient: 0.45,
  diffuse: 0.7,
  shininess: 24,
  specularColor: /** @type {[number, number, number]} */ ([40, 44, 52]),
});

/** The mesh is already in world coordinates, so its one instance sits on zero. */
const MESH_ANCHOR = /** @type {[number, number, number]} */ ([0, 0, 0]);

/**
 * One tile of the covering rectangle, and where to get it.
 * @typedef {object} DemTile
 * @property {number} zoom
 * @property {number} x
 * @property {number} y
 * @property {string} url
 */

/**
 * A decoded tile handed to `buildTerrainGrid`: its index, and its pixels.
 * `rgba` is `TILE*TILE*4` bytes in the browser's own row-major order.
 * @typedef {object} DemTilePixels
 * @property {number} x
 * @property {number} y
 * @property {Uint8ClampedArray|Uint8Array} rgba
 */

/**
 * How much of the grid is real, and who said so. Structurally the advisory
 * grid's provenance block over a different set of points — same question, same
 * words for the answer.
 * @typedef {object} OrthoTerrainProvenance
 * @property {string} source
 * @property {string} attribution   the licence line the tiles require
 * @property {number} zoom          the level actually read, after clamping
 * @property {number} resolutionM   the DEM's own ground resolution at that level
 * @property {number} tilesRequested
 * @property {number} tilesDecoded
 * @property {number} cells
 * @property {number} missing       cells no tile could answer
 * @property {TerrainCoverage} coverage
 */

/**
 * The render grid. `AdvisoryGrid`'s vocabulary, backed by one `Float32Array`
 * instead of a cell array because this one is 35,000 cells rather than 576.
 *
 * Row-major, index = `row*cols + col`, **row 0 northernmost, col 0 westernmost** —
 * the same convention `AdvisoryGrid` carries, so a consumer never has to ask
 * which one it is holding. The mesh flips it once, visibly, where north becomes
 * +Y.
 *
 * @typedef {object} OrthoTerrainGrid
 * @property {number} rows
 * @property {number} cols
 * @property {number} cellSizeM     ground metres between samples, both axes
 * @property {LatLng} origin        the lattice centre; local metres are ENU about it
 * @property {LatLngBounds} bounds  what the lattice actually covers
 * @property {Float32Array} elevM   rows*cols metres MSL; NaN where nobody answered
 * @property {number|null} minM     over the cells that answered; null when none did
 * @property {number|null} maxM
 * @property {OrthoTerrainProvenance} provenance
 */

/**
 * An indexed triangle mesh in the grid's local metre frame.
 * @typedef {object} OrthoTerrainMesh
 * @property {Float32Array} positions  vertexCount*3, XY local metres, Z metres MSL
 * @property {Float32Array} normals    vertexCount*3, unit, +Z up
 * @property {Uint32Array} indices     triangleCount*3, CCW seen from above
 * @property {number} vertexCount
 * @property {number} triangleCount
 */

/* ---------- the tile rectangle ---------- */

// Web Mercator, in absolute pixels at a zoom rather than in tile fractions: the
// stitched raster is addressed in pixels, so carrying the tile size through every
// conversion is one fewer place to drop it.

/** @param {number} lng @param {number} zoom @returns {number} */
const lngToPixelX = (lng, zoom) => ((lng + 180) / 360) * TERRAIN_DEM_TILE_SIZE * 2 ** zoom;

/** @param {number} lat @param {number} zoom @returns {number} */
const latToPixelY = (lat, zoom) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI))
    * TERRAIN_DEM_TILE_SIZE * 2 ** zoom;
};

/** @param {number} px @param {number} zoom @returns {number} */
const pixelXToLng = (px, zoom) => (px / (TERRAIN_DEM_TILE_SIZE * 2 ** zoom)) * 360 - 180;

/** @param {number} py @param {number} zoom @returns {number} */
const pixelYToLat = (py, zoom) => {
  const n = Math.PI - (2 * Math.PI * py) / (TERRAIN_DEM_TILE_SIZE * 2 ** zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/**
 * One DEM pixel's ground size at a latitude. Web Mercator is conformal, so the
 * same figure holds on both axes locally — which is what lets one `cellSizeM`
 * describe a square lattice.
 * @param {number} zoom @param {number} lat @returns {number} metres
 */
function metresPerPixel(zoom, lat) {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180))
    / (TERRAIN_DEM_TILE_SIZE * 2 ** zoom);
}

/**
 * The zoom actually readable. The pyramid genuinely stops at z15 — asking for
 * z16 returns nothing — so this is a fact about the dataset, and it is clamped
 * rather than thrown because a caller deriving zoom from a viewport would rather
 * have the deepest real level than an exception. The level used is recorded in
 * the grid's provenance.
 * @param {number} zoom @returns {number}
 */
const clampZoom = (zoom) => Math.max(0, Math.min(TERRAIN_DEM_MAX_ZOOM, Math.floor(zoom)));

/** @param {LatLngBounds} bounds */
function assertBounds(bounds) {
  const sw = bounds?.southWest;
  const ne = bounds?.northEast;
  if (!Number.isFinite(sw?.lat) || !Number.isFinite(sw?.lng)
    || !Number.isFinite(ne?.lat) || !Number.isFinite(ne?.lng)) {
    throw new TypeError('ortho-terrain: bounds must be {southWest:{lat,lng}, northEast:{lat,lng}}');
  }
  if (ne.lat < sw.lat || ne.lng < sw.lng) {
    throw new TypeError('ortho-terrain: bounds are inverted');
  }
}

/**
 * The inclusive tile rectangle covering a box.
 *
 * @param {LatLngBounds} bounds
 * @param {number} [zoom]
 * @returns {{ zoom: number, x0: number, x1: number, y0: number, y1: number,
 *            tilesX: number, tilesY: number, count: number }}
 */
export function demTileRect(bounds, zoom = MESH_ZOOM) {
  assertBounds(bounds);
  const z = clampZoom(zoom);
  const span = 2 ** z;
  const clamp = (/** @type {number} */ i) => Math.max(0, Math.min(span - 1, i));
  const x0 = clamp(Math.floor(lngToPixelX(bounds.southWest.lng, z) / TERRAIN_DEM_TILE_SIZE));
  const x1 = clamp(Math.floor(lngToPixelX(bounds.northEast.lng, z) / TERRAIN_DEM_TILE_SIZE));
  // Mercator Y grows southward, so the north edge gives the low index.
  const y0 = clamp(Math.floor(latToPixelY(bounds.northEast.lat, z) / TERRAIN_DEM_TILE_SIZE));
  const y1 = clamp(Math.floor(latToPixelY(bounds.southWest.lat, z) / TERRAIN_DEM_TILE_SIZE));
  const tilesX = x1 - x0 + 1;
  const tilesY = y1 - y0 + 1;
  return { zoom: z, x0, x1, y0, y1, tilesX, tilesY, count: tilesX * tilesY };
}

/**
 * Every tile covering a box, row-major from the north-west corner.
 *
 * The endpoint is `TERRAIN_DEM_URL` — the same tiles MapLibre already draws the
 * 3D scene's terrain from, which is what makes the orthographic view a second
 * reader of a source the app ships rather than a new dependency on the world.
 *
 * @param {LatLngBounds} bounds
 * @param {number} [zoom]
 * @returns {DemTile[]}
 */
export function demTiles(bounds, zoom = MESH_ZOOM) {
  const rect = demTileRect(bounds, zoom);
  /** @type {DemTile[]} */
  const out = [];
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      out.push({
        zoom: rect.zoom,
        x,
        y,
        url: TERRAIN_DEM_URL
          .replace('{z}', String(rect.zoom))
          .replace('{x}', String(x))
          .replace('{y}', String(y)),
      });
    }
  }
  return out;
}

/* ---------- decode: bytes to metres ---------- */

/**
 * One tile's pixels, decoded to metres MSL.
 *
 * The length check is not defensive noise: a buffer of the wrong size decodes
 * without complaint into a raster that is sheared by a row, which draws a
 * plausible-looking wrong mountain. A decode error, by contrast, is never subtle
 * — a wrong encoding puts a summit at −32,000 m.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba  size*size*4 bytes
 * @param {number} [size]
 * @returns {Float32Array}
 */
export function decodeTileHeights(rgba, size = TERRAIN_DEM_TILE_SIZE) {
  const expected = size * size * 4;
  if (!rgba || rgba.length !== expected) {
    throw new TypeError(`ortho-terrain: expected ${expected} RGBA bytes, got ${rgba?.length}`);
  }
  const out = new Float32Array(size * size);
  for (let i = 0, at = 0; i < out.length; i++, at += 4) {
    out[i] = decodeTerrarium(rgba[at], rgba[at + 1], rgba[at + 2]);
  }
  return out;
}

/* ---------- the grid ---------- */

/**
 * Stitch decoded tiles into one grid over `bounds`.
 *
 * Pure: bytes in, numbers out, no canvas and no network — `loadTerrainGrid()` is
 * the half that fetches.
 *
 * The lattice is a *subsample of the DEM's own pixels*, not a resampling of them.
 * `cellSizeM` is a whole number of pixels near `targetCellSizeM` (at z14 and 45°,
 * 4 px ≈ 26.8 m), so every height in the grid is a value the pyramid actually
 * published rather than a bilinear blend of four of them. Which also means the
 * grid's size is decided by the tiles and the box, not by a fixed sample count.
 *
 * A tile that is absent from `tiles` leaves its pixels NaN. That is the whole of
 * the failure handling here, and it is deliberate: three tiles of four is a
 * usable mesh with a stated hole in it, and throwing would throw away the three.
 *
 * @param {object} opts
 * @param {LatLngBounds} opts.bounds
 * @param {readonly DemTilePixels[]} opts.tiles
 * @param {number} [opts.zoom]
 * @param {number} [opts.targetCellSizeM]
 * @returns {OrthoTerrainGrid}
 */
export function buildTerrainGrid({
  bounds, tiles, zoom = MESH_ZOOM, targetCellSizeM = TARGET_CELL_SIZE_M,
}) {
  const rect = demTileRect(bounds, zoom);
  const z = rect.zoom;
  const tile = TERRAIN_DEM_TILE_SIZE;

  const rasterCols = rect.tilesX * tile;
  const rasterRows = rect.tilesY * tile;
  const raster = new Float32Array(rasterCols * rasterRows).fill(NaN);

  let tilesDecoded = 0;
  for (const supplied of tiles ?? []) {
    if (supplied.x < rect.x0 || supplied.x > rect.x1
      || supplied.y < rect.y0 || supplied.y > rect.y1) continue;
    const heights = decodeTileHeights(supplied.rgba, tile);
    const ox = (supplied.x - rect.x0) * tile;
    const oy = (supplied.y - rect.y0) * tile;
    for (let py = 0; py < tile; py++) {
      raster.set(heights.subarray(py * tile, (py + 1) * tile), (oy + py) * rasterCols + ox);
    }
    tilesDecoded++;
  }

  // The pixel window covering the box, in absolute pixels, clipped to the raster
  // the tiles actually span. A DEM pixel carries the elevation at its top-left
  // corner (tilezen's convention), so a pixel index converts straight back to a
  // coordinate with no half-pixel shift.
  const left = rect.x0 * tile;
  const top = rect.y0 * tile;
  const px0 = Math.max(left, Math.floor(lngToPixelX(bounds.southWest.lng, z)));
  const px1 = Math.min(left + rasterCols - 1, Math.ceil(lngToPixelX(bounds.northEast.lng, z)));
  const py0 = Math.max(top, Math.floor(latToPixelY(bounds.northEast.lat, z)));
  const py1 = Math.min(top + rasterRows - 1, Math.ceil(latToPixelY(bounds.southWest.lat, z)));

  const centreLat = (bounds.southWest.lat + bounds.northEast.lat) / 2;
  const pixelM = metresPerPixel(z, centreLat);
  const step = Math.max(1, Math.round(targetCellSizeM / pixelM));
  const cellSizeM = step * pixelM;
  const cols = Math.floor((px1 - px0) / step) + 1;
  const rows = Math.floor((py1 - py0) / step) + 1;

  const elevM = new Float32Array(rows * cols);
  let minM = Infinity;
  let maxM = -Infinity;
  let missing = 0;
  for (let row = 0; row < rows; row++) {
    const rasterRow = py0 + row * step - top;
    for (let col = 0; col < cols; col++) {
      const h = raster[rasterRow * rasterCols + (px0 + col * step - left)];
      elevM[row * cols + col] = h;
      if (Number.isFinite(h)) {
        if (h < minM) minM = h;
        if (h > maxM) maxM = h;
      } else {
        missing++;
      }
    }
  }

  const answered = rows * cols - missing;
  return {
    rows,
    cols,
    cellSizeM,
    origin: {
      lat: pixelYToLat(py0 + ((rows - 1) * step) / 2, z),
      lng: pixelXToLng(px0 + ((cols - 1) * step) / 2, z),
    },
    bounds: {
      southWest: {
        lat: pixelYToLat(py0 + (rows - 1) * step, z),
        lng: pixelXToLng(px0, z),
      },
      northEast: {
        lat: pixelYToLat(py0, z),
        lng: pixelXToLng(px0 + (cols - 1) * step, z),
      },
    },
    elevM,
    minM: answered ? minM : null,
    maxM: answered ? maxM : null,
    provenance: {
      source: 'AWS Terrain Tiles (terrarium)',
      attribution: TERRAIN_DEM_ATTRIBUTION,
      zoom: z,
      resolutionM: pixelM,
      tilesRequested: rect.count,
      tilesDecoded,
      cells: rows * cols,
      missing,
      coverage: missing === 0 ? 'complete' : (answered === 0 ? 'empty' : 'partial'),
    },
  };
}

/**
 * Fetch the covering tiles and decode them into a grid. The browser half.
 *
 * `premultiplyAlpha: 'none'` and `colorSpaceConversion: 'none'` are not cosmetic.
 * A terrarium tile is not a picture: its bytes are one number split across three
 * channels, and any colour management the browser applies on the way into a
 * canvas silently rewrites elevations. The tiles are colour type 2 (no alpha), so
 * premultiplication is a no-op today — it is set anyway, because "today" is a
 * property of the encoder, not of this code.
 *
 * A tile that fails to fetch or decode is dropped, not thrown: see
 * `buildTerrainGrid`.
 *
 * @param {object} opts
 * @param {LatLngBounds} opts.bounds
 * @param {number} [opts.zoom]
 * @param {number} [opts.targetCellSizeM]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<OrthoTerrainGrid>}
 */
export async function loadTerrainGrid({
  bounds, zoom = MESH_ZOOM, targetCellSizeM = TARGET_CELL_SIZE_M, signal,
}) {
  const wanted = demTiles(bounds, zoom);
  const loaded = await Promise.all(wanted.map(async (t) => {
    try {
      const res = await fetch(t.url, { signal });
      if (!res.ok) return null;
      const rgba = await tilePixels(await res.blob());
      return { x: t.x, y: t.y, rgba };
    } catch {
      // A dead tile is a hole in the grid, which the grid can say out loud.
      return null;
    }
  }));
  return buildTerrainGrid({
    bounds,
    zoom,
    targetCellSizeM,
    tiles: /** @type {DemTilePixels[]} */ (loaded.filter(Boolean)),
  });
}

/**
 * One tile blob's raw RGBA. The only DOM in this file.
 * @param {Blob} blob
 * @returns {Promise<Uint8ClampedArray>}
 */
async function tilePixels(blob) {
  const size = TERRAIN_DEM_TILE_SIZE;
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  try {
    const ctx = new OffscreenCanvas(size, size).getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('ortho-terrain: no 2d context to decode a DEM tile in');
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, size, size).data;
  } finally {
    bitmap.close();
  }
}

/* ---------- the mesh ---------- */

/**
 * The grid as an indexed triangle mesh, in local metres about `grid.origin`.
 *
 * Z is metres MSL and nothing else — no exaggeration is applied here. The
 * MapLibre scene multiplies its route Z by the terrain slider because MapLibre
 * scales the mesh out from under it; this mesh *is* the terrain, so anything
 * scaling it has to scale the route in the same pass, and that decision belongs
 * to whoever owns both.
 *
 * Normals come from the height field analytically rather than by accumulating
 * face normals: the lattice is regular, so the surface gradient is two central
 * differences and one normalise per vertex — exact, and an order of magnitude
 * less work than the general case. A single-colour mesh reads as terrain only
 * because of them, so they are not optional polish.
 *
 * Triangles touching a cell nobody answered are not emitted. A hole in the DEM
 * is a hole in the mesh; the alternative is a surface at sea level that looks
 * like a lake.
 *
 * @param {OrthoTerrainGrid} grid
 * @returns {OrthoTerrainMesh}
 */
export function buildTerrainMesh(grid) {
  const { rows, cols, cellSizeM, elevM } = grid;
  const count = rows * cols;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);

  // Row 0 is the northernmost, +Y is north: the one flip between the grid's
  // storage order and the mesh's world, done here where it is visible.
  const halfX = ((cols - 1) * cellSizeM) / 2;
  const halfY = ((rows - 1) * cellSizeM) / 2;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const h = elevM[i];
      const at = i * 3;
      positions[at] = col * cellSizeM - halfX;
      positions[at + 1] = halfY - row * cellSizeM;
      if (!Number.isFinite(h)) {
        // An absent vertex is never referenced by a triangle. Z stays 0 as a
        // placeholder for a point nothing draws, not as a claim about sea level,
        // and the normal points up so no NaN can reach a vertex buffer.
        normals[at + 2] = 1;
        continue;
      }
      positions[at + 2] = h;

      // Central differences over whichever neighbours answered — a missing one is
      // not spanned rather than being read as a cliff. Subtracted in the order
      // that yields the normal's horizontal components directly: the surface
      // normal is (-∂h/∂x, -∂h/∂y, 1) normalised, and writing the negation into
      // the difference keeps flat ground at exactly (0, 0, 1).
      const west = col > 0 ? elevM[i - 1] : NaN;
      const east = col < cols - 1 ? elevM[i + 1] : NaN;
      const north = row > 0 ? elevM[i - cols] : NaN;
      const south = row < rows - 1 ? elevM[i + cols] : NaN;
      const spanX = (Number.isFinite(west) ? 1 : 0) + (Number.isFinite(east) ? 1 : 0);
      const spanY = (Number.isFinite(north) ? 1 : 0) + (Number.isFinite(south) ? 1 : 0);
      const nx = spanX
        ? ((Number.isFinite(west) ? west : h) - (Number.isFinite(east) ? east : h))
          / (spanX * cellSizeM)
        : 0;
      const ny = spanY
        ? ((Number.isFinite(south) ? south : h) - (Number.isFinite(north) ? north : h))
          / (spanY * cellSizeM)
        : 0;
      const len = Math.hypot(nx, ny, 1);
      normals[at] = nx / len;
      normals[at + 1] = ny / len;
      normals[at + 2] = 1 / len;
    }
  }

  // Uint32 unconditionally: a 512-sample grid is 262,144 vertices, well past what
  // Uint16 addresses, and WebGL2 has no trouble with 32-bit indices. A silent
  // overflow here would draw a plausible-looking wrong mountain.
  const quads = Math.max(0, rows - 1) * Math.max(0, cols - 1);
  const full = new Uint32Array(quads * 6);
  let at = 0;
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const nw = row * cols + col;
      const ne = nw + 1;
      const sw = nw + cols;
      const se = sw + 1;
      if (!Number.isFinite(elevM[nw]) || !Number.isFinite(elevM[ne])
        || !Number.isFinite(elevM[sw]) || !Number.isFinite(elevM[se])) continue;
      // Counter-clockwise seen from +Z, so front faces point at the sky. With
      // row 0 north, "south-west first" is what makes that true.
      full[at++] = sw; full[at++] = se; full[at++] = ne;
      full[at++] = sw; full[at++] = ne; full[at++] = nw;
    }
  }
  const indices = at === full.length ? full : full.slice(0, at);

  return { positions, normals, indices, vertexCount: count, triangleCount: at / 3 };
}

/* ---------- the height query ---------- */

/**
 * The ground at a point, in the mesh's own local metre frame.
 *
 * This is the picking fix the spike's verdict mandates, not a convenience:
 * deck's `pickObject` is not depth-correct against terrain, so a click on a
 * mountainside can return a waypoint buried inside the mountain. Rejecting a hit
 * whose world Z is below `groundAt(grid, x, y)` is the only thing that makes a
 * pick mean what it looks like.
 *
 * Answers `null` rather than a number in three cases, all of them the same rule:
 * outside the lattice, on a grid too small to interpolate across, and where any
 * of the four surrounding cells is absent. Absence is a value, and interpolating
 * across a hole would invent ground.
 *
 * @param {OrthoTerrainGrid} grid
 * @param {number} x  metres east of `grid.origin`
 * @param {number} y  metres north of `grid.origin`
 * @returns {number|null} metres MSL
 */
export function groundAt(grid, x, y) {
  const { rows, cols, cellSizeM, elevM } = grid;
  if (rows < 2 || cols < 2) return null;
  const fx = (x + ((cols - 1) * cellSizeM) / 2) / cellSizeM;
  const fy = (((rows - 1) * cellSizeM) / 2 - y) / cellSizeM;
  // NaN fails every comparison, so a NaN coordinate lands here rather than
  // indexing with one.
  if (!(fx >= 0 && fx <= cols - 1 && fy >= 0 && fy <= rows - 1)) return null;

  const col = Math.min(cols - 2, Math.floor(fx));
  const row = Math.min(rows - 2, Math.floor(fy));
  const tx = fx - col;
  const ty = fy - row;
  const at = row * cols + col;
  const nw = elevM[at];
  const ne = elevM[at + 1];
  const sw = elevM[at + cols];
  const se = elevM[at + cols + 1];
  if (!Number.isFinite(nw) || !Number.isFinite(ne)
    || !Number.isFinite(sw) || !Number.isFinite(se)) return null;

  return nw * (1 - tx) * (1 - ty)
    + ne * tx * (1 - ty)
    + sw * (1 - tx) * ty
    + se * tx * ty;
}

/* ---------- the layer ---------- */

/**
 * The terrain, as the one layer that draws it.
 *
 * `_instanced: false` because there is exactly one mesh and it is already in
 * world coordinates; deck's default would place a copy of it at every datum.
 * `getColor` defaults to white rather than deck's black — the material multiplies
 * through it, and black renders a perfectly correct, perfectly invisible
 * mountain.
 *
 * @param {object} opts
 * @param {OrthoTerrainMesh} opts.mesh
 * @param {string} [opts.id]
 * @param {[number, number, number]} [opts.color]
 * @param {boolean} [opts.wireframe]
 * @param {boolean} [opts.pickable]
 * @returns {SimpleMeshLayer}
 */
export function orthoTerrainLayer({
  mesh, id = 'ortho-terrain', color = [255, 255, 255], wireframe = false, pickable = false,
}) {
  return new SimpleMeshLayer({
    id,
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    // Repeated from the Deck's own parameters on purpose: the picking pass builds
    // its state from `layer.props.parameters`, not from the deck-level ones.
    parameters: { ...DEPTH_PARAMETERS },
    data: [{ kind: 'terrain' }],
    mesh: {
      attributes: {
        POSITION: { value: mesh.positions, size: 3 },
        NORMAL: { value: mesh.normals, size: 3 },
      },
      indices: { value: mesh.indices, size: 1 },
    },
    getPosition: () => MESH_ANCHOR,
    getColor: color,
    _instanced: false,
    wireframe,
    material: { ...TERRAIN_MATERIAL },
    pickable,
  });
}
