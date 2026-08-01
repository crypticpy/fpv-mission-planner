// 3D-07, end to end (M16 wave D): the dive as it is flown.
//
// The dynamics arithmetic is unit-tested in tests/dive-dynamics.test.mjs and the
// checks over it in tests/dive-checks.test.mjs. What only a browser can answer is
// whether this surface says what those engines actually produced — because every
// interesting state here is an absence, and an absence is exactly what a screen
// silently papers over:
//
//   * With no dive speed stated there is no clock. The axis has to say so and
//     measure in metres; a seconds axis over an unstated speed would be the panel
//     inventing the one number the pilot withheld.
//   * The vertical-speed track has no series at all then, and reads "not
//     modelled" rather than drawing a flat line at zero.
//   * The pullout badge stays "unchecked" until both the speed and the load are
//     authored, and only then carries a clearance.
//   * There is no thermal card, and the panel says why. The mockup has one; no
//     engine in this codebase estimates motor or ESC temperature. The spec pins
//     the sentence so the card cannot quietly reappear with a number behind it.
//
// The same two figures that turn the run into a timeline are authored mid-spec,
// so each of those is checked on both sides of the one edit that changes it.
//
// External hosts are stubbed as in dive-authoring.spec.js; nothing here contacts
// a tile, terrain or weather provider.

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
const WAYPOINTS = [at(700, 80), at(1500, -60)];

/** The pair the pullout — and the clock — are read from. Nothing derives either. */
const SPEED_MS = 30;
const LOAD_G = 2.5;

test.describe('the dive dynamics reading', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('the timeline and the systems card report what the engines produced, and name what they did not', async ({ context, page }) => {
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
      title: 'Dive dynamics fixture',
      tag: 'dive',
      launchElevationMslM: GROUND_M,
    });
    await importMissionFile(page, doc);

    await activate3d(page);
    await page.locator('#vb-dive').click();
    await page.locator('#route-templates button', { hasText: 'Mountain dive' }).click();
    await expect(page.locator('#dive-strip')).toBeVisible();
    // The ground band under the run is the terrain field itself, drawn: it is
    // there only where a corridor sample came back. Waiting for it is waiting for
    // the analysis to have ground to answer with — without it the clearance rows
    // below are honestly unmodelled, which is a real state but not this one.
    await expect(page.locator('.dive-strip-ground').first()).toBeAttached();

    // ---- the bottom edge offers two readings, and opens on the geometry ----
    // The profile is the reading a plan can always answer; the dynamics need a
    // pack, the air and a terrain corridor, so they are the reading you ask for.
    const profileTab = page.locator('#dive-read-profile');
    const dynamicsTab = page.locator('#dive-read-dynamics');
    await expect(profileTab).toHaveAttribute('aria-pressed', 'true');
    await expect(dynamicsTab).toHaveAttribute('aria-pressed', 'false');

    await dynamicsTab.click();
    await expect(dynamicsTab).toHaveAttribute('aria-pressed', 'true');
    // The dynamics ride the analysis, so they arrive a pass later than the click.
    const phases = page.locator('#dive-phases .dive-phase');
    await expect(phases.first()).toBeVisible();

    // ---- no stated speed, so no clock, and the axis says which ----
    const axisNote = page.locator('#dive-axis .dive-axis-note');
    await expect(axisNote).toContainText('no dive speed stated');
    await expect(page.locator('#dive-axis .dive-tick').last()).toContainText('m');
    // Each phase is measured in the same frame as the axis it sits over.
    await expect(phases.first().locator('.dive-phase-len')).toContainText('m');

    // ---- and the row that needs a speed draws nothing rather than zero ----
    const tracks = page.locator('.dive-tracks .dive-track-plot');
    await expect(tracks.nth(1)).toHaveClass(/is-empty/);
    await expect(tracks.nth(1)).toHaveText('not modelled');
    // Altitude is geometry over two authored gates, so it is real even here —
    // the hole is about the speed, not about the run.
    await expect(tracks.nth(0)).not.toHaveClass(/is-empty/);
    await expect(tracks.nth(0).locator('svg .dive-track-line').first()).toBeAttached();
    // Clearance is the terrain reading, and the terrain has landed — so the hole
    // in this panel is speed-shaped and not ground-shaped, which is the whole
    // distinction the "not modelled" wording exists to keep.
    await expect(tracks.nth(2)).not.toHaveClass(/is-empty/);

    // ---- the systems card takes the standing briefing's seat ----
    const systems = page.locator('#dive-systems');
    await expect(systems).toBeVisible();
    await expect(systems.locator('h3')).toHaveText('Systems margin');
    await expect(page.locator('#conditions-card')).toBeHidden();

    // ---- the absence a pilot is owed a reason for ----
    // No engine in this codebase estimates motor or ESC temperature, so the
    // mockup's fourth card is not drawn and the panel says so in words.
    await expect(page.locator('#dive-absent')).toContainText('No thermal margin is shown');
    await expect(page.locator('#dive-margins .dive-margin')).toHaveCount(4);
    await expect(page.locator('#dive-margins [data-margin="thermal"]')).toHaveCount(0);
    for (const key of ['energy', 'electrical', 'pullout', 'link']) {
      await expect(page.locator(`#dive-margins [data-margin="${key}"]`)).toHaveCount(1);
    }

    // ---- unauthored, the pullout badge is unchecked rather than clear ----
    const pullout = page.locator('#dive-margins [data-margin="pullout"]');
    await expect(pullout).toHaveAttribute('data-tone', 'unknown');
    await expect(pullout).toContainText('unchecked');
    await expect(systems).toContainText('needs a stated dive speed');

    // ---- a phase chip is a control: it opens the leg the phase belongs to ----
    // The pullout is authored on the dive leg, so its chip leads there too.
    const card = page.locator('#dive-card');
    await expect(card).toBeHidden();
    await phases.nth(1).click();
    await expect(card).toBeVisible();
    // One seat: the leg the pilot opened outranks the standing systems card.
    await expect(systems).toBeHidden();

    // ---- state the two figures, on the leg where they are authored ----
    await card.locator('input[data-field="speedMs"]').fill(String(SPEED_MS));
    await card.locator('input[data-field="speedMs"]').blur();
    await card.locator('input[data-field="pulloutLoadG"]').fill(String(LOAD_G));
    await card.locator('input[data-field="pulloutLoadG"]').blur();
    await page.waitForTimeout(SAVE_SETTLE_MS + 400);
    await page.locator('#btn-dive-close').click();
    await expect(card).toBeHidden();
    await expect(systems).toBeVisible();

    // ---- now there is a clock, and the row that needed it has a series ----
    await expect(axisNote).toContainText('at the stated dive speed');
    await expect(page.locator('#dive-axis .dive-tick').last()).toContainText('s');
    await expect(tracks.nth(1)).not.toHaveClass(/is-empty/);
    await expect(tracks.nth(1).locator('svg .dive-track-line').first()).toBeAttached();

    // ---- and the pullout badge carries a clearance it can defend ----
    await expect(pullout).not.toHaveAttribute('data-tone', 'unknown');
    await expect(pullout).not.toContainText('unchecked');
    // Stated, and labelled as stated: the load is the pilot's figure, not a
    // measurement, and the card says which of the two it is.
    await expect(systems).toContainText(`${LOAD_G} g`);
    await expect(systems).toContainText('as stated, not as measured');

    // ---- the way out is reachable from the card that reads the way in ----
    // Until wave D this door did not exist: the recovery plan could only be
    // opened from a pin the pilot might never have placed.
    const recovery = page.locator('#dive-recovery');
    await expect(recovery).toBeHidden();
    await page.locator('#btn-dive-recovery').click();
    await expect(recovery).toBeVisible();
    await expect(recovery.locator('h3')).toHaveText('Recovery plan');

    expect(errors).toEqual([]);
  });
});
