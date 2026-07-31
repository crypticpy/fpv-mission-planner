// Subjects and the segment editor, end to end (M7 wave D, ADR 0011 §5).
//
// The arithmetic behind all of this is covered without a browser — what a shot
// row says (tests/map-segment-inspector.test.mjs), where a subject pin goes and
// which gesture raises which command (tests/map-route-layer.test.mjs), the 3D
// placement (tests/map-scene3d.test.mjs) and the brief's wording
// (tests/brief.test.mjs). None of those can answer the question this spec exists
// for: whether an edit made on the map ever reaches the mission document and
// comes back through the analysis.
//
// That path is long and every join in it is a place the wave could be silently
// half-wired. A click has to mean "place a subject" rather than "add a
// waypoint"; the pin has to raise `addSubject`; the bridge has to accept it; the
// inspector's picker has to raise `setSegmentSubject`; the analysis has to
// publish a `shot` for the segment; and the brief has to print it. A unit test
// can prove each link in isolation and still leave the chain broken in the
// middle, which is exactly the failure mode of a wave that adds a port between
// two modules.
//
// One spec, one flow, deliberately: the Playwright suite is a gate on every
// build and its runtime is a cost paid by every push.
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

/** The editor row whose `<dt>` reads `label` — the controls are built, not markup. */
const editorRow = (page, label) => page.locator('#segment-editor dt', { hasText: label })
  .locator('xpath=following-sibling::dd[1]');

test.describe('subjects and the segment editor', () => {
  test('a subject placed on the map becomes a shot in the brief', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await page.locator('#tab-map').click();
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();

    const canvas = page.locator('#map-canvas');
    const card = page.locator('#segment-card');
    const subjects = page.locator('#map-canvas .subject-marker');

    // ---- a two-waypoint route, the same way segment-inspector.spec.js draws one ----
    await page.locator('#btn-route').click();
    await canvas.click({ position: { x: 340, y: 240 } });
    await canvas.click({ position: { x: 420, y: 330 } });
    await expect(page.locator('#map-canvas .route-marker')).toHaveCount(2);
    await expect(subjects).toHaveCount(0);

    // ---- subject mode makes the next click place a thing to film ----
    const subjectMode = page.locator('#btn-subject');
    await subjectMode.click();
    await expect(subjectMode).toHaveAttribute('aria-pressed', 'true');
    await canvas.click({ position: { x: 500, y: 250 } });
    await expect(subjects).toHaveCount(1);
    // Exclusive with route mode: that click must not also have dropped a waypoint.
    await expect(page.locator('#map-canvas .route-marker')).toHaveCount(2);

    // Back to route mode so the rest of the flow clicks legs rather than scenery.
    await subjectMode.click();
    await expect(subjectMode).toHaveAttribute('aria-pressed', 'false');

    // ---- open the second leg and unfold the editor ----
    await page.locator('#map-canvas path.route-hit').nth(1).click();
    await expect(card).toBeVisible();
    await expect(page.locator('#segment-title')).toHaveText('1 → 2');

    const fold = page.locator('#segment-editor-fold');
    await expect(fold).toBeVisible();
    await fold.locator('summary').click();
    await expect(page.locator('#segment-editor')).toBeVisible();

    // ---- attach the subject to this leg ----
    const facts = page.locator('#segment-facts');
    await expect(facts).not.toContainText('Framing');

    await editorRow(page, 'Subject').locator('select').selectOption({ label: 'Untitled subject' });

    /* The whole point of the wave, in one assertion: the edit went out as a
     * command, through the bridge, into the document, back through the analysis
     * pass, and returned as a `shot` record the panel could describe. Nothing on
     * this screen computed it. */
    await expect(facts).toContainText('Framing');
    await expect(facts).toContainText('Untitled subject');
    await expect(facts).toContainText('Subject range');
    await expect(facts).toContainText('Elevation angle');
    // No rejection: the status line stays down when a command lands.
    await expect(page.locator('#segment-status')).toBeHidden();

    // ---- and the intent it is filmed with ----
    await editorRow(page, 'Intent').locator('select').selectOption('orbit');
    await expect(page.locator('#segment-sub')).toContainText('orbit');
    await expect(page.locator('#segment-sub')).toContainText('framing Untitled subject');

    // An orbit brings its own controls with it — the rows that would be refused
    // on another intent do not exist until the intent that carries them is set.
    await expect(page.locator('#segment-editor dt', { hasText: 'Orbit radius' })).toBeVisible();
    await expect(page.locator('#segment-editor dt', { hasText: 'Dwell' })).toBeVisible();

    // ---- a refused command says why, rather than doing nothing ----
    // The direction of an orbit with no radius is not a thing the document can
    // hold, and a control that silently no-ops is worse than one that explains.
    await editorRow(page, 'Orbit direction').locator('select').selectOption('ccw');
    await expect(page.locator('#segment-status')).toBeVisible();
    await expect(page.locator('#segment-status')).not.toBeEmpty();

    await editorRow(page, 'Orbit radius').locator('input').fill('120');
    await editorRow(page, 'Orbit radius').locator('input').blur();
    await expect(page.locator('#segment-status')).toBeHidden();

    // ---- the brief prints the shot ----
    await page.locator('#btn-brief').click();
    const sheet = page.locator('#brief-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Route');
    await expect(sheet).toContainText('orbit Untitled subject');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
