// The segment inspector, end to end in 2D (M4 wave C).
//
// The pure half of this feature is covered without a browser
// (tests/map-segment-inspector.test.mjs for what it says, and
// tests/map-route-layer.test.mjs for which drawn hop is which segment). What
// only a browser can answer is whether the click ever arrives: the hit targets
// are invisible SVG strokes lying over the route line, and whether an SVG path
// with zero stroke opacity takes a pointer event is a browser question with a
// CSS answer. If `pointer-events` is ever lost, every assertion below fails and
// no unit test notices.
//
// The other half of the job is that selecting a leg must not disturb a single
// gesture that already existed. Route mode has meant "a click on the ground adds
// a waypoint" since M1, and a click that selects a leg travels through Leaflet's
// own event dispatch, which sends it to the map as well by default. So the spec
// insists on the count of waypoints as much as on the panel.
//
// 3D parity is the next wave's suite. The 3D wiring is real — scene-layers.js
// draws one pickable datum per leg and scene.js bridges the pick to the same
// action — but proving it needs WebGL and a terrain handshake, which is what
// scene-3d.spec.js is for.
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

test.describe('the segment inspector', () => {
  test('clicking a leg opens it, closing hides it, and editing clears it', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await page.locator('#tab-map').click();
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();

    const canvas = page.locator('#map-canvas');
    const card = page.locator('#segment-card');
    const markers = page.locator('#map-canvas .route-marker');

    // Nothing is selected before anything is drawn.
    await expect(card).toBeHidden();

    // ---- a two-waypoint route, the same way mission-persistence draws one ----
    await page.locator('#btn-route').click();
    await canvas.click({ position: { x: 340, y: 240 } });
    await canvas.click({ position: { x: 420, y: 330 } });
    await expect(markers).toHaveCount(2);
    await expect(card).toBeHidden();

    /* Two authored segments, so two hit lines: launch → 1 and 1 → 2. The return
     * hop is a line nobody drew and gets none, which is why this is 2 and not 3
     * — a change to that is a change to what can be selected. */
    const hits = page.locator('#map-canvas path.route-hit');
    await expect(hits).toHaveCount(2);

    // ---- clicking the first leg opens it on that leg's own numbers ----
    await hits.first().click();
    await expect(card).toBeVisible();
    await expect(page.locator('#segment-title')).toHaveText('Launch → 1');
    // The click must not also have reached the map underneath: in route mode
    // that would have dropped a third waypoint on the leg just selected.
    await expect(markers).toHaveCount(2);

    // The distance is the analysis's, and it is the same figure the route card's
    // first row is showing — one number, formatted twice.
    const facts = page.locator('#segment-facts');
    const distance = (await facts.locator('dd').first().innerText()).trim();
    expect(distance, 'the distance row never filled in').not.toBe('');
    const firstRowDistance = (await page.locator('#route-rows tr').first()
      .locator('td').nth(1).innerText()).trim();
    expect(distance).toBe(firstRowDistance);

    // …and at least one field that could only have come from the analysis: the
    // segment id the click came back with, which is the key every figure above
    // was looked up under.
    await expect(page.locator('#segment-id')).not.toBeEmpty();
    await expect(facts).toContainText('Altitude');
    await expect(facts).toContainText('Terrain clearance');

    // ---- the second leg switches rather than stacking ----
    await hits.nth(1).click();
    await expect(page.locator('#segment-title')).toHaveText('1 → 2');
    await expect(markers).toHaveCount(2);

    // ---- and clicking it again closes it ----
    await hits.nth(1).click();
    await expect(card).toBeHidden();

    // ---- the close button does the same ----
    await hits.first().click();
    await expect(card).toBeVisible();
    await page.locator('#btn-segment-close').click();
    await expect(card).toBeHidden();

    // ---- a selection that outlives its segment is dropped, not defended ----
    // Select the last leg, then delete the waypoint it arrives at. The panel has
    // to go without a word: editing the route is the pilot working, not a fault.
    await hits.nth(1).click();
    await expect(card).toBeVisible();
    await markers.nth(1).click();
    await expect(markers).toHaveCount(1);
    await expect(card).toBeHidden();

    // The route is still there and still selectable — one segment now.
    await expect(page.locator('#map-canvas path.route-hit')).toHaveCount(1);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
