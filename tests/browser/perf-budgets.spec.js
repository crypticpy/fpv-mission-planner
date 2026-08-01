// Performance budgets on bounded fixtures (M4 exit gate, item 5).
//
// Two budgets, and they are different in kind.
//
// The *bundle* budgets are exact and cheap: gzip the built chunks and compare
// bytes. They live in a Playwright spec rather than in a build script for one
// reason — this suite is the only thing in `npm run check` guaranteed to run
// after `vite build`, so a budget asserted here can never be measuring last
// week's dist/.
//
// The *runtime* budgets are deliberately loose. A ceiling tight enough to catch
// a 20 % regression on this machine is a ceiling that fails on a cold CI runner
// with a software rasteriser, and a suite that cries wolf gets deleted. So these
// are tripwires for the kind of regression that changes the shape of the work —
// an edit that starts re-analysing synchronously, a 3D path that stops caching
// its chunk — and not benchmarks. The measured numbers are attached to every
// run, so anyone tracking the trend has the data even though the assertion has
// slack in it.
//
// Fixtures are bounded on purpose: six waypoints, one flat DEM, no network.
// "Fast on a small mission" is the only claim being made.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { expect, test } from '@playwright/test';

import { FIXTURE_ORIGIN, flatDem, pointAt } from '../fixtures/synthetic-dem.mjs';
import {
  activate3d, attachJson, emptyPoint2d, importMissionFile, missionDoc,
  seedTheme, stubExternals, stubImagery, stubTerrain, watchConsole,
} from './harness.js';

/* ---------- what ships ---------- */

const DIST = fileURLToPath(new URL('../../dist/assets/', import.meta.url));

/**
 * Every built asset matching a prefix and extension, gzipped, in kB.
 *
 * Summed rather than picked: `vite build` currently emits the 3D engine as one
 * large chunk and a 67-byte shim, and a budget written against "the big one"
 * would quietly stop covering the split the day rolldown changes its mind. What
 * a pilot pays to enter 3D is all of it.
 *
 * gzip rather than raw or brotli because gzip is what a plain static host —
 * GitHub Pages, which is where this deploys — negotiates by default. Level 9 so
 * the number is stable across Node versions rather than tracking zlib's default.
 *
 * @param {string} prefix @param {string} ext
 */
function gzippedKb(prefix, ext) {
  const files = readdirSync(DIST).filter((f) => f.startsWith(prefix) && f.endsWith(ext));
  expect(files.length, `no ${prefix}*${ext} in dist/assets — was the app built?`)
    .toBeGreaterThan(0);
  const parts = files.map((f) => ({
    file: f,
    kb: Number((gzipSync(readFileSync(join(DIST, f)), { level: 9 }).length / 1024).toFixed(2)),
  }));
  return { parts, kb: Number(parts.reduce((sum, p) => sum + p.kb, 0).toFixed(2)) };
}

/* ---------- the mission the runtime budgets are measured on ---------- */

const GROUND_M = 120;
const at = (/** @type {number} */ east, /** @type {number} */ north) =>
  pointAt(pointAt(FIXTURE_ORIGIN, 0, north), 90, east);

const LAUNCH = at(0, 0);
/** Six waypoints — the bound. A budget on an unbounded route is not a budget. */
const WAYPOINTS = [
  at(600, 500), at(1400, 900), at(2000, 100),
  at(1600, -800), at(700, -1100), at(-200, -400),
];

const seed = () => missionDoc({
  launch: LAUNCH,
  waypoints: WAYPOINTS,
  altitudeMslM: GROUND_M + 140,
  title: 'Budget fixture',
  tag: 'perf',
});

const rowsFor = (/** @type {number} */ n) => n + 2;

test.describe('performance budgets', () => {
  test.use({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });

  /* Numbers, not ratios. The headroom under each is intentional: these are the
   * sizes the M4 work landed at, rounded up to the next round figure, so the
   * assertion fires on a new dependency rather than on ordinary churn. Moving
   * one of these up is a decision someone should have to make on purpose.
   *
   * The entry budget was re-based 160 → 168 at M7 ship, and most of that move
   * is the meter getting honest, not the app getting fatter. Under the old
   * chunk graph the entry statically imported a sibling mission-schema chunk
   * (5.2 kB gzip) that the `index-` prefix never counted — every pilot
   * downloaded it before first paint, invisibly to this assertion. M7's
   * de-tangling (CAMERA_INTENTS moved to mission-schema.js so analyze.js
   * stops dragging the compiler into the entry) collapsed that graph: the
   * entry chunk now carries its whole static closure and nothing rides
   * uncounted. Same meter-equivalent budget (160 + 5.2 ≈ 165) plus M7's real
   * always-path growth (segment editor, shot analysis) minus the brief moving
   * to a lazy chunk, landed at 166.9; 168 keeps the same ~1 kB headroom the
   * old figure had at M6 ship.
   *
   * Re-based 168 → 172 at M10 wave C: the Analyze panels (route timeline,
   * elevation profile) are always-path feature code, 170.8 on landing. If the
   * Plan modes ever become lazy chunks (the M7 brief pattern), claw this back.
   *
   * Re-based 172 → 174 at M10 wave D: the Review fix panel and the fix-linking
   * engine, 172.4 on landing — the same always-path category as wave C, and
   * the same claw-back applies if the Plan modes go lazy.
   *
   * Re-based 174 → 178 at M11 ship: the wind panel, the ladder/heading
   * segments and the map arrows, 177.0 on landing. Always-path on purpose —
   * the ribbon that unfolds it is persistent chrome on all four destinations.
   * The claw-back here is real if ever needed: the panel body only renders on
   * unfold, so it could become a lazy chunk behind the toggle. Verified at
   * this re-base that the split graph is intact (brief, import-router,
   * compile, scene3d all still separate chunks) — this is feature growth,
   * not a chunk collapsing into the entry. */
  /* Re-based 178 → 180 at M12 wave D: the scene viewbar wiring and the five
   * 3D system-state cards, 178.3 on landing. Always-path by design — the
   * cards are exactly the code that must be present when the 3D chunk fails
   * to load, so they cannot live in the 3D chunk; the viewbar is persistent
   * chrome on the map stage. Verified at this re-base that the split graph
   * is intact (all three scene3d chunks still lazy, none in the precache). */
  /* Re-based 180 → 183 at M13 wave D: the Field home card, the offline
   * readiness rows and the first-run tour, 181.6 on landing. The Field
   * surfaces are always-path on purpose — the offline destination is exactly
   * the code that must already be on the device at a trailhead. The claw-back
   * here is the tour: only a first run ever shows it, so it could become a
   * lazy chunk behind the first-run check (the decision reads localStorage
   * synchronously; only the showing would await the import). Verified at
   * this re-base that the split graph is intact (scene3d ×3, brief,
   * import-router, compile, adapter-contracts all still separate chunks). */
  /* Re-based 183 → 187 at M14 wave B: the RecoveryEntry component, the
   * history-and-restore render and the import-preview flow, 183.5 on landing.
   * These live in the mission fold, which is entry-chunk shell on purpose —
   * recovery is exactly the surface that must work offline at a trailhead.
   * The claw-back here is the history section: it renders only while the
   * fold is open, so renderHistory and its component could become a lazy
   * chunk behind the fold toggle the way the brief already is. Verified at
   * this re-base that the split graph is intact (scene3d ×3, brief,
   * import-router, compile, adapter-contracts all still separate chunks). */
  /* Re-based 187 → 191 at M14 wave D: the spot detail page and its forecast
   * chart component, 187.4 on landing. Both sit behind the Library's spots
   * card, which is entry-chunk shell. The claw-back here is the pair itself:
   * the planner (L-03) cannot work without the network anyway — its whole
   * job is a fresh forecast fetch — so spot-detail.js and forecast-chart.js
   * could become a lazy chunk behind the roster's name button, with the
   * click awaiting the import (mind the Chromium failed-import cache: the
   * retry would have to reload, not re-import). Verified at this re-base
   * that the split graph is intact (scene3d ×3, brief, import-router,
   * compile, adapter-contracts all still separate chunks). */
  /* Re-based 191 → 195 at M15 wave D: the Aircraft destination's card
   * surfaces — aircraft/pack cards with the confidence badge and pairing
   * strip (waves B/C), then the camera FOV page and the Model-confidence
   * card (wave D), 191.5 on landing. All of it is the equipment shell a
   * pilot needs offline at the field, so it belongs in the entry chunk.
   * The claw-back here is the camera page: its select/preview pair renders
   * only on its own tab, so camerapage.js could become a lazy chunk behind
   * the tab click (mind the Chromium failed-import cache: the retry would
   * have to reload, not re-import). Verified at this re-base that the split
   * graph is intact (scene3d, brief, import-router, compile,
   * adapter-contracts all still separate chunks). */
  const ENTRY_BUDGET_KB = 195;
  const SCENE3D_BUDGET_KB = 500;

  test('the built bundles are inside their gzip budgets', async () => {
    const entry = gzippedKb('index-', '.js');
    const scene3d = gzippedKb('scene3d-', '.js');
    // Not budgeted, but recorded: the 3D chunk drags MapLibre's stylesheet in
    // with it, and a jump there is worth seeing even though nothing fails on it.
    const scene3dCss = gzippedKb('scene3d-', '.css');
    const entryCss = gzippedKb('index-', '.css');

    await attachJson(test.info(), 'bundle-sizes.json', {
      entry: { ...entry, budgetKb: ENTRY_BUDGET_KB },
      scene3d: { ...scene3d, budgetKb: SCENE3D_BUDGET_KB },
      unbudgeted: { entryCss, scene3dCss },
    });

    expect(entry.kb,
      `the entry bundle is ${entry.kb} kB gzip, over its ${ENTRY_BUDGET_KB} kB budget. `
      + 'This is what every pilot downloads before the app draws anything.')
      .toBeLessThanOrEqual(ENTRY_BUDGET_KB);

    expect(scene3d.kb,
      `the 3D chunk is ${scene3d.kb} kB gzip, over its ${SCENE3D_BUDGET_KB} kB budget. `
      + 'It is lazy (ADR 0004), so this is what pressing 3D costs — not the app.')
      .toBeLessThanOrEqual(SCENE3D_BUDGET_KB);

    /* The split itself, which is the architectural claim ADR 0004 makes and the
     * one a careless `import` in the wrong file would undo overnight. If the 3D
     * engine ever ends up inside the entry chunk, the entry budget above catches
     * it — but only after it has already shipped once at four times the size. */
    expect(scene3d.kb,
      'the 3D chunk is no bigger than the entry bundle — the lazy split has collapsed')
      .toBeGreaterThan(entry.kb);
  });

  test('an edit and a 3D activation land inside their time budgets', async ({ context, page }) => {
    // The 3D budget alone allows 20 s; the whole test needs room around it.
    test.setTimeout(180_000);

    await stubExternals(context, { elevationM: GROUND_M });
    await stubImagery(context);
    await stubTerrain(context, flatDem({ elevM: GROUND_M }));
    await seedTheme(page);
    const errors = watchConsole(page);

    await page.goto('/');
    await page.locator('#tab-2d').click();
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();
    await importMissionFile(page, seed());
    const canvas2d = page.locator('#map-canvas');
    await canvas2d.scrollIntoViewIfNeeded();
    const rows = page.locator('#route-rows tr');
    await expect(rows).toHaveCount(rowsFor(WAYPOINTS.length));

    /* ---- an edit reaches the screen ----
     *
     * Timed from the click to the row appearing, which spans the whole path the
     * pilot waits on: the command, the re-analysis over seven legs, and the
     * render of the card and both map layers. Measured three times because the
     * first edit after a load also pays for whatever the browser was still
     * doing, and the budget is about the steady state. */
    const EDIT_BUDGET_MS = 2_000;
    /** @type {number[]} */
    const editMs = [];
    for (let i = 0; i < 3; i++) {
      const expected = rowsFor(WAYPOINTS.length + i + 1);
      const spot = await emptyPoint2d(page);
      const started = Date.now();
      await canvas2d.click({ position: spot });
      await expect(rows).toHaveCount(expected);
      editMs.push(Date.now() - started);
    }
    const worstEdit = Math.max(...editMs);
    expect(worstEdit,
      `a route edit took ${worstEdit} ms to reach the screen, over the ${EDIT_BUDGET_MS} ms budget. `
      + 'On a six-waypoint mission that means the analysis is no longer keeping up with the pointer.')
      .toBeLessThanOrEqual(EDIT_BUDGET_MS);

    /* ---- 3D comes up ----
     *
     * From the press to the tab re-enabling, which the app only allows once the
     * chunk has arrived and `scene.ready` resolved. The engine measured is the
     * ortho host — the one the tab starts by default since M12 — so this is
     * deck booting and the first terrain tiles decoding, and it is the cost the
     * default press actually pays. A software rasteriser on CI does all of that
     * far slower than a GPU, hence the room. */
    const SCENE_BUDGET_MS = 20_000;
    const started3d = Date.now();
    await activate3d(page);
    const activateMs = Date.now() - started3d;
    expect(activateMs,
      `3D took ${activateMs} ms to become ready, over the ${SCENE_BUDGET_MS} ms budget.`)
      .toBeLessThanOrEqual(SCENE_BUDGET_MS);

    await attachJson(test.info(), 'runtime-budgets.json', {
      waypoints: WAYPOINTS.length,
      editMs, worstEditMs: worstEdit, editBudgetMs: EDIT_BUDGET_MS,
      activate3dMs: activateMs, activate3dBudgetMs: SCENE_BUDGET_MS,
    });

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
