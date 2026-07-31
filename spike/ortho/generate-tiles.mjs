#!/usr/bin/env node
// Fetch the real terrarium DEM tiles this spike renders, once, into public/.
//
// spike/occlusion generates its DEM from a pure function because its proofs are
// about a *known* ridge. This spike's question is different — "is the AWS
// terrarium pyramid a viable mesh source for a standalone orthographic deck.gl
// view, and can a region of it be pre-downloaded for offline field use" — and
// the only honest way to answer the second half is to actually download a region
// and count what it cost. So this script is the field-pack rehearsal, not a
// fixture generator: it walks the same tile rectangle a per-region pack would,
// against the same public endpoint the app already ships
// (src/presentation/map/tile-sources.js), and writes what it found.
//
// The tiles are build output and are gitignored. Re-running is a no-op once the
// manifest matches, so the Playwright run never depends on S3 being up.
//
// Usage: node spike/ortho/generate-tiles.mjs [--force]

import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  BOUNDS,
  HALF_SPAN_M,
  ORIGIN,
  TERRARIUM_URL,
  TILE_ZOOMS,
  metresPerPixel,
  tileList,
  tileRange,
} from './scene.mjs';

const HERE = import.meta.dirname;
const PUBLIC = path.join(HERE, 'public');
const OUT = path.join(PUBLIC, 'tiles');
const MANIFEST = path.join(OUT, 'manifest.json');
const FORCE = process.argv.includes('--force');

/** Identity of this pack: the box and the levels. Change either and it refetches. */
const stampOf = () => JSON.stringify({ ORIGIN, HALF_SPAN_M, TILE_ZOOMS });

/** Concurrency. Polite against a public S3 bucket, still fast enough. */
const POOL = 8;

const url = (t) => TERRARIUM_URL
  .replace('{z}', String(t.z))
  .replace('{x}', String(t.x))
  .replace('{y}', String(t.y));

const rel = (t) => path.join(String(t.z), String(t.x), `${t.y}.png`);

async function main() {
  const stamp = stampOf();
  if (!FORCE) {
    const existing = await readFile(MANIFEST, 'utf8').then(JSON.parse).catch(() => null);
    if (existing?.stamp === stamp) {
      // Trust but verify: a half-finished run must not read as a complete pack.
      const ok = await stat(path.join(OUT, rel(existing.zooms.at(-1).sample)))
        .then(() => true).catch(() => false);
      if (ok) {
        console.log(
          `generate-tiles: up to date (${existing.totalTiles} tiles, `
          + `${(existing.totalBytes / 1024 / 1024).toFixed(2)} MB)`,
        );
        return;
      }
    }
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(PUBLIC, { recursive: true });
  // Build output, not source. The fetcher is what gets committed.
  await writeFile(path.join(PUBLIC, '.gitignore'), 'tiles/\n');

  const zooms = [];
  let totalTiles = 0;
  let totalBytes = 0;
  const startedAll = Date.now();

  for (const z of TILE_ZOOMS) {
    const tiles = tileList(z);
    const range = tileRange(z);
    let bytes = 0;
    let failed = 0;
    const started = Date.now();

    // A fixed-size pool rather than Promise.all over 49 tiles: this is meant to
    // behave like a field-pack download, and a field-pack download that opens
    // fifty sockets at once is the one a phone on LTE fails at.
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= tiles.length) return;
        const t = tiles[i];
        const res = await fetch(url(t)).catch((e) => ({ ok: false, statusText: String(e) }));
        if (!res.ok) {
          failed++;
          console.warn(`  ${t.z}/${t.x}/${t.y}: ${res.status ?? ''} ${res.statusText}`);
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        await mkdir(path.join(OUT, String(t.z), String(t.x)), { recursive: true });
        await writeFile(path.join(OUT, rel(t)), buf);
        bytes += buf.length;
      }
    };
    await Promise.all(Array.from({ length: POOL }, worker));

    if (failed) throw new Error(`generate-tiles: ${failed} tile(s) failed at z${z}`);

    const elapsedMs = Date.now() - started;
    zooms.push({
      z,
      tiles: tiles.length,
      range: { x0: range.x0, x1: range.x1, y0: range.y0, y1: range.y1 },
      bytes,
      elapsedMs,
      metresPerPixel: Number(metresPerPixel(z).toFixed(2)),
      sample: tiles[0],
    });
    totalTiles += tiles.length;
    totalBytes += bytes;
    console.log(
      `  z${z}: ${String(tiles.length).padStart(3)} tiles  `
      + `${(bytes / 1024 / 1024).toFixed(2)} MB  ${elapsedMs} ms  `
      + `${metresPerPixel(z).toFixed(1)} m/px`,
    );
  }

  await writeFile(MANIFEST, `${JSON.stringify({
    stamp,
    origin: ORIGIN,
    halfSpanM: HALF_SPAN_M,
    bounds: BOUNDS,
    source: TERRARIUM_URL,
    fetchedAt: new Date().toISOString(),
    zooms,
    totalTiles,
    totalBytes,
    totalElapsedMs: Date.now() - startedAll,
  }, null, 2)}\n`);

  console.log(
    `generate-tiles: ${totalTiles} tiles, ${(totalBytes / 1024 / 1024).toFixed(2)} MB `
    + `for a ${(HALF_SPAN_M * 2) / 1000} km box at ${ORIGIN.lat}, ${ORIGIN.lng}`,
  );
}

/**
 * Put @loaders.gl's terrain mesh worker on our own origin.
 *
 * Option A's TerrainLayer parses its DEM in a web worker that loaders.gl
 * resolves from `unpkg.com/@loaders.gl/terrain@<version>/dist/terrain-worker.js`
 * at runtime. That is a network dependency on *code*, in an app whose whole
 * premise is working at a trailhead with no signal, and it survives both of the
 * fixes that look like they should remove it (see layers.js). Self-hosting the
 * file and pointing `loadOptions.terrain.workerUrl` at the copy does remove it.
 *
 * Copying it here rather than importing it is deliberate: it is the build step a
 * production adoption of Option A would have to own — an extra asset, versioned
 * against @loaders.gl/terrain, that nothing in the module graph references and
 * so nothing checks. The spike pays that cost once so the verdict can quote it.
 */
async function copyTerrainWorker() {
  const from = path.join(
    HERE, '..', '..', 'node_modules', '@loaders.gl', 'terrain', 'dist', 'terrain-worker.js',
  );
  const dir = path.join(PUBLIC, 'workers');
  const to = path.join(dir, 'terrain-worker.js');
  await mkdir(dir, { recursive: true });
  try {
    await copyFile(from, to);
    const { size } = await stat(to);
    console.log(`generate-tiles: self-hosted terrain worker, ${(size / 1024).toFixed(1)} kB`);
  } catch (e) {
    console.warn(`generate-tiles: could not copy the terrain worker (${e.message});`
      + ' the ?worker=self mode will fall back to the CDN');
  }
}

await main();
await copyTerrainWorker();
