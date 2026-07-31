// esm-imports.mjs — shared extraction of module specifiers from browser ESM.
//
// No dependencies, no parser: the app ships plain browser ESM, so every module
// edge is a literal string in an `import`/`export … from` statement (or a
// literal dynamic `import('…')`), and a regex over comment-stripped source
// finds all of them. Shared by arch-check.mjs (resolution + layering) and
// generate-dev-sw.mjs (the dev worker's precache list), so the two can never
// disagree about what counts as an import.

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

// A dynamic `import('…')` with a literal specifier. `import` must not be
// preceded by an identifier character or a dot (that would be a method call),
// and the argument must be a single string literal — a computed specifier is
// invisible to static analysis and deliberately unmatched.
const DYNAMIC_IMPORT_RE = /(?<![.\w$])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Static module specifiers in `src`, with the line each was found on.
 * Covers `import x from 's'`, `import 's'`, `export … from 's'`.
 */
export function importsOf(src) {
  const clean = stripComments(src);
  const found = [];
  for (const re of [IMPORT_RE, EXPORT_FROM_RE]) {
    for (const m of clean.matchAll(re)) {
      found.push({ spec: m[1], line: clean.slice(0, m.index).split('\n').length });
    }
  }
  return found;
}

/**
 * Literal dynamic `import('…')` specifiers in `src`, with the line each was
 * found on. JSDoc's `import('…')` type syntax lives in comments, so stripping
 * them first is what keeps a typedef from becoming a module edge.
 */
export function dynamicImportsOf(src) {
  const clean = stripComments(src);
  const found = [];
  for (const m of clean.matchAll(DYNAMIC_IMPORT_RE)) {
    found.push({ spec: m[1], line: clean.slice(0, m.index).split('\n').length });
  }
  return found;
}
