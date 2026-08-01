// 3D-06, end to end (M16 wave C).
//
// The arithmetic behind these surfaces is unit-tested twice over — the profile
// model in tests/dive-profile.test.mjs, the dive geometry in tests/dive.test.mjs.
// What only a browser can answer is whether the three of them are the same
// plan: does the strip appear off the gates the template just seeded, does a
// gate button on it open the inspector for that leg, does an altitude typed
// there reach the persisted document, and does the pullout chip stay silent
// until the pilot has stated both numbers it needs.
//
// That last one is the point of the spec. The chip is the surface most likely
// to be asked for a number nobody supplied, so it is checked in all three
// states: neither figure authored, one authored, both authored.
//
// External hosts are stubbed exactly as in dive-conditions.spec.js; nothing
// here contacts a tile, terrain or weather provider.

import { expect, test } from '@playwright/test';

import { FIXTURE_ORIGIN, flatDem, pointAt } from '../fixtures/synthetic-dem.mjs';
import {
  activate3d, importMissionFile, missionDoc, SAVE_SETTLE_MS, seedTheme,
  stubExternals, stubImagery, stubTerrain, watchConsole,
} from './harness.js';

const GROUND_M = 120;
const at = (/** @type {number} */ east, /** @type {number} */ north) =>
  pointAt(pointAt(FIXTURE_ORIGIN, 0, north), 90, east);

const LAUNCH = at(0, 0);
/** The line the dive sketch extends along. */
const WAYPOINTS = [at(700, 80), at(1500, -60)];

/** What the dive gate is raised to by hand, in MSL metres. */
const DIVE_MSL = 300;
/** The pair the pullout is read from — nothing derives either of them. */
const SPEED_MS = 30;
const LOAD_G = 2.5;

/** @param {import('@playwright/test').Page} page @param {string} id */
const persisted = (page, id) => page.evaluate((key) => new Promise((resolve, reject) => {
  const req = indexedDB.open('fpv-planner');
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const db = req.result;
    const get = db.transaction('missions').objectStore('missions').get(key);
    get.onsuccess = () => { db.close(); resolve(get.result); };
    get.onerror = () => { db.close(); reject(get.error); };
  };
}), id);

test.describe('the dive profile strip and the leg inspector', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('a seeded dive is authored through the strip, and the pullout chip only speaks from stated numbers', async ({ context, page }) => {
    // One WebGL init on a software GPU, then cheap DOM assertions.
    test.setTimeout(120_000);

    await stubExternals(context, { elevationM: GROUND_M });
    await stubImagery(context);
    await stubTerrain(context, flatDem({ elevM: GROUND_M }));
    await seedTheme(page);
    const errors = watchConsole(page);

    await page.goto('/');
    await page.locator('#tab-2d').click();
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();
    const doc = missionDoc({
      launch: LAUNCH,
      waypoints: WAYPOINTS,
      altitudeMslM: GROUND_M + 140,
      title: 'Dive authoring fixture',
      tag: 'dive',
      launchElevationMslM: GROUND_M,
    });
    await importMissionFile(page, doc);

    await activate3d(page);
    await page.locator('#vb-dive').click();

    // ---- the template row hands the bottom edge over once a plan exists ----
    const row = page.locator('#route-templates');
    const strip = page.locator('#dive-strip');
    await expect(row).toBeVisible();
    await expect(strip).toBeHidden();
    await row.locator('button', { hasText: 'Mountain dive' }).click();
    await expect(strip).toBeVisible();
    await expect(row).toBeHidden();

    // ---- one button per gate on the flown line, numbered in flight order ----
    const gateButtons = strip.locator('.dive-strip-gate');
    await expect(gateButtons).toHaveCount(3);
    await expect(gateButtons.nth(0)).toHaveAttribute('data-gate', 'approach');
    await expect(gateButtons.nth(1)).toHaveAttribute('data-gate', 'dive');
    await expect(gateButtons.nth(2)).toHaveAttribute('data-gate', 'recovery');
    await expect(gateButtons.nth(1)).toHaveText('2');
    // Flat fixture terrain: every station answered, so the caption claims no holes.
    await expect(page.locator('#dive-strip-caption')).not.toContainText('no ground');

    // ---- a gate button is the selection control for its leg ----
    const card = page.locator('#dive-card');
    await expect(card).toBeHidden();
    await gateButtons.nth(1).click();
    await expect(card).toBeVisible();
    await expect(card).toContainText('Approach → dive');
    await expect(gateButtons.nth(1)).toHaveAttribute('aria-pressed', 'true');

    // ---- nothing authored yet, so the chip names what is missing ----
    const chip = page.locator('#dive-pullout');
    await expect(chip).toHaveAttribute('data-tone', 'unknown');
    await expect(chip).toContainText('No dive speed or pullout load stated');
    // Drop and pitch are geometry over two authored altitudes, so they are real
    // even here — the chip's silence is about speed and load, not about the leg.
    await expect(card).toContainText('Drop');
    await expect(card).toContainText('° down');

    // ---- an altitude typed on the leg reaches the document ----
    const endBox = card.locator('input[data-gate="dive"]');
    const apply = page.locator('#btn-dive-apply');
    await expect(apply).toBeDisabled();
    await endBox.fill(String(DIVE_MSL));
    await endBox.blur();
    await expect(apply).toBeEnabled();
    await apply.click();
    await page.waitForTimeout(SAVE_SETTLE_MS + 400);
    const afterAltitude = await persisted(page, doc.id);
    const gateOf = (/** @type {*} */ saved, /** @type {string} */ kind) =>
      (saved?.scene?.dive?.gates ?? []).find((/** @type {{kind: string}} */ g) => g.kind === kind);
    expect(gateOf(afterAltitude, 'dive')?.altitudeMslM).toBe(DIVE_MSL);

    // ---- AGL is a reading frame; the stored number does not move ----
    const frame = page.locator('#btn-dive-frame');
    await expect(frame).toHaveText('MSL');
    await frame.click();
    await expect(frame).toHaveText('AGL');
    await expect(card.locator('input[data-gate="dive"]'))
      .toHaveValue(String(DIVE_MSL - GROUND_M));
    await expect(card).toContainText(`${DIVE_MSL} m MSL is what is stored`);
    await frame.click();
    await expect(frame).toHaveText('MSL');

    // ---- one figure is not enough for an arc ----
    const speedBox = card.locator('input[data-field="speedMs"]');
    await speedBox.fill(String(SPEED_MS));
    await speedBox.blur();
    await expect(chip).toHaveAttribute('data-tone', 'unknown');
    await expect(chip).toContainText('No pullout load stated');

    // ---- both stated: the arc, and the ground it clears ----
    const loadBox = card.locator('input[data-field="pulloutLoadG"]');
    await loadBox.fill(String(LOAD_G));
    await loadBox.blur();
    await expect(chip).toContainText('sinks');
    await expect(chip).toContainText('clearing the ground under the gate');
    await expect(chip).toHaveAttribute('data-tone', 'good');

    await page.waitForTimeout(SAVE_SETTLE_MS + 400);
    const afterProfile = await persisted(page, doc.id);
    expect(afterProfile?.scene?.dive?.speedMs).toBe(SPEED_MS);
    expect(afterProfile?.scene?.dive?.pulloutLoadG).toBe(LOAD_G);

    // ---- closing the leg puts the standing briefing back in the seat ----
    await page.locator('#btn-dive-close').click();
    await expect(card).toBeHidden();
    await expect(page.locator('#conditions-card')).toBeVisible();
    // The gates are mission geometry, so the strip outlives the selection.
    await expect(strip).toBeVisible();

    expect(errors).toEqual([]);
  });
});

test.describe('the stage chrome at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the tool rail, the strip and the view bar stack without overlapping', async ({ context, page }) => {
    // The bottom of a phone stage carries three things that all want the same
    // edge, and the view bar is the one that wraps — four rows at this width.
    // They used to be anchored by hand-picked `bottom:` offsets, which is a
    // promise each element makes about its neighbours' heights; the view bar
    // broke that promise the moment it wrapped, and the strip landed on top of
    // it. They share one flex column now, so what this guards is the column:
    // no offset arithmetic can drift back in without this failing.
    test.setTimeout(120_000);

    await stubExternals(context, { elevationM: GROUND_M });
    await stubImagery(context);
    await stubTerrain(context, flatDem({ elevM: GROUND_M }));
    await seedTheme(page);
    const errors = watchConsole(page);

    await page.goto('/');
    await page.locator('#tab-2d').click();
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();
    await importMissionFile(page, missionDoc({
      launch: LAUNCH,
      waypoints: WAYPOINTS,
      altitudeMslM: GROUND_M + 140,
      title: 'Dive stacking fixture',
      tag: 'dive',
      launchElevationMslM: GROUND_M,
    }));

    await activate3d(page);
    await page.locator('#vb-dive').click();
    await page.locator('#route-templates button', { hasText: 'Mountain dive' }).click();

    const strip = page.locator('#dive-strip');
    await expect(strip).toBeVisible();

    const box = async (/** @type {string} */ selector) => {
      const rect = await page.locator(selector).boundingBox();
      if (!rect) throw new Error(`${selector} has no box`);
      return rect;
    };
    const viewbar = await box('#scene-viewbar');
    const stripBox = await box('#dive-strip');
    const toolbar = await box('.map-toolbar');

    // Read bottom-up, the way the column is built: the view bar keeps the edge,
    // the strip sits above it, the rail above that. One pixel of tolerance for
    // sub-pixel flex rounding; a real collision is tens of pixels.
    expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(viewbar.y + 1);
    expect(toolbar.y + toolbar.height).toBeLessThanOrEqual(stripBox.y + 1);
    // And the whole column stays on the stage rather than running off the foot.
    const stage = await box('.map-stage');
    expect(viewbar.y + viewbar.height).toBeLessThanOrEqual(stage.y + stage.height + 1);

    // The sheet takes the bottom for itself at this width, so the strip yields
    // to it instead of stacking a fourth row nobody has room for.
    await page.locator('.dive-strip-gate').nth(1).click();
    await expect(page.locator('#dive-card')).toBeVisible();
    await expect(strip).toBeHidden();

    expect(errors).toEqual([]);
  });
});
