// The Field destination (F-01 home + O-03 offline readiness, design
// evolution M13) — the first browser coverage the 'field' destination has
// ever had.
//
// What only a browser can prove here: the home card renders off the same
// analysis pass as Plan (a verdict is present and levelled, the tiles carry
// real numbers); the flight clock starts, ticks against the wall clock and
// survives a reload (src/field-timer.js persists the start, not the count);
// the readiness card renders all six rows and its async second pass (evidence
// store, storage estimate) actually lands; and the update check talks to a
// real service-worker registration and reports honestly.
//
// The readiness rows' *wording* is the unit suite's job
// (tests/readiness.test.mjs) — this file pins only what needs a live browser:
// row count, the always-true rows (online signal, the never-stored basemap),
// and the async patch arriving.

import { expect, test } from '@playwright/test';

import { gotoDest, openDest, stubExternals, watchConsole } from './harness.js';

test.describe('the Field destination', () => {
  test('the home card carries a levelled verdict and real numbers off the default loadout', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);
    await page.goto('/');
    await gotoDest(page, 'field');

    const verdict = page.locator('#field-verdict');
    await expect(verdict).toBeVisible();
    expect(['go', 'caution', 'nogo', 'unknown'])
      .toContain(await verdict.getAttribute('data-level'));
    await expect(page.locator('#field-verdict-label')).not.toBeEmpty();
    await expect(page.locator('#field-verdict-why')).not.toBeEmpty();
    await expect(page.locator('#field-mission-title')).not.toBeEmpty();

    // The default loadout flies, so the tiles are numbers, not placeholders.
    await expect(page.locator('#field-radius')).toHaveText(/\d/);
    await expect(page.locator('#field-turnhome')).toHaveText(/\d+:\d{2}/);
    expect(errors).toEqual([]);
  });

  test('the flight clock starts, ticks, survives a reload, and resets', async ({ context, page }) => {
    await stubExternals(context);
    await page.goto('/');
    await gotoDest(page, 'field');

    const value = page.locator('#field-timer');
    const btn = page.locator('#btn-field-timer');
    await expect(value).toHaveText('0:00');
    await expect(btn).toHaveText('Start');

    await btn.click();
    await expect(btn).toHaveText('Reset');
    // One real second must pass — the clock counts the wall, not renders.
    await expect(value).toHaveText(/0:0[1-9]/, { timeout: 5000 });

    // The persisted start is a wall-clock instant, so the reload resumes the
    // count instead of restarting it.
    await page.reload();
    await expect(page.locator('#dest-field')).toBeVisible();
    await expect(btn).toHaveText('Reset');
    await expect(value).toHaveText(/0:0[1-9]|[1-9]:\d{2}/);

    await btn.click();
    await expect(value).toHaveText('0:00');
    await expect(btn).toHaveText('Start');
  });

  test('the readiness card renders all six rows and the async pass lands', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);
    await page.goto('/');
    await gotoDest(page, 'field');

    const rows = page.locator('#field-readiness .rdy-row');
    await expect(rows).toHaveCount(6);

    // The two rows whose truth is the same in every run: Playwright's
    // context is online, and the basemap is never claimed as stored —
    // the card's founding honesty rule.
    await expect(rows.first()).toHaveAttribute('data-state', 'ok');
    await expect(rows.first().locator('.rdy-title')).toHaveText('Online');
    await expect(rows.last().locator('.rdy-title')).toContainText('never stored');
    await expect(rows.last()).toHaveAttribute('data-state', 'info');

    // The async second pass: navigator.storage.estimate() answered, and the
    // missions row now names a figure it could not have known synchronously.
    await expect(rows.nth(4).locator('.rdy-body')).toContainText('Using');
    expect(errors).toEqual([]);
  });

  test('Check for updates asks a real registration and reports the honest answer', async ({ context, page }) => {
    await stubExternals(context);
    await page.goto('/');
    await gotoDest(page, 'field');

    // Same wait as update-notice.spec.js: the first install has claimed the
    // tab, so a registration exists and update() has something to check.
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.locator('#btn-rdy-update').click();

    // The dev worker on disk is byte-identical to the one running, so the
    // only honest answer is "nothing new".
    await expect(page.locator('#rdy-update-note'))
      .toHaveText('You are on the newest build.');
  });

  test('the sunlight latch flips to sun-glare and back to what was set before', async ({ context, page }) => {
    await stubExternals(context);
    await page.goto('/');
    await gotoDest(page, 'field');

    const sun = page.locator('#btn-sunlight');
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
    const before = await theme();
    await expect(sun).toHaveAttribute('aria-pressed', 'false');

    await sun.click();
    await expect(sun).toHaveAttribute('aria-pressed', 'true');
    expect(await theme()).toBe('sun-glare');

    await sun.click();
    await expect(sun).toHaveAttribute('aria-pressed', 'false');
    expect(await theme()).toBe(before);
  });

  test('Open map leads out to the Plan destination', async ({ context, page }) => {
    await stubExternals(context);
    await page.goto('/');
    await gotoDest(page, 'field');

    await page.locator('#btn-field-map').click();
    await expect(page.locator('#dest-plan')).toBeVisible();
    expect(await openDest(page)).toBe('plan');
  });
});
