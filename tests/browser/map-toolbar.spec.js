// The base-layer toggle on the map toolbar (M10 wave B).
//
// It replaced Leaflet's two-press L.control.layers switcher with a one-press
// flip, and it took over that control's persistence path: setBaseLayer fires
// the `baselayerchange` the switcher would have fired, which rides the
// adapter's `viewchange` into the saved map state. What a browser must prove:
// the press actually swaps the layer (the title names the *next* press, so it
// flips), and the choice survives a reload. The 3D half of the button's state
// machine — disabled while MapLibre draws its own ground — is asserted in
// scene-3d.spec.js, which owns the 3D harness.

import { expect, test } from '@playwright/test';

/** A 1×1 transparent PNG, as the stand-in for every map tile. */
const BLANK_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** Stub the third-party origins the app can reach (see smoke.spec.js). */
async function stubExternals(context) {
  await context.route(/(^|\/\/|\.)((server\.)?arcgisonline\.com|tile\.openstreetmap\.org)/, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_TILE }));
  await context.route(/open-meteo\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
}

/** Collects console errors and uncaught page errors for later assertion. */
function watchConsole(page) {
  /** @type {string[]} */
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

test('the base-layer toggle flips in one press and the choice survives a reload', async ({ context, page }) => {
  await stubExternals(context);
  const errors = watchConsole(page);
  await page.goto('/');

  const btn = page.locator('#btn-baselayer');
  // Fresh state opens on satellite; the title names what a press will do.
  await expect(btn).toHaveAttribute('title', 'Base layer: satellite — switch to streets');

  // One press, both effects: the OSM layer is the one on the map, and the
  // title now offers the way back.
  await btn.click();
  await expect(btn).toHaveAttribute('title', 'Base layer: streets — switch to satellite');
  await expect(page.locator('#map-canvas img[src*="openstreetmap"]').first()).toBeAttached();

  // The choice rode `baselayerchange` → `viewchange` into the saved map state.
  await page.reload();
  await expect(page.locator('#btn-baselayer'))
    .toHaveAttribute('title', 'Base layer: streets — switch to satellite');
  await expect(page.locator('#map-canvas img[src*="openstreetmap"]').first()).toBeAttached();

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});
