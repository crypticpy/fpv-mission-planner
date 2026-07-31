// Route editing parity between the two engines (M4 exit gate, item 1).
//
// The mission document is the only authority (ADR 0002) and both engines reach
// it through the same five actions on the frame — `addWaypoint`, `removeWaypoint`,
// `moveWaypoint`, `moveLaunch`, `selectSegment`. That is a claim about wiring,
// and wiring is exactly what a unit test cannot check: the 2D pins are Leaflet
// DOM markers with click handlers, and the 3D pins are deck.gl geometry reached
// through an explicit `map.on('click')` → `overlay.pickObject()` bridge that
// interleaved mode obliges scene.js to build by hand (ADR 0004). Two entirely
// different pointer paths, one document.
//
// So the shape of this spec is: do a thing in 2D, write down what it did to the
// document, reset, do the same thing in 3D, insist on the same answer. What is
// written down is never a coordinate — the two engines project differently and a
// pixel comparison between them would be a test of MapLibre's camera. It is the
// route card, which is rail DOM, built from the analysis, and identical whichever
// engine is drawing: `n` waypoints make `n + 2` rows, always.
//
// The one assertion that is a literal rather than a comparison is the segment id.
// The fixture fixes its own node ids, so both engines have to answer
// `seg_parity_1` when the leg between waypoints 1 and 2 is clicked — which closes
// the gap segment-inspector.spec.js left open in as many words: the 3D pick →
// `selectSegment` path had never been exercised in a browser.
//
// Targeting in 3D is the awkward part and is done by reading the picture back:
// the pins are 10 px discs in the route colour and the legs are 4 px lines in it,
// so the densest small window of route-coloured pixels is a pin and the densest
// column is the one long vertical leg. Nothing here reproduces MapLibre's
// projection; it finds the drawn thing and clicks it, which is what a pilot does.
//
// Nothing here reaches the network. Terrain is flat, so no leg is ever occluded —
// occlusion is terrain-fixtures.spec.js's question, not this one.

import { expect, test } from '@playwright/test';

import { FIXTURE_ORIGIN, flatDem, pointAt } from '../fixtures/synthetic-dem.mjs';
import {
  activate3d, cssColors, emptyPoint2d, importMissionFile, MAP_KEY, matchesAny,
  missionDoc, pixelAt, seedTheme, settledScan, stubExternals, stubImagery, stubTerrain,
} from './harness.js';

/* ---------- the fixture ---------- */

/** Flat ground, so the only thing that can move a drawn leg is an edit. */
const GROUND_M = 100;

/** 100 m over it, level. Nothing here is about height; terrain-fixtures is. */
const CRUISE_MSL_M = GROUND_M + 100;

/**
 * How far the fixture reaches east and north of the pad, in metres.
 *
 * Kilometres, and deliberately: the 2D map frames itself on the *footprint* —
 * the range rings, tens of kilometres across — and never on the route, so a
 * mission a pilot would actually fly draws as a 20 px scribble in the middle of
 * the canvas, too small for Playwright to resolve a click target on. There is no
 * app control that fits the 2D map to the route, so the route is sized to the
 * frame instead. The cost is that this route is far beyond the aircraft's
 * budget, which colours it as the critical route rather than the ordinary one —
 * both are read off the live document below, so it makes no difference.
 */
const EAST_M = 5_000;
const NORTH_M = 4_000;

/** Metres east and north of the fixture origin, as a point on the globe. */
function at(east, north) {
  return pointAt(pointAt(FIXTURE_ORIGIN, 0, north), 90, east);
}

/**
 * A pad in the middle, a tall level leg out to the west, and a long hop east.
 *
 * The middle leg is what every 3D target is found from, and the shape exists to
 * serve it. It is level (both ends at cruise) and runs along a line of
 * longitude, so at bearing 0 and pitch 0 it draws as a true vertical — both ends
 * sit at the same distance from the screen centre, so perspective displaces them
 * identically. Nothing else in the picture crosses it: the ramp out to waypoint 1
 * and the hop from waypoint 2 both end *on* it, and the return runs from
 * waypoint 3 into the pad without ever reaching that longitude. So the longest
 * column of route colour is that leg, and the middle of it is 150 px from the
 * nearest pin at any framing this spec uses.
 *
 * The pad in the middle is the other half. The 2D map centres itself on the
 * launch, because the range rings it frames on are drawn around the launch — so
 * a route arranged around the pad is a route in the middle of the 2D canvas
 * rather than one hanging off a corner of it.
 */
const LAUNCH = at(0, 0);
const WAYPOINTS = [at(-EAST_M, -NORTH_M), at(-EAST_M, NORTH_M), at(EAST_M, 0)];

/**
 * Fixed node ids, so "the same segment" is a name and not a comparison — and so
 * the id survives the re-import between passes. `missionDoc` still mints a fresh
 * mission id every time, which is what keeps the repository from re-identifying
 * the import behind the spec's back.
 */
const TAG = 'parity';
/** The level middle leg: waypoint 1 to waypoint 2, second of four drawn legs. */
const MIDDLE_LEG_ID = `seg_${TAG}_1`;
const MIDDLE_LEG_TITLE = '1 → 2';
/** Which waypoint every edit below acts on, in both engines: the north one. */
const TARGET_INDEX = 1;

const seed = () => missionDoc({
  launch: LAUNCH,
  waypoints: WAYPOINTS,
  altitudeMslM: CRUISE_MSL_M,
  tag: TAG,
  title: 'Parity fixture',
});

/** Rows the route card shows for `n` waypoints: one per leg, plus the total. */
const rowsFor = (n) => n + 2;

/* ---------- finding things in the 3D picture ---------- */

/** Which pixels of `image` are one of `colors`, as a flat bitmap. */
function maskOf(image, colors, tolerance = 40) {
  const { width, height } = image;
  const bits = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelAt(image, x, y);
      if (matchesAny(colors, r, g, b, tolerance)) bits[y * width + x] = 1;
    }
  }
  return { bits, width, height };
}

/**
 * A summed-area table over a mask, as a function counting any rectangle in
 * constant time. Half a million candidate windows get scanned below and the
 * naive form is minutes rather than milliseconds.
 * @param {ReturnType<typeof maskOf>} mask
 */
function areaTable({ bits, width, height }) {
  const stride = width + 1;
  const sat = new Int32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += bits[y * width + x];
      sat[(y + 1) * stride + x + 1] = sat[y * stride + x + 1] + row;
    }
  }
  return (x0, y0, x1, y1) => sat[(y1 + 1) * stride + x1 + 1]
    - sat[y0 * stride + x1 + 1] - sat[(y1 + 1) * stride + x0] + sat[y0 * stride + x0];
}

/**
 * The `count` densest non-overlapping `size`×`size` windows.
 *
 * A pin is a filled 10 px disc and a leg is a 4 px line, so at size 15 a window
 * on a pin holds ~140 matching pixels and a window on a leg holds ~60. The
 * separation is what makes this a pin finder rather than a bright-spot finder,
 * and `minCount` is where it refuses to guess.
 *
 * @param {ReturnType<typeof maskOf>} mask
 * @param {{ size?: number, count: number, minCount: number }} opts
 */
function denseSpots(mask, { size = 15, count, minCount }) {
  const area = areaTable(mask);
  const half = Math.floor(size / 2);
  /** @type {{ x: number, y: number, count: number }[]} */
  const spots = [];
  for (let k = 0; k < count; k++) {
    let best = { x: -1, y: -1, count: 0 };
    for (let y = half; y < mask.height - half; y++) {
      for (let x = half; x < mask.width - half; x++) {
        // Suppress the neighbourhood of everything already found, or the same
        // pin comes back `count` times one pixel apart.
        if (spots.some((s) => Math.abs(s.x - x) < size * 2 && Math.abs(s.y - y) < size * 2)) continue;
        const n = area(x - half, y - half, x + half, y + half);
        if (n > best.count) best = { x, y, count: n };
      }
    }
    if (best.count < minCount) break;
    spots.push(best);
  }
  return spots;
}

/**
 * A point on the one long vertical run of colour: the densest column, and the
 * middle of its longest unbroken run.
 *
 * The middle is what keeps this off the pins at either end — the run is ~600 px
 * and the pick radius is 6 — without having to know where the pins are.
 * @param {ReturnType<typeof maskOf>} mask
 */
function verticalLegPoint(mask) {
  const { bits, width, height } = mask;
  let column = -1;
  let bestTotal = 0;
  for (let x = 0; x < width; x++) {
    let total = 0;
    for (let y = 0; y < height; y++) total += bits[y * width + x];
    if (total > bestTotal) { bestTotal = total; column = x; }
  }
  let run = 0;
  let best = { from: 0, to: -1 };
  for (let y = 0; y <= height; y++) {
    if (y < height && bits[y * width + column]) { run += 1; continue; }
    if (run > best.to - best.from) best = { from: y - run, to: y - 1 };
    run = 0;
  }
  return { x: column, y: Math.round((best.from + best.to) / 2), length: best.to - best.from + 1 };
}

/**
 * Somewhere on the terrain with nothing drawn near it and no control over it —
 * where a click means "add a waypoint here" and nothing else.
 *
 * Widest clear window first, because clearance is the whole point: the pick
 * radius is 6 px and a click 20 px from a leg would still be a click that
 * *nearly* selected something. The search is confined to the middle of the
 * canvas, since the four corners are where MapLibre keeps its controls and the
 * edges of a perspective view are where a future fixture would put its horizon.
 *
 * @param {ReturnType<typeof maskOf>} mask
 * @param {{ x: number, y: number, width: number, height: number }[]} controls
 */
function emptyPoint(mask, controls) {
  const area = areaTable(mask);
  const insetX = Math.round(mask.width * 0.12);
  const insetY = Math.round(mask.height * 0.12);
  const cx = mask.width / 2;
  const cy = mask.height / 2;

  for (const size of [121, 81, 61, 41]) {
    const half = Math.floor(size / 2);
    let best = null;
    for (let y = insetY; y < mask.height - insetY; y += 4) {
      for (let x = insetX; x < mask.width - insetX; x += 4) {
        if (area(x - half, y - half, x + half, y + half) !== 0) continue;
        if (controls.some((c) => x > c.x - half && x < c.x + c.width + half
          && y > c.y - half && y < c.y + c.height + half)) continue;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (!best || d < best.d) best = { x, y, d };
      }
    }
    if (best) return { x: best.x, y: best.y, clearance: half };
  }
  throw new Error('no clear ground anywhere on the 3D canvas');
}

/** The map controls floating over the 3D canvas, in canvas coordinates. */
async function controlBoxes(page, canvasBox) {
  /** @type {{ x: number, y: number, width: number, height: number }[]} */
  const boxes = [];
  for (const control of await page.locator('#map-3d .maplibregl-ctrl').all()) {
    const box = await control.boundingBox();
    if (box) boxes.push({ ...box, x: box.x - canvasBox.x, y: box.y - canvasBox.y });
  }
  return boxes;
}

/**
 * How far every drag below goes. Down and to the right of the north pin is open
 * canvas in both engines, and at either engine's scale it is far enough to move
 * a leg's distance, its course and the whole route's total — the route card is
 * rounded to a tenth, so a nudge would prove nothing.
 */
const DRAG_DX = 80;
const DRAG_DY = 60;

/** Press and drag, in viewport coordinates, slowly enough for a drag handler. */
async function dragBy(page, from, dx, dy) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 5 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 5 });
  await page.mouse.up();
}

/**
 * Click the middle of an SVG path, by the path's own geometry.
 *
 * `locator.click()` will not do it. An axis-aligned `<path>` with `fill="none"`
 * has a zero-area client rect, and a zero-area rect is Playwright's definition
 * of "not visible" — so a *level* route leg, which is what this fixture is built
 * around, is unclickable through the normal actionability path even though the
 * browser delivers the click perfectly well. It does so because style.css asks
 * it to: `.leaflet-pane > svg path.route-hit { pointer-events: stroke }`, which
 * hit-tests the 14 px stroke whether or not it is painted. So the element is
 * fine, the precheck is wrong about it, and `getPointAtLength` gives a point
 * that is on the line by construction rather than by luck.
 */
async function clickPath(page, locator) {
  const at = await locator.evaluate((el) => {
    const p = el.getPointAtLength(el.getTotalLength() / 2);
    const screen = new DOMPoint(p.x, p.y).matrixTransform(el.getScreenCTM());
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(at.x, at.y);
}

/** The middle of an element, in viewport coordinates. */
async function centreOf(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('nothing to grab: the element has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * The route card said something different afterwards.
 *
 * Polled rather than asserted once, because a drag lands a command that runs an
 * analysis before anything redraws — and compared as raw text rather than with
 * `toHaveText`, which normalises whitespace and would call two different tables
 * equal often enough to matter.
 */
async function expectRouteChanged(page, before, hint) {
  await expect.poll(() => page.locator('#route-rows').innerText(), { message: hint, timeout: 10_000 })
    .not.toBe(before);
}

/**
 * Where the app last stored the launch point.
 *
 * `persist()` writes it on every launch move regardless of engine (map-view.js),
 * which makes it the one place a pad drag can be read back without asking either
 * renderer where it drew the pin.
 * @returns {Promise<{lat: number, lng: number}>}
 */
async function storedLaunch(page) {
  const raw = await page.evaluate((key) => window.localStorage.getItem(key), MAP_KEY);
  const state = JSON.parse(/** @type {string} */ (raw));
  return { lat: state.lat, lng: state.lng };
}

/* ---------- the run ---------- */

test.describe('route editing parity', () => {
  // Fixed, because Field view's framing is what every 3D target is found in.
  test.use({ viewport: { width: 1280, height: 900 } });

  test('every edit does the same thing in 3D that it does in 2D', async ({ context, page }) => {
    // Ten edits, half of them behind a terrain handshake, on a software GPU.
    test.setTimeout(300_000);

    await stubExternals(context, { elevationM: GROUND_M });
    await stubImagery(context);
    await stubTerrain(context, flatDem({ elevM: GROUND_M }));
    await seedTheme(page);
    // Field view animates unless the pilot asked for less motion; a jump is what
    // makes "the frame after the click" a frame worth reading.
    await page.emulateMedia({ reducedMotion: 'reduce' });

    /** @type {string[]} */
    const errors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    await page.goto('/');
    await page.locator('#tab-map').click();
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();

    const rows = page.locator('#route-rows tr');
    const card = page.locator('#segment-card');
    const routeTable = page.locator('#route-rows');

    /* ================= 2D ================= */

    const canvas2d = page.locator('#map-canvas');
    const markers = page.locator('#map-canvas .route-marker');
    /**
     * Back to the fixture, through the app's own import path — and back on
     * screen afterwards.
     *
     * The scroll is not incidental. The file picker lives in the mission fold,
     * below the map, so opening a mission scrolls the map clean out of the
     * viewport; every mouse gesture below is in viewport coordinates and would
     * otherwise be aimed at the page above the fold.
     */
    const reset2d = async () => {
      await importMissionFile(page, seed());
      await canvas2d.scrollIntoViewIfNeeded();
      await expect(markers).toHaveCount(WAYPOINTS.length);
    };

    await reset2d();

    // ---- select the middle leg ----
    /* One hit line per authored segment. The hop home under a direct return is a
     * line nobody drew and gets none, which is why this is 3 and not 4 — and why
     * clicking it in either engine adds a waypoint rather than opening anything. */
    const hits = page.locator('#map-canvas path.route-hit');
    await expect(hits).toHaveCount(WAYPOINTS.length);
    await clickPath(page, hits.nth(TARGET_INDEX));
    await expect(card).toBeVisible();
    await expect(page.locator('#segment-title')).toHaveText(MIDDLE_LEG_TITLE);
    await expect(page.locator('#segment-id')).toHaveText(MIDDLE_LEG_ID);
    // The click must not also have reached the map: in route mode that would
    // have dropped a waypoint on the leg just selected.
    await expect(rows).toHaveCount(rowsFor(WAYPOINTS.length));
    // …and clicking it again closes it, rather than stacking.
    await clickPath(page, hits.nth(TARGET_INDEX));
    await expect(card).toBeHidden();

    // ---- add a waypoint on empty ground ----
    await canvas2d.click({ position: await emptyPoint2d(page) });
    await expect(rows).toHaveCount(rowsFor(WAYPOINTS.length + 1));

    // ---- remove one by clicking its pin ----
    await reset2d();
    await markers.nth(TARGET_INDEX).click();
    await expect(rows).toHaveCount(rowsFor(WAYPOINTS.length - 1));

    // ---- move one by dragging its pin ----
    await reset2d();
    const beforeMove2d = await routeTable.innerText();
    await dragBy(page, await centreOf(markers.nth(TARGET_INDEX)), DRAG_DX, DRAG_DY);
    await expect(rows).toHaveCount(rowsFor(WAYPOINTS.length));
    await expectRouteChanged(page, beforeMove2d, 'dragging a pin in 2D moved nothing');

    // ---- move the launch, which the route survives ----
    await reset2d();
    const launchBefore2d = await storedLaunch(page);
    await dragBy(page, await centreOf(page.locator('#map-canvas .launch-marker')), DRAG_DX, DRAG_DY);
    await expect(rows).toHaveCount(rowsFor(WAYPOINTS.length));
    expect(await storedLaunch(page), 'dragging the pad in 2D moved nothing')
      .not.toEqual(launchBefore2d);

    /* ================= 3D ================= */

    await activate3d(page);
    const canvas3d = page.locator('#map-3d canvas.maplibregl-canvas');

    /* The route's own colours, off the live document — the scene reads the same
     * custom properties (scene-layers.js `readPalette`). The critical one is
     * what a route the budget cannot cover is drawn in, and the warning one is
     * the single pin the reserve runs out on; which of the three the fixture
     * ends up in is not this spec's business. */
    const routeColors = await cssColors(page, ['--series-2', '--status-critical', '--status-warning']);
    /* The pad, separately, and at a tighter tolerance: `--ring-planned` is only
     * 24 apart from `--series-1` per channel, and a footprint ring is not a
     * landing pad. */
    const padColors = await cssColors(page, ['--series-1']);
    const PAD_TOLERANCE = 16;

    /**
     * Back to the fixture, framed the same way every time.
     *
     * Field view is pressed after every import because opening a mission moves
     * the launch, and moving the launch asks the map to re-frame on the
     * footprint rings — kilometres wide, with the route a dot in the middle.
     *
     * The zoom-out is the second half of that framing and matters as much. Field
     * view fits the mission to the frame, which by definition leaves its far
     * corners against the edges of the canvas — where MapLibre's navigation
     * control, the scene controls and the attribution are. One step out halves
     * the picture and puts every pin in open canvas, at no cost to this spec:
     * nothing here measures a distance on screen, only what a click did.
     */
    /** Where the canvas is now: importing scrolls it away, as it does in 2D. */
    let box3d = /** @type {*} */ (await canvas3d.boundingBox());
    /** Canvas coordinates to viewport coordinates. */
    const on3d = (/** @type {{x: number, y: number}} */ p) =>
      ({ x: box3d.x + p.x, y: box3d.y + p.y });

    const reset3d = async () => {
      await importMissionFile(page, seed());
      await page.locator('#btn-scene3d-field').click();
      await page.locator('#map-3d .maplibregl-ctrl-zoom-out').click();
      const { image } = await settledScan(page, canvas3d, routeColors);
      /* Last, because every locator action above scrolls its own target into
       * view: where the canvas ended up is only knowable once nothing more is
       * going to move it. */
      await canvas3d.scrollIntoViewIfNeeded();
      box3d = /** @type {*} */ (await canvas3d.boundingBox());
      return image;
    };

    let image = await reset3d();
    /* In canvas coordinates, so this survives every scroll the imports cause —
     * only a resized canvas would move them, and the viewport is pinned. */
    const controls3d = await controlBoxes(page, box3d);
    /** Where the route is drawn, and where nothing may be clicked by accident. */
    const routeMask = (i) => maskOf(i, routeColors);
    const blockedMask = (i) => maskOf(i, [...routeColors, ...padColors]);

    /**
     * The north pin: waypoint 2, topmost of the three by a third of the canvas.
     *
     * The pad is not in this mask, so the three densest spots are the three pins
     * and nothing else. The gap to the next one down is asserted rather than
     * assumed, because three "pins" a few pixels apart would mean the finder had
     * locked onto one bright thing three times.
     * @param {ReturnType<typeof maskOf>} m
     */
    const northPin = (m) => {
      const found = denseSpots(m, { count: WAYPOINTS.length, minCount: 90 })
        .sort((a, b) => a.y - b.y);
      expect(found.length, 'not every waypoint pin was found on the 3D canvas')
        .toBe(WAYPOINTS.length);
      expect(found[1].y - found[0].y,
        'the pins came back stacked on each other — the finder locked onto one thing twice')
        .toBeGreaterThan(m.height * 0.12);
      return found[0];
    };

    // ---- select the same leg, by name ----
    const mask = routeMask(image);
    const leg = verticalLegPoint(mask);
    expect(leg.length,
      'no long vertical run of route colour on the 3D canvas — the middle leg is not drawn, '
      + 'or Field view did not frame it')
      .toBeGreaterThan(mask.height * 0.2);
    const legAt = on3d(leg);
    await page.mouse.click(legAt.x, legAt.y);
    await expect(card).toBeVisible();
    await expect(page.locator('#segment-title')).toHaveText(MIDDLE_LEG_TITLE);
    await expect(page.locator('#segment-id')).toHaveText(MIDDLE_LEG_ID);
    await expect(rows).toHaveCount(rowsFor(WAYPOINTS.length));
    // …and the same second click closes it.
    await page.mouse.click(legAt.x, legAt.y);
    await expect(card).toBeHidden();

    // ---- add a waypoint on empty ground ----
    const clearAt = on3d(emptyPoint(blockedMask(image), controls3d));
    await page.mouse.click(clearAt.x, clearAt.y);
    await expect(rows).toHaveCount(rowsFor(WAYPOINTS.length + 1));

    // ---- remove one by clicking its pin ----
    image = await reset3d();
    const removeAt = on3d(northPin(routeMask(image)));
    await page.mouse.click(removeAt.x, removeAt.y);
    await expect(rows).toHaveCount(rowsFor(WAYPOINTS.length - 1));

    // ---- move one by dragging its pin ----
    image = await reset3d();
    const beforeMove3d = await routeTable.innerText();
    await dragBy(page, on3d(northPin(routeMask(image))), DRAG_DX, DRAG_DY);
    await expect(rows).toHaveCount(rowsFor(WAYPOINTS.length));
    await expectRouteChanged(page, beforeMove3d, 'dragging a pin in 3D moved nothing');

    // ---- move the launch, which the route survives ----
    image = await reset3d();
    /* A small window, because two legs meet on the pad and the pick returns
     * whatever is drawn at the pixel under the pointer. The densest 5×5 of pad
     * colour is a piece of pad with no line across it, which is what a pilot
     * grabs and what deck's pick answers with.
     *
     * The controls are subtracted rather than trusted around: an element
     * screenshot is the page clipped to the element's box, so the floating
     * scene controls are *in* the pixels this reads — and the terrain slider
     * inside them is drawn in `--series-1`, the pad's own colour, in a solid
     * block denser than any disc. It out-scores the real pad every time. */
    const pad3d = denseSpots(maskOf(image, padColors, PAD_TOLERANCE),
      { size: 5, count: 6, minCount: 15 })
      .find((s) => !controls3d.some((c) => s.x >= c.x && s.x <= c.x + c.width
        && s.y >= c.y && s.y <= c.y + c.height));
    expect(pad3d, 'the launch pad is not drawn clear of its own legs on the 3D canvas').toBeTruthy();

    const launchBefore3d = await storedLaunch(page);

    /* First that a click on it does nothing at all — "the pad is dragged, never
     * clicked" (scene.js). This is the assertion that would have caught the
     * gesture bug this spec found: every press on a pin used to arm a drag with
     * no threshold, so a stationary click committed a move to wherever inside
     * the pick radius the cursor sat, and then suppressed its own click. The pad
     * moving here means a pilot can shift their launch point by tapping it. */
    const padTable = await routeTable.innerText();
    await page.mouse.click(on3d(pad3d).x, on3d(pad3d).y);
    await expect(rows).toHaveCount(rowsFor(WAYPOINTS.length));
    /* Hidden proves the pick really answered "launch": a click that had landed
     * on one of the two legs meeting here would open the card, and would
     * otherwise satisfy every other assertion in this block. */
    await expect(card).toBeHidden();
    expect(await routeTable.innerText(), 'a click on the 3D launch pad moved the launch')
      .toBe(padTable);
    expect(await storedLaunch(page), 'a click on the 3D launch pad moved the launch')
      .toEqual(launchBefore3d);

    await dragBy(page, on3d(pad3d), DRAG_DX, DRAG_DY);
    await expect(rows).toHaveCount(rowsFor(WAYPOINTS.length));
    expect(await storedLaunch(page), 'dragging the pad in 3D moved nothing')
      .not.toEqual(launchBefore3d);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
