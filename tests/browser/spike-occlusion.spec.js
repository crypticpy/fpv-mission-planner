// ADR 0004 rendering spike — does MapLibre terrain + deck.gl actually render
// mission geometry correctly in 3D?
//
// Run with `npm run spike:occlusion` (playwright.spike.config.js). This spec is
// excluded from `npm run check`.
//
// Everything here is a PIXEL PROBE, not a golden image. The page paints the
// path pure magenta over a terrain palette that cannot produce magenta (the
// ground is the terrarium DEM drawn as imagery, so its red channel is always
// 128-130), which makes "is the path visible at this screen position" a
// question a screenshot can answer exactly. Golden images would couple the
// proofs to a GPU driver; a magenta run in a column does not.
//
// A screenshot is also the only readback that composites BOTH canvases. In
// overlaid mode deck draws into a second canvas stacked over the map, so
// reading the map's own framebuffer would report "occluded" for a path that is
// plainly painted on top of the ridge. The proofs must be about what a user
// sees, so they are taken from what the page presents.
//
// Four questions, and the answers this spec pins down:
//
//   1. Does explicit MSL Z render above the terrain (ridge and valley)?   yes
//   2. Does terrain occlude a path behind it?              interleaved only
//   3. Does picking identify the path?             yes, in both modes, but
//                                                  see the ordering note below
//   4. What does it cost?                          spike/occlusion/measure.mjs

import { expect, test } from '@playwright/test';

import { decode, pixelAt } from '../../spike/occlusion/png.mjs';
import {
  SCENES,
  SURFACES,
  isPathPixel,
  isSkyPixel,
  offsetToLngLat,
} from '../../spike/occlusion/scene.mjs';

const MODES = ['interleaved', 'overlaid'];

/**
 * Load a scene and wait until the terrain, the style and deck have all settled.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{scene: string, mode: string, alt?: number}} opts
 */
async function render(page, { scene, mode, alt }) {
  const query = new URLSearchParams({ scene, mode });
  if (alt !== undefined) query.set('alt', String(alt));
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => 'spike' in window, null, { timeout: 45_000 });
  await page.evaluate(() => window.spike.ready);

  const errors = await page.evaluate(() => window.spike.errors);
  // A DEM tile that failed to decode would leave holes in the terrain, and a
  // hole reads exactly like "the path is visible here". No proof below is
  // meaningful unless the terrain loaded completely.
  expect(errors, `page errors in ${scene}/${mode}`).toEqual([]);

  return decode(await page.screenshot());
}

/**
 * Every row where the path is painted, within a few columns of `col`.
 *
 * The window makes "absent" the strict reading and "present" the forgiving one,
 * which is the right way round: a false PASS on occlusion is the outcome this
 * spike exists to rule out.
 */
function pathRows(image, col, halfWidth = 2) {
  const rows = [];
  for (let y = 0; y < image.height; y++) {
    for (let x = col - halfWidth; x <= col + halfWidth; x++) {
      const [r, g, b] = pixelAt(image, x, y);
      if (isPathPixel(r, g, b)) { rows.push(y); break; }
    }
  }
  return rows;
}

/** The vertical centre of the painted path in a column, or null if absent. */
function pathRow(image, col) {
  const rows = pathRows(image, col);
  return rows.length ? (rows[0] + rows[rows.length - 1]) / 2 : null;
}

/** Is the path painted anywhere at all in this frame? */
function anyPathPixels(image) {
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const [r, g, b] = pixelAt(image, x, y);
      if (isPathPixel(r, g, b)) return true;
    }
  }
  return false;
}

/** Screen column of a probe, from deck's own projection of its coordinate. */
async function probeColumn(page, scene, probe) {
  const [lng, lat] = offsetToLngLat(...probe.atKm);
  const alt = await page.evaluate(() => window.spike.info().pathAltM);
  const [x] = await page.evaluate(
    ([lo, la, z]) => window.spike.project(lo, la, z),
    [lng, lat, alt],
  );
  return Math.round(x);
}

// ---------------------------------------------------------------------------
// Proof 1 — explicit MSL Z renders above the terrain, in ridge and valley
// ---------------------------------------------------------------------------

for (const sceneName of ['above-ridge', 'above-valley']) {
  const scene = SCENES[sceneName];
  const { graze } = scene;
  const deep = scene.probes.find((p) => p.id === graze.buriedProbe);
  const clear = scene.probes.find((p) => p.id === graze.clearProbe);

  test.describe(`${sceneName}: explicit MSL Z`, () => {
    for (const mode of MODES) {
      test(`${mode}: the DEM decodes to the fixture surface`, async ({ page }) => {
        await render(page, { scene: sceneName, mode });
        for (const probe of scene.probes) {
          const [lng, lat] = offsetToLngLat(...probe.atKm);
          const got = await page.evaluate(
            ([lo, la]) => window.spike.terrainAt(lo, la),
            [lng, lat],
          );
          // MapLibre's own reading of the terrain it is rendering, against the
          // function the tiles were generated from. If these disagree the
          // terrarium encoding or the tile sampling convention is wrong and
          // every pixel below is measuring the wrong mountain.
          expect(got, `terrain under ${probe.id}`)
            .toBeCloseTo(SURFACES[scene.surface](...probe.atKm), 1);
        }
      });

      test(`${mode}: the path is drawn at its altitude, not at sea level`, async ({ page }) => {
        const shot = await render(page, { scene: sceneName, mode });
        const cols = {
          deep: await probeColumn(page, scene, deep),
          clear: await probeColumn(page, scene, clear),
        };

        const atDeep = pathRow(shot, cols.deep);
        const atClear = pathRow(shot, cols.clear);
        expect(atDeep, `path missing over ${deep.id}`).not.toBeNull();
        expect(atClear, `path missing over ${clear.id}`).not.toBeNull();

        // One constant MSL altitude, one constant range from the camera: the
        // painted row must not care what the ground under it is doing. A path
        // draped onto the terrain would step between these two columns by the
        // difference in ground height (90 m in the valley, 140 m on the ridge).
        expect(Math.abs(atDeep - atClear), 'path row differs between probes')
          .toBeLessThanOrEqual(3);

        // The documented deck.gl failure mode, rendered rather than argued
        // about: the same geometry with Z dropped to zero. If the layer ignored
        // the third ordinate, this frame and the one above would be identical.
        const seaShot = await render(page, { scene: sceneName, mode, alt: 0 });

        if (mode === 'interleaved') {
          // Sea level is 168 m under the lowest ground in either fixture, so
          // with real depth testing the whole route is inside the planet. Not a
          // pixel of it survives anywhere in the frame — which is as complete a
          // refutation of "the path is drawn at sea level" as a screenshot can
          // give, since the visible frame above is full of it.
          expect(anyPathPixels(seaShot), 'a sea-level path is still visible').toBe(false);
        } else {
          // Overlaid mode has no depth relationship with the terrain, so the
          // sea-level path is painted over the ground rather than buried. It
          // still has to land somewhere else on screen.
          const atSea = pathRow(seaShot, cols.clear);
          expect(atSea, 'sea-level control did not render').not.toBeNull();
          expect(atSea - atClear, 'sea-level path is not clearly lower on screen')
            .toBeGreaterThan(60);
        }
      });

      // Depth against the terrain is the whole subject here, and overlaid mode
      // has none — it would fail every assertion below for the reason the
      // occlusion suite already records, not for a new one.
      const graze3 = mode === 'interleaved' ? test : test.skip;
      graze3(`${mode}: the path sits at the right absolute height`, async ({ page }) => {
        // The strongest claim the spike can make, and the only one that pins
        // deck.gl's absolute MSL scale to MapLibre's terrain rather than to
        // deck.gl's own projection maths: fly the same path just under a known
        // ground height and MapLibre's depth buffer must swallow it, just over
        // and it must let it through — and exactly at it, cut it in half.
        const { surfaceM, marginM } = graze;

        const below = await render(page, { scene: sceneName, mode, alt: surfaceM - marginM });
        const colDeep = await probeColumn(page, scene, deep);
        const colClear = await probeColumn(page, scene, clear);

        expect(
          pathRows(below, colDeep),
          `path ${marginM} m below the ${surfaceM} m surface is still visible`,
        ).toEqual([]);
        // …and in the very same frame, where the ground is lower, it is not
        // hidden. Without this control "vanished" would be indistinguishable
        // from "never drew".
        expect(
          pathRow(below, colClear),
          'nothing rendered at all in the buried frame',
        ).not.toBeNull();

        const above = await render(page, { scene: sceneName, mode, alt: surfaceM + marginM });
        expect(
          pathRows(above, colDeep).length,
          `path ${marginM} m above the ${surfaceM} m surface is clipped`,
        ).toBeGreaterThanOrEqual(pathRows(above, colClear).length - 2);

        // Flown at exactly the ground height, the ribbon should be half in the
        // hillside and half out of it. This is the actual measurement: it says
        // deck.gl's idea of `surfaceM` metres MSL and MapLibre's idea of the
        // same are the same place, to within a few metres, in a scene where a
        // 30 m error would already be visible.
        const at = await render(page, { scene: sceneName, mode, alt: surfaceM });
        const cut = pathRows(at, colDeep).length;
        const whole = pathRows(at, colClear).length;
        expect(whole, 'the control column vanished too').toBeGreaterThan(10);
        expect(cut / whole, `ribbon at ${surfaceM} m is not half-buried`)
          .toBeGreaterThan(0.25);
        expect(cut / whole, `ribbon at ${surfaceM} m is not half-buried`)
          .toBeLessThan(0.75);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Proof 2 — occlusion. This is the proof ADR 0004 gates the milestone on.
// ---------------------------------------------------------------------------

test.describe('occlusion: a path behind a ridge', () => {
  const scene = SCENES.occlusion;
  const behind = scene.probes.find((p) => p.id === 'behind-wall');
  const ends = scene.probes.filter((p) => p.expect === 'visible');

  test('interleaved: the ridge hides the path behind it', async ({ page }) => {
    const shot = await render(page, { scene: 'occlusion', mode: 'interleaved' });

    // Both ends first. The wall is 1.2 km of a straight 5 km path, so the same
    // line at the same altitude and nearly the same range passes its ends in
    // clear air — that is what makes the middle's absence occlusion rather than
    // a layer that failed to draw.
    const endRows = [];
    for (const probe of ends) {
      const col = await probeColumn(page, scene, probe);
      const row = pathRow(shot, col);
      expect(row, `path missing past the wall at ${probe.id}`).not.toBeNull();
      endRows.push(row);
    }
    expect(Math.abs(endRows[0] - endRows[1]), 'the two ends disagree').toBeLessThanOrEqual(3);

    const colBehind = await probeColumn(page, scene, behind);
    expect(pathRows(shot, colBehind), 'the path shows through the ridge').toEqual([]);

    // And it is the terrain doing the hiding: the pixel where the path would
    // have been is ridge, not sky. A camera that had simply lost the geometry
    // would leave background there.
    const y = Math.round((endRows[0] + endRows[1]) / 2);
    const [r, g, b] = pixelAt(shot, colBehind, y);
    expect(isSkyPixel(r, g, b), `expected terrain at (${colBehind}, ${y}), got rgb(${r},${g},${b})`)
      .toBe(false);
  });

  test('overlaid: the ridge does NOT hide the path (documented limitation)', async ({ page }) => {
    // Not a bug in this spec. MapboxOverlay's default mode draws deck into a
    // separate canvas composited over the map, so it has no access to the
    // terrain's depth buffer and paints the path straight through 140 m of
    // rock. Recorded as an assertion so that a future deck.gl release changing
    // this fails loudly instead of quietly widening our options.
    const shot = await render(page, { scene: 'occlusion', mode: 'overlaid' });
    const colBehind = await probeColumn(page, scene, behind);

    expect(pathRow(shot, colBehind), 'overlaid mode now occludes — re-check the ADR')
      .not.toBeNull();

    const y = Math.round(pathRow(shot, colBehind));
    const [r, g, b] = pixelAt(shot, colBehind, y);
    expect(isPathPixel(r, g, b)).toBe(true);
    // The ridge is genuinely there in this frame — the path is painted over it.
    const [gr, gg, gb] = pixelAt(shot, colBehind, y + 60);
    expect(isSkyPixel(gr, gg, gb), 'no ridge in the overlaid frame either').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Proof 3 — picking
// ---------------------------------------------------------------------------

test.describe('picking', () => {
  const scene = SCENES.occlusion;
  const probe = scene.probes.find((p) => p.id === 'past-south-end');

  /** Click the path where it is actually painted, and report what resolved. */
  async function clickThePath(page, mode) {
    const shot = await render(page, { scene: 'occlusion', mode });
    const col = await probeColumn(page, scene, probe);
    const row = pathRow(shot, col);
    expect(row, 'nothing to click on').not.toBeNull();

    // The painted pixel, not the projected one. Those coincide only when deck's
    // view state is in step with the map's, which is exactly the thing that
    // silently goes wrong (see the ordering note in spike/occlusion/main.js).
    const y = Math.round(row);
    await page.evaluate(() => window.spike.resetEvents());
    await page.mouse.move(col, y);
    await page.mouse.click(col, y);
    return { at: [col, y], events: await page.evaluate(() => window.spike.events()) };
  }

  for (const mode of MODES) {
    test(`${mode}: a real click on the visible path identifies it`, async ({ page }) => {
      const { at, events } = await clickThePath(page, mode);

      // The route that works in both modes: the app subscribes to MapLibre's
      // pointer events and calls overlay.pickObject itself.
      expect(events.mapClick, `click at (${at}) picked nothing`).not.toBeNull();
      expect(events.mapClick.layerId).toBe('mission-path');
      expect(events.mapClick.index).toBe(0);
      expect(events.mapClick.objectId).toBe('leg-1');
      expect(events.mapClick.objectName).toBe('mission path');
      expect(events.mapHover?.layerId, 'hover did not resolve the path')
        .toBe('mission-path');
    });

    test(`${mode}: empty sky picks nothing`, async ({ page }) => {
      await render(page, { scene: 'occlusion', mode });
      // Top-left corner: sky in every occlusion frame. Without this, "picking
      // works" would be satisfied by a layer that claims every pixel.
      await page.evaluate(() => window.spike.resetEvents());
      await page.mouse.click(5, 5);
      const events = await page.evaluate(() => window.spike.events());
      expect(events.mapClick, 'picked the path out of empty sky').toBeNull();
      expect(events.deckClick, 'deck picked the path out of empty sky').toBeNull();
    });
  }

  test('overlaid: deck\'s own onClick fires', async ({ page }) => {
    const { events } = await clickThePath(page, 'overlaid');
    expect(events.deckClick?.layerId, 'MapboxOverlay stopped forwarding pointer events')
      .toBe('mission-path');
  });

  test('interleaved: deck\'s own onClick does NOT fire (documented limitation)', async ({ page }) => {
    // MapboxOverlay subscribes to MapLibre's pointer events in _onAddOverlaid
    // only; the interleaved path returns an empty div and wires nothing. So the
    // `onClick`/`onHover` props are dead in the mode that gets occlusion right,
    // and an app that wants both must bridge the events itself. Asserted rather
    // than described so a future deck.gl release cannot quietly fix it without
    // us noticing.
    const { events } = await clickThePath(page, 'interleaved');
    expect(events.deckClick, 'interleaved mode now forwards clicks — simplify the adapter')
      .toBeNull();
    expect(events.mapClick?.layerId, 'the bridge is the only route that works here')
      .toBe('mission-path');
  });

  test('the picked coordinate is a ground-plane unprojection, not the path vertex', async ({ page }) => {
    // Worth pinning down before production leans on it: deck reports
    // `info.coordinate` by unprojecting the picked PIXEL onto z = 0, so for a
    // path flying 20 m up it names a spot well past the aircraft, not the
    // waypoint that was clicked. Route positions have to come from
    // `info.object` / `info.index`, which are exact.
    const { events } = await clickThePath(page, 'overlaid');
    const [, wantLat] = offsetToLngLat(...probe.atKm);
    const [, gotLat] = events.mapClick.coordinate;
    expect(Math.abs(gotLat - wantLat), 'coordinate now matches the path vertex')
      .toBeGreaterThan(0.001);
  });
});
