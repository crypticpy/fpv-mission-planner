#!/usr/bin/env node
// generate-dev-sw.mjs — regenerates the PRECACHE_URLS list inside the repo-root
// sw.js (the DEV-PATH worker) from what the browser actually loads.
//
// scripts/generate-sw.mjs already removed the hand-maintained-list failure mode
// from production builds by walking dist/. The dev path had kept it: add a
// module, forget the list, and a dev-mode offline load quietly misses it — by
// M6 the list had drifted nine modules behind the import graph. This script
// closes that gap the same way: nothing hand-maintained, everything derived.
//
//   node scripts/generate-dev-sw.mjs          rewrite sw.js in place
//   node scripts/generate-dev-sw.mjs --check  exit 1 if the list is stale
//                                             (`npm run sw:check`, part of `npm run check`)
//
// The list is the static shell — ".", index.html, manifest.webmanifest, and
// every file under css/, vendor/, icons/, the same directories a build copies
// into dist/ — plus the ESM import graph walked from src/app.js, static and
// dynamic imports both (M6's lazily imported compiler + adapters are runtime
// modules on the dev path, so they precache here even though production ships
// them as one built chunk). Nothing under src/presentation/map/scene3d/ is
// followed — same exclusion, same reasoning as generate-sw.mjs's SCENE_CHUNK
// filter (ADR 0004).

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { importsOf, dynamicImportsOf } from './lib/esm-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SW = path.join(ROOT, 'sw.js');
const ENTRY = 'src/app.js';
const SCENE_DIR = 'src/presentation/map/scene3d/';

/** posix-separated path of `abs` relative to ROOT. */
function relUrl(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

/** Every file under ROOT/`dir`, as posix paths relative to ROOT, sorted. */
async function walk(dir) {
  const files = [];
  for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await walk(rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files.sort();
}

// ---- the import graph, walked from the entry module ----
const modules = new Set();
const queue = [path.join(ROOT, ENTRY)];
while (queue.length) {
  const file = /** @type {string} */ (queue.pop());
  const rel = relUrl(file);
  if (modules.has(rel)) continue;
  modules.add(rel);
  const src = await readFile(file, 'utf8');
  for (const { spec, line } of [...importsOf(src), ...dynamicImportsOf(src)]) {
    // Bare specifiers cannot resolve in the browser; arch-check reports them
    // with full context, so they are simply not edges here.
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), spec);
    if (relUrl(target).startsWith(SCENE_DIR)) continue;
    if (!existsSync(target) || !statSync(target).isFile()) {
      throw new Error(`generate-dev-sw: ${rel}:${line} — '${spec}' does not ` +
        'resolve to a file. `npm run arch` has the full report.');
    }
    queue.push(target);
  }
}

// "." is the start_url the manifest declares and the URL a home-screen launch
// requests; a distinct cache key from "index.html" even though the two serve
// the same bytes, so both are precached — same as the generated worker.
//
// Deduplicated because the graph and the directory walks can meet: the Leaflet
// adapter imports vendor/leaflet/leaflet-src.esm.js at runtime, and the
// vendor/ walk lists the same file.
const urls = [...new Set([
  '.',
  'index.html',
  'manifest.webmanifest',
  ...await walk('css'),
  ...[...modules].sort(),
  ...await walk('vendor'),
  ...await walk('icons'),
])];

// ---- splice the list into sw.js between its literal brackets ----
const swSrc = await readFile(SW, 'utf8');
const OPEN = 'const PRECACHE_URLS = [';
const CLOSE = '\n];';
const start = swSrc.indexOf(OPEN);
const end = start === -1 ? -1 : swSrc.indexOf(CLOSE, start);
if (start === -1 || end === -1) {
  throw new Error('generate-dev-sw: could not find the PRECACHE_URLS array in ' +
    'sw.js — this script splices between `const PRECACHE_URLS = [` and `];`. ' +
    'Fix sw.js or update the markers here.');
}

const block = `${OPEN}\n${urls.map((u) => `  '${u}',`).join('\n')}${CLOSE}`;
const next = swSrc.slice(0, start) + block + swSrc.slice(end + CLOSE.length);

if (process.argv.includes('--check')) {
  if (next === swSrc) {
    console.log(`generate-dev-sw: sw.js in sync — ${urls.length} precached URLs`);
    process.exit(0);
  }
  const current = [...swSrc.slice(start + OPEN.length, end).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const missing = urls.filter((u) => !current.includes(u));
  const stale = current.filter((u) => !urls.includes(u));
  console.error('generate-dev-sw: sw.js PRECACHE_URLS has drifted from the import graph.');
  for (const u of missing) console.error(`  missing: ${u}`);
  for (const u of stale) console.error(`  stale:   ${u}`);
  if (!missing.length && !stale.length) console.error('  (same entries, different order or formatting)');
  console.error('Run `node scripts/generate-dev-sw.mjs` and commit the result.');
  process.exit(1);
}

await writeFile(SW, next);
console.log(`generate-dev-sw: sw.js — ${urls.length} precached URLs ` +
  `(${modules.size} modules reachable from ${ENTRY})`);
