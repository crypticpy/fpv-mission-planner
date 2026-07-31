#!/usr/bin/env node
// generate-sw.mjs — emits dist/sw.js from the build output (ADR 0009).
//
// The hand-written PRECACHE_URLS list in the repo-root sw.js has one failure
// mode that no test catches: add an asset, forget the list, and the app is
// quietly broken offline for everyone who installed it. This script removes
// that mode from production builds by walking dist/ and generating the list.
//
// The *runtime* half of the worker is not duplicated here — it is lifted
// verbatim out of the repo-root sw.js, starting at its first event listener.
// Root sw.js therefore remains the single source of truth for caching and
// offline behaviour; this script only replaces its two constants.
//
// The cache version is derived from the content of every precached file, so a
// build that changes nothing produces a byte-identical worker, and a build
// that changes anything invalidates the previous cache through the existing
// activate handler (which deletes every cache whose name isn't the current
// CACHE_NAME).

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SOURCE_SW = path.join(ROOT, 'sw.js');
const OUT_SW = path.join(DIST, 'sw.js');

// Where the runtime logic begins in the source worker. Everything above it is
// the hand-maintained constants block this script replaces.
const RUNTIME_MARKER = "self.addEventListener('install'";

/** Every file under `dir`, as paths relative to `dir`, posix-separated. */
async function walk(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(path.join(dir, entry.name), rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

const runtime = await readFile(SOURCE_SW, 'utf8');
const markerAt = runtime.indexOf(RUNTIME_MARKER);
if (markerAt === -1) {
  throw new Error(
    `generate-sw: could not find ${JSON.stringify(RUNTIME_MARKER)} in sw.js — the ` +
    'source worker\'s runtime logic must start with an install listener so this ' +
    'script can lift it. Fix sw.js or update RUNTIME_MARKER.',
  );
}

/**
 * The 3D scene stays out of the shell (ADR 0004).
 *
 * The chunk and its stylesheet are MapLibre and deck.gl — about 442 kB gzip,
 * three times the whole rest of the app. Precaching them would mean every pilot
 * who installs this tool downloads a 3D engine they may never open, on the
 * connection they installed it to survive without. So the shell stays the shell:
 * pressing 3D with no connection fails, the map stays in 2D, and map-view.js
 * says so. Offline 3D is an M8 decision, not an accident of a dist/ walk.
 *
 * vite.config.js gives the chunk its `scene3d-` prefix, and Vite names the CSS
 * asset after the chunk, so one prefix covers both.
 */
const SCENE_CHUNK = /(^|\/)scene3d-[^/]*\.(js|css)$/;

const all = await walk(DIST);
// The worker never precaches itself: it is fetched and versioned by the
// browser's own update check, and caching it would pin the cache-busting
// mechanism to whatever shipped first.
const assets = all.filter((rel) => rel !== 'sw.js' && !SCENE_CHUNK.test(rel));

if (!assets.includes('index.html')) {
  throw new Error('generate-sw: dist/index.html is missing — run `vite build` first.');
}

// Content-derived cache version: the file list *and* the bytes behind it.
const version = createHash('sha256');
for (const rel of assets) {
  version.update(rel);
  version.update('\0');
  version.update(createHash('sha256').update(await readFile(path.join(DIST, rel))).digest());
}
const cacheName = `fpv-shell-${version.digest('hex').slice(0, 12)}`;

// "." is the start_url the manifest declares and the URL a home-screen launch
// requests; it is a distinct cache key from "index.html" even though the two
// serve the same bytes, so both are precached — same as the hand-written list.
const urls = ['.', ...assets];

const generated = `// FPV Mission Planner — service worker (GENERATED — do not edit).
//
// Produced by scripts/generate-sw.mjs from the contents of dist/. The runtime
// logic below is lifted verbatim from the repo-root sw.js; the precache list
// and cache version are generated. Edit sw.js, then rebuild.
//
// Paths are relative to this file's scope (the app can live at "/" locally or
// at a GitHub Pages subpath) — never use a leading "/".

const CACHE_NAME = '${cacheName}';

const PRECACHE_URLS = [
${urls.map((u) => `  '${u}',`).join('\n')}
];

${runtime.slice(markerAt)}`;

await writeFile(OUT_SW, generated);
console.log(`generate-sw: dist/sw.js — ${urls.length} precached URLs, cache ${cacheName}`);
