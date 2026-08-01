// The app-shell update notice (ADR 0012 §4, §7).
//
// The service worker keeps skipWaiting()/clients.claim(), so a build that
// finishes installing takes over the very next fetch with nothing on screen
// having said so — the one event a page can hear that handoff on is
// `controllerchange`, and src/render/update-notice.js turns it into a notice
// the pilot can act on or ignore. The one thing a unit test cannot prove is
// the two-events-look-alike problem this module exists to solve: the very
// first controllerchange a page ever sees is an ordinary install, not an
// update, and must stay silent. This spec drives the real event through a
// real service-worker registration rather than asserting on the module's
// internal state, and dispatches a synthetic second `controllerchange` for
// the "a build actually changed under you" case — Playwright cannot force a
// second real worker to install without a second build on disk, and a plain
// `Event` on `navigator.serviceWorker` reaches the same listener a real
// handoff would.
//
// External hosts are stubbed exactly as in smoke.spec.js; nothing here
// contacts a tile or weather provider.

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

test.describe('app-shell update notice', () => {
  test('stays silent through the ordinary first-install handoff', async ({ context, page }) => {
    await stubExternals(context);
    await page.goto('/');

    // The real first handoff: install → activate → clients.claim() controls
    // this very tab. setupUpdateNotice() captured "no controller yet" at boot
    // and must swallow exactly this one event.
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);

    // Still in the DOM (aria-live regions that come and go are invisible to
    // some assistive tech announcing them), just hidden.
    const notice = page.locator('#update-notice');
    await expect(notice).toBeAttached();
    await expect(notice).toBeHidden();
    await expect(notice).toHaveAttribute('aria-live', 'polite');
  });

  test('a later handoff shows the notice, and it is dismissible from the keyboard', async ({ context, page }) => {
    await stubExternals(context);
    await page.goto('/');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);

    // A second handoff — the one a real deploy fires once this tab is already
    // controlled. Synthetic because forcing a *real* second install needs a
    // second build on disk; the listener cannot tell this from a real one.
    await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));

    const notice = page.locator('#update-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute('aria-live', 'polite');
    await expect(notice.locator('.update-notice-text')).toContainText(
      'updated in the background — reload to run the newest build');

    const reload = notice.getByRole('button', { name: 'Reload' });
    const dismiss = notice.getByRole('button', { name: 'Dismiss' });
    await expect(reload).toBeVisible();
    await expect(dismiss).toBeVisible();

    // Keyboard-reachable and operable, not just clickable: focus it directly
    // (a real <button>, so this is exactly what Tab would land on) and
    // dismiss with Enter rather than a pointer event.
    await dismiss.focus();
    await expect(dismiss).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(notice).toBeHidden();

    // A further handoff still gets through — the suppression is only ever
    // for the very first one, not "the first one after any dismissal".
    await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
    await expect(notice).toBeVisible();
  });
});
