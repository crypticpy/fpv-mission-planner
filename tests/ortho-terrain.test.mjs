import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MESH_ZOOM,
  buildTerrainGrid,
  buildTerrainMesh,
  decodeTileHeights,
  demTileRect,
  demTiles,
  groundAt,
} from '../src/presentation/map/scene3d/ortho-terrain.js';
import { TERRAIN_DEM_TILE_SIZE, decodeTerrarium } from '../src/presentation/map/tile-sources.js';

/* The orthographic view's terrain, tested where it can be: in node, with no
 * network and no canvas.
 *
 * Everything here is the pure half of ortho-terrain.js, and the split exists for
 * this reason — `loadTerrainGrid()` fetches and reads a canvas and is a browser
 * spec's problem, while every arithmetic step that can be silently wrong is
 * below.
 *
 * Four of these carry real weight:
 *
 *   *The decode.* We own `elevation_m = R*256 + G + B/256 - 32768` now. It is
 *     four lines and it is our bug surface, so the triples below are computed by
 *     hand rather than by running the function and pasting what it said.
 *
 *   *The tile rectangle.* Asking for the wrong tiles draws the wrong mountain
 *     without erroring. The fixture box is the spike's Mount Hood box and the
 *     expected rectangles are the ones SPIKE-VERDICT.md measured against the live
 *     endpoint — 1 / 4 / 12 / 42 tiles at z12–z15.
 *
 *   *The stitch.* An off-by-one tile offset puts the west half of the DEM in the
 *     east, which looks like terrain. Four tiles of four distinct constant
 *     heights catch it; nothing subtler does.
 *
 *   *groundAt vs the mesh.* A stem stands on `groundAt()` and the eye sees the
 *     mesh. If those two disagree the view lies about where the ground is, which
 *     is the one failure this whole feature exists to prevent. */

const TILE = TERRAIN_DEM_TILE_SIZE;

/* Mount Hood, 45.3736 / −121.696, a 5 km box — the spike's fixture, and the box
 * every measured figure in the verdict is about. The local flat projection is
 * the spike's too: over ±2.5 km its error against a geodesic is centimetres. */
const HOOD = { lat: 45.3736, lng: -121.696 };
const HALF_SPAN_M = 2500;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((HOOD.lat * Math.PI) / 180);
const HOOD_BOX = {
  southWest: {
    lat: HOOD.lat - HALF_SPAN_M / M_PER_DEG_LAT,
    lng: HOOD.lng - HALF_SPAN_M / M_PER_DEG_LNG,
  },
  northEast: {
    lat: HOOD.lat + HALF_SPAN_M / M_PER_DEG_LAT,
    lng: HOOD.lng + HALF_SPAN_M / M_PER_DEG_LNG,
  },
};

/* Web Mercator, written out again rather than imported: a tile-index test that
 * borrows the module's own conversion proves only that it is self-consistent. */
const pixelXToLng = (px, z) => (px / (TILE * 2 ** z)) * 360 - 180;
const pixelYToLat = (py, z) => {
  const n = Math.PI - (2 * Math.PI * py) / (TILE * 2 ** z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/**
 * A box pinned to absolute pixel coordinates at a zoom, inset a quarter pixel so
 * the module's floor/ceil land on exactly the pixels named here rather than on
 * whichever side of an integer the last bit of a cosine fell.
 */
const boxOfPixels = (z, px0, py0, px1, py1) => ({
  southWest: { lat: pixelYToLat(py1 - 0.25, z), lng: pixelXToLng(px0 + 0.25, z) },
  northEast: { lat: pixelYToLat(py0 + 0.25, z), lng: pixelXToLng(px1 - 0.25, z) },
});

/** A terrarium tile whose every pixel is `heightAt(px, py)` metres. */
function tileBytes(heightAt, size = TILE) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const v = Math.round((heightAt(px, py) + 32768) * 256); // in 1/256 m units
      const at = (py * size + px) * 4;
      rgba[at] = (v >> 16) & 0xff;
      rgba[at + 1] = (v >> 8) & 0xff;
      rgba[at + 2] = v & 0xff;
      rgba[at + 3] = 255;
    }
  }
  return rgba;
}

/** A grid literal, for the mesh and sampler tests. Row 0 is northernmost. */
const gridOf = (rows, cols, cellSizeM, heights) => ({
  rows,
  cols,
  cellSizeM,
  origin: { lat: 0, lng: 0 },
  bounds: { southWest: { lat: 0, lng: 0 }, northEast: { lat: 0, lng: 0 } },
  elevM: Float32Array.from(heights),
  minM: null,
  maxM: null,
  provenance: /** @type {never} */ (null),
});

/* ---------- the decode ---------- */

test('decodeTerrarium against hand-computed triples, sea level and below included', () => {
  // 128*256 - 32768 = 0. The one triple where a sign error is invisible in the
  // output and obvious in the input, so it is worth naming.
  assert.equal(decodeTerrarium(128, 0, 0), 0);

  // Mount Hood, 3429 m: 32768 + 3429 = 36197 = 141*256 + 101.
  assert.equal(decodeTerrarium(141, 101, 0), 3429);

  // The Dead Sea shore, −430 m: 32768 − 430 = 32338 = 126*256 + 82. Below sea
  // level is a real elevation, not an absence and not a clamp.
  assert.equal(decodeTerrarium(126, 82, 0), -430);

  // A whole channel below the offset: 127*256 − 32768.
  assert.equal(decodeTerrarium(127, 0, 0), -256);

  // The blue channel is 1/256 m, so it is where a plain integer decode hides.
  assert.equal(decodeTerrarium(128, 0, 128), 0.5);
  assert.equal(decodeTerrarium(128, 0, 1), 1 / 256);

  // The two ends of the encoding.
  assert.equal(decodeTerrarium(0, 0, 0), -32768);
  assert.equal(decodeTerrarium(255, 255, 255), 32767.99609375);

  // One 1/256 m under sea level — the case an unsigned decode reads as +32,767.
  assert.equal(decodeTerrarium(127, 255, 255), -1 / 256);
});

test('decodeTileHeights walks RGBA row-major and refuses a buffer of the wrong size', () => {
  // 2x2, four distinct heights, written out as bytes by hand.
  const rgba = Uint8ClampedArray.from([
    128, 0, 0, 255, // 0 m
    141, 101, 0, 255, // 3429 m
    126, 82, 0, 255, // -430 m
    128, 0, 128, 255, // 0.5 m
  ]);
  assert.deepEqual([...decodeTileHeights(rgba, 2)], [0, 3429, -430, 0.5]);

  // A short buffer decodes into a raster sheared by a row if nobody looks.
  assert.throws(() => decodeTileHeights(rgba.slice(0, 12), 2), TypeError);
  assert.throws(() => decodeTileHeights(rgba, 4), TypeError);
  assert.throws(() => decodeTileHeights(null, 2), TypeError);
});

test('a synthesised tile round-trips through the decode', () => {
  const heights = decodeTileHeights(tileBytes((px, py) => px * 2 - py, 8), 8);
  for (let py = 0; py < 8; py++) {
    for (let px = 0; px < 8; px++) {
      assert.equal(heights[py * 8 + px], px * 2 - py);
    }
  }
});

/* ---------- the tile rectangle ---------- */

test('the Mount Hood box walks the tile rectangle the spike measured', () => {
  // SPIKE-VERDICT.md, "The DEM download for one planning box": 1 / 4 / 12 / 42
  // tiles at z12–z15, fetched against the live endpoint.
  assert.deepEqual(demTileRect(HOOD_BOX, 12), {
    zoom: 12, x0: 663, x1: 663, y0: 1467, y1: 1467, tilesX: 1, tilesY: 1, count: 1,
  });
  assert.deepEqual(demTileRect(HOOD_BOX, 13), {
    zoom: 13, x0: 1326, x1: 1327, y0: 2934, y1: 2935, tilesX: 2, tilesY: 2, count: 4,
  });
  assert.deepEqual(demTileRect(HOOD_BOX, 14), {
    zoom: 14, x0: 2652, x1: 2654, y0: 5868, y1: 5871, tilesX: 3, tilesY: 4, count: 12,
  });
  assert.equal(demTileRect(HOOD_BOX, 15).count, 42);
  assert.equal(demTileRect(HOOD_BOX).zoom, MESH_ZOOM, 'z14 by default: 12 tiles, 1.34 MB');
});

test('demTiles lists exactly those tiles, north-west first, at the shipped endpoint', () => {
  const tiles = demTiles(HOOD_BOX, 14);
  assert.equal(tiles.length, 12);

  const expected = [];
  for (let y = 5868; y <= 5871; y++) for (let x = 2652; x <= 2654; x++) expected.push(`14/${x}/${y}`);
  assert.deepEqual(tiles.map((t) => `${t.zoom}/${t.x}/${t.y}`), expected);

  assert.equal(tiles[0].url,
    'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/14/2652/5868.png');
  assert.equal(tiles[11].url,
    'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/14/2654/5871.png');
  assert.ok(tiles.every((t) => !t.url.includes('{')), 'every placeholder is filled');
});

test('the pyramid stops at z15, so a deeper request is clamped rather than fetched blind', () => {
  const deep = demTileRect(HOOD_BOX, 18);
  assert.equal(deep.zoom, 15);
  assert.deepEqual(deep, demTileRect(HOOD_BOX, 15));
  assert.equal(demTiles(HOOD_BOX, 99)[0].url.includes('/15/'), true);
});

test('a box that is not a box is a TypeError, not an empty tile list', () => {
  assert.throws(() => demTileRect(null, 14), TypeError);
  assert.throws(() => demTileRect({ southWest: { lat: 1 }, northEast: { lat: 2, lng: 2 } }, 14), TypeError);
  assert.throws(() => demTileRect({
    southWest: { lat: NaN, lng: 0 }, northEast: { lat: 1, lng: 1 },
  }, 14), TypeError);
  assert.throws(() => demTileRect({
    southWest: { lat: 46, lng: 0 }, northEast: { lat: 45, lng: 1 },
  }, 14), TypeError, 'north below south is inverted, not a zero-height box');
});

/* ---------- the stitch ---------- */

test('a one-tile box lands the DEM pixels on the grid, decimated to render density', () => {
  // A 64 px window inside one tile at z14, so the grid is small enough to check
  // cell by cell. Height = the pixel's own column, which makes every sample say
  // where it came from.
  const z = 14;
  const [x, y] = [2652, 5868];
  const px0 = x * TILE;
  const py0 = y * TILE;
  const grid = buildTerrainGrid({
    bounds: boxOfPixels(z, px0, py0, px0 + 64, py0 + 64),
    zoom: z,
    targetCellSizeM: 26,
    tiles: [{ x, y, rgba: tileBytes((px, py) => px * 100 + py) }],
  });

  // 26 m over a 6.71 m pixel is 4 pixels, and the cell size is the DEM's own
  // spacing rather than the number that was asked for.
  assert.equal(grid.cols, 17, '(64 px window / 4 px step) + 1');
  assert.equal(grid.rows, 17);
  assert.equal(grid.cellSizeM, 4 * grid.provenance.resolutionM,
    'the cell size is a whole number of DEM pixels, not the number that was asked for');
  assert.ok(Math.abs(grid.provenance.resolutionM - 6.71) < 0.01,
    `z14 is ~6.7 m/px at this latitude, got ${grid.provenance.resolutionM}`);

  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      assert.equal(grid.elevM[row * grid.cols + col], (col * 4) * 100 + row * 4);
    }
  }
  assert.equal(grid.minM, 0);
  assert.equal(grid.maxM, 64 * 100 + 64);
  assert.equal(grid.provenance.coverage, 'complete');
  assert.equal(grid.provenance.missing, 0);
  assert.equal(grid.provenance.tilesRequested, 1);
  assert.equal(grid.provenance.tilesDecoded, 1);
  assert.equal(grid.provenance.attribution, 'Terrain: Mapzen/AWS Terrain Tiles');
});

test('four tiles stitch into four quadrants — west stays west, north stays north', () => {
  // The failure this catches is an offset that mirrors or rotates the raster,
  // which is invisible in anything but a mountain you already know.
  const z = 10;
  const [x0, y0] = [163, 366];
  const constant = { nw: 100, ne: 200, sw: 300, se: 400 };
  const grid = buildTerrainGrid({
    bounds: boxOfPixels(z, x0 * TILE, y0 * TILE, (x0 + 2) * TILE, (y0 + 2) * TILE),
    zoom: z,
    targetCellSizeM: 4000,
    tiles: [
      { x: x0, y: y0, rgba: tileBytes(() => constant.nw) },
      { x: x0 + 1, y: y0, rgba: tileBytes(() => constant.ne) },
      { x: x0, y: y0 + 1, rgba: tileBytes(() => constant.sw) },
      { x: x0 + 1, y: y0 + 1, rgba: tileBytes(() => constant.se) },
    ],
  });

  assert.equal(grid.provenance.tilesDecoded, 4);
  assert.equal(grid.provenance.coverage, 'complete');
  const quadrant = (row, col) => grid.elevM[row * grid.cols + col];
  const lastRow = grid.rows - 1;
  const lastCol = grid.cols - 1;
  assert.equal(quadrant(0, 0), constant.nw);
  assert.equal(quadrant(0, lastCol), constant.ne);
  assert.equal(quadrant(lastRow, 0), constant.sw);
  assert.equal(quadrant(lastRow, lastCol), constant.se);

  // And the grid's own bounds run the way its indices do.
  assert.ok(grid.bounds.northEast.lat > grid.bounds.southWest.lat);
  assert.ok(grid.bounds.northEast.lng > grid.bounds.southWest.lng);
  assert.ok(grid.origin.lat > grid.bounds.southWest.lat && grid.origin.lat < grid.bounds.northEast.lat);
  assert.ok(grid.origin.lng > grid.bounds.southWest.lng && grid.origin.lng < grid.bounds.northEast.lng);
});

test('a tile nobody could fetch is a hole in the grid, not a lake at sea level', () => {
  const z = 10;
  const [x0, y0] = [163, 366];
  const grid = buildTerrainGrid({
    bounds: boxOfPixels(z, x0 * TILE, y0 * TILE, (x0 + 2) * TILE, (y0 + 2) * TILE),
    zoom: z,
    targetCellSizeM: 4000,
    tiles: [
      { x: x0, y: y0, rgba: tileBytes(() => 1500) },
      { x: x0 + 1, y: y0, rgba: tileBytes(() => 1500) },
      { x: x0, y: y0 + 1, rgba: tileBytes(() => 1500) },
      // the south-east tile never arrived
    ],
  });

  assert.equal(grid.provenance.tilesRequested, 4);
  assert.equal(grid.provenance.tilesDecoded, 3);
  assert.equal(grid.provenance.coverage, 'partial');
  assert.ok(grid.provenance.missing > 0);
  assert.ok(Number.isNaN(grid.elevM[(grid.rows - 1) * grid.cols + (grid.cols - 1)]),
    'the missing quadrant is NaN');
  // The range is over what answered. A 0 here would be the sea-level lie.
  assert.equal(grid.minM, 1500);
  assert.equal(grid.maxM, 1500);
});

test('a grid with no tiles at all says so rather than describing flat ground', () => {
  const z = 10;
  const grid = buildTerrainGrid({
    bounds: boxOfPixels(z, 163 * TILE, 366 * TILE, 164 * TILE, 367 * TILE),
    zoom: z,
    targetCellSizeM: 4000,
    tiles: [],
  });
  assert.equal(grid.provenance.coverage, 'empty');
  assert.equal(grid.provenance.missing, grid.provenance.cells);
  assert.equal(grid.minM, null);
  assert.equal(grid.maxM, null);
  assert.ok([...grid.elevM].every(Number.isNaN));
});

test('a tile outside the covering rectangle is ignored, not blitted somewhere wrong', () => {
  const z = 10;
  const [x0, y0] = [163, 366];
  const grid = buildTerrainGrid({
    bounds: boxOfPixels(z, x0 * TILE, y0 * TILE, x0 * TILE + 128, y0 * TILE + 128),
    zoom: z,
    targetCellSizeM: 4000,
    tiles: [
      { x: x0, y: y0, rgba: tileBytes(() => 800) },
      { x: x0 + 9, y: y0 + 9, rgba: tileBytes(() => -999) },
    ],
  });
  assert.equal(grid.provenance.tilesDecoded, 1);
  assert.ok([...grid.elevM].every((h) => h === 800));
});

/* ---------- the mesh ---------- */

test('mesh topology: one vertex per cell, two triangles per quad, indices in range', () => {
  const rows = 5;
  const cols = 4;
  const grid = gridOf(rows, cols, 10, Array.from({ length: rows * cols }, (_, i) => i));
  const mesh = buildTerrainMesh(grid);

  assert.equal(mesh.vertexCount, rows * cols);
  assert.equal(mesh.positions.length, rows * cols * 3);
  assert.equal(mesh.normals.length, rows * cols * 3);
  assert.equal(mesh.triangleCount, (rows - 1) * (cols - 1) * 2);
  assert.equal(mesh.indices.length, mesh.triangleCount * 3);
  assert.ok(mesh.indices instanceof Uint32Array, 'Uint16 would overflow past 256 samples per axis');
  assert.ok([...mesh.indices].every((i) => i >= 0 && i < mesh.vertexCount));
});

test('mesh positions are local metres about the grid centre, Z is metres MSL', () => {
  // 3x3 at 100 m, so the lattice runs -100..+100 on both axes.
  const heights = [10, 20, 30, 40, 50, 60, 70, 80, 90];
  const mesh = buildTerrainMesh(gridOf(3, 3, 100, heights));
  const vertex = (i) => [...mesh.positions.slice(i * 3, i * 3 + 3)];

  // Row 0 is northernmost, so index 0 is the NORTH-west corner: +Y, -X.
  assert.deepEqual(vertex(0), [-100, 100, 10]);
  assert.deepEqual(vertex(2), [100, 100, 30]);
  assert.deepEqual(vertex(4), [0, 0, 50], 'the centre cell sits on the origin');
  assert.deepEqual(vertex(6), [-100, -100, 70]);
  assert.deepEqual(vertex(8), [100, -100, 90]);
});

test('the first quad is the south-west one, wound counter-clockwise seen from above', () => {
  const mesh = buildTerrainMesh(gridOf(2, 2, 50, [1, 2, 3, 4]));
  // nw=0 ne=1 sw=2 se=3, and the winding is stated so a future edit cannot flip
  // the surface inside out and call it a lighting bug.
  assert.deepEqual([...mesh.indices], [2, 3, 1, 2, 1, 0]);

  // Cross product of the projected triangle: positive is counter-clockwise with
  // +X east and +Y north, which is what puts front faces at the sky.
  for (let t = 0; t < mesh.triangleCount; t++) {
    const [a, b, c] = [...mesh.indices.slice(t * 3, t * 3 + 3)];
    const p = (i) => [mesh.positions[i * 3], mesh.positions[i * 3 + 1]];
    const [ax, ay] = p(a); const [bx, by] = p(b); const [cx, cy] = p(c);
    const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    assert.ok(cross > 0, `triangle ${t} is wound clockwise (${cross})`);
  }
});

test('normals: flat ground points straight up, a slope leans away from the rise', () => {
  const flat = buildTerrainMesh(gridOf(3, 3, 100, Array(9).fill(1200)));
  for (let i = 0; i < 9; i++) {
    assert.deepEqual([...flat.normals.slice(i * 3, i * 3 + 3)], [0, 0, 1]);
  }

  // Rising 100 m per 100 m eastward: a 45° slope, normal (-1,0,1)/√2.
  const east = buildTerrainMesh(gridOf(3, 3, 100, [0, 100, 200, 0, 100, 200, 0, 100, 200]));
  const centre = [...east.normals.slice(4 * 3, 4 * 3 + 3)];
  assert.ok(Math.abs(centre[0] + Math.SQRT1_2) < 1e-6, `nx was ${centre[0]}`);
  assert.ok(Math.abs(centre[1]) < 1e-6);
  assert.ok(Math.abs(centre[2] - Math.SQRT1_2) < 1e-6);

  // Rising northward: row 0 is north, so the normal leans south (-Y).
  const north = buildTerrainMesh(gridOf(3, 3, 100, [200, 200, 200, 100, 100, 100, 0, 0, 0]));
  const mid = [...north.normals.slice(4 * 3, 4 * 3 + 3)];
  assert.ok(Math.abs(mid[0]) < 1e-6);
  assert.ok(Math.abs(mid[1] + Math.SQRT1_2) < 1e-6, `ny was ${mid[1]}`);

  assert.ok([...east.normals].every(Number.isFinite), 'no NaN reaches a vertex buffer');
});

test('a cell nobody answered drops the triangles that touch it, and nothing else', () => {
  const heights = [10, 20, 30, 40, NaN, 60, 70, 80, 90];
  const mesh = buildTerrainMesh(gridOf(3, 3, 100, heights));

  // All four quads of a 3x3 touch the centre cell, so a hole in the middle is a
  // mesh with no triangles at all — and no NaN in the positions either.
  assert.equal(mesh.triangleCount, 0);
  assert.equal(mesh.indices.length, 0);
  assert.equal(mesh.vertexCount, 9);
  assert.ok([...mesh.positions].every(Number.isFinite), 'an absent vertex is placed, not NaN');
  assert.ok([...mesh.normals].every(Number.isFinite));

  // A corner hole touches one quad of the four.
  const corner = buildTerrainMesh(gridOf(3, 3, 100, [NaN, 20, 30, 40, 50, 60, 70, 80, 90]));
  assert.equal(corner.triangleCount, 6, 'three quads survive');
  assert.ok(![...corner.indices].includes(0), 'nothing references the absent vertex');
});

/* ---------- the height query ---------- */

test('groundAt returns the cell value at a lattice point, on the edges included', () => {
  // 3x3 at 100 m: lattice x,y ∈ {-100, 0, 100}.
  const grid = gridOf(3, 3, 100, [10, 20, 30, 40, 50, 60, 70, 80, 90]);
  assert.equal(groundAt(grid, -100, 100), 10, 'north-west corner');
  assert.equal(groundAt(grid, 0, 100), 20);
  assert.equal(groundAt(grid, 100, 100), 30, 'north-east corner');
  assert.equal(groundAt(grid, -100, 0), 40, 'west edge');
  assert.equal(groundAt(grid, 0, 0), 50, 'the origin');
  assert.equal(groundAt(grid, 100, -100), 90, 'south-east corner');
});

test('groundAt is bilinear between them', () => {
  const grid = gridOf(2, 2, 100, [0, 100, 200, 300]);
  // nw=0 ne=100 sw=200 se=300 over a 100 m cell running -50..+50.
  assert.equal(groundAt(grid, 0, 0), 150, 'the centre is the mean of four corners');
  assert.equal(groundAt(grid, 0, 50), 50, 'halfway along the north edge');
  assert.equal(groundAt(grid, 0, -50), 250, 'halfway along the south edge');
  assert.equal(groundAt(grid, -50, 0), 100, 'halfway down the west edge');
  assert.equal(groundAt(grid, -25, 25), 75);
});

test('groundAt and the mesh agree at every vertex — a stem stands where the eye sees ground', () => {
  const rows = 4;
  const cols = 5;
  const grid = gridOf(rows, cols, 30, Array.from({ length: rows * cols }, (_, i) => 900 + i * 7));
  const mesh = buildTerrainMesh(grid);
  for (let i = 0; i < mesh.vertexCount; i++) {
    const [x, y, z] = [...mesh.positions.slice(i * 3, i * 3 + 3)];
    assert.ok(Math.abs(groundAt(grid, x, y) - z) < 1e-9,
      `vertex ${i}: mesh Z ${z}, groundAt ${groundAt(grid, x, y)}`);
  }
});

test('groundAt outside the lattice is null — absence is a value, not sea level', () => {
  const grid = gridOf(3, 3, 100, [10, 20, 30, 40, 50, 60, 70, 80, 90]);
  assert.equal(groundAt(grid, -100.001, 0), null, 'a millimetre past the west edge');
  assert.equal(groundAt(grid, 100.001, 0), null);
  assert.equal(groundAt(grid, 0, 100.001), null);
  assert.equal(groundAt(grid, 0, -100.001), null);
  assert.equal(groundAt(grid, 5000, 5000), null);
  assert.equal(groundAt(grid, NaN, 0), null, 'a NaN coordinate is not an index');
  assert.equal(groundAt(grid, 0, undefined), null);
});

test('groundAt will not interpolate across a hole, or over a grid with no cell to span', () => {
  const holed = gridOf(3, 3, 100, [10, 20, 30, 40, NaN, 60, 70, 80, 90]);
  assert.equal(groundAt(holed, 0, 0), null, 'the absent cell itself');
  assert.equal(groundAt(holed, -50, 50), null, 'the quad north-west of it');
  assert.equal(groundAt(holed, 50, 50), null);
  // The far corners of a 3x3 sit in quads that touch the centre too, so the
  // whole of this grid is unanswerable — which is the honest answer.
  assert.equal(groundAt(holed, -100, 100), null);

  const stripe = gridOf(1, 4, 100, [1, 2, 3, 4]);
  assert.equal(groundAt(stripe, 0, 0), null, 'one row cannot be interpolated across');
});
