import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ADR 0012 §4's dev-path precache guard.
 *
 * sw.js says it plainly: PRECACHE_URLS is hand-maintained for the no-bundler
 * dev path, and "forgetting to [add a line] is no longer a production bug" —
 * only because this file exists to make it a caught one instead. A module
 * app.js can reach but the worker never fetched is invisible until the one
 * time it matters: offline, at a trailhead, on the one code path nobody
 * exercised online. This test does the same static walk a bundler would, with
 * none of the machinery — every `import`/`export … from`/dynamic `import()`
 * in this codebase is a plain string literal (no template specifiers, no
 * `require`), so a regex over the source text is the whole job.
 *
 * Two directions, both load-bearing:
 *   reachable ⊆ precached — nothing the entry graph can load is missing from
 *     the list (the failure mode above).
 *   precached ⊇ real files — nothing on the list is a typo or a moved file
 *     (a silent cache miss that *looks* precached until it 404s).
 *
 * One documented exception: src/presentation/map/scene3d/*, reached only
 * through map-view.js's own dynamic import and deliberately excluded from
 * the dev-path list (ADR 0004 — see sw.js's own comment beside
 * PRECACHE_URLS). This walk stops at that boundary rather than following it,
 * the same way sw.js's own list does. */

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const SW_PATH = path.join(ROOT, 'sw.js');

/**
 * Comments stripped the way this file's own imports need them to be, not the
 * way a real parser would: line comments first, except a `//` immediately
 * preceded by `:` — the codebase has a few genuine `// … import('./x.js') …`
 * prose comments (documenting the very dynamic imports this walk cares
 * about) that would otherwise register as edges, and this codebase's
 * `https://` string literals must not be truncated on the way to finding
 * them. Then block comments, which removes every JSDoc
 * `@typedef {import('./x.js')}` reference wholesale — those are type-only,
 * never a runtime fetch, and the codebase is full of them.
 *
 * Line comments have to go first: a prose `//` comment describing a glob
 * path (e.g. "every render lives in src/render/*") can contain a bare `/*`
 * two-character sequence with no real closing `*``/`, and stripping block
 * comments first would then read that as the *start* of one, non-greedily
 * swallowing everything up to the next unrelated `*``/` — including real
 * import statements in between.
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  return src
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** @param {string} content @returns {string[]} raw specifiers, unresolved */
function specifiersIn(content) {
  const code = stripComments(content);
  const specs = [];
  for (const re of [
    /\bfrom\s+['"]([^'"]+)['"]/g, // `import … from '…'` and `export … from '…'`
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import()
    /^import\s+['"]([^'"]+)['"]/gm, // side-effect-only `import '…';`
  ]) {
    let m;
    while ((m = re.exec(code))) specs.push(m[1]);
  }
  return specs;
}

// ADR 0004: the 3D scene is reached only through map-view.js's own dynamic
// import and is deliberately absent from the dev-path precache list — see
// sw.js's comment beside PRECACHE_URLS. The walk stops here rather than
// following it, the same boundary sw.js itself draws.
const SCENE3D_DIR = path.join(SRC, 'presentation', 'map', 'scene3d') + path.sep;

/**
 * Every local `.js` module reachable from `entryAbsPath`, static or dynamic,
 * scene3d excepted. Throws if a specifier cannot be resolved to a real file —
 * that is exactly as load-bearing a bug as a missing precache line.
 * @param {string} entryAbsPath
 * @returns {Set<string>}
 */
function walk(entryAbsPath) {
  const seen = new Set([entryAbsPath]);
  const stack = [entryAbsPath];
  while (stack.length) {
    const file = stack.pop();
    const dir = path.dirname(file);
    for (const spec of specifiersIn(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue; // a package specifier, not a local file
      const resolved = path.normalize(path.join(dir, spec));
      if (!resolved.endsWith('.js')) continue; // e.g. maplibre-gl's own .css
      if (resolved.startsWith(SCENE3D_DIR)) continue;
      if (!existsSync(resolved)) {
        throw new Error(`${path.relative(ROOT, file)} imports "${spec}", `
          + `which does not resolve to a file (${path.relative(ROOT, resolved)}).`);
      }
      if (!seen.has(resolved)) { seen.add(resolved); stack.push(resolved); }
    }
  }
  return seen;
}

function swPrecacheSrcFiles() {
  const sw = readFileSync(SW_PATH, 'utf8');
  const files = new Set();
  for (const m of sw.matchAll(/'(src\/[^']+\.js)'/g)) files.add(path.join(ROOT, m[1]));
  return files;
}

test('every module src/app.js can reach is precached in sw.js (dev path)', () => {
  const reached = walk(path.join(SRC, 'app.js'));
  const precached = swPrecacheSrcFiles();
  // sw.js's PRECACHE_URLS only ever lists 'src/...' entries for this codebase's
  // own modules (vendor/* libraries are precached separately, under their own
  // path, and are out of scope for this src-module guard) — so the comparison
  // is scoped to src/ reachables the same way the precached set already is.
  const SRC_PREFIX = SRC + path.sep;
  const missing = [...reached]
    .filter((f) => f.startsWith(SRC_PREFIX) && !precached.has(f))
    .map((f) => path.relative(ROOT, f))
    .sort();
  assert.deepEqual(missing, [], `sw.js PRECACHE_URLS is missing: ${missing.join(', ')}`);
});

test('every src/ entry in sw.js PRECACHE_URLS resolves to a real file', () => {
  const precached = swPrecacheSrcFiles();
  const dangling = [...precached].filter((f) => !existsSync(f)).map((f) => path.relative(ROOT, f)).sort();
  assert.deepEqual(dangling, [], `sw.js PRECACHE_URLS names files that do not exist: ${dangling.join(', ')}`);
});
