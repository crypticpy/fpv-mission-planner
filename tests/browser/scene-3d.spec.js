// The 3D scene, end to end and deliberately shallow (ADR 0004, wave B).
//
// The spike already answered the hard graphics questions — does explicit MSL Z
// render above terrain, does terrain occlude, does picking work — with pixel
// probes against a synthetic DEM, and it answered them once. That spec runs on
// demand from playwright.spike.config.js and costs a minute of WebGL. This one
// runs on every `npm run check`, so it asks only what a build can break:
//
//   * is the 3D mode tab offered at all?
//   * does selecting it fetch a lazy chunk and start the ortho planner — the
//     host the tab answers with by default since M12?
//   * does the viewbar's host toggle fetch the *other* chunk and get MapLibre
//     all the way through the terrain-then-overlay handshake that the ADR says
//     fails silently when it is done in the wrong order?
//   * are the two controls that only exist in satellite 3D really there?
//   * does going back leave the 2D map intact rather than a dead container?
//   * and is the console clean through all of it?
//
// The ortho host's own controls — projection, azimuth, exaggeration, contours,
// and the system-state cards behind them — have their own gate in
// ortho-viewbar.spec.js; this spec only proves both engines come up.
//
// Nothing here probes a pixel. If this passes and the picture is wrong, the
// spike spec is the instrument for finding out why.
//
// The terrain and imagery are stubbed, never fetched. A gate that reached AWS
// and Esri on every run would fail for reasons that have nothing to do with the
// build, and would breach the tile providers' usage policies besides.

import { expect, test } from '@playwright/test';

import { encodeRGB } from '../../spike/occlusion/png.mjs';

/**
 * A 256×256 terrarium tile of flat ground at 150 m.
 *
 * Terrarium packs elevation as `R*256 + G + B/256 - 32768`, so 150 m is
 * `R=128, G=150, B=0` — and a *valid decodable PNG* is the point. MapLibre
 * reports a tile it cannot decode as a source error and then quietly leaves a
 * hole in the mesh, so a 1×1 blank stand-in like the smoke suite's would make
 * every assertion below a test of the error path. Generated with the spike's own
 * encoder rather than a pasted base64 blob, because the next person to change
 * the encoding should not have to hand-decode a literal to find out what it
 * says.
 */
const TERRAIN_TILE = encodeRGB(256, 256, (() => {
  const rgb = new Uint8Array(256 * 256 * 3);
  for (let i = 0; i < 256 * 256; i++) {
    rgb[i * 3] = 128;
    rgb[i * 3 + 1] = 150;
    rgb[i * 3 + 2] = 0;
  }
  return rgb;
})());

/** Imagery: 256×256 of flat grey. Nothing here reads it; it only has to decode. */
const IMAGERY_TILE = encodeRGB(256, 256, new Uint8Array(256 * 256 * 3).fill(96));

/**
 * Every origin the map can reach, answered locally.
 *
 * Fulfilled rather than aborted, exactly as in the smoke suite: an aborted
 * request is itself a console error, which would defeat the console assertion.
 */
async function stubTiles(context) {
  // A returning pilot: latch M13's first-run tour off, or its overlay would
  // intercept every click this suite makes (see onboarding.spec.js).
  await context.addInitScript(() => localStorage.setItem('fpv:v1:onboarded', 'true'));
  await context.route(/elevation-tiles-prod/, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(TERRAIN_TILE) }));
  await context.route(/(^|\/\/|\.)((server\.)?arcgisonline\.com|tile\.openstreetmap\.org)/, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(IMAGERY_TILE) }));
  await context.route(/open-meteo\.com/, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/elevation')) {
      const points = (url.searchParams.get('latitude') || '').split(',').length;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ elevation: Array.from({ length: points }, () => 150) }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

/** Console errors and uncaught page errors, for later assertion. */
function watchConsole(page) {
  /** @type {string[]} */
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

test.describe('the 3D scene', () => {
  test('the 3D tab starts the ortho planner, the host toggle reaches MapLibre, and coming back leaves 2D intact', async ({ context, page }) => {
    await stubTiles(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await expect(page.locator('#view-map')).toBeVisible();

    // ---- the mode tab is offered ----
    const tab3d = page.locator('#tab-3d');
    await expect(tab3d).toBeEnabled();
    await expect(tab3d).toHaveAttribute('aria-selected', 'false');
    // 2D first, always: nothing of either lazy engine has been fetched yet.
    await expect(page.locator('#map-3d')).toBeHidden();

    // ---- selecting it gets all the way through the ortho init handshake ----
    await tab3d.click();

    /* The tab disables the moment the click lands and re-enables only after
     * `scene.ready` resolves — for the ortho host that is deck's own `onLoad`
     * plus the first terrain fetch decoding. Enabled-while-still-selected
     * therefore proves the chunk was fetched and the planner came up; since
     * M12 the failure path stays on the tab and renders a system-state card
     * instead, which the canvas assertion below would catch. The timeout is
     * generous because this is a cold chunk plus a software GPU. */
    await expect(tab3d).toBeEnabled({ timeout: 30_000 });
    await expect(tab3d).toHaveAttribute('aria-selected', 'true');

    // deck.gl's canvas, which carries no engine class — MapLibre's is the one
    // that tags its own, and it must not be the engine answering the tab.
    const orthoCanvas = page.locator('#map-3d canvas:not(.maplibregl-canvas)');
    await expect(orthoCanvas.first()).toBeVisible();
    const orthoBox = await orthoCanvas.first().boundingBox();
    expect(orthoBox?.height ?? 0, 'the ortho canvas has no height — its CSS did not apply')
      .toBeGreaterThan(100);

    // Both engines are never on screen at once.
    await expect(page.locator('#map-canvas')).toBeHidden();

    // The viewbar is the ortho host's chrome: up, wearing the host it serves,
    // with the toggle offering the other engine by name.
    const viewbar = page.locator('#scene-viewbar');
    await expect(viewbar).toBeVisible();
    await expect(viewbar).toHaveAttribute('data-host', 'ortho');
    await expect(page.locator('#vb-host')).toHaveText('Satellite');
    await expect(page.locator('#vb-proj-ortho')).toHaveAttribute('aria-pressed', 'true');

    // …and the control that means nothing in any 3D: both engines draw their
    // own ground, so the base-layer toggle is disabled rather than ignored.
    await expect(page.locator('#btn-baselayer')).toBeDisabled();
    await expect(page.locator('#btn-baselayer')).toHaveAttribute('title', 'Base layer — 2D only');

    // ---- the host toggle fetches the other chunk and starts MapLibre ----
    /* This is the handshake ADR 0004 calls load-bearing: `scene.ready` resolves
     * inside `map.once('idle')` *following* setTerrain, so a satellite view on
     * screen proves the style and DEM loaded and the deck overlay went on
     * against a settled view state. */
    await page.locator('#vb-host').click();
    await expect(viewbar).toHaveAttribute('data-host', 'maplibre', { timeout: 30_000 });
    const canvas = page.locator('#map-3d canvas.maplibregl-canvas');
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    const box = await canvas.boundingBox();
    expect(box?.height ?? 0, 'the 3D canvas has no height — its CSS did not apply')
      .toBeGreaterThan(100);

    // The ortho-only groups stand down with their host; the toggle stays, and
    // is now the way back.
    await expect(page.locator('#vb-proj-ortho')).toBeHidden();
    await expect(page.locator('#vb-host')).toHaveText('Terrain');

    // The DEM's credit is a licence obligation, not decoration, and MapLibre's
    // own control is where the 2D map's tile credits live too.
    await expect(page.locator('#map-3d .maplibregl-ctrl-attrib')).toContainText('Mapzen');

    // ---- the two controls that only mean anything in satellite 3D ----
    const slider = page.locator('#scene3d-exaggeration');
    await expect(slider).toBeVisible();
    await expect(slider).toHaveValue('1');
    await expect(page.locator('#btn-scene3d-field')).toBeVisible();

    // Moving it re-terrains and redraws; the assertion that matters is that
    // neither throws, which the console check at the end covers.
    await slider.fill('2');
    await expect(page.locator('#scene3d-exaggeration-out')).toHaveText('2.0×');

    await page.locator('#btn-scene3d-field').click();

    // ---- and back, to a live 2D map rather than a dead container ----
    await page.locator('#tab-2d').click();
    await expect(tab3d).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('#map-3d')).toBeHidden();
    // The viewbar is 3D chrome and leaves with it.
    await expect(viewbar).toBeHidden();

    const leaflet = page.locator('#map-canvas.leaflet-container');
    await expect(leaflet).toBeVisible();
    await expect(page.locator('#map-canvas .leaflet-tile').first()).toBeAttached();
    // The footprint ring is Leaflet still drawing the same solve it drew before.
    await expect(page.locator('#map-canvas .leaflet-overlay-pane path').first()).toBeAttached();
    const leafletBox = await leaflet.boundingBox();
    expect(leafletBox?.height ?? 0, 'Leaflet came back to a collapsed container')
      .toBeGreaterThan(100);
    // The base-layer toggle wakes back up with the 2D engine it belongs to.
    await expect(page.locator('#btn-baselayer')).toBeEnabled();

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
