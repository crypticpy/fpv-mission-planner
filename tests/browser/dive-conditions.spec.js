// 3D-05, end to end (M16 wave B).
//
// The card's arithmetic is not what this spec is for — conditionsFacts reads
// numbers other passes already own, and those passes have their own gates. What
// only a browser can answer is the wiring: does the card come up when 3D does
// and stand down when it doesn't, does the template row read the document's
// state through the editor port (a routed mission must disable the two
// route-seeding chips and leave the dive chip live), and does tapping a chip
// actually land gates in the persisted mission document — the whole
// port → command-module → bridge → reducer → repository chain, which unit tests
// prove link by link but cannot prove joined.
//
// External hosts are stubbed exactly as in ortho-viewbar.spec.js; nothing here
// contacts a tile, terrain or weather provider.

import { expect, test } from '@playwright/test';

import { FIXTURE_ORIGIN, flatDem, pointAt } from '../fixtures/synthetic-dem.mjs';
import {
  activate3d, importMissionFile, missionDoc, SAVE_SETTLE_MS, seedTheme,
  stubExternals, stubImagery, stubTerrain, watchConsole,
} from './harness.js';

const GROUND_M = 120;
const at = (/** @type {number} */ east, /** @type {number} */ north) =>
  pointAt(pointAt(FIXTURE_ORIGIN, 0, north), 90, east);

const LAUNCH = at(0, 0);
/** A drawn route: what disables the route-seeding chips and aims the dive sketch. */
const WAYPOINTS = [at(700, 80), at(1500, -60)];

test.describe('the mountain conditions card and the template row', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('the card rides 3D mode, and Mountain dive seeds gates into the document', async ({ context, page }) => {
    // One WebGL init on a software GPU, then cheap DOM assertions.
    test.setTimeout(120_000);

    await stubExternals(context, { elevationM: GROUND_M });
    await stubImagery(context);
    await stubTerrain(context, flatDem({ elevM: GROUND_M }));
    await seedTheme(page);
    const errors = watchConsole(page);

    await page.goto('/');
    await page.locator('#tab-2d').click();
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();
    const doc = missionDoc({
      launch: LAUNCH,
      waypoints: WAYPOINTS,
      altitudeMslM: GROUND_M + 140,
      title: 'Dive fixture',
      tag: 'dive',
      // The dive template places gates relative to this; without it the chip
      // must be disabled, which the last block below proves the other way.
      launchElevationMslM: GROUND_M,
    });
    await importMissionFile(page, doc);

    // ---- 2D: neither surface is on screen ----
    const card = page.locator('#conditions-card');
    const row = page.locator('#route-templates');
    await expect(card).toBeHidden();
    await expect(row).toBeHidden();

    await activate3d(page);

    // ---- 3D alone is not enough: the workspace waits on the Dive latch ----
    // Overlays over the stage are summoned, not standing — an always-on row
    // would intercept taps aimed at the canvas and the viewbar under it.
    await expect(card).toBeHidden();
    await expect(row).toBeHidden();
    const latch = page.locator('#vb-dive');
    await latch.click();
    await expect(latch).toHaveAttribute('aria-pressed', 'true');

    // ---- the card, off numbers other passes own ----
    await expect(card).toBeVisible();
    await expect(card).toContainText('Mission conditions');
    await expect(card).toContainText('Launch elevation');
    await expect(card).toContainText('Density altitude');
    await expect(card).toContainText('Lift margin');
    // The wind block is the wind panel's own ladder model — heading either way,
    // and the panel's own sentence when there is no profile to show.
    await expect(card).toContainText('Wind profile');
    // No thermal model exists, so no surface may claim one (ADR 0008).
    await expect(card).not.toContainText(/thermal/i);

    // ---- the template row reads the document through the port ----
    await expect(row).toBeVisible();
    const dive = row.locator('button', { hasText: 'Mountain dive' });
    const traverse = row.locator('button', { hasText: 'Ridge traverse' });
    const orbit = row.locator('button', { hasText: 'High-altitude orbit' });
    await expect(dive).toBeEnabled();
    // This mission has a drawn route, so the route-seeding pair declines —
    // disabled chips wearing the builder's own reason, not missing ones.
    await expect(traverse).toBeDisabled();
    await expect(orbit).toBeDisabled();
    await expect(traverse).toHaveAttribute('title', /already has waypoints/);

    // ---- one tap, three gates, persisted ----
    await dive.click();
    await page.waitForTimeout(SAVE_SETTLE_MS + 400);
    const saved = await page.evaluate((id) => new Promise((resolve, reject) => {
      const req = indexedDB.open('fpv-planner');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const get = db.transaction('missions').objectStore('missions').get(id);
        get.onsuccess = () => { db.close(); resolve(get.result); };
        get.onerror = () => { db.close(); reject(get.error); };
      };
    }), doc.id);
    const gates = saved?.scene?.dive?.gates ?? [];
    expect(gates.map((/** @type {{kind: string}} */ g) => g.kind))
      .toEqual(['approach', 'dive', 'recovery']);
    for (const g of gates) expect(g.altitudeMslM).toBeGreaterThan(GROUND_M);

    // ---- leaving 3D takes both surfaces with it ----
    await page.locator('#tab-2d').click();
    await expect(card).toBeHidden();
    await expect(row).toBeHidden();

    expect(errors).toEqual([]);
  });
});
