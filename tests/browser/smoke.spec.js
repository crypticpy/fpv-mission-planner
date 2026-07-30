// Browser smoke suite (ADR 0009).
//
// Everything here runs against dist/ served statically — see playwright.config.js.
// The questions it answers are the ones no unit test can:
//
//   * does the built bundle boot at all, and does the physics reach the screen?
//   * did every asset the app needs actually make it into dist/? (The map tab
//     is the sharp end of this: Leaflet's CSS, its ESM build and the fonts are
//     all separate build inputs, and a broken one shows up as a dead map.)
//   * is the console clean, on both views?
//   * does the generated service worker install and serve the shell offline?
//
// External hosts are stubbed, never contacted. Map tiles come from Esri and
// OSM and the weather from Open-Meteo; a smoke gate that depended on three
// third-party services would fail for reasons that have nothing to do with the
// build, and would breach the tile providers' usage policy on every CI run.

import { expect, test } from '@playwright/test';

/** A 1×1 transparent PNG, as the stand-in for every map tile. */
const BLANK_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Stub the three third-party origins the app can reach. Fulfilled rather than
 * aborted: an aborted request is itself a console error, which would defeat
 * the console assertion below.
 */
async function stubExternals(context) {
  await context.route(/(^|\/\/|\.)((server\.)?arcgisonline\.com|tile\.openstreetmap\.org)/, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_TILE }));

  await context.route(/open-meteo\.com/, (route) => {
    const url = new URL(route.request().url());
    // The elevation endpoint is asked for a list of points and must answer with
    // one sample per point, or the terrain card treats the reply as malformed.
    if (url.pathname.includes('/elevation')) {
      const points = (url.searchParams.get('latitude') || '').split(',').length;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ elevation: Array.from({ length: points }, () => 150) }),
      });
    }
    // Anything else (forecast, archive) gets an empty-but-well-formed payload:
    // the app only fetches these when the pilot asks for live weather, and the
    // smoke run never does.
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
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

test.describe('built app', () => {
  test('planner renders a plan, the map renders, and the console stays clean', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await expect(page).toHaveTitle('FPV Mission Planner');

    // ---- the planner produced a real verdict ----
    // "—" is the placeholder index.html ships; anything else means app.js
    // booted, the catalog loaded and planMission() ran to completion.
    const badge = page.locator('#verdict-badge');
    await expect(badge).not.toHaveText('—');
    // NO PACK is the one non-placeholder verdict that means no mission was
    // solved, so name the three that mean one was.
    await expect(badge).toHaveText(/^(GO|CAUTION|DON’T FLY)$/);

    // ...and the plan behind it. The hero figure is the mission radius; the
    // margins line is the chip string the verdict builds out of the solve.
    await expect(page.locator('#hero-value')).toHaveText(/^\d+(\.\d+)?$/);
    await expect(page.locator('#verdict-margins')).not.toBeEmpty();
    await expect(page.locator('#tile-energy .tile-value')).not.toHaveText('—');

    // ---- the map tab renders a real Leaflet map ----
    // This is the assertion that catches vendored assets missing from dist/:
    // .leaflet-container only exists once leaflet-src.esm.js has run, and the
    // tile pane only fills once leaflet.css has been applied.
    await page.locator('#tab-map').click();
    await expect(page.locator('#view-map')).toBeVisible();
    const leaflet = page.locator('#map-canvas.leaflet-container');
    await expect(leaflet).toBeVisible();
    await expect(page.locator('#map-canvas .leaflet-tile-pane')).toBeAttached();
    await expect(page.locator('#map-canvas .leaflet-tile').first()).toBeAttached();
    // The footprint ring is the map's own read of the same solve.
    await expect(page.locator('#map-canvas .leaflet-overlay-pane path').first()).toBeAttached();

    // Leaflet sizes itself from CSS; a zero-height container means leaflet.css
    // never made it into the bundle.
    const box = await leaflet.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(100);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('the generated service worker installs and serves the shell offline', async ({ context, page }) => {
    await stubExternals(context);

    await page.goto('/');

    // index.html registers the worker on window load; ready resolves once an
    // *active* worker controls this scope, which is after install's waitUntil —
    // so the generated precache list has been fetched and stored by here.
    const swScope = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return reg.active ? reg.scope : null;
    });
    expect(swScope, 'no active service worker').toContain('localhost');

    // The worker claims clients on activate, but the page that triggered the
    // very first install may still be uncontrolled; one reload guarantees the
    // fetch handler is in front of every request before the network is cut.
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);

    // ---- now cut the network and prove the shell is served from cache ----
    await context.setOffline(true);
    try {
      // Guard against a false pass before asserting anything: everything below
      // would also be true of an ordinary online reload. This probe asks for a
      // same-origin URL that is neither precached nor stubbed, so it resolves
      // (as a 404) whenever the network is up and rejects only when it is
      // genuinely down — `navigator.onLine` is not a reliable signal here.
      const reachable = await page.evaluate(() =>
        fetch('./__smoke_offline_probe__', { cache: 'no-store' }).then(() => true, () => false));
      expect(reachable, 'the network was still up — the offline assertions would prove nothing').toBe(false);

      await page.reload();

      await expect(page).toHaveTitle('FPV Mission Planner');
      await expect(page.locator('.masthead h1')).toHaveText('FPV Mission Planner');
      // Not just the HTML: a verdict means the precached JS bundle was served
      // and executed from cache too.
      await expect(page.locator('#verdict-badge')).toHaveText(/^(GO|CAUTION|DON’T FLY)$/);
      await expect(page.locator('#hero-value')).toHaveText(/^\d+(\.\d+)?$/);

      // ...and the worker really was in front of the request that served this
      // document, rather than some browser-level cache.
      const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
      expect(controlled, 'no service worker was controlling the page').toBe(true);
    } finally {
      await context.setOffline(false);
    }
  });
});
