# 0009 — Build/type/test tooling and the move to src/

**Status**: Accepted (2026-07-30)

## Decision

- **npm with a committed `package-lock.json`**; every dependency pinned. The
  runtime app keeps **zero production dependencies** besides vendored map
  libraries; everything below is devDependencies.
- **Vite** builds the production bundle to `dist/` from the existing
  `index.html` entry. Source stays plain browser-runnable ESM — no
  Vite-specific syntax (`import.meta.glob`, aliases) in application code — so
  the no-build dev path (`python3 -m http.server`) keeps working alongside
  `vite dev`. Static deployability is preserved: `dist/` is a plain static
  directory.
- **Service-worker precache is generated from build output.** The hand-written
  `PRECACHE_URLS` list is replaced by a post-build step that reads the Vite
  manifest/dist file list and emits `dist/sw.js` with a content-derived cache
  version. The manual-list failure mode (new asset forgotten → broken offline)
  becomes impossible in production builds.
- **Type checking**: `typescript` as a dev tool only — `tsc --noEmit` with
  `checkJs` over an explicit include list (JSDoc types, no `.ts` rewrite). The
  list starts with new/clean modules and ratchets up; a file added to the list
  never leaves it.
- **Lint**: ESLint flat config, `js.configs.recommended` plus a few
  correctness rules; no stylistic churn against the existing codebase.
- **Browser automation**: Playwright. M0 ships a smoke suite (app boots from
  `dist/` served statically, planner renders a verdict, zero console errors,
  offline reload works after SW install). Later milestones extend it (route
  editing, visual snapshots, a11y).
- **Architecture dependency checks**: `scripts/arch-check.mjs` parses static
  imports and enforces layering as the `src/` taxonomy fills in:
  `domain` imports only `domain`; `application` imports `domain` +
  `application`; `infrastructure` imports `domain` contracts, never
  `presentation`; `presentation` never imports `infrastructure` providers
  directly. Violations fail CI.
- **One command**: `npm run check` = typecheck + lint + unit/contract tests +
  build + arch-check + browser smoke. CI runs exactly this.
- **One deliberate move to `src/`** (M0b): `js/**` → `src/**`
  structure-preserving, all imports/tests/sw/index updated in a single commit.
  Later milestones create the layered directories (`domain/`, `application/`,
  `infrastructure/`, `presentation/`) and move modules as they are refactored
  — no second big-bang.
- **Deployment**: GitHub Pages switches from serving the branch root to a
  GitHub Actions workflow that builds and publishes `dist/` — cut over only
  after the M0 exit gate (built bundle verified online + offline). Until then
  Pages keeps serving the current no-build root, which remains functional.

## Why

Milestones 1–8 need types on frozen contracts, browser evidence, generated SW
manifests, and enforced boundaries. Adding them now, before the mission
document lands, means every later work package inherits `npm run check` as its
acceptance command instead of inventing verification per-feature.

## Consequences

- First-ever `node_modules` in the repo's workflow; CI gains `npm ci` +
  Playwright browser install.
- `sw.js` at the root becomes a dev-only artifact or a generated file —
  the generator is the source of truth.
- All 310 existing tests must pass unchanged through M0a and after the M0b
  move (path updates only).
