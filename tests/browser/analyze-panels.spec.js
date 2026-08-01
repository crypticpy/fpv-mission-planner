// The Analyze panels of M10 wave C: RouteTimeline and ElevationProfile.
//
// The models are proved without a browser (tests/route-timeline.test.mjs,
// tests/elevation-profile.test.mjs). What only a browser can answer:
//
//   * do the panels actually draw against the live pipeline — a route drawn on
//     the 2D map coming back as timeline rows, and the stubbed elevation
//     service coming back as a profile rather than an eternal "pending";
//   * does the selection genuinely travel — a tap on a timeline row lighting
//     the strip, a tap on the profile lighting the row, and the same segment
//     open in the map's inspector when the pilot switches back to 2D. The
//     model tests can't see this because the selection lives in map-view and
//     the components only rent it.
//
// External hosts are stubbed exactly as in smoke.spec.js; nothing here contacts
// a tile or weather provider.

import { expect, test } from '@playwright/test';

/** A 1×1 transparent PNG, as the stand-in for every map tile. */
const BLANK_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** Stub the third-party origins the app can reach (see smoke.spec.js). */
async function stubExternals(context) {
  // A returning pilot: latch M13's first-run tour off, or its overlay would
  // intercept every click this suite makes (see onboarding.spec.js).
  await context.addInitScript(() => localStorage.setItem('fpv:v1:onboarded', 'true'));
  await context.route(/(^|\/\/|\.)((server\.)?arcgisonline\.com|tile\.openstreetmap\.org)/, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_TILE }));

  await context.route(/open-meteo\.com/, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/elevation')) {
      const points = (url.searchParams.get('latitude') || '').split(',').length;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ elevation: Array.from({ length: points }, () => 150) }),
      });
    }
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

test.describe('the Analyze route panels', () => {
  test('empty states, a drawn route, and a selection that travels', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');

    // ---- before any route: both panels say so, as designed surfaces ----
    await page.locator('#tab-analyze').click();
    await expect(page.locator('#route-timeline .sysstate-title')).toHaveText('NO ROUTE YET');
    await expect(page.locator('#elevation-profile .sysstate-title')).toHaveText('NO ROUTE YET');

    // ---- a two-waypoint route, the same way segment-inspector draws one ----
    await page.locator('#tab-2d').click();
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();
    const canvas = page.locator('#map-canvas');
    await page.locator('#btn-route').click();
    await canvas.click({ position: { x: 340, y: 240 } });
    await canvas.click({ position: { x: 420, y: 330 } });
    await expect(page.locator('#map-canvas .route-marker')).toHaveCount(2);

    await page.locator('#tab-analyze').click();

    /* The strip: two authored legs plus the direct hop home — plus, when the
     * route fits, the dashed loiter tail. Ask only for what every fixture
     * guarantees: at least the three legs, and exactly two clickable ones. */
    const blocks = page.locator('#route-timeline .rtl-block');
    expect(await blocks.count()).toBeGreaterThanOrEqual(3);
    await expect(page.locator('#route-timeline button.rtl-block')).toHaveCount(2);

    // The rows: one per authored leg, named the way the route card names them,
    // and one aggregated way home.
    const rows = page.locator('#route-timeline .rtl-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('Launch → 1');
    await expect(rows.last()).toContainText('Home — direct line');

    /* The profile: the stubbed elevation service answers 150 m for every
     * station, so the field lands and the silhouette draws. If this stays
     * "READING THE GROUND" forever, the corridor→field→render loop is broken. */
    await expect(page.locator('#elevation-profile svg')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#elevation-profile .sysstate-title')).toHaveCount(0);

    // ---- selection: a row press lights the strip… ----
    const firstRow = page.locator('#route-timeline button.rtl-row').first();
    await firstRow.click();
    await expect(page.locator('#route-timeline button.rtl-row').first())
      .toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#route-timeline button.rtl-block').first())
      .toHaveAttribute('aria-pressed', 'true');

    // …a second press is the same toggle the map click is…
    await page.locator('#route-timeline button.rtl-row').first().click();
    await expect(page.locator('#route-timeline button.rtl-row').first())
      .toHaveAttribute('aria-pressed', 'false');

    // …and a press on the profile's first stretch selects that segment.
    await page.locator('#elevation-profile svg rect[fill="transparent"]')
      .click({ position: { x: 20, y: 100 } });
    await expect(page.locator('#route-timeline button.rtl-row').first())
      .toHaveAttribute('aria-pressed', 'true');

    // ---- the same selection is open in the map's inspector, back in 2D ----
    await page.locator('#tab-2d').click();
    await expect(page.locator('#segment-card')).toBeVisible();
    await expect(page.locator('#segment-title')).toHaveText('Launch → 1');
    // Selecting from Analyze must not have edited the route.
    await expect(page.locator('#map-canvas .route-marker')).toHaveCount(2);

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
