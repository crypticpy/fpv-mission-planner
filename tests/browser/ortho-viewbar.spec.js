// The ortho planner's chrome and the 3D system states (M12, waves C–D).
//
// scene-3d.spec.js proves both engines come up; this spec is the gate on what
// the pilot can *do* with the default one. The viewbar is presentation wiring
// all the way down — every latch is read back from the scene handle rather
// than mirrored (map-view.js `syncViewbar`) — so the assertions here are
// deliberately about aria-pressed and the value readout: if those move, the
// handle moved, and the handle's own geometry is ortho-scene.test.mjs's
// business, not a pixel probe's.
//
// The second half is the M12 failure contract: a 3D that cannot start keeps
// the pilot on the 3D tab with a system-state card over a live 2D map, and
// the card's buttons are the way out — not a silent bounce back to 2D.

import { expect, test } from '@playwright/test';

import { FIXTURE_ORIGIN, flatDem, pointAt } from '../fixtures/synthetic-dem.mjs';
import {
  activate3d, importMissionFile, missionDoc, seedTheme,
  stubExternals, stubImagery, stubTerrain, watchConsole,
} from './harness.js';

const GROUND_M = 120;
const at = (/** @type {number} */ east, /** @type {number} */ north) =>
  pointAt(pointAt(FIXTURE_ORIGIN, 0, north), 90, east);

const LAUNCH = at(0, 0);
/** Eastbound, so "Route bearing up" has one unambiguous answer to compute. */
const WAYPOINTS = [at(700, 80), at(1500, -60), at(2100, 40)];

const seed = () => missionDoc({
  launch: LAUNCH,
  waypoints: WAYPOINTS,
  altitudeMslM: GROUND_M + 140,
  title: 'Viewbar fixture',
  tag: 'viewbar',
});

/** aria-pressed, as a matcher-friendly helper name. */
const pressed = (/** @type {import('@playwright/test').Locator} */ el, /** @type {boolean} */ on) =>
  expect(el).toHaveAttribute('aria-pressed', String(on));

test.describe('the ortho viewbar', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('projection, azimuth, exaggeration and contours all latch, and survive a 2D round trip', async ({ context, page }) => {
    // One WebGL init on a software GPU, then cheap button presses.
    test.setTimeout(120_000);

    await stubExternals(context, { elevationM: GROUND_M });
    await stubImagery(context);
    await stubTerrain(context, flatDem({ elevM: GROUND_M }));
    await seedTheme(page);
    const errors = watchConsole(page);

    await page.goto('/');
    await page.locator('#tab-2d').click();
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();
    await importMissionFile(page, seed());

    await activate3d(page);

    // ---- the opening stance: the defaults the handle was born with ----
    const viewbar = page.locator('#scene-viewbar');
    await expect(viewbar).toBeVisible();
    await expect(viewbar).toHaveAttribute('data-host', 'ortho');
    // The loading card has been dismissed by the engine coming up.
    await expect(page.locator('#scene-state')).toBeHidden();
    await pressed(page.locator('#vb-proj-ortho'), true);
    await pressed(page.locator('#vb-az-free'), true);
    await pressed(page.locator('#vb-contours'), false);
    await expect(page.locator('#vb-exag-value')).toHaveText('1.0×');

    // ---- projection is a three-way latch ----
    await page.locator('#vb-proj-persp').click();
    await pressed(page.locator('#vb-proj-persp'), true);
    await pressed(page.locator('#vb-proj-ortho'), false);
    await page.locator('#vb-proj-top').click();
    await pressed(page.locator('#vb-proj-top'), true);
    await pressed(page.locator('#vb-proj-persp'), false);
    await page.locator('#vb-proj-ortho').click();
    await pressed(page.locator('#vb-proj-ortho'), true);
    await pressed(page.locator('#vb-proj-top'), false);

    // ---- so is azimuth, and Reset lets go back to free orbit ----
    await page.locator('#vb-az-north').click();
    await pressed(page.locator('#vb-az-north'), true);
    await pressed(page.locator('#vb-az-free'), false);
    await page.locator('#vb-az-route').click();
    await pressed(page.locator('#vb-az-route'), true);
    await pressed(page.locator('#vb-az-north'), false);
    await page.locator('#vb-reset').click();
    await pressed(page.locator('#vb-az-free'), true);
    await pressed(page.locator('#vb-az-route'), false);

    // ---- exaggeration steps by quarters and clamps at 1.0 ----
    await page.locator('#vb-exag-up').click();
    await expect(page.locator('#vb-exag-value')).toHaveText('1.25×');
    await page.locator('#vb-exag-down').click();
    await expect(page.locator('#vb-exag-value')).toHaveText('1.0×');
    await page.locator('#vb-exag-down').click();
    await expect(page.locator('#vb-exag-value')).toHaveText('1.0×');

    // ---- contours toggle ----
    await page.locator('#vb-contours').click();
    await pressed(page.locator('#vb-contours'), true);

    // ---- the latches ride the live handle across a 2D round trip ----
    await page.locator('#vb-exag-up').click();
    await expect(page.locator('#vb-exag-value')).toHaveText('1.25×');
    await page.locator('#tab-2d').click();
    await expect(viewbar).toBeHidden();
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();
    await activate3d(page);
    // Same handle, one frame: nothing was rebuilt, so nothing reset.
    await expect(page.locator('#vb-exag-value')).toHaveText('1.25×');
    await pressed(page.locator('#vb-contours'), true);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});

test.describe('when the 3D chunk cannot arrive', () => {
  /* The service worker would both bypass route interception (its own fetches
   * are not the page's) and defeat the premise by serving a cached chunk —
   * blocked, this test is genuinely the first-use-offline case. */
  test.use({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });

  test('the pilot stays on the 3D tab with a card over a live 2D map, and the card recovers', async ({ context, page }) => {
    // The recovery at the end is a document reload plus a cold WebGL init on a
    // software GPU — the one expensive step in an otherwise cheap test.
    test.setTimeout(120_000);

    await stubExternals(context, { elevationM: GROUND_M });
    await stubImagery(context);
    await seedTheme(page);
    // No console assertion here: the aborted chunk request is *supposed* to
    // land in the log — this test is about what the pilot sees instead.
    const CHUNK = /\/assets\/scene3d-[^/]+\.js$/;
    await context.route(CHUNK, (route) => route.abort());

    await page.goto('/');
    await page.locator('#tab-2d').click();
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();

    const tab3d = page.locator('#tab-3d');
    await tab3d.click();
    // The handshake completes — into the failure state, not out of the tab.
    await expect(tab3d).toBeEnabled({ timeout: 30_000 });
    await expect(tab3d).toHaveAttribute('aria-selected', 'true');

    // The designed card, over a 2D map that still works underneath it.
    const card = page.locator('#scene-state');
    await expect(card).toBeVisible();
    await expect(card.locator('.sysstate-title')).toHaveText('3D needs a connection');
    await expect(card.locator('.sysstate-action')).toHaveText('Retry 3D');
    await expect(page.locator('#map-canvas')).toBeVisible();
    await expect(page.locator('#map-3d')).toBeHidden();

    // "Use 2D map" is the card's way out, and it dismisses the card with it.
    await page.locator('#scene-state .sysstate-secondary').click();
    await expect(page.locator('#tab-2d')).toHaveAttribute('aria-selected', 'true');
    await expect(tab3d).toHaveAttribute('aria-selected', 'false');
    await expect(card).toBeHidden();

    // Back onto the tab: the chunk is still unreachable, so the card returns.
    await tab3d.click();
    await expect(tab3d).toBeEnabled({ timeout: 30_000 });
    await expect(card).toBeVisible();

    /* The chunk becoming reachable again is what Retry is for. Retry reloads
     * the document — a failed dynamic import() is cached in the page's module
     * map, so no in-page call could ever re-fetch the chunk. The saved session
     * (view='3d') re-engages 3D on boot, and that boot's fresh module map is
     * what finally fetches it. The routes live on the context, so they hold
     * across the navigation. */
    await context.unroute(CHUNK);
    await stubTerrain(context, flatDem({ elevM: GROUND_M }));
    await page.locator('#scene-state .sysstate-action').click();
    await expect(tab3d).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
    await expect(page.locator('#scene-viewbar')).toBeVisible({ timeout: 60_000 });
    await expect(card).toBeHidden();
    await expect(page.locator('#map-3d canvas').first()).toBeVisible();
  });
});
