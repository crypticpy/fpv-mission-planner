// Option B, first half: turn an elevation source into a regular grid we own.
//
// "Self-sampled elevation grid" is the whole of Option B's premise, and it has
// two possible feeds, both implemented here because the choice between them is
// most of the verdict:
//
//   terrarium — fetch the covering AWS DEM tiles, decode the PNGs in the page
//               (canvas getImageData), stitch them into one raster and bilinear
//               sample it. This is the "documented upgrade path" R-DEM parks at
//               the end of its recommendation, built.
//
//   openmeteo — ask the app's existing ElevationProvider port
//               (src/infrastructure/elevation/open-meteo-elevation.js) for the
//               grid, 100 coordinates at a time. Not a straw man: it is what the
//               app has today. The measurement is the point — a mesh needs
//               thousands of samples and this endpoint answers a hundred per
//               round trip.
//
// Nothing here is production code. It exists to produce numbers.

import {
  BOUNDS,
  HALF_SPAN_M,
  TILE_SIZE,
  decodeTerrarium,
  latToTileY,
  lngToTileX,
  offsetToLngLat,
  tileRange,
} from './scene.mjs';

/** Open-Meteo's documented ceiling on one request. */
const ELEVATION_BATCH_MAX = 100;
const OPEN_METEO_ELEVATION_URL = 'https://api.open-meteo.com/v1/elevation';

/**
 * @typedef {object} Grid
 * @property {number} n            samples per axis
 * @property {Float32Array} heights  n*n metres MSL, row 0 = south
 * @property {number} spacingM     ground distance between samples
 * @property {number} minM
 * @property {number} maxM
 * @property {Record<string, number>} timings  milliseconds, by phase
 * @property {number} requests     how many network round trips it took
 * @property {number} bytes        how many bytes came back (terrarium only)
 * @property {string} source
 */

/* ------------------------------------------------------------ terrarium path */

/**
 * Decode one terrarium PNG into a Float32Array of metres.
 *
 * `premultiplyAlpha: 'none'` and `colorSpaceConversion: 'none'` are not
 * cosmetic. A terrarium tile is not a picture: its bytes are a number split
 * across three channels, and any colour management the browser applies on the
 * way into a canvas silently rewrites elevations. The tiles are colour type 2
 * (no alpha), so premultiplication would be a no-op today — it is set anyway,
 * because "today" is a property of the encoder, not of this code.
 *
 * @param {Blob} blob
 * @returns {Promise<Float32Array>} TILE_SIZE * TILE_SIZE metres MSL
 */
async function decodeTile(blob) {
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
  const out = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0, at = 0; i < out.length; i++, at += 4) {
    out[i] = decodeTerrarium(data[at], data[at + 1], data[at + 2]);
  }
  return out;
}

/**
 * Every covering tile at `z`, stitched into one raster.
 *
 * @param {number} z
 * @param {string} baseUrl  template with {z}/{x}/{y}
 * @returns {Promise<{raster: Float32Array, cols: number, rows: number,
 *                    x0: number, y0: number, requests: number, bytes: number,
 *                    fetchMs: number, decodeMs: number}>}
 */
async function loadRaster(z, baseUrl) {
  const { x0, x1, y0, y1 } = tileRange(z);
  const tilesX = x1 - x0 + 1;
  const tilesY = y1 - y0 + 1;
  const cols = tilesX * TILE_SIZE;
  const rows = tilesY * TILE_SIZE;
  const raster = new Float32Array(cols * rows);

  let bytes = 0;
  let fetchMs = 0;
  let decodeMs = 0;
  let requests = 0;

  const jobs = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      jobs.push((async () => {
        const url = baseUrl
          .replace('{z}', String(z)).replace('{x}', String(tx)).replace('{y}', String(ty));
        const t0 = performance.now();
        const res = await fetch(url);
        if (!res.ok) throw new Error(`dem: ${z}/${tx}/${ty} -> ${res.status}`);
        const blob = await res.blob();
        fetchMs += performance.now() - t0;
        requests++;
        bytes += blob.size;

        const t1 = performance.now();
        const tile = await decodeTile(blob);
        decodeMs += performance.now() - t1;

        // Row-major into the stitched raster, north-west corner first — the same
        // orientation the tile indices run in, so the sampler's arithmetic is a
        // straight scale rather than a flip nobody can verify by reading it.
        const ox = (tx - x0) * TILE_SIZE;
        const oy = (ty - y0) * TILE_SIZE;
        for (let py = 0; py < TILE_SIZE; py++) {
          raster.set(
            tile.subarray(py * TILE_SIZE, (py + 1) * TILE_SIZE),
            (oy + py) * cols + ox,
          );
        }
      })());
    }
  }
  await Promise.all(jobs);
  return { raster, cols, rows, x0, y0, requests, bytes, fetchMs, decodeMs };
}

/**
 * An n x n grid over BOUNDS, sampled from the terrarium pyramid.
 *
 * @param {{ n: number, z: number, baseUrl: string }} opts
 * @returns {Promise<Grid>}
 */
export async function terrariumGrid({ n, z, baseUrl }) {
  const t0 = performance.now();
  const { raster, cols, x0, y0, requests, bytes, fetchMs, decodeMs } =
    await loadRaster(z, baseUrl);
  const loadedAt = performance.now();

  const heights = new Float32Array(n * n);
  const step = (HALF_SPAN_M * 2) / (n - 1);
  let minM = Infinity;
  let maxM = -Infinity;

  for (let iy = 0; iy < n; iy++) {
    // Row 0 is the SOUTH edge: the mesh is built in a Y-north world, so the grid
    // is stored the way the mesh reads it rather than the way the raster is laid
    // out. One flip, here, where it is visible.
    const dyM = -HALF_SPAN_M + iy * step;
    for (let ix = 0; ix < n; ix++) {
      const dxM = -HALF_SPAN_M + ix * step;
      const [lng, lat] = offsetToLngLat(dxM, dyM);
      // Fractional pixel position in the stitched raster. A DEM pixel is the
      // elevation at its top-left CORNER (tilezen's convention), so tile
      // fraction * TILE_SIZE is the pixel index directly — no half-pixel shift.
      const px = (lngToTileX(lng, z) - x0) * TILE_SIZE;
      const py = (latToTileY(lat, z) - y0) * TILE_SIZE;
      const ix0 = Math.floor(px);
      const iy0 = Math.floor(py);
      const fx = px - ix0;
      const fy = py - iy0;
      const at = iy0 * cols + ix0;
      const h = raster[at] * (1 - fx) * (1 - fy)
        + raster[at + 1] * fx * (1 - fy)
        + raster[at + cols] * (1 - fx) * fy
        + raster[at + cols + 1] * fx * fy;
      heights[iy * n + ix] = h;
      if (h < minM) minM = h;
      if (h > maxM) maxM = h;
    }
  }

  return {
    n,
    heights,
    spacingM: step,
    minM,
    maxM,
    requests,
    bytes,
    source: `terrarium z${z}`,
    timings: {
      fetchMs: Math.round(fetchMs),
      decodeMs: Math.round(decodeMs),
      loadMs: Math.round(loadedAt - t0),
      sampleMs: Math.round(performance.now() - loadedAt),
      totalMs: Math.round(performance.now() - t0),
    },
  };
}

/* ------------------------------------------------------------ open-meteo path */

/**
 * The same n x n grid, asked for one hundred points at a time.
 *
 * Sequential, not parallel, for the reason the production adapter states in its
 * own header: a burst of parallel requests from every open tab is how a keyless
 * service starts rate-limiting. That is exactly why the number this returns is
 * the number that matters.
 *
 * @param {{ n: number }} opts
 * @returns {Promise<Grid>}
 */
export async function openMeteoGrid({ n }) {
  const t0 = performance.now();
  const step = (HALF_SPAN_M * 2) / (n - 1);
  /** @type {{lat: number, lng: number}[]} */
  const points = [];
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const [lng, lat] = offsetToLngLat(-HALF_SPAN_M + ix * step, -HALF_SPAN_M + iy * step);
      points.push({ lat, lng });
    }
  }

  const heights = new Float32Array(n * n);
  let requests = 0;
  let bytes = 0;
  let minM = Infinity;
  let maxM = -Infinity;

  for (let at = 0; at < points.length; at += ELEVATION_BATCH_MAX) {
    const batch = points.slice(at, at + ELEVATION_BATCH_MAX);
    const url = `${OPEN_METEO_ELEVATION_URL}`
      + `?latitude=${batch.map((p) => p.lat.toFixed(6)).join(',')}`
      + `&longitude=${batch.map((p) => p.lng.toFixed(6)).join(',')}`;
    const res = await fetch(url);
    requests++;
    if (!res.ok) throw new Error(`dem: open-meteo -> ${res.status}`);
    const text = await res.text();
    bytes += text.length;
    const body = JSON.parse(text);
    const values = body?.elevation;
    if (!Array.isArray(values) || values.length !== batch.length) {
      throw new Error('dem: open-meteo returned a batch of the wrong length');
    }
    for (let i = 0; i < values.length; i++) {
      const h = Number(values[i]);
      heights[at + i] = h;
      if (h < minM) minM = h;
      if (h > maxM) maxM = h;
    }
  }

  return {
    n,
    heights,
    spacingM: step,
    minM,
    maxM,
    requests,
    bytes,
    source: 'open-meteo elevation API',
    timings: { totalMs: Math.round(performance.now() - t0) },
  };
}

/**
 * Bilinear read of a built grid, in local metres. What the altitude stems stand
 * on and what the picking proofs bury a probe under.
 *
 * @param {Grid} grid @param {number} dxM @param {number} dyM
 * @returns {number}
 */
export function groundAt(grid, dxM, dyM) {
  const { n, heights, spacingM } = grid;
  const fx = (dxM + HALF_SPAN_M) / spacingM;
  const fy = (dyM + HALF_SPAN_M) / spacingM;
  const x0 = Math.min(n - 2, Math.max(0, Math.floor(fx)));
  const y0 = Math.min(n - 2, Math.max(0, Math.floor(fy)));
  const tx = Math.min(1, Math.max(0, fx - x0));
  const ty = Math.min(1, Math.max(0, fy - y0));
  const at = y0 * n + x0;
  return heights[at] * (1 - tx) * (1 - ty)
    + heights[at + 1] * tx * (1 - ty)
    + heights[at + n] * (1 - tx) * ty
    + heights[at + n + 1] * tx * ty;
}

export { BOUNDS };
