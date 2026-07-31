// Interop in the browser (M6 wave D exit gate).
//
// src/interop.js and the import-router sit behind tests/import-router.test.mjs
// and the five adapters' own unit suites, which prove the bytes. What none of
// those can prove is that a pilot in front of the built bundle can actually hand
// this mission to another tool and get a real file, or hand this planner a file
// from one, and that the honesty this feature exists for — what does and does
// not travel — is on screen where a pilot reads it rather than only in a return
// value nothing renders.
//
// Four questions, four specs:
//
//   * does pressing Export actually produce a file, and does the note name what
//     stayed behind?
//   * does picking a real ArduPilot waypoint file through #mission-file open it,
//     with the losses that specific import made named in the note?
//   * does the compatibility report in the mission fold name every exportable
//     format, and the loss every one of them shares (ADR 0010 §2's `reserve`,
//     which no adapter declares support for)?
//   * does the brief's own "Export compatibility" section say the same thing?
//
// External hosts are stubbed exactly as in smoke.spec.js; nothing here contacts
// a tile or weather provider.

import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import {
  importMissionFile, missionDoc, stubExternals, watchConsole,
} from './harness.js';

/** A real ArduPilot/QGC WPL 110 file: one home row and five plain waypoints, no
 * RTL command — this is QGroundControl's own test fixture for what Mission
 * Planner writes (see the matching .provenance.md). Row 0 is home; rows 1-5 are
 * the route, so the resulting mission carries 5 waypoints and no return leg. */
const ARDUPILOT_FIXTURE = readFileSync(
  new URL('../fixtures/interop/qgroundcontrol-missionplanner.waypoints', import.meta.url),
  'utf8',
);

/** Every format the router can name, in the order the registry declares them. */
const FORMAT_LABELS = [
  'GPX 1.1', 'KML', 'QGroundControl Plan', 'ArduPilot mission (QGC WPL 110)', 'INAV mission',
];

async function openMissionFold(page) {
  const fold = page.locator('#mission-fold');
  if (!await fold.evaluate((el) => el.open)) await fold.locator('summary').click();
}

test.describe('interop', () => {
  test('export downloads a real file and names what stayed behind', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    // #route-rows only exists on the Map tab (importMissionFile checks it), and
    // #btn-interop-export sits in the mission fold below either view.
    await page.locator('#tab-map').click();
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();
    await importMissionFile(page, missionDoc({
      launch: { lat: 47.6, lng: -122.1 },
      waypoints: [{ lat: 47.61, lng: -122.11 }, { lat: 47.62, lng: -122.12 }],
      altitudeMslM: 200,
      title: 'Ridge Loop',
    }));

    await page.locator('#interop-format').selectOption('gpx');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#btn-interop-export').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.gpx$/);
    const path = await download.path();
    expect(path, 'the export produced no file').not.toBeNull();
    const text = readFileSync(/** @type {string} */ (path), 'utf8');
    expect(text).toContain('<gpx');
    expect(text).toContain('Ridge Loop');

    // The note names the format and at least the one loss every format shares:
    // ADR 0010 §2's `reserve` concept, which no adapter declares support for.
    await expect(page.locator('#mission-note')).toContainText('Exported as GPX 1.1');
    await expect(page.locator('#mission-note')).toContainText('reserve policy');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('a real ArduPilot waypoint file imports through #mission-file, losses named', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    // #route-rows only exists on the Map tab, checked below.
    await page.locator('#tab-map').click();
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();
    await openMissionFold(page);
    await page.locator('#mission-file').setInputFiles({
      name: 'qgroundcontrol-missionplanner.waypoints',
      mimeType: 'text/plain',
      buffer: Buffer.from(ARDUPILOT_FIXTURE),
    });

    // Row 0 is home; rows 1-5 are the five waypoints, plus the route panel's own
    // straight-line-home leg and the whole-route total row.
    await expect(page.locator('#mission-note')).toContainText('Imported');
    await expect(page.locator('#mission-note')).toContainText('ArduPilot mission (QGC WPL 110)');
    // The two losses this specific import makes (ids re-minted, speed policy
    // not carried by the format) rather than the export-side reserve loss.
    await expect(page.locator('#mission-note')).toContainText('route geometry');
    await expect(page.locator('#mission-note')).toContainText('speed policy');
    await expect(page.locator('#mission-title')).toHaveValue('Imported ArduPilot mission');
    await expect(page.locator('#route-rows tr')).toHaveCount(7);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('the compatibility report in the mission fold names every exportable format', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await openMissionFold(page);

    const rows = page.locator('#interop-report p');
    await expect(rows).toHaveCount(FORMAT_LABELS.length);
    const texts = await rows.allTextContents();
    for (const label of FORMAT_LABELS) {
      expect(texts.some((t) => t.startsWith(`${label}:`)), `no report line for ${label}`).toBe(true);
    }
    // ADR 0010 §2's `reserve` concept is unconditional and no adapter supports
    // it, so every one of those lines names the same loss.
    for (const t of texts) expect(t).toContain('reserve policy');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test("the brief's export-compatibility section names the same losses", async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await expect(page.locator('#verdict-badge')).not.toHaveText('—');
    // #btn-brief lives inside the Map tab's card.
    await page.locator('#tab-map').click();
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();

    await page.locator('#btn-brief').click();
    await expect(page.locator('#brief')).toBeVisible();

    const section = page.locator('#brief-sheet .brief-block', { hasText: 'Export compatibility' });
    await expect(section).toBeVisible();
    await expect(section.locator('dt')).toHaveText(FORMAT_LABELS);
    const losses = await section.locator('dd').allTextContents();
    expect(losses).toHaveLength(FORMAT_LABELS.length);
    // Same unconditional loss as the fold's report, worded with its disposition
    // (deriveLosses calls an unsupported concept "dropped") rather than the
    // rail's own shorter wording — the two surfaces read the same finding, not
    // identical sentences.
    for (const l of losses) expect(l).toContain('reserve policy (dropped)');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
