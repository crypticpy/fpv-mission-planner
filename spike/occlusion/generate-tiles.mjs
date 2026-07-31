#!/usr/bin/env node
// Synthetic terrarium-encoded raster-dem tiles for the ADR 0004 spike.
//
// No network, no API key, no fixture PNGs in the repo: the DEM is a pure
// function of position (spike/occlusion/scene.mjs SURFACES) evaluated per DEM
// pixel and written as terrarium RGB. Regenerating is deterministic — same
// bytes, every machine — so the spike is reproducible from source alone.
//
// Terrarium encoding (the `"encoding": "terrarium"` MapLibre accepts):
//
//     elevation_m = (R * 256 + G + B / 256) - 32768
//
// Sampling convention matters more than it looks. A DEM pixel (px, py) of tile
// (z, x, y) is the elevation at world position (x + px/256, y + py/256) — the
// pixel's top-left CORNER, not its centre, and the last row/column of a tile is
// *not* duplicated by its neighbour. That is what makes the pyramid one
// continuous global grid; sample at pixel centres instead and every tile seam
// becomes a half-pixel step in the terrain mesh.
//
// Usage: node spike/occlusion/generate-tiles.mjs [--force]

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { encodeRGB } from './png.mjs';
import { DEM_BOUNDS, SURFACES, TILES, lngLatToOffset } from './scene.mjs';

const HERE = import.meta.dirname;
const PUBLIC = path.join(HERE, 'public');
const OUT = path.join(PUBLIC, 'tiles');
const STAMP = path.join(OUT, 'generated.json');
const FORCE = process.argv.includes('--force');

const { minZoom, maxZoom, halfSpanKm, size } = TILES;

const lngToTileX = (lng, z) => ((lng + 180) / 360) * 2 ** z;
const lngOfTileX = (X, z) => (X / 2 ** z) * 360 - 180;
const latToTileY = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
};
const latOfTileY = (Y, z) => {
  const n = Math.PI - (2 * Math.PI * Y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

const [westLng, southLat, eastLng, northLat] = DEM_BOUNDS;

// Identity of this tile set: change a surface, a zoom range or the span and the
// stamp stops matching, so the next run regenerates instead of serving stale
// terrain under new assertions.
const stamp = createHash('sha256')
  .update(JSON.stringify({
    tiles: TILES,
    bounds: DEM_BOUNDS,
    surfaces: Object.keys(SURFACES),
    // The surface functions themselves, so editing a fixture invalidates too.
    source: Object.values(SURFACES).map(String).join('\n'),
  }))
  .digest('hex')
  .slice(0, 16);

if (!FORCE) {
  const existing = await readFile(STAMP, 'utf8').then(JSON.parse).catch(() => null);
  if (existing?.stamp === stamp) {
    console.log(`generate-tiles: up to date (${existing.tiles} tiles, stamp ${stamp})`);
    process.exit(0);
  }
}

await rm(OUT, { recursive: true, force: true });
await mkdir(PUBLIC, { recursive: true });
// The tiles are build output, not source: the generator is what gets committed.
await writeFile(path.join(PUBLIC, '.gitignore'), 'tiles/\n');

/** One 256x256 terrarium tile as PNG bytes. */
function renderTile(surface, z, tx, ty) {
  const rgb = new Uint8Array(size * size * 3);
  let at = 0;
  for (let py = 0; py < size; py++) {
    const lat = latOfTileY(ty + py / size, z);
    for (let px = 0; px < size; px++) {
      const lng = lngOfTileX(tx + px / size, z);
      const { dxKm, dyKm } = lngLatToOffset(lng, lat);
      // Terrarium's range is [-32768, 32768); every fixture value is a few
      // hundred metres, so the clamp is a guard against a future surface
      // function, not a live concern.
      const v = Math.min(65535.996, Math.max(0, surface(dxKm, dyKm) + 32768));
      const whole = Math.floor(v);
      rgb[at++] = whole >> 8;
      rgb[at++] = whole & 0xff;
      rgb[at++] = Math.floor((v - whole) * 256);
    }
  }
  return encodeRGB(size, size, rgb);
}

let written = 0;
let bytes = 0;

for (const [name, surface] of Object.entries(SURFACES)) {
  for (let z = minZoom; z <= maxZoom; z++) {
    const x0 = Math.floor(lngToTileX(westLng, z));
    const x1 = Math.floor(lngToTileX(eastLng, z));
    // Mercator Y grows southward, so the north edge gives the low index.
    const y0 = Math.floor(latToTileY(northLat, z));
    const y1 = Math.floor(latToTileY(southLat, z));

    for (let tx = x0; tx <= x1; tx++) {
      await mkdir(path.join(OUT, name, String(z), String(tx)), { recursive: true });
      for (let ty = y0; ty <= y1; ty++) {
        const png = renderTile(surface, z, tx, ty);
        await writeFile(path.join(OUT, name, String(z), String(tx), `${ty}.png`), png);
        written++;
        bytes += png.length;
      }
    }
  }
}

await writeFile(STAMP, `${JSON.stringify({ stamp, tiles: written, bounds: DEM_BOUNDS }, null, 2)}\n`);

console.log(
  `generate-tiles: ${written} tiles, ${(bytes / 1024 / 1024).toFixed(2)} MB, ` +
  `z${minZoom}-${maxZoom}, +/-${halfSpanKm} km around ${DEM_BOUNDS.map((n) => n.toFixed(4)).join(',')}`,
);
