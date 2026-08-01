// Review mode's fix panel, M10 wave D (P-05/T-04).
//
// The model and the engine are proved without a browser (tests/fix-links.test.mjs,
// tests/review-panel.test.mjs). What only a browser can answer:
//
//   * parity — the fix rows are the warning stack's constraints, one for one,
//     and the passive stack actually hides while Review supersedes it;
//   * the links genuinely land — a conditions fix reaches the rail control on
//     desktop, and on the phone layout it opens the conditions sheet first;
//   * the evidence disclosure opens with the constraint's own explanation.
//
// A 20 °F pack drives the constraint used here: a cold pack warns whatever
// the air is doing (physics.js reads the pack's own temperature), so
// W-ENERGY-PACK-COLD is deterministic where the weather-dependent codes are not.

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

test.describe('the Review fix panel', () => {
  test('parity with the stack, an evidence disclosure, and a link that lands', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);
    await page.goto('/');

    // A constraint this spec controls: a 20 °F pack always raises
    // W-ENERGY-PACK-COLD, whatever else the fixture day produces.
    await page.locator('#in-packtemp-on').check();
    await page.locator('#in-packtemp').fill('20');

    await page.locator('#tab-review').click();

    // The panel's two cards are up, and the passive stack has stepped aside.
    await expect(page.locator('.review-fixes h3')).toHaveText('Findings');
    await expect(page.locator('.review-reserve h3')).toHaveText('Final reserve');
    await expect(page.locator('#warnings')).toBeHidden();
    const reviewRows = await page.locator('#review-fixes .fixrow').count();
    expect(reviewRows).toBeGreaterThanOrEqual(1);

    // The driven constraint is a row, wearing the stack's own severity dress
    // and carrying its fix link.
    const coldPack = page.locator('#review-fixes .fixrow[data-code="W-ENERGY-PACK-COLD"]');
    await expect(coldPack).toHaveClass(/warn-caution/);
    await expect(coldPack.locator('.fix-go')).toHaveText('Set the pack temperature');

    // Its evidence opens with the ADR 0008 shape — read / baseline / blind.
    await coldPack.locator('.fix-evidence summary').click();
    await expect(coldPack.locator('.fix-evidence')).toContainText('Read from:');
    await expect(coldPack.locator('.fix-evidence')).toContainText('Baseline:');

    // The reserve confirmation speaks in words, and P-05's numbers are there.
    await expect(page.locator('.review-reserve-line').first())
      .toContainText(/Don’t land below \d+%/);

    // ---- the links land ----
    // A conditions fix reaches its rail control: on desktop the rail is a
    // permanent sidebar, so the press focuses and lights the slider directly.
    await page.locator('.review-reserve .fix-go').click();
    await expect(page.locator('#in-reserve')).toBeFocused();

    // The driven row's own link lands on the pack-temp control it named.
    await coldPack.locator('.fix-go').click();
    await expect(page.locator('#in-packtemp')).toBeFocused();
    await expect(page.locator('#packtemp-row')).toHaveClass(/fix-flash/);

    // ---- parity, counted the other way ----
    // Leaving Review restores the passive stack with the same findings the
    // panel showed — same constraints, same count, no disagreement.
    await page.locator('#tab-analyze').click();
    await expect(page.locator('#warnings')).toBeVisible();
    await expect(page.locator('#warnings .warn')).toHaveCount(reviewRows);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test.describe('on the phone layout', () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test('a conditions fix opens the sheet before it lands', async ({ context, page }) => {
      await stubExternals(context);
      const errors = watchConsole(page);
      await page.goto('/');

      await page.locator('#tab-review').click();
      await expect(page.locator('.review-reserve h3')).toHaveText('Final reserve');

      // The rail is a closed bottom sheet here — the fix link must open it
      // first, then land on the control inside it.
      await page.locator('.review-reserve .fix-go').click();
      await expect(page.locator('body')).toHaveClass(/sheet-open/);
      await expect(page.locator('#btn-plan-controls')).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('#in-reserve')).toBeFocused();

      expect(errors, errors.join('\n')).toEqual([]);
    });
  });
});
