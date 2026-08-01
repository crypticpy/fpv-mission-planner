// Aircraft's paged screens and the E-01 card library (M15 wave B).
//
// The unit suites prove modelConfidence()'s honesty rules and the state
// restore's tolerance. What only a real browser can prove: the sub-nav
// actually pages the destination (one panel up at a time, charts drawn at
// real width); the cards draw the badge and the Use press runs the *same*
// handler the old dropdown did — pack re-pick, swap notice and all; every
// relocated fold is really on its new page; and the open page survives a
// reload the way a view preference should.
//
// External hosts are stubbed exactly as in smoke.spec.js; nothing here
// contacts a tile or weather provider.

import { expect, test } from '@playwright/test';

import { gotoDest, stubExternals, watchConsole } from './harness.js';

test.describe('aircraft pages', () => {
  test('the sub-nav pages the destination and the cards carry the confidence badge', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await gotoDest(page, 'aircraft');

    // The destination opens on the Aircraft page; the other panels wait.
    await expect(page.locator('#actab-aircraft')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#acpage-aircraft')).toBeVisible();
    await expect(page.locator('#acpage-batteries')).toBeHidden();
    await expect(page.locator('#acpage-calibration')).toBeHidden();
    // Camera's tab is live since E-03 filled its panel (wave D).
    await expect(page.locator('#actab-camera')).toBeVisible();
    await expect(page.locator('#acpage-camera')).toBeHidden();

    // E-01: one card per airframe, each wearing where its numbers come from.
    const cards = page.locator('#aircraft-cards .accard');
    await expect(cards).toHaveCount(2);
    await expect(cards.first().locator('.confbadge')).toHaveText('Catalog');
    // The airframe on the rail is marked with a word, not a Use button…
    const flying = page.locator('.accard[aria-current="true"]');
    await expect(flying).toHaveCount(1);
    await expect(flying).toContainText('GEPRC MOZ7 V2');
    await expect(flying.locator('.accard-flying')).toHaveText('ON THE RAIL');
    await expect(flying.locator('.map-btn')).toHaveCount(0);
    // …and an unflown catalog model shows no invented percentage.
    await expect(page.locator('.confbadge-pct')).toHaveCount(0);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('Use runs the old dropdown handler: pack re-pick, swap notice, card flip', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await gotoDest(page, 'aircraft');

    const cinelog = page.locator('.accard', { hasText: 'Cinelog30' });
    await cinelog.locator('.map-btn').click();

    // The change went through #sel-drone's own handler: the 6S pack that no
    // longer fits was swapped and the notice says so in the old words.
    await expect(page.locator('#sel-drone')).toHaveValue('cinelog30v3');
    const notice = page.locator('#swap-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('doesn’t fit the GEPRC Cinelog30 V3');
    await expect(notice).toContainText('switched to');

    // The cards trade places.
    await expect(cinelog).toHaveAttribute('aria-current', 'true');
    await expect(cinelog.locator('.accard-flying')).toHaveText('ON THE RAIL');
    await expect(page.locator('.accard', { hasText: 'MOZ7' }).locator('.map-btn')).toBeVisible();

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('every relocated fold is on its page, and the share fold reached the Library', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await gotoDest(page, 'aircraft');

    // Batteries: the pack selects, the parallel toggle, the instance fold and
    // both authoring folds — the E-02 shelf, intact after the move.
    await page.locator('#actab-batteries').click();
    await expect(page.locator('#acpage-batteries')).toBeVisible();
    await expect(page.locator('#acpage-aircraft')).toBeHidden();
    for (const id of ['sel-manufacturer', 'sel-battery', 'in-parallel',
      'pack-instance-fold', 'custom-form', 'manufacturer-form']) {
      await expect(page.locator(`#acpage-batteries #${id}`)).toHaveCount(1);
    }
    // The shoot-out drew at the page's real width, not a hidden-container
    // fallback: bars exist and the chart is wider than the 300px floor.
    await expect(page.locator('#chart-cmp-radius svg rect').first()).toBeVisible();
    const chartW = await page.locator('#chart-cmp-radius svg').evaluate((el) => el.clientWidth);
    expect(chartW).toBeGreaterThan(320);

    // Calibration: the logbook form lives here now.
    await page.locator('#actab-calibration').click();
    await expect(page.locator('#acpage-calibration')).toBeVisible();
    await expect(page.locator('#acpage-calibration #flightlog-form input').first()).toBeVisible();

    // The share fold is the Library's now, and only the Library's.
    await gotoDest(page, 'library');
    await expect(page.locator('#dest-library #share-export')).toHaveCount(1);
    await expect(page.locator('#dest-aircraft #share-export')).toHaveCount(0);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('beginner mode retires the Calibration tab and the open page follows it off', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await gotoDest(page, 'aircraft');
    await page.locator('#actab-calibration').click();
    await expect(page.locator('#acpage-calibration')).toBeVisible();

    await page.locator('#sel-detail').selectOption('beginner');
    // The tab is gone, and the selection did not strand on a hidden page.
    await expect(page.locator('#actab-calibration')).toBeHidden();
    await expect(page.locator('#acpage-calibration')).toBeHidden();
    await expect(page.locator('#actab-aircraft')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#acpage-aircraft')).toBeVisible();

    // Full detail brings the tab back where it was left.
    await page.locator('#sel-detail').selectOption('full');
    await expect(page.locator('#actab-calibration')).toBeVisible();

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('the open page is a saved view preference: a reload comes back to it', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await gotoDest(page, 'aircraft');
    await page.locator('#actab-batteries').click();
    await expect(page.locator('#acpage-batteries')).toBeVisible();

    await page.reload();
    await expect(page.locator('#dest-aircraft')).toBeVisible();
    await expect(page.locator('#actab-batteries')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#acpage-batteries')).toBeVisible();
    await expect(page.locator('#acpage-aircraft')).toBeHidden();

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
