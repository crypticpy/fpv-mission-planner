// The E-03 camera page and E-04 calibration surface (M15 wave D).
//
// The unit suites prove fovDeg/subjectFraming's geometry and the confidence
// and drift engines. What only a real browser can prove: the camera select is
// the same seam as Plan's segment editor (the profile lands in the mission
// document, not just the DOM), the FOV pane draws from the picked profile,
// and the Model-confidence card re-scores itself when a real cruise leg goes
// through the logbook's own form.
//
// External hosts are stubbed exactly as in smoke.spec.js.

import { expect, test } from '@playwright/test';

import { gotoDest, stubExternals, watchConsole } from './harness.js';

/** Drag a range input to a value the way the page's own listener expects. */
async function setRange(page, id, value) {
  await page.locator(`#${id}`).evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input'));
  }, String(value));
}

test.describe('camera page and calibration surface', () => {
  test('the camera select writes the mission profile and the FOV pane draws it', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await gotoDest(page, 'aircraft');
    await page.locator('#actab-camera').click();
    await expect(page.locator('#acpage-camera')).toBeVisible();

    // No camera on the mission yet: the pane says how to earn a drawing.
    await expect(page.locator('#sel-camera')).toHaveValue('');
    await expect(page.locator('#cam-empty')).toBeVisible();
    await expect(page.locator('#cam-body')).toBeHidden();

    // Picking a camera fills the tiles, the wedge and the framing sentence.
    await page.locator('#sel-camera').selectOption('dji-o3-air-unit');
    await expect(page.locator('#cam-body')).toBeVisible();
    await expect(page.locator('#tile-cam-fov .tile-value')).toContainText('°');
    await expect(page.locator('#cam-preview svg')).toHaveCount(1);
    await expect(page.locator('#cam-framing')).toContainText('% of the frame width');

    // The sliders move the sentence — same math the Plan shot checks use.
    const before = await page.locator('#cam-framing').textContent();
    await setRange(page, 'in-cam-dist', 100);
    await expect(page.locator('#cam-dist-val')).toHaveText('100 m');
    expect(await page.locator('#cam-framing').textContent()).not.toBe(before);

    // The profile lives on the mission, not in this select: leave the page and
    // come back, and the render rebuilds the selection from the document.
    await page.locator('#actab-batteries').click();
    await page.locator('#actab-camera').click();
    await expect(page.locator('#sel-camera')).toHaveValue('dji-o3-air-unit');

    // The camera is equipment identity, not a chart sweep — beginner mode
    // keeps it while Calibration retires.
    await page.locator('#sel-detail').selectOption('beginner');
    await expect(page.locator('#actab-camera')).toBeVisible();
    await expect(page.locator('#actab-calibration')).toBeHidden();

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('the Model-confidence card scores the catalog record once a cruise leg is logged', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await gotoDest(page, 'aircraft');
    await page.locator('#actab-calibration').click();
    await expect(page.locator('#acpage-calibration')).toBeVisible();

    // Empty logbook: catalog provenance, no percentage, no invented numbers.
    await expect(page.locator('#calib-confidence')).toBeVisible();
    await expect(page.locator('#calib-conf-badge .confbadge-word')).toHaveText('Catalog');
    await expect(page.locator('#calib-conf-badge .confbadge-pct')).toHaveCount(0);
    await expect(page.locator('#calib-conf-line')).toContainText('Flying the catalog record');
    await expect(page.locator('#calib-conf-line')).toContainText('No scored cruise legs yet');
    await expect(page.locator('#calib-conf-impact')).toBeHidden();

    // One plausible cruise leg through the form's own door: 20 minutes at
    // 30 mph putting 3500 mAh back into the stock 6S pack solves a cdA just
    // off the catalog's.
    await page.locator('#flightlog-kind').selectOption('cruise');
    await page.fill('#flightlog-time', '20:00');
    await page.fill('#flightlog-mah', '3500');
    await page.fill('#flightlog-speed', '30');
    await page.locator('#flightlog-form summary', { hasText: 'Conditions' }).click();
    await page.fill('#flightlog-temp', '68');
    await page.locator('#flightlog-form button:has-text("Log this flight")').click();

    // The solve is scored against the record that is flying, so the badge
    // earns its percentage and the before/after strip compares the same legs.
    await expect(page.locator('#calib-conf-badge .confbadge-pct')).toHaveCount(1);
    await expect(page.locator('#calib-conf-line')).toContainText('Over 1 logged cruise leg');
    await expect(page.locator('#calib-conf-impact')).toBeVisible();
    await expect(page.locator('#calib-conf-impact')).toContainText('your fit by ±');
    await expect(page.locator('#calib-conf-impact')).toContainText('Not flyable yet');
    await expect(page.locator('#drift-panel')).toBeVisible();

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
