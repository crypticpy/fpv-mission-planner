// Explicit-elevation routes over synthetic terrain (M4 exit gate, item 2).
//
// The claim under test is one sentence: a leg authored at a height in metres MSL
// is drawn at that height, and the terrain in front of it hides it or does not,
// according to the terrain — not according to a fallback, a drape, or a zero.
//
// The proof is a 2×3 matrix rather than a measurement. One route, one shape, one
// camera; two surfaces and three altitudes:
//
//                        ridge (342–400 m under the route)   valley (200–258 m)
//     500 m MSL                    visible                        visible
//     300 m MSL                    HIDDEN                         visible
//     100 m MSL                    hidden                         hidden
//
// The middle row is the whole gate. The document, the camera and the drawn
// geometry are byte-identical between those two cells; the only difference is
// which DEM the tile server answered with. A route drawn at sea level, drawn
// draped on the ground, or drawn without a depth test against the terrain fails
// at least one cell of this matrix, and a route drawn at 300 m MSL and depth-
// tested against the fixture's own surface passes all six.
//
// Every margin is ≥42 m of real elevation, which at this camera is ~25 px of
// depth separation. ADR 0004's warning about billboarded ribbons is why: a
// tolerance in metres is the wrong unit for a ribbon whose width is in pixels,
// so the fixture is built so nothing has to graze.
//
// The surfaces are `tests/fixtures/synthetic-dem.mjs`'s — the same ridge and
// valley M3's terrain tests classify — served to MapLibre as real terrarium
// tiles by tests/browser/harness.js. Nothing here reaches the network.

import { expect, test } from '@playwright/test';

import { FIXTURE_ORIGIN, pointAt, ridgeDem, valleyDem } from '../fixtures/synthetic-dem.mjs';
import {
  activate3d, attachJson, columnExtent, cssColors, importMissionFile, missionDoc,
  seedTheme, settledScan, stubExternals, stubImagery, stubTerrain,
} from './harness.js';

/* ---------- the two surfaces, and the three heights across them ---------- */

/** Half the route's square footprint, in metres. Everything below is in this box. */
const HALF_M = 700;

/**
 * Broad enough that the whole route sits on one side of the 300 m line.
 *
 * `axisDeg: 0` runs the crest and the trough north–south, so elevation is a
 * function of easting alone and the route's four sides each cross the feature
 * the same way. Over |east| ≤ 700 m the ridge never drops below 342 m and the
 * valley never rises above 258 m.
 */
const SHAPE = { widthM: 1200, axisDeg: 0 };
const RIDGE = ridgeDem({ base: 200, heightM: 200, ...SHAPE });
const VALLEY = valleyDem({ base: 400, depthM: 200, ...SHAPE });

const ABOVE_M = 500;
const BETWEEN_M = 300;
const BELOW_M = 100;

/** Metres east and north of the fixture origin, as a point on the globe. */
function at(east, north) {
  return pointAt(pointAt(FIXTURE_ORIGIN, 0, north), 90, east);
}

/**
 * A rectangle flown level, with both ends of the flight pinned to the pad.
 *
 * The two 4-metre stubs are the fixture's one piece of cunning. The launch
 * vertex is the one vertex the scene draws on the *ground* by definition
 * (scene-geometry.js: the pad sits on the terrain), so any leg touching it is a
 * ramp between ground and cruise, and a ramp grazes the surface somewhere. Both
 * stubs are shorter than a pixel at this camera, which leaves every leg that
 * covers any real screen area exactly level at the authored altitude.
 */
const LAUNCH = at(-HALF_M, -HALF_M);
const WAYPOINTS = [
  at(-HALF_M + 4, -HALF_M),
  at(HALF_M, -HALF_M),
  at(HALF_M, HALF_M),
  at(-HALF_M, HALF_M),
  at(-HALF_M, -HALF_M + 4),
];

/* ---------- reading the canvas ---------- */

/**
 * Import the route at `altitudeMslM`, re-frame on it, and count the route-
 * coloured pixels on the canvas.
 *
 * Re-importing rather than reloading is what keeps the six cells comparable:
 * the WebGL context, the terrain source and the tile cache are the same ones
 * throughout, so the only variable between two rows is the number in the
 * document. Field view is pressed each time because opening a mission moves the
 * launch, which asks the map to re-frame on the footprint.
 */
async function renderAt(page, canvas, colors, altitudeMslM, title) {
  await importMissionFile(page, missionDoc({
    launch: LAUNCH, waypoints: WAYPOINTS, altitudeMslM, title,
  }));
  await page.locator('#btn-scene3d-field').click();
  return settledScan(page, canvas, colors);
}

/* ---------- the matrix ---------- */

test.describe('explicit-elevation routes over terrain', () => {
  // A viewport wide enough to keep the rail and the map side by side, and a fixed
  // one so the framing that Field view computes is the same on every machine.
  test.use({ viewport: { width: 1280, height: 900 } });

  for (const [name, dem, expected] of /** @type {const} */ ([
    // `between` is the cell that carries the gate: the same document, drawn the
    // same way, hidden by one surface and clear of the other.
    ['ridge', RIDGE, 'hidden'],
    ['valley', VALLEY, 'visible'],
  ])) {
    test(`a 300 m MSL route is ${expected} over the ${name}`, async ({ context, page }) => {
      // Three 3D renders behind one WebGL init, on a software GPU.
      test.setTimeout(240_000);

      await stubExternals(context);
      await stubImagery(context);
      await stubTerrain(context, dem);
      await seedTheme(page);
      // Field view animates unless the pilot asked for less motion; a jump is
      // what makes "the frame after the click" a settled frame.
      await page.emulateMedia({ reducedMotion: 'reduce' });

      const errors = [];
      page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
      page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

      await page.goto('/');
      await page.locator('#tab-2d').click();
      await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();

      await importMissionFile(page, missionDoc({
        launch: LAUNCH, waypoints: WAYPOINTS, altitudeMslM: ABOVE_M, title: `${name} above`,
      }));
      await activate3d(page);
      const canvas = page.locator('#map-3d canvas.maplibregl-canvas');
      await page.locator('#btn-scene3d-field').click();

      /* The route's own colour, off the live document — the scene reads the same
       * two properties (scene-layers.js), picking the critical one when the
       * budget cannot cover the route. Which of the two it is does not matter
       * here, and pinning it would make this spec fail the day the fixture grows
       * a kilometre. */
      const colors = await cssColors(page, ['--series-2', '--status-critical']);

      // ---- 500 m MSL: clear of everything, in both fixtures ----
      const above = await settledScan(page, canvas, colors);
      const baseline = above.scan.total;
      expect(baseline, 'the route was not drawn at all at 500 m MSL').toBeGreaterThan(2_000);

      /* And drawn across the picture rather than balled up in a corner: Field
       * view frames the mission, so a route that occupies a tenth of the canvas
       * would mean the camera, not the geometry, is what the rows below measure. */
      const extent = columnExtent(above.scan.columns);
      expect(extent.last - extent.first,
        'the framed route spans almost none of the canvas — check Field view')
        .toBeGreaterThan(above.image.width * 0.4);

      // ---- 100 m MSL: under both surfaces, so the terrain owns every pixel ----
      const below = await renderAt(page, canvas, colors, BELOW_M, `${name} below`);
      expect(below.scan.total,
        'a route at 100 m MSL — below every point of this surface — is still on screen. '
        + 'Either the terrain is not in the depth buffer, or the route is not at its authored height.')
        .toBeLessThan(baseline * 0.02);

      // ---- 300 m MSL: the cell that differs between the two fixtures ----
      const between = await renderAt(page, canvas, colors, BETWEEN_M, `${name} between`);
      if (expected === 'hidden') {
        expect(between.scan.total,
          'the ridge stands 42 m above this route everywhere and does not hide it')
          .toBeLessThan(baseline * 0.10);
      } else {
        expect(between.scan.total,
          'the valley floor is 42 m below this route everywhere and it is not drawn clear of it')
          .toBeGreaterThan(baseline * 0.80);

        /* Not merely present — present across the same span it occupied at 500 m.
         * A route clipped to a sliver would pass a count threshold on a wide
         * enough margin; it cannot pass this. */
        const clear = columnExtent(between.scan.columns);
        expect(clear.last - clear.first).toBeGreaterThan((extent.last - extent.first) * 0.8);
      }

      /* The numbers the six cells actually produced, and the picture the
       * decisive one produced, kept with the run. When a graphics stack changes
       * under this spec, the counts say by how much before anyone re-derives
       * the fixture. */
      await attachJson(test.info(), `${name}-visible-pixels.json`, {
        fixture: name,
        canvasWidth: above.image.width,
        routeColumns: extent,
        visiblePixels: {
          [`${ABOVE_M}m`]: baseline,
          [`${BETWEEN_M}m`]: between.scan.total,
          [`${BELOW_M}m`]: below.scan.total,
        },
      });
      await test.info().attach(`${name}-at-${BETWEEN_M}m.png`, {
        contentType: 'image/png',
        body: await canvas.screenshot(),
      });

      expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
    });
  }
});
