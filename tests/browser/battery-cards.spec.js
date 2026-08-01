// The E-02 battery-instance library (M15 wave C).
//
// The unit suites prove pairingCheck()'s thresholds and the instance store's
// tolerance. What only a real browser can prove: the cards draw from the real
// fold — a pack added through the form appears as a card, wearing the right
// resistance-provenance chip; Fly routes through the hidden #sel-pack-instance
// select so the plan's footnote follows; and the pairing strip words the
// engine's verdicts without inventing numbers.
//
// External hosts are stubbed exactly as in smoke.spec.js.

import { expect, test } from '@playwright/test';

import { gotoDest, stubExternals, watchConsole } from './harness.js';

/** Add one physical pack through the fold's own form. */
async function addPack(page, { label, cycles, ir }) {
  await page.fill('#pack-instance-label', label);
  await page.fill('#pack-instance-cycles', cycles == null ? '' : String(cycles));
  await page.fill('#pack-instance-ir', ir == null ? '' : String(ir));
  await page.locator('#pack-instance-form button:has-text("Save this pack")').click();
}

async function openBatteriesPage(page) {
  await gotoDest(page, 'aircraft');
  await page.locator('#actab-batteries').click();
  await expect(page.locator('#acpage-batteries')).toBeVisible();
  await page.locator('#pack-instance-fold summary').click();
}

test.describe('battery instance cards', () => {
  test('the shelf starts on the catalog spec, and a saved pack becomes the planned card', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await openBatteriesPage(page);

    // One card before any pack is described: the model as recorded.
    const cards = page.locator('#pack-cards .accard');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toHaveAttribute('aria-current', 'true');
    await expect(cards.first().locator('.packcard-chip')).toHaveText('Spec');
    await expect(page.locator('#pack-pairing')).toBeHidden();

    // Describing a pack selects it — the card appears already planned, and its
    // measured resistance is the one the plan flies.
    await addPack(page, { label: 'Pack A', cycles: 320, ir: 100 });
    await expect(cards).toHaveCount(2);
    const packA = page.locator('#pack-cards .accard', { hasText: 'Pack A' });
    await expect(packA).toHaveAttribute('aria-current', 'true');
    await expect(packA.locator('.packcard-chip')).toHaveText('Measured');
    await expect(packA.locator('.accard-specs')).toContainText('320 cycles');
    // 320 cycles on a Li-Ion pack is worth a sentence, never a health score.
    await expect(packA.locator('.packcard-warn')).toContainText('a lot for a Li-Ion pack');
    await expect(page.locator('#battery-note')).toContainText('Flying Pack A');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('the pairing strip words the engine’s verdicts and nothing else', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await openBatteriesPage(page);

    // Two matched packs: one row, ready, anchored on the pack the plan flies.
    await addPack(page, { label: 'Pack A', cycles: 40, ir: 100 });
    await addPack(page, { label: 'Pack B', cycles: 45, ir: 110 });
    const rows = page.locator('#pack-pairing-rows .pairrow');
    await expect(page.locator('#pack-pairing')).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator('.pairverdict')).toHaveText('Parallel ready');
    await expect(rows.first()).toContainText('ΔIR 10.0 mΩ (10%)');

    // A tired third pack: the anchor moves to it, and its two pairings land on
    // either side of the caution/avoid line — naming who works harder.
    await addPack(page, { label: 'Pack C', cycles: 200, ir: 60 });
    await expect(rows).toHaveCount(2);
    await expect(page.locator('.pairverdict.caution')).toHaveCount(1);
    await expect(page.locator('.pairverdict.avoid')).toHaveCount(1);
    await expect(page.locator('#pack-pairing-rows')).toContainText('more than its share');

    // A pack with no measured resistance never gets a verdict invented for it.
    await addPack(page, { label: 'Pack D', cycles: 5 });
    await expect(rows).toHaveCount(3);
    await expect(page.locator('.pairverdict.unknown')).toHaveCount(3);
    await expect(page.locator('#pack-pairing-rows')).toContainText('measure both packs');

    // Back on the catalog spec there is no anchor — every pair is on the table.
    await page.locator('#pack-cards .accard', { hasText: 'Catalog spec' }).locator('.map-btn').click();
    await expect(rows).toHaveCount(6);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('Fly routes through the fold’s select, and beginner mode keeps the whole shelf away', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await openBatteriesPage(page);
    await addPack(page, { label: 'Pack A', cycles: 40, ir: 100 });
    await addPack(page, { label: 'Pack B', cycles: 45, ir: 110 });

    // B was saved last, so B is planned; Fly on A goes through #sel-pack-instance.
    const packA = page.locator('#pack-cards .accard', { hasText: 'Pack A' });
    await packA.locator('.map-btn').click();
    await expect(packA).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('#battery-note')).toContainText('Flying Pack A');
    const selLabel = await page.locator('#sel-pack-instance option:checked').textContent();
    expect(selLabel).toContain('Pack A');

    // The instance shelf is a full-detail surface, like the fold always was.
    await page.locator('#sel-detail').selectOption('beginner');
    await expect(page.locator('#pack-cards')).toBeHidden();
    await expect(page.locator('#pack-pairing')).toBeHidden();

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
