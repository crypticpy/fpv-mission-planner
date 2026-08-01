// 3D-08, end to end (M16 wave D): the dive's way out.
//
// The recovery plan is the one part of a mountain dive with no derivation
// behind it at all. Nothing computes a lost-link altitude, nothing picks a
// bailout field, nothing decides where a run should be broken off — a pilot
// states all three or the mission does not have them. So the thing worth
// guarding in a browser is the loop, not the arithmetic:
//
//   * Review says the three are unstated, and offers the control that states
//     them. Before wave D that link had nowhere to land: the reducer took the
//     commands, the checks read the answers, and no surface raised one.
//   * The link lands on the recovery panel, and what is typed and clicked
//     there reaches the persisted document.
//   * A placed bailout appears on the flat map too. It is placed with a click
//     and drawn by a different engine than the one that placed it, which is
//     exactly where a control with no visible effect hides.
//   * Review then reads all three back as stated, with no fix link on them.
//
// The abort gate's seeded altitude is asserted against the run's own top gate
// rather than a constant: the seed is "the highest gate this plan carries", and
// a spec that hard-coded the template's number would keep passing if the seed
// silently became something else that happened to match.
//
// External hosts are stubbed as in dive-authoring.spec.js; nothing here
// contacts a tile, terrain or weather provider.

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
/** Metres east and north of the fixture origin, kept as numbers so the spec can
 *  measure the leg on screen and turn pixels back into metres. */
const WP_A = { east: 700, north: 80 };
const WP_B = { east: 1500, north: -60 };
const WAYPOINTS = [at(WP_A.east, WP_A.north), at(WP_B.east, WP_B.north)];
/** How long the second leg is, which is the spec's only scale bar. */
const LEG_M = Math.hypot(WP_B.east - WP_A.east, WP_B.north - WP_A.north);

/** How far off the route the bailout is dropped. Inside `nearestGroundSampler`'s
 *  250 m, so the terrain field still answers where it lands. */
const BAILOUT_OFFSET_M = 150;
/** The lost-link climb, in MSL metres — a figure only a pilot can state. */
const RTH_MSL = 900;
/** What the bailout is renamed to once it exists. */
const BAILOUT_NAME = 'South meadow';

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

/** How far off the route a click has to land to be the map's and not the leg's. */
const MIN_OFFSET_PX = 12;

/**
 * The second leg as it is drawn right now: the two waypoint pins' centres and
 * the distance between them, which is `LEG_M` on the ground and is this spec's
 * only scale bar.
 * @param {import('@playwright/test').Page} page
 */
async function routeLeg(page) {
  const pins = page.locator('#map-canvas .route-marker');
  const [a, b] = await Promise.all([pins.nth(0).boundingBox(), pins.nth(1).boundingBox()]);
  if (!a || !b) throw new Error('the route pins are not on screen');
  const centre = (/** @type {{x: number, y: number, width: number, height: number}} */ box) =>
    ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const from = centre(a);
  const to = centre(b);
  return { from, to, legPx: Math.hypot(to.x - from.x, to.y - from.y) };
}

/**
 * Zoom in until `offsetM` metres is worth clicking distance.
 *
 * The map opens fitted to the whole footprint, kilometres across, where the
 * sampler's entire 250 m tolerance is a handful of pixels wide — narrower than
 * the route's own hit line. There is no aim that both surveys and reaches the
 * map at that scale, so the spec does what a pilot picking a landing site does
 * and zooms in first, on the control rather than the wheel: the wheel did not
 * take in this view's state, and `zoomIn` is the affordance a pilot has anyway.
 *
 * Zooming about the container centre pushes the second leg — which sits east of
 * the fitted centre — further off to one side, so `panLegClear` runs after this
 * and puts it back somewhere clickable.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} offsetM
 */
async function zoomForOffset(page, offsetM) {
  const zoomIn = page.locator('#map-canvas .leaflet-control-zoom-in');
  for (let step = 0; step < 8; step += 1) {
    const { legPx } = await routeLeg(page);
    // Comfortably past the minimum, not at it: the next thing done with this
    // scale is an aim, and an aim that only just clears the hit line is one
    // rounding away from being swallowed by it.
    if (Math.abs(offsetM) * (legPx / LEG_M) >= MIN_OFFSET_PX * 1.6) return;
    await zoomIn.click();
    // Leaflet animates the zoom; the pins are only where the next measurement
    // expects them once it has landed.
    await page.waitForTimeout(450);
  }
  throw new Error(`the map never zoomed in far enough for ${offsetM} m to be clickable`);
}

/**
 * What is on top at a page point, as a string worth reading in a failure.
 * @param {import('@playwright/test').Page} page @param {number} x @param {number} y
 */
const topmostAt = (page, x, y) => page.evaluate(([px, py]) => {
  const el = document.elementFromPoint(px, py);
  return el ? `${el.tagName}#${el.id}.${el.getAttribute('class') ?? ''}` : 'nothing';
}, [x, y]);

/** Whether a page point belongs to the flat map and to nothing in front of it. */
const isMapAt = async (/** @type {import('@playwright/test').Page} */ page, x, y) =>
  (await topmostAt(page, x, y)).includes('leaflet-container');

/**
 * Drag the map until the second leg is on ground that can be clicked.
 *
 * The recovery panel sits over the stage's right-hand third and the view toolbar
 * over the column beside it, so roughly half the map is a card rather than the
 * map. That is not a layout to fix — a pilot placing a site can pan, and the
 * panel has to stay open because it is the thing being tested. But the leg lands
 * squarely under the panel: it is east of the footprint's centre, and zooming
 * about that centre carries it further east every step.
 *
 * So the map is panned the way a pilot pans it, by dragging bare ground, until
 * the leg sits in the clear left-hand part of the stage. Panning moves pixels
 * and not places, so nothing about the terrain under the leg changes — the
 * sampler still answers over it, which is the property the aim depends on.
 *
 * The drag aims at where the leg should end up and then checks, up to three
 * times, because one drag does not reliably land it: Leaflet throws the map on
 * release, and a pan that overshoots into the left rail is as unclickable as one
 * that never left the card.
 *
 * @param {import('@playwright/test').Page} page
 */
async function panLegClear(page) {
  const stage = await page.locator('#map-canvas').boundingBox();
  if (!stage) throw new Error('the map is not on screen');
  /* Low and to the left: clear of the panel, clear of the toolbar column, clear
     of the zoom control in the opposite corner, and far enough inside the frame
     that a perpendicular offset either side of the leg stays on the stage. */
  const target = { x: stage.x + stage.width * 0.27, y: stage.y + stage.height * 0.6 };
  /** How close to the target counts as parked — a quarter of the clear area. */
  const CLOSE_PX = 60;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { from, to } = await routeLeg(page);
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const dx = target.x - mid.x;
    const dy = target.y - mid.y;
    if (Math.hypot(dx, dy) < CLOSE_PX) return;
    await dragMapBy(page, stage, dx, dy);
  }
  const { from, to } = await routeLeg(page);
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  throw new Error(`the leg would not park: it is at ${Math.round(mid.x)},${Math.round(mid.y)}`
    + ` and wanted ${Math.round(target.x)},${Math.round(target.y)}`);
}

/**
 * Drag the map by a pixel offset, grabbing somewhere that is bare map.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{x: number, y: number, width: number, height: number}} stage
 * @param {number} dx @param {number} dy
 */
async function dragMapBy(page, stage, dx, dy) {
  /* The grab has to be bare map, and the release has to stay inside the frame —
     a drag that runs off the stage stops moving it. */
  const viewportH = page.viewportSize()?.height ?? stage.y + stage.height;
  const inside = (/** @type {number} */ x, /** @type {number} */ y) =>
    x > stage.x + 8 && x < stage.x + stage.width - 8
    && y > stage.y + 8 && y < Math.min(stage.y + stage.height, viewportH) - 8;
  /** @type {{x: number, y: number}|null} */
  let grab = null;
  for (let fy = 0.85; fy >= 0.15 && !grab; fy -= 0.1) {
    for (let fx = 0.15; fx <= 0.9 && !grab; fx += 0.1) {
      const x = stage.x + stage.width * fx;
      const y = stage.y + stage.height * fy;
      if (!inside(x, y) || !inside(x + dx, y + dy)) continue;
      if (await isMapAt(page, x, y)) grab = { x, y };
    }
  }
  if (!grab) throw new Error(`no bare map to drag by (${Math.round(dx)}, ${Math.round(dy)}) px`);

  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  // In steps, because a single jump reads as a teleport rather than a drag and
  // Leaflet only pans on the moves it sees.
  await page.mouse.move(grab.x + dx * 0.5, grab.y + dy * 0.5, { steps: 8 });
  await page.mouse.move(grab.x + dx, grab.y + dy, { steps: 8 });
  /* Held still before letting go, which is what stops Leaflet throwing the map:
     it only coasts when the last movement was within a few tens of milliseconds
     of the release, and a thrown map lands somewhere nobody aimed at. */
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(400);
}

/**
 * Click ground beside the route on the flat map. The placement is deliberately
 * not a 3D affordance — the recovery panel opens in either view, because the
 * abort gate and the bailout are places on the ground rather than heights in the
 * air — and a Leaflet click is unambiguously a ground point, where a pick
 * against a terrain mesh answers nothing when the ray misses it.
 *
 * Aimed off the second leg rather than at a fraction of the canvas, because the
 * terrain field only answers within `nearestGroundSampler`'s 250 m of a sampled
 * corridor point: a click out in the empty corner is honestly unsurveyed ground,
 * a real state but not the one under test. The two waypoint pins give the scale
 * — `LEG_M` apart on the ground, measurably far apart on screen — so an offset
 * in metres can be aimed in pixels without the spec knowing the zoom.
 *
 * The offset is perpendicular because the route carries an invisible 14 px-wide
 * hit line whose click is the leg's gesture, not the map's. Where along the leg
 * is not fixed, though: the recovery card and the toolbar sit over the stage,
 * the map card runs past the fold, and a click on any of those does something
 * else or nothing while leaving the armed button armed. So the aim walks the
 * leg and takes the first station that is really the map — every one of them is
 * inside the sampler's tolerance, which is the only property that matters here.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} offsetM metres to the side — left of the direction of travel
 *   when positive, and inside the sampler's tolerance either way
 */
async function clickBesideRoute(page, offsetM) {
  const { from, to, legPx } = await routeLeg(page);
  const offsetPx = offsetM * (legPx / LEG_M);
  // 14 px of invisible hit line, drawn from the centre out: anything inside 7 px
  // of it is the leg's click. The margin is for the pin anchors, which the two
  // centres above assume are the same and cannot be exactly.
  if (Math.abs(offsetPx) < MIN_OFFSET_PX) {
    throw new Error(`${offsetM} m is ${offsetPx.toFixed(1)} px at this zoom — inside the route's hit line`);
  }
  const ux = (to.x - from.x) / legPx;
  const uy = (to.y - from.y) / legPx;
  /** @type {string[]} */
  const missed = [];
  for (const along of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    const x = from.x + (to.x - from.x) * along + uy * offsetPx;
    const y = from.y + (to.y - from.y) * along - ux * offsetPx;
    const hit = await topmostAt(page, x, y);
    if (hit.includes('leaflet-container')) { await page.mouse.click(x, y); return; }
    missed.push(`${along} → ${hit}`);
  }
  // Fail where the aim is wrong rather than three assertions later, on a button
  // that is still lit because its click went somewhere else.
  throw new Error(`no station on the leg at ${offsetM} m is the map: ${missed.join('; ')}`);
}

test.describe('the recovery plan', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('Review names what is unstated, the link lands on the control, and what is stated there reaches the document', async ({ context, page }) => {
    // One WebGL init on a software GPU, then DOM assertions and two clicks.
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
      title: 'Dive recovery fixture',
      tag: 'dive',
      launchElevationMslM: GROUND_M,
    });
    await importMissionFile(page, doc);

    await activate3d(page);
    await page.locator('#vb-dive').click();
    await page.locator('#route-templates button', { hasText: 'Mountain dive' }).click();
    await expect(page.locator('#dive-strip')).toBeVisible();
    // The ground band under the run is the terrain field itself, drawn: it is
    // there only where a corridor sample came back. Waiting for it here — while
    // the strip is still up, which is a 3D surface — is waiting for the later
    // placement to have something to survey against. Without it the click races
    // the corridor fetch and the site is stored honestly unsurveyed, which fails
    // the survey assertion for a reason that has nothing to do with placing.
    await expect(page.locator('.dive-strip-ground').first()).toBeAttached();

    // The template seeds the three flown gates and nothing else — the way out is
    // the pilot's to state, and this is the state Review has to describe.
    await page.waitForTimeout(SAVE_SETTLE_MS + 400);
    const seeded = await persisted(page, doc.id);
    /** @param {*} saved */
    const diveOf = (saved) => saved?.scene?.dive ?? null;
    /** @param {*} saved @param {string} kind */
    const gateOf = (saved, kind) =>
      (diveOf(saved)?.gates ?? []).find((/** @type {{kind: string}} */ g) => g.kind === kind);
    expect(diveOf(seeded)?.rthAltitudeMslM ?? null).toBeNull();
    expect(diveOf(seeded)?.bailout ?? null).toBeNull();
    expect(gateOf(seeded, 'abort')).toBeUndefined();
    /** The top of the run, which is what a placed abort gate starts at. */
    const runTopM = Math.max(...diveOf(seeded).gates
      .map((/** @type {{altitudeMslM: number}} */ g) => g.altitudeMslM));

    // ---- Review: three unstated answers, each with the control beside it ----
    await page.locator('#tab-review').click();
    const card = page.locator('#review-recovery');
    await expect(card).toBeVisible();
    await expect(card.locator('h3')).toHaveText('Recovery plan');
    const values = card.locator('.recovery-lines dd');
    await expect(values).toHaveCount(3);
    await expect(values.nth(0)).toHaveAttribute('data-stated', 'false');
    await expect(values.nth(0)).toContainText('not stated');
    await expect(values.nth(1)).toContainText('no site chosen');
    await expect(values.nth(2)).toContainText('no gate set');
    await expect(card.locator('.recovery-go')).toHaveCount(3);

    // ---- the link lands on the panel that states them ----
    const panel = page.locator('#dive-recovery');
    await expect(panel).toBeHidden();
    await card.locator('.recovery-go').first().click();
    await expect(panel).toBeVisible();
    await expect(panel.locator('h3')).toHaveText('Recovery plan');
    // The standing briefing yields the seat, as it does to either inspector.
    await expect(page.locator('#conditions-card')).toBeHidden();

    // The latch is the pilot's, not the view's: the two things this panel places
    // are places, so it follows them to the map they are placed on.
    await page.locator('#tab-2d').click();
    await expect(panel).toBeVisible();

    // ---- a typed climb reaches the document ----
    const rth = page.locator('#recovery-rth');
    await expect(rth).toHaveValue('');
    await rth.fill(String(RTH_MSL));
    await rth.blur();
    await page.waitForTimeout(SAVE_SETTLE_MS + 400);
    expect(diveOf(await persisted(page, doc.id))?.rthAltitudeMslM).toBe(RTH_MSL);

    // ---- the bailout is placed with a click, and surveyed where it lands ----
    await zoomForOffset(page, BAILOUT_OFFSET_M);
    // Panned before arming rather than after: a drag that starts while a
    // placement is armed is a gesture the app has to tell apart from a click,
    // and this spec is not the place to find out whether it does.
    await panLegClear(page);
    const placeBailout = page.locator('#btn-place-bailout');
    await expect(placeBailout).toHaveText('Place on the map');
    await placeBailout.click();
    await expect(placeBailout).toHaveAttribute('aria-pressed', 'true');
    await expect(placeBailout).toHaveText('Click the map…');
    await clickBesideRoute(page, BAILOUT_OFFSET_M);
    // Armed for exactly one click, whatever that click did.
    await expect(page.locator('#btn-place-bailout')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#btn-place-bailout')).toHaveText('Move');
    await page.waitForTimeout(SAVE_SETTLE_MS + 400);
    const placed = diveOf(await persisted(page, doc.id))?.bailout;
    expect(placed).toBeTruthy();
    // Flat fixture terrain: the field answers the same height everywhere, so a
    // surveyed elevation is the fixture's own number and not a guess.
    expect(placed.elevationMslM).toBeCloseTo(GROUND_M, 0);
    expect(typeof placed.name).toBe('string');
    await expect(panel).toContainText('m MSL');

    // ---- and it is the pilot's to name ----
    const name = page.locator('#recovery-bailout-name');
    await name.fill(BAILOUT_NAME);
    await name.blur();
    await page.waitForTimeout(SAVE_SETTLE_MS + 400);
    expect(diveOf(await persisted(page, doc.id))?.bailout?.name).toBe(BAILOUT_NAME);

    // ---- the abort gate, seeded from the run rather than from thin air ----
    const placeAbort = page.locator('#btn-place-abort');
    await expect(placeAbort).toBeEnabled();
    await placeAbort.click();
    await clickBesideRoute(page, -BAILOUT_OFFSET_M);
    await page.waitForTimeout(SAVE_SETTLE_MS + 400);
    const abort = gateOf(await persisted(page, doc.id), 'abort');
    expect(abort).toBeTruthy();
    expect(abort.altitudeMslM).toBe(runTopM);
    await expect(page.locator('#dive-recovery input[data-gate="abort"]'))
      .toHaveValue(String(runTopM));

    // ---- and the flat map draws what the panel placed ----
    await expect(page.locator('#map-canvas .dive-bailout-dot')).toBeVisible();
    await expect(page.locator('#map-canvas .dive-gate-marker')).toHaveCount(5);

    // ---- Review reads all three back, with nothing left to link to ----
    await page.locator('#tab-review').click();
    const after = page.locator('#review-recovery .recovery-lines dd');
    await expect(after.nth(0)).toHaveAttribute('data-stated', 'true');
    await expect(after.nth(1)).toHaveAttribute('data-stated', 'true');
    await expect(after.nth(2)).toHaveAttribute('data-stated', 'true');
    await expect(after.nth(1)).toContainText(BAILOUT_NAME);
    await expect(page.locator('#review-recovery .recovery-go')).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
