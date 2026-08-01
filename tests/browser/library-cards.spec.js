// The mission library's cards, search and filters (M14 wave C, L-01).
//
// The repository contract suite proves what a MissionSummary carries and the
// bridge suite proves New Mission flushes before it seeds. What only a real
// browser can prove: the cards actually draw the badge, the stats and the
// route thumbnail; typing in the search narrows the list the pilot sees (and
// says something honest when nothing matches); the chips filter by where a
// document came from; and the New mission button leaves the old mission on
// the list while a fresh one takes the editor.
//
// External hosts are stubbed exactly as in smoke.spec.js; nothing here
// contacts a tile or weather provider.

import { expect, test } from '@playwright/test';

import { gotoDest, missionDoc, openMissionFold, stubExternals, watchConsole } from './harness.js';

test.describe('mission library cards', () => {
  test('a card carries the origin badge, the stats line, and a route thumbnail', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await gotoDest(page, 'library');
    await openMissionFold(page);

    const cards = page.locator('#mission-list .spot-row.mission-card');
    await expect(cards).toHaveCount(1);

    // The boot mission was authored here — the badge is a word, not a colour.
    const card = cards.first();
    await expect(card).toHaveAttribute('data-origin', 'authored');
    await expect(card.locator('.recovery-badge')).toHaveText('SAVED');
    // The open mission is marked as the one on screen, in both senses.
    await expect(card).toHaveAttribute('aria-current', 'true');
    await expect(card).toContainText('open now');
    // The stats line says how big the mission is…
    await expect(card).toContainText('km');
    await expect(card).toContainText('waypoint');
    // …and the thumbnail is decoration beside it, launch dot always present.
    await expect(card.locator('svg.mission-thumb')).toBeVisible();
    await expect(card.locator('.mission-thumb-launch')).toHaveCount(1);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('search narrows the list and the chips filter by origin', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await gotoDest(page, 'library');
    await openMissionFold(page);

    // Bring in a second mission that really came from somewhere else. A native
    // file keeps its own provenance on import (only a collision re-stamps it),
    // so the file itself says imported — as a friend's export would.
    const doc = missionDoc({
      launch: { lat: 47.6, lng: -122.1 },
      waypoints: [{ lat: 47.61, lng: -122.11 }, { lat: 47.62, lng: -122.12 }],
      altitudeMslM: 200,
      title: 'Cliff Band Sortie',
    });
    doc.provenance.origin = 'imported';
    await page.locator('#mission-file').setInputFiles({
      name: `${doc.id}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(doc)),
    });
    await expect(page.locator('#import-preview')).toBeVisible();
    await page.locator('#btn-import-confirm').click();
    await expect(page.locator('#mission-note')).toContainText('Imported “Cliff Band Sortie”');

    const cards = page.locator('#mission-list .spot-row.mission-card');
    await expect(cards).toHaveCount(2);
    await expect(page.locator('#mission-list [data-origin="imported"] .recovery-badge')).toHaveText('IMPORTED');

    // Search is a narrowing of the same list, not a different store…
    await page.locator('#mission-search').fill('cliff');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('Cliff Band Sortie');
    // …and a search with no matches says so instead of showing an empty void.
    await page.locator('#mission-search').fill('zzz');
    await expect(cards).toHaveCount(0);
    await expect(page.locator('#mission-list .spots-empty')).toContainText('No missions match');
    await page.locator('#mission-search').fill('');
    await expect(cards).toHaveCount(2);

    // The chips split the library by where documents came from.
    const chip = (f) => page.locator(`#mission-filters button[data-filter="${f}"]`);
    await chip('imported').click();
    await expect(chip('imported')).toHaveAttribute('aria-pressed', 'true');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('Cliff Band Sortie');
    await chip('saved').click();
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).not.toContainText('Cliff Band Sortie');
    await expect(cards.first().locator('.recovery-badge')).toHaveText('SAVED');
    await chip('all').click();
    await expect(cards).toHaveCount(2);
    await expect(chip('saved')).toHaveAttribute('aria-pressed', 'false');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('New mission leaves the old one on the list and opens a fresh editor', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await gotoDest(page, 'library');
    await openMissionFold(page);
    await expect(page.locator('#mission-list .spot-row.mission-card')).toHaveCount(1);

    await page.locator('#mission-title').fill('The One Being Left');
    await page.locator('#mission-title').press('Tab');
    await expect(page.locator('#mission-note')).toContainText('Renamed');

    await page.locator('#btn-mission-new').click();
    await expect(page.locator('#mission-note')).toContainText('Started “');

    // The fresh mission takes the editor; the old one is a row, not a memory.
    await expect(page.locator('#mission-title')).not.toHaveValue('The One Being Left');
    const cards = page.locator('#mission-list .spot-row.mission-card');
    await expect(cards).toHaveCount(2);
    const old = page.locator('#mission-list .mission-card', { hasText: 'The One Being Left' });
    await expect(old).toHaveCount(1);
    await expect(old).not.toHaveAttribute('aria-current', 'true');
    await expect(page.locator('#mission-list .mission-card[aria-current="true"]')).toHaveCount(1);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
