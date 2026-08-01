// The wind intelligence suite on screen (M11 exit gate).
//
// tests/wind-panel.test.mjs and tests/wind-layer.test.mjs pin the models and
// the legend wording at the unit level. What they cannot prove is the suite's
// central claim: that every figure in the panel is the app's own state worn
// four ways — so pressing a rung moves the rail's cruise select, pressing a
// heading moves the rail's wind-mode select, and the map's legend loses its
// "read at N m" the moment the sky stops being the live one. That
// cross-surface agreement only exists in a booted browser, and it is what
// this file asserts:
//
//   * is the ribbon really on every destination, and does it unfold the panel
//     wherever the pilot happens to be?
//   * do W-02 and W-03 write back through the rail's own controls rather than
//     through some private state of their own?
//   * does the W-04 legend follow the preset-honesty rule end-to-end — a live
//     profile names its height, a preset names none, calm draws nothing? This
//     is the regression test for leaveLiveSky() (src/app.js): before it, a
//     live profile latched by a successful fetch survived the switch to a
//     preset and the legend kept naming a height for a wind that was never
//     read at one.
//   * does the panel's door land on the Plan 2D map with the panel folded?
//   * does a height-only resize — the mobile URL bar collapsing — re-measure
//     the arrow canvas? The stage is viewport-relative and the canvas is
//     stretched by CSS, so a backing store that missed the resize skews every
//     bearing until the next render pass happens to run.
//
// The arrows are canvas pixels, so the one probe that touches them counts lit
// pixels through getImageData rather than guessing at geometry. Everything
// else is read as DOM, the way the other M-gate specs read their surfaces.
//
// Nothing here reaches the network: the harness answers the forecast with a
// steady 12 mph westerly, and tiles are a blank PNG.

import { expect, test } from '@playwright/test';

import { gotoDest, stubExternals, watchConsole } from './harness.js';

/**
 * Boot the app with the harness's sky answering the live fetch, so the wind
 * profile latches and every level of the ladder has the default westerly.
 * @param {import('@playwright/test').Page} page
 */
async function boot(page) {
  await page.goto('/');
  await expect(page.locator('#verdict-badge')).toHaveText(/^(GO|CAUTION|DON’T FLY)$/);
}

/**
 * Unfold the panel through the ribbon — the only door it has.
 * @param {import('@playwright/test').Page} page
 */
async function openPanel(page) {
  const toggle = page.locator('.windrib-toggle');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#wind-panel')).toBeVisible();
}

/**
 * Drive the weather rail by hand — the same helper wind-advisory.spec.js
 * carries, six lines and not worth a harness seat yet.
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, number>} fields  input id → value
 */
async function setCustomWeather(page, fields) {
  await page.locator('#sel-weather').selectOption('custom');
  for (const [id, value] of Object.entries(fields)) {
    await page.locator(`#${id}`).fill(String(value));
    await page.locator(`#${id}`).dispatchEvent('input');
  }
}

/**
 * How many pixels the W-04 arrow canvas actually lit. -1 while the canvas has
 * not been created or sized, so a poll can tell "not yet" from "calm".
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<number>}
 */
function litArrowPixels(page) {
  return page.evaluate(() => {
    const c = document.querySelector('#map-canvas canvas.wind-arrows');
    if (!(c instanceof HTMLCanvasElement) || !c.width) return -1;
    const data = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
    if (!data) return -1;
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) { if (data[i] > 0) lit += 1; }
    return lit;
  });
}

test.describe('the wind panel in a browser', () => {
  test('the ribbon is on every destination and unfolds the panel', async ({ context, page }) => {
    test.setTimeout(90_000);
    await stubExternals(context, { sky: {} });
    const errors = watchConsole(page);
    await boot(page);

    await openPanel(page);

    // Three segments, Now selected first.
    await expect(page.locator('.windpanel-seg')).toHaveCount(3);
    await expect(page.locator('[data-i="seg-now"]')).toHaveAttribute('aria-selected', 'true');

    // The hero is the planning wind the ribbon compresses — the harness's
    // westerly, once the live fetch lands, read at the default 80 m level.
    await expect(page.locator('.windpanel-dir')).toHaveText('W · 270°');
    await expect(page.locator('.windpanel-figures .windpanel-level')).toHaveText('Flying height 80 m');
    // The surface tile is a measured 10 m reading, and says so — the proof the
    // profile latched rather than fell back to the rule of thumb.
    await expect(page.locator('.windpanel-tile').first()).toContainText('measured at 10 m');
    await expect(page.locator('.windpanel-tile')).toHaveCount(2);

    // The outlook is the scrubber's state as chips. How many chips fit depends
    // on the wall clock — the stub's forecast ends at midnight — but "Now" is
    // always first and always the selected hour.
    const firstChip = page.locator('.windpanel-hour').first();
    await expect(firstChip.locator('.windpanel-hour-when')).toHaveText('Now');
    await expect(firstChip).toHaveAttribute('aria-pressed', 'true');

    // W-04's door rides every segment.
    await expect(page.locator('.windpanel-openmap')).toHaveText('Open wind map');

    // The chrome is outside the destination sections: walk all four and the
    // open panel never leaves the screen.
    for (const dest of /** @type {const} */ (['field', 'library', 'aircraft', 'plan'])) {
      await gotoDest(page, dest);
      await expect(page.locator('#wind-panel'), `the panel left the screen on ${dest}`).toBeVisible();
      await expect(page.locator('.windrib-toggle')).toBeVisible();
    }

    // Fold it back up.
    await page.locator('.windrib-toggle').click();
    await expect(page.locator('.windrib-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#wind-panel')).toBeHidden();

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('the altitude and heading segments steer the rail, not a private copy', async ({ context, page }) => {
    test.setTimeout(90_000);
    await stubExternals(context, { sky: {} });
    const errors = watchConsole(page);
    await boot(page);
    await openPanel(page);
    // Wait for the live profile before reading the ladder off it.
    await expect(page.locator('.windpanel-tile').first()).toContainText('measured at 10 m');

    // W-02: four rungs, highest on top, the planning level pressed.
    await page.locator('[data-i="seg-altitude"]').click();
    await expect(page.locator('[data-i="seg-altitude"]')).toHaveAttribute('aria-selected', 'true');
    const rungs = page.locator('.windpanel-ladder .windpanel-level');
    await expect(rungs).toHaveCount(4);
    await expect(rungs.first().locator('.windpanel-level-alt')).toHaveText('180 m');
    await expect(page.locator('[data-i="L80"]')).toHaveAttribute('aria-pressed', 'true');

    // Pressing a rung is pressing the rail's cruise-altitude select.
    await page.locator('[data-i="L120"]').click();
    await expect(page.locator('[data-i="L120"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-i="L80"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#sel-cruise-alt')).toHaveValue('120');

    // …and the Now hero follows the level the plan now flies.
    await page.locator('[data-i="seg-now"]').click();
    await expect(page.locator('.windpanel-figures .windpanel-level')).toHaveText('Flying height 120 m');

    // W-03: the three wind-relative courses, the planned one pressed.
    await page.locator('[data-i="seg-headings"]').click();
    await expect(page.locator('.windpanel-heading')).toHaveCount(3);
    await expect(page.locator('.windpanel-leg')).toHaveCount(2); // Out and Home
    await expect(page.locator('[data-i="HheadOut"]')).toHaveAttribute('aria-pressed', 'true');

    // Pressing a row is pressing the rail's wind-mode select.
    await page.locator('[data-i="Hcross"]').click();
    await expect(page.locator('[data-i="Hcross"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#sel-windmode')).toHaveValue('cross');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('the W-04 arrows draw, and the legend follows the preset-honesty rule', async ({ context, page }) => {
    test.setTimeout(90_000);
    await stubExternals(context, { sky: {} });
    const errors = watchConsole(page);
    await boot(page);

    await page.locator('#tab-2d').click();
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();

    // A live profile: arrows on the ground, the height named in the legend.
    await expect(page.locator('.wind-legend')).toHaveText('Arrows point downwind · read at 80 m');
    await expect(page.locator('.wind-text')).toContainText('from 270°');
    await expect.poll(() => litArrowPixels(page), {
      message: 'the arrow canvas never lit a pixel under a 12 mph wind',
    }).toBeGreaterThan(0);

    // A preset wind belongs to no level, and switching to one must also drop
    // the latched live profile — the leaveLiveSky() regression.
    await page.locator('#sel-weather').selectOption('comtn');
    await expect(page.locator('.wind-legend')).toHaveText('Arrows point downwind');
    // The panel agrees: no profile means no ladder, and the surface tile goes
    // back to the labeled rule of thumb.
    await openPanel(page);
    await expect(page.locator('.windpanel-tile').first()).toContainText('estimated');
    await page.locator('[data-i="seg-altitude"]').click();
    await expect(page.locator('.windpanel-nodata')).toContainText('preset sky');

    // Calm air: the legend says why there is nothing, and there is nothing.
    await setCustomWeather(page, { 'in-wind': 0, 'in-gust': 0 });
    await expect(page.locator('.wind-legend')).toHaveText('Calm — no arrows to draw');
    await expect.poll(() => litArrowPixels(page), {
      message: 'calm air left arrows on the map',
    }).toBe(0);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('a height-only resize re-measures the arrow canvas', async ({ context, page }) => {
    test.setTimeout(90_000);
    await stubExternals(context, { sky: {} });
    const errors = watchConsole(page);
    /* The masking this test once fell for: landing on the map schedules the
     * debounced terrain fetches (analysis-host.js, 500 ms), and each answer
     * ends in a full update() — a render pass that redraws the arrows and
     * quietly heals exactly the staleness this test exists to catch. So wait
     * for the app to stop asking the world questions before opening the
     * window: after the last elevation answer the render passes settle, and
     * from there nothing redraws the arrows but the code under test. */
    let lastFetch = Date.now();
    page.on('request', (r) => { if (r.url().includes('open-meteo.com')) lastFetch = Date.now(); });
    await boot(page);

    await page.locator('#tab-2d').click();
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();
    await expect.poll(() => litArrowPixels(page), {
      message: 'the arrow canvas never lit a pixel under a 12 mph wind',
    }).toBeGreaterThan(0);
    await expect.poll(() => Date.now() - lastFetch, {
      message: 'the app never went quiet after landing on the map',
      timeout: 20_000,
    }).toBeGreaterThan(1200);

    /* The canvas's backing store against the box CSS stretches it over. Height
     * only — the app's resize handler routes a width change through a full
     * update(), and it is the cheap height-only path this test is about. */
    const staleness = () => page.evaluate(() => {
      const host = document.querySelector('#map-canvas');
      const c = document.querySelector('#map-canvas canvas.wind-arrows');
      if (!(host instanceof HTMLElement) || !(c instanceof HTMLCanvasElement)) return null;
      const dpr = window.devicePixelRatio || 1;
      return { store: c.height, box: Math.round(host.clientHeight * dpr) };
    });

    const before = await staleness();
    expect(before, 'the arrow canvas is not on the map').not.toBeNull();
    expect(before?.store).toBe(before?.box);

    /* Same width, new height: the debounced handler in src/app.js takes the
     * resizeMapView() branch and never runs a render pass — which is exactly
     * the window the arrows used to go stale in. The stage height is
     * viewport-relative (css/style.css), so the box really changes. */
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('the test browser has no viewport to resize');
    await page.setViewportSize({ width: viewport.width, height: viewport.height - 160 });

    await expect.poll(async () => (await staleness())?.box, {
      message: 'the stage never changed height under the viewport resize',
    }).not.toBe(before?.box);
    await expect.poll(async () => {
      const now = await staleness();
      return now ? now.box - now.store : null;
    }, {
      message: 'the arrow canvas backing store never re-measured after the height-only resize',
    }).toBe(0);
    // Re-measured and redrawn: setting a canvas dimension clears the bitmap, so
    // a fix that resized without stroking would leave a blank, honest-looking canvas.
    await expect.poll(() => litArrowPixels(page), {
      message: 'the resize left the arrow canvas blank',
    }).toBeGreaterThan(0);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('the panel’s door lands on the Plan 2D map with the panel folded', async ({ context, page }) => {
    test.setTimeout(90_000);
    await stubExternals(context, { sky: {} });
    const errors = watchConsole(page);
    await boot(page);

    // Unfold the panel somewhere that is not Plan, then take the door.
    await gotoDest(page, 'field');
    await openPanel(page);
    await page.locator('.windpanel-openmap').click();

    await expect(page.locator('#dest-plan')).toBeVisible();
    await expect(page.locator('#tab-2d')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();
    await expect(page.locator('#wind-panel')).toBeHidden();
    await expect(page.locator('.windrib-toggle')).toHaveAttribute('aria-expanded', 'false');
    // The map the door opened has the arrows on it.
    await expect(page.locator('#map-canvas canvas.wind-arrows')).toBeAttached();

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
