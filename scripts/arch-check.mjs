#!/usr/bin/env node
// arch-check.mjs — static import checks over the application source (ADR 0009).
//
// No dependencies, no parser: the app is plain browser ESM, so every module
// edge is a literal string in an `import`/`export … from` statement and a
// regex over comment-stripped source finds all of them.
//
// Two jobs:
//
//  1. **Every relative import resolves to a real file.** Browsers do not guess
//     extensions or index files, so a specifier that misses is a blank page —
//     and a structure-preserving directory move (M0b's js/ → src/) is exactly
//     the operation that breaks these silently. This runs today.
//
//  2. **Layering.** ADR 0009's taxonomy — domain / application /
//     infrastructure / presentation — is enforced as soon as directories with
//     those names appear anywhere under the source root. Until they do, every
//     module is unlayered and rule 2 has nothing to say. Nothing here needs
//     editing when the layers land; they switch themselves on.
//
// Source root: `src/` when it exists, otherwise `js/`. The M0b move therefore
// needs no change to this file.

import { readdir, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CANDIDATE_ROOTS = ['src', 'js'];
const SOURCE_EXTS = new Set(['.js', '.mjs']);

/**
 * ADR 0009's layering, as "a module in layer X may import layers […]".
 *
 * - domain imports only domain — no I/O, no framework, no UI.
 * - application imports domain + application — orchestration over the model.
 * - infrastructure imports domain contracts, never presentation.
 * - presentation never reaches an infrastructure provider directly; it goes
 *   through application.
 */
const LAYERS = {
  domain: ['domain'],
  application: ['domain', 'application'],
  infrastructure: ['domain', 'infrastructure'],
  presentation: ['domain', 'application', 'presentation'],
};

/**
 * Comments blanked out — so an example import inside a doc block is not read as
 * a real edge — with the line count preserved, so reported line numbers match
 * the file.
 *
 * Line comments go first on each line: this codebase's prose is full of things
 * like `js/render/*`, and treating that as a block-comment opener would swallow
 * the rest of the file.
 */
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (let line of src.split('\n')) {
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) { out.push(''); continue; }
      inBlock = false;
      line = line.slice(end + 2);
    }
    line = line.replace(/(^|[^:'"])\/\/.*$/, '$1');
    line = line.replace(/\/\*.*?\*\//g, '');
    const open = line.indexOf('/*');
    if (open !== -1) { inBlock = true; line = line.slice(0, open); }
    out.push(line);
  }
  return out.join('\n');
}

// Both anchored to the start of a line, because an ESM import/export-from is
// always a top-level statement. The clause between the keyword and `from`
// excludes quotes and semicolons so a match can never run past the end of the
// statement it started in and swallow an unrelated string literal.
const IMPORT_RE = /^[ \t]*import\s+(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/gm;
const EXPORT_FROM_RE = /^[ \t]*export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gm;

/**
 * Static module specifiers in `src`, with the line each was found on.
 * Covers `import x from 's'`, `import 's'`, `export … from 's'`.
 */
function importsOf(src) {
  const clean = stripComments(src);
  const found = [];
  for (const re of [IMPORT_RE, EXPORT_FROM_RE]) {
    for (const m of clean.matchAll(re)) {
      found.push({ spec: m[1], line: clean.slice(0, m.index).split('\n').length });
    }
  }
  return found;
}

/** Every source file under `dir`, absolute, sorted. */
async function walk(dir) {
  const out = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/** The ADR layer a path belongs to, or null when it is not yet layered. */
function layerOf(relPath) {
  for (const segment of relPath.split(path.sep)) {
    if (segment in LAYERS) return segment;
  }
  return null;
}

const sourceRoot = CANDIDATE_ROOTS.map((r) => path.join(ROOT, r)).find((p) => existsSync(p));
if (!sourceRoot) {
  console.error(`arch-check: no source root — looked for ${CANDIDATE_ROOTS.join(', ')} under ${ROOT}`);
  process.exit(1);
}

const files = await walk(sourceRoot);
/** @type {string[]} */
const violations = [];
let edges = 0;
let layeredFiles = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const fromLayer = layerOf(path.relative(sourceRoot, file));
  if (fromLayer) layeredFiles++;
  const src = await readFile(file, 'utf8');

  for (const { spec, line } of importsOf(src)) {
    edges++;

    if (!spec.startsWith('.')) {
      // The runtime has zero production dependencies and no import map, so a
      // bare specifier cannot resolve in the browser.
      violations.push(`${rel}:${line} — bare specifier '${spec}': the app ships no ` +
        'dependencies and no import map, so this cannot resolve in a browser.');
      continue;
    }

    const target = path.resolve(path.dirname(file), spec);
    if (!existsSync(target) || !statSync(target).isFile()) {
      violations.push(`${rel}:${line} — '${spec}' does not resolve to a file ` +
        `(${path.relative(ROOT, target)}). Browsers do not add extensions or index files.`);
      continue;
    }

    if (!fromLayer) continue;
    const toLayer = layerOf(path.relative(sourceRoot, target));
    // An unlayered target is a module that has not been moved into the
    // taxonomy yet — allowed, so the migration can proceed module by module.
    if (!toLayer) continue;
    if (!LAYERS[fromLayer].includes(toLayer)) {
      violations.push(`${rel}:${line} — ${fromLayer} imports ${toLayer} ('${spec}'). ` +
        `${fromLayer} may import: ${LAYERS[fromLayer].join(', ')}.`);
    }
  }
}

const where = path.relative(ROOT, sourceRoot);
if (violations.length) {
  console.error(`arch-check: ${violations.length} violation(s) in ${where}/\n`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(
  `arch-check: clean — ${files.length} modules, ${edges} imports in ${where}/; ` +
  (layeredFiles
    ? `${layeredFiles} layered module(s) checked against ADR 0009.`
    : 'no domain/application/infrastructure/presentation directories yet, so layering rules are dormant.'),
);
