#!/usr/bin/env node
// The fourth ADR 0004 question: what would this cost us?
//
// Measures the spike's own build output rather than estimating from published
// bundle sizes, because the number that matters is what *this* app would ship —
// tree-shaken, minified, and split so maplibre-gl and the deck.gl scopes can be
// read off separately (see the manualChunks in vite.config.js).
//
// Gzip, not brotli: GitHub Pages serves gzip, and the app's existing budget is
// quoted in gzip. Level 9, matching what a static host's precompressed asset
// would be.
//
// Usage: node spike/occlusion/measure.mjs      (after a spike build)

import { gzipSync } from 'node:zlib';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const HERE = import.meta.dirname;
const DIST = path.join(HERE, 'dist', 'assets');
const REPO = path.resolve(HERE, '..', '..');

/** Which library a chunk belongs to, from the name manualChunks gave it. */
function bucket(file) {
  if (file.endsWith('.css')) return 'maplibre-gl (css)';
  if (file.startsWith('maplibre-')) return 'maplibre-gl';
  if (file.startsWith('deck-')) return '@deck.gl/*';
  if (file.startsWith('vendor-')) return 'transitive deps';
  return 'spike page';
}

const files = await readdir(DIST).catch(() => {
  throw new Error('no spike build found — run `npm run spike:occlusion:build` first');
});

const rows = [];
for (const file of files.filter((f) => /\.(js|css)$/.test(f))) {
  const bytes = await readFile(path.join(DIST, file));
  rows.push({
    file,
    bucket: bucket(file),
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
  });
}
rows.sort((a, b) => b.gzip - a.gzip);

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
const pad = (s, n) => String(s).padEnd(n);

console.log('\nADR 0004 spike — rendering bundle cost\n');
console.log(`  ${pad('chunk', 30)}${pad('library', 20)}${pad('raw', 12)}gzip`);
console.log(`  ${'-'.repeat(72)}`);
for (const r of rows) {
  console.log(`  ${pad(r.file, 30)}${pad(r.bucket, 20)}${pad(kb(r.raw), 12)}${kb(r.gzip)}`);
}

const totals = new Map();
for (const r of rows) {
  const t = totals.get(r.bucket) ?? { raw: 0, gzip: 0 };
  totals.set(r.bucket, { raw: t.raw + r.raw, gzip: t.gzip + r.gzip });
}

console.log(`\n  ${pad('by library', 50)}${pad('raw', 12)}gzip`);
console.log(`  ${'-'.repeat(72)}`);
for (const [name, t] of [...totals].sort((a, b) => b[1].gzip - a[1].gzip)) {
  console.log(`  ${pad(name, 50)}${pad(kb(t.raw), 12)}${kb(t.gzip)}`);
}

const js = rows.filter((r) => r.file.endsWith('.js'));
const sum = (xs, k) => xs.reduce((n, x) => n + x[k], 0);
console.log(`  ${'-'.repeat(72)}`);
console.log(`  ${pad('JS total', 50)}${pad(kb(sum(js, 'raw')), 12)}${kb(sum(js, 'gzip'))}`);
console.log(`  ${pad('JS + CSS total', 50)}${pad(kb(sum(rows, 'raw')), 12)}${kb(sum(rows, 'gzip'))}`);

// The spike page's own glue is a few kB of scene setup that production would
// replace with a real adapter, so the honest "cost of adopting" figure is
// everything except it.
const libs = rows.filter((r) => r.bucket !== 'spike page');
console.log(`  ${pad('libraries only (excludes the spike page itself)', 50)}${pad(kb(sum(libs, 'raw')), 12)}${kb(sum(libs, 'gzip'))}`);

const pkg = JSON.parse(await readFile(path.join(REPO, 'package.json'), 'utf8'));
const named = ['maplibre-gl', '@deck.gl/core', '@deck.gl/layers', '@deck.gl/mapbox'];
console.log('\n  versions measured');
for (const name of named) console.log(`    ${pad(name, 22)}${pkg.devDependencies?.[name] ?? '(absent)'}`);
console.log();
