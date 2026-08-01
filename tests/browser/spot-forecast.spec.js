// The saved spot's own page and its forecast planner (M14 wave D, L-02/L-03).
//
// What only a real browser can prove: the roster's name button actually pages
// into the detail (list and form hide, back link returns); the page fetches
// the spot's sky and words the current conditions; the day tabs, height
// toggle and hour scrub retell one forecast without disagreeing; "Plan at
// this time" lands on the Plan destination with the audited hour applied; and
// a spot with no reachable sky says so and offers a retry instead of a blank.
//
// The stubbed sky publishes 24 hours from local midnight for day one and no
// hours for days two and three — which is exactly the day-with-no-hours case
// the planner must state honestly rather than draw as an empty axis.

import { expect, test } from '@playwright/test';

import { gotoDest, stubExternals, watchConsole } from './harness.js';

/** Save the current pin as a named spot from the Library's spots card. */
async function saveSpot(page, name, notes) {
  await gotoDest(page, 'library');
  await page.locator('#spot-name').fill(name);
  if (notes) await page.locator('#spot-notes').fill(notes);
  await page.locator('#btn-save-spot').click();
  await expect(page.locator('#spots-note')).toContainText(`Saved “${name}”`);
}

// An hour guaranteed far from "now" on the 24-hour day-one strip, so planning
// for it always shows the forecast banner instead of the Now readout.
const FAR_HOUR = (new Date().getHours() + 12) % 24;

test.describe('spot detail and forecast planner', () => {
  test('the spot page carries the facts, the current sky, and the chart', async ({ context, page }) => {
    await stubExternals(context, { sky: {} });
    const errors = watchConsole(page);

    await page.goto('/');
    await saveSpot(page, 'Ridge Gate', 'Watch the powerlines on approach.');
    await page.locator('#spots-list .spot-open').click();

    // The page replaces the roster — back brings it home.
    const detail = page.locator('#spot-detail');
    await expect(detail).toBeVisible();
    await expect(page.locator('#spots-list')).toBeHidden();
    await expect(page.locator('#spot-form')).toBeHidden();
    await expect(detail).toContainText('Ridge Gate');
    await expect(detail).toContainText('Saved');
    await expect(detail).toContainText('Watch the powerlines on approach.');
    await expect(detail).toContainText('Loadout —');

    // The current sky, worded at the height it was read.
    await expect(page.locator('.spot-now-reading')).toContainText('Right now at 80 m — 12 gusting 18 mph');

    // The chart: wind line, a rain bar per stubbed hour, the golden strip —
    // and the range input as the control the picture decorates.
    await expect(detail.locator('svg.forecast-chart-svg')).toBeVisible();
    await expect(detail.locator('.fc-wind')).toHaveCount(1);
    await expect(detail.locator('.fc-rain')).toHaveCount(24);
    await expect(detail.locator('.fc-gold')).toHaveCount(1);
    await expect(page.locator('#spot-hour')).toBeVisible();
    await expect(page.locator('.fc-legend')).toContainText('Golden hour');

    await detail.locator('.spot-back').click();
    await expect(detail).toBeHidden();
    await expect(page.locator('#spots-list')).toBeVisible();
    await expect(page.locator('#spot-form')).toBeVisible();

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('day tabs, height toggle and the scrub retell the same forecast', async ({ context, page }) => {
    await stubExternals(context, { sky: {} });
    const errors = watchConsole(page);

    await page.goto('/');
    await saveSpot(page, 'Cliff Band');
    await page.locator('#spots-list .spot-open').click();
    const detail = page.locator('#spot-detail');

    // Three day tabs — the fetch really carries three days, no more.
    const dayTab = (i) => detail.locator(`.spot-day-tabs button[data-day="${i}"]`);
    await expect(detail.locator('.spot-day-tabs button')).toHaveCount(3);
    await expect(dayTab(0)).toHaveText('Today');
    await expect(dayTab(0)).toHaveAttribute('aria-pressed', 'true');

    // The stub publishes hours for day one only: day two says so instead of
    // drawing an empty axis.
    await dayTab(1).click();
    await expect(dayTab(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(dayTab(0)).toHaveAttribute('aria-pressed', 'false');
    await expect(detail).toContainText('No hourly forecast for this day yet.');
    await expect(detail.locator('svg.forecast-chart-svg')).toHaveCount(0);
    await dayTab(0).click();
    await expect(detail.locator('svg.forecast-chart-svg')).toBeVisible();

    // The height toggle flips the latch and relabels which wind is drawn.
    const altBtn = (m) => detail.locator(`.spot-alt-toggle button[data-alt="${m}"]`);
    await expect(altBtn(80)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.fc-legend')).toContainText('Wind · 80 m');
    await altBtn(10).click();
    await expect(altBtn(10)).toHaveAttribute('aria-pressed', 'true');
    await expect(altBtn(80)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.fc-legend')).toContainText('Wind · 10 m');

    // Scrubbing changes the clock on the reading; the stubbed sky is the same
    // every hour, so the weather half deliberately stays put.
    const reading = page.locator('#spot-reading');
    const before = await reading.textContent();
    await page.locator('#spot-hour').fill(String(FAR_HOUR));
    await expect(reading).not.toHaveText(before);
    await expect(reading).toContainText('12 gusting 18 mph');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('Plan at this time lands on Plan with the audited hour applied', async ({ context, page }) => {
    await stubExternals(context, { sky: {} });
    const errors = watchConsole(page);

    await page.goto('/');
    await saveSpot(page, 'Bench Overlook');
    await page.locator('#spots-list .spot-open').click();

    await page.locator('#spot-hour').fill(String(FAR_HOUR));
    await page.locator('#btn-spot-plan').click();

    // Plan destination, live mode, and the strip auditioning the chosen hour —
    // with the banner that says the tiles are a forecast, not the current sky.
    await expect(page.locator('body')).toHaveAttribute('data-dest', 'plan');
    await expect(page.locator('#forecast-strip')).toBeVisible();
    await expect(page.locator('#forecast-banner')).toBeVisible();
    await expect(page.locator('#forecast-banner')).toContainText('Planning for');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('a spot with no reachable sky says so and offers a retry', async ({ context, page }) => {
    await stubExternals(context); // no sky: the forecast host answers junk
    const errors = watchConsole(page);

    await page.goto('/');
    await saveSpot(page, 'No Signal Draw');
    await page.locator('#spots-list .spot-open').click();

    const detail = page.locator('#spot-detail');
    await expect(detail).toBeVisible();
    // The facts still stand; the sky is honestly absent, not pretended.
    await expect(detail).toContainText('No Signal Draw');
    await expect(page.locator('.spot-fetch-error')).toContainText('Could not fetch this spot’s weather');
    await expect(detail.locator('svg.forecast-chart-svg')).toHaveCount(0);

    // Retry really refetches — the host is still down, so the page lands back
    // on the same honest error rather than a spinner or a blank.
    await page.locator('#btn-spot-retry').click();
    await expect(page.locator('.spot-fetch-error')).toContainText('Could not fetch this spot’s weather');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
