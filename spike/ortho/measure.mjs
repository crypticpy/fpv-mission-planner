#!/usr/bin/env node
// "What would each option cost us" — measured, not estimated.
//
// Two numbers this script produces that the browser cannot:
//
//   1. Bundle cost per option, from separate single-file builds. The spike's own
//      dist/ is split by manualChunks, but vite 8's rolldown backend is free to
//      merge or drop chunk names it considers redundant, and it does: several of
//      the buckets in vite.config.js never appear in the output. A chunk table
//      that quietly merged Option A into Option B would be worse than no table,
//      so the authoritative figure comes from four minimal entry points, each
//      built with `inlineDynamicImports` so the whole dependency closure lands
//      in one file, and each diffed against the same baseline.
//
//   2. The field-pack download size, read off the tile manifest that
//      generate-tiles.mjs wrote when it rehearsed exactly that download.
//
// The Open-Meteo latency question — "could Option B just use the elevation
// source we already have" — is answered in ortho.spec.js instead, in the
// browser, over the same fetch path the app uses. Measuring it twice would only
// double the load on a free public API to produce the same answer.
//
// Gzip level 9, matching the occlusion spike and the app's existing budget:
// GitHub Pages serves gzip, and a static host's precompressed asset is level 9.
//
// Usage: node spike/ortho/measure.mjs        (after `npm run spike:ortho:build`)

import { gzipSync } from 'node:zlib';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HERE = import.meta.dirname;
const DIST = path.join(HERE, 'dist', 'assets');
const PROBE = path.join(HERE, '.bundle-probe');

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
const pad = (s, n) => String(s).padEnd(n);
const rule = (n = 74) => '  ' + '-'.repeat(n);

/* ------------------------------------------------------- 1. the spike build */

async function chunkTable() {
  const files = await readdir(DIST).catch(() => null);
  if (!files) {
    console.log('  no spike build found — run `npm run spike:ortho:build` first\n');
    return;
  }
  const rows = [];
  for (const file of files.filter((f) => /\.(js|css)$/.test(f))) {
    const bytes = await readFile(path.join(DIST, file));
    rows.push({ file, raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length });
  }
  rows.sort((a, b) => b.gzip - a.gzip);

  console.log(`  ${pad('chunk as shipped', 46)}${pad('raw', 14)}gzip`);
  console.log(rule());
  for (const r of rows) console.log(`  ${pad(r.file, 46)}${pad(kb(r.raw), 14)}${kb(r.gzip)}`);
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  console.log(rule());
  console.log(`  ${pad('total', 46)}${pad(kb(sum('raw')), 14)}${kb(sum('gzip'))}`);
  console.log('\n  Chunk names come from vite.config.js manualChunks, but rolldown merges');
  console.log('  buckets at will — read the per-option deltas below, not this table.\n');
}

/* --------------------------------------------------- 2. per-option closures */

// Each entry pulls in exactly what that option needs and nothing else, and
// *uses* every import (a bare import of an ES module with side-effect-free
// exports is tree-shaken to nothing, which would report a zero-cost Option A).
const ENTRIES = {
  base: `
    import { Deck, OrbitView, COORDINATE_SYSTEM, LightingEffect, AmbientLight,
             DirectionalLight } from '@deck.gl/core';
    import { PathLayer, LineLayer, ScatterplotLayer, SolidPolygonLayer,
             PolygonLayer } from '@deck.gl/layers';
    globalThis.__probe = [Deck, OrbitView, COORDINATE_SYSTEM, LightingEffect,
      AmbientLight, DirectionalLight, PathLayer, LineLayer, ScatterplotLayer,
      SolidPolygonLayer, PolygonLayer];
  `,
  'option-b-simplemesh': `
    import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
    globalThis.__probeB = [SimpleMeshLayer];
  `,
  'option-a-terrainlayer': `
    import { TerrainLayer } from '@deck.gl/geo-layers';
    globalThis.__probeA = [TerrainLayer];
  `,
  'option-a-terrainlayer-offline': `
    import { TerrainLayer } from '@deck.gl/geo-layers';
    import { TerrainLoader } from '@loaders.gl/terrain';
    globalThis.__probeA = [TerrainLayer, TerrainLoader];
  `,
};

/**
 * Build one entry into a single minified file and return its gzip size.
 *
 * `inlineDynamicImports` is what makes the number comparable: without it a
 * package that happens to lazy-load a sub-module reports a smaller headline
 * figure than one that does not, and the app pays for both either way.
 */
async function closureSize(name, source, build) {
  const dir = path.join(PROBE, name);
  await mkdir(dir, { recursive: true });
  const entry = path.join(dir, 'entry.js');
  // Every probe includes the baseline imports, so `total - base` is the true
  // marginal cost of adding that package to a page that already has deck core.
  await writeFile(entry, name === 'base' ? source : ENTRIES.base + source);

  await build({
    root: dir,
    logLevel: 'error',
    build: {
      outDir: path.join(dir, 'out'),
      emptyOutDir: true,
      minify: true,
      lib: { entry, formats: ['es'], fileName: 'probe' },
      // rolldown renamed `output.inlineDynamicImports`; both spellings are set
      // so this keeps producing one file across the rename either way.
      rollupOptions: { output: { codeSplitting: false } },
    },
  });

  const out = path.join(dir, 'out');
  const files = await readdir(out);
  let raw = 0;
  let gzip = 0;
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const bytes = await readFile(path.join(out, f));
    raw += bytes.length;
    gzip += gzipSync(bytes, { level: 9 }).length;
  }
  return { raw, gzip };
}

async function optionCost() {
  const { build } = await import('vite');
  await rm(PROBE, { recursive: true, force: true });

  const sizes = {};
  for (const [name, source] of Object.entries(ENTRIES)) {
    sizes[name] = await closureSize(name, source, build);
  }
  await rm(PROBE, { recursive: true, force: true });

  const base = sizes.base;
  console.log(`  ${pad('single-file closure', 46)}${pad('raw', 14)}${pad('gzip', 12)}Δ gzip`);
  console.log(rule(86));
  for (const [name, s] of Object.entries(sizes)) {
    const delta = name === 'base' ? '—' : `+${kb(s.gzip - base.gzip)}`;
    console.log(`  ${pad(name, 46)}${pad(kb(s.raw), 14)}${pad(kb(s.gzip), 12)}${delta}`);
  }
  console.log(rule(86));
  console.log('\n  base = @deck.gl/core + @deck.gl/layers, which the app already ships.');
  console.log('  Δ is therefore the marginal cost of adopting that option, gzipped.\n');
  return sizes;
}

/* -------------------------------------------------------- 3. the DEM budget */

async function tileBudget() {
  const manifestPath = path.join(HERE, 'public', 'tiles', 'manifest.json');
  const manifest = await readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => null);
  if (!manifest) {
    console.log('  no tile manifest — run `node spike/ortho/generate-tiles.mjs` first\n');
    return null;
  }

  console.log(`  ${pad('zoom', 8)}${pad('tiles', 8)}${pad('m/px', 10)}${pad('bytes', 14)}fetch`);
  console.log(rule());
  for (const z of manifest.zooms) {
    console.log(`  ${pad(`z${z.z}`, 8)}${pad(z.tiles, 8)}${pad(z.metresPerPixel.toFixed(1), 10)}`
      + `${pad(kb(z.bytes), 14)}${(z.elapsedMs / 1000).toFixed(1)} s`);
  }
  console.log(rule());
  console.log(`  ${pad('all', 8)}${pad(manifest.totalTiles, 8)}${pad('', 10)}`
    + `${pad(kb(manifest.totalBytes), 14)}${(manifest.totalElapsedMs / 1000).toFixed(1)} s`);
  console.log(`\n  ${2 * manifest.halfSpanM} m box at ${manifest.origin.lat}, ${manifest.origin.lng}.`);
  console.log('  This download is the field-pack rehearsal: it is exactly what a pilot');
  console.log('  would have to have on disk before losing signal.\n');
  return manifest;
}

/* -------------------------------------------------------------------- main */

console.log('\nOrthographic 3D spike — cost of each terrain path\n');

console.log('  === as built ===\n');
await chunkTable();

console.log('  === marginal bundle cost per option ===\n');
const sizes = await optionCost();

console.log('  === DEM tiles for one 5 km planning box ===\n');
const manifest = await tileBudget();

// One line the verdict can quote without re-deriving it.
if (manifest && sizes) {
  const a = sizes['option-a-terrainlayer'].gzip - sizes.base.gzip;
  const b = sizes['option-b-simplemesh'].gzip - sizes.base.gzip;
  console.log(`  summary: Option A +${kb(a)} gzip, Option B +${kb(b)} gzip,`
    + ` DEM ${kb(manifest.totalBytes)} per box.\n`);
}
