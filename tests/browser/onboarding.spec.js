// The first-run tour (O-01 welcome chooser + O-02 location step, design
// evolution M13).
//
// The one thing the unit suite cannot prove is the tour's whole reason to
// exist: that it shows on a genuinely fresh browser profile and never again
// after any exit. Every other browser spec seeds `fpv:v1:onboarded` through
// the harness precisely so this overlay stays out of their way — this file is
// the only one that boots with `firstRun: true` and meets the tour on purpose.
//
// The location step drives the real permission machinery: Playwright's
// default is to deny the geolocation prompt, which is exactly the pilot who
// presses "Block", and `grantPermissions` + `setGeolocation` is the pilot who
// allows it. Both ends of that fork are what O-02's honesty is about.

import { expect, test } from '@playwright/test';

import { MAP_KEY, openDest, stubExternals, watchConsole } from './harness.js';

test.describe('the first-run tour', () => {
  test('shows once on a fresh profile, and the quiet exit latches it off for good', async ({ context, page }) => {
    await stubExternals(context, { firstRun: true });
    const errors = watchConsole(page);
    await page.goto('/');

    // The welcome chooser, focused for the keyboard, with the location step
    // still behind it.
    const overlay = page.locator('#onboard');
    await expect(overlay).toBeVisible();
    await expect(page.locator('.onboard-card')).toBeFocused();
    await expect(page.locator('#onboard-location')).toBeHidden();
    for (const id of ['#onboard-field', '#onboard-plan', '#onboard-library', '#onboard-dismiss']) {
      await expect(page.locator(id)).toBeVisible();
    }

    // The quiet exit goes straight to the planner…
    await page.locator('#onboard-dismiss').click();
    await expect(overlay).toBeHidden();
    expect(await openDest(page)).toBe('plan');

    // …and the latch survives a reload: the tour never shows twice.
    await page.reload();
    await expect(page.locator('#dest-plan')).toBeVisible();
    await expect(overlay).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('a door pages to the location step, and Not now lands on the chosen destination', async ({ context, page }) => {
    await stubExternals(context, { firstRun: true });
    await page.goto('/');

    await page.locator('#onboard-field').click();
    await expect(page.locator('#onboard-welcome')).toBeHidden();
    await expect(page.locator('#onboard-location')).toBeVisible();
    // The honesty note: until the pilot allows it, the pin is the default spot.
    await expect(page.locator('.onboard-note')).toContainText('Austin');

    await page.locator('#onboard-later').click();
    await expect(page.locator('#onboard')).toBeHidden();
    expect(await openDest(page)).toBe('field');
  });

  test('Escape is an exit, not a trap', async ({ context, page }) => {
    await stubExternals(context, { firstRun: true });
    await page.goto('/');
    await expect(page.locator('#onboard')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('#onboard')).toBeHidden();
    expect(await openDest(page)).toBe('plan');
  });

  test('a granted location moves the launch pin and finishes at the chosen destination', async ({ context, page }) => {
    await stubExternals(context, { firstRun: true });
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 30.4, longitude: -97.9 });
    const errors = watchConsole(page);
    await page.goto('/');

    await page.locator('#onboard-field').click();
    await page.locator('#onboard-locate').click();

    await expect(page.locator('#onboard')).toBeHidden();
    expect(await openDest(page)).toBe('field');
    // The pin actually moved — the whole point of the step.
    const saved = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? 'null'), MAP_KEY);
    expect(saved?.lat).toBeCloseTo(30.4, 5);
    expect(saved?.lng).toBeCloseTo(-97.9, 5);
    expect(errors).toEqual([]);
  });

  test('a denied location gets an honest card, and both ways forward stay live', async ({ context, page }) => {
    await stubExternals(context, { firstRun: true });
    // No grantPermissions: Playwright denies the prompt, exactly like a
    // pilot pressing Block.
    await page.goto('/');

    await page.locator('#onboard-plan').click();
    await page.locator('#onboard-locate').click();

    // The same sentence the rail shows — denial is stated, not papered over,
    // and neither button below it has gone anywhere.
    await expect(page.locator('#onboard-geo')).toContainText('Location denied');
    await expect(page.locator('#onboard-locate')).toBeVisible();
    await expect(page.locator('#onboard-later')).toBeVisible();

    await page.locator('#onboard-later').click();
    await expect(page.locator('#onboard')).toBeHidden();
    expect(await openDest(page)).toBe('plan');
  });

  test('a returning pilot never sees it — a saved session alone is enough', async ({ context, page }) => {
    // firstRun, so the harness does NOT latch `onboarded` — the only thing
    // marking this profile as returning is the session blob an earlier build
    // would have written, which is how a pilot upgrading from before M13
    // must be treated.
    await stubExternals(context, { firstRun: true });
    await page.addInitScript(() =>
      localStorage.setItem('fpv:v1:session', JSON.stringify({ view: 'dashboard' })));
    await page.goto('/');

    await expect(page.locator('.destnav, #nav-plan').first()).toBeAttached();
    await expect(page.locator('#onboard')).toBeHidden();
  });
});
