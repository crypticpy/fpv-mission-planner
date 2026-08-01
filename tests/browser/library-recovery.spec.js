// Library recovery in the browser (M14 wave B, L-04/H-04).
//
// The repository contract suite proves what the versions store does, and the
// bridge suite proves the order restore makes its calls in. What only a real
// browser can prove: the history is on screen in the Library, Restore is a
// button whose press actually brings a stored version back to the mission on
// screen, and a picked file is previewed — with nothing stored — until the
// pilot confirms it.
//
// External hosts are stubbed exactly as in smoke.spec.js; nothing here
// contacts a tile or weather provider.

import { expect, test } from '@playwright/test';

import { gotoDest, missionDoc, openMissionFold, stubExternals, watchConsole } from './harness.js';

test.describe('library recovery', () => {
  test('the history lists checkpoints and Restore brings a version back', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await gotoDest(page, 'library');
    await openMissionFold(page);

    // Boot seeded a mission; its first confirmed save recorded checkpoint v1.
    const entries = page.locator('#mission-history .recovery-entry');
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toContainText('CURRENT');
    await expect(entries.first()).toContainText('v1');
    await expect(entries.first()).toContainText('AUTOSAVE');

    // Rename the mission, then restore v1: the state being left is checkpointed
    // (v2), the restore itself is recorded (v3), and the title on screen is the
    // seed's again — nothing along the way was deleted.
    const original = await page.locator('#mission-title').inputValue();
    await page.locator('#mission-title').fill('Renamed for the history test');
    await page.locator('#mission-title').press('Tab');
    await expect(page.locator('#mission-note')).toContainText('Renamed');

    await entries.first().getByRole('button', { name: 'Restore' }).click();
    await expect(page.locator('#mission-note')).toContainText('Restored v1');
    await expect(page.locator('#mission-title')).toHaveValue(original);
    await expect(entries).toHaveCount(3);
    await expect(entries.first()).toContainText('CURRENT');
    await expect(entries.first()).toContainText('RESTORED');
    await expect(entries.first()).toContainText('v3');
    await expect(entries.nth(1)).toContainText('v2');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('an import is previewed, stored only on confirm; cancel stores nothing', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await gotoDest(page, 'library');
    await openMissionFold(page);
    await expect(page.locator('#mission-list .spot-row')).toHaveCount(1);

    const doc = missionDoc({
      launch: { lat: 47.6, lng: -122.1 },
      waypoints: [{ lat: 47.61, lng: -122.11 }, { lat: 47.62, lng: -122.12 }],
      altitudeMslM: 200,
      title: 'Previewed Ridge',
    });
    const file = {
      name: `${doc.id}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(doc)),
    };

    // Cancel first: the preview names what would arrive, and walking away
    // leaves the library exactly as it was.
    await page.locator('#mission-file').setInputFiles(file);
    await expect(page.locator('#import-preview')).toBeVisible();
    await expect(page.locator('#import-preview-title')).toContainText('Previewed Ridge');
    await expect(page.locator('#import-preview-meta')).toContainText('2 waypoints');
    await page.locator('#btn-import-cancel').click();
    await expect(page.locator('#import-preview')).toBeHidden();
    await expect(page.locator('#mission-note')).toContainText('nothing was stored');
    // A round trip re-renders the list from the repository, not from the DOM
    // the preview left behind — still one mission.
    await gotoDest(page, 'plan');
    await gotoDest(page, 'library');
    await expect(page.locator('#mission-list .spot-row')).toHaveCount(1);

    // The same file again — the cleared input fires again — confirmed this time.
    await page.locator('#mission-file').setInputFiles(file);
    await expect(page.locator('#import-preview')).toBeVisible();
    await page.locator('#btn-import-confirm').click();
    await expect(page.locator('#mission-note')).toContainText('Imported “Previewed Ridge”');
    await expect(page.locator('#mission-list .spot-row')).toHaveCount(2);
    // The import is an event in the new open mission's history, not silence.
    await expect(page.locator('#mission-history .recovery-entry').first()).toContainText('IMPORTED');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
