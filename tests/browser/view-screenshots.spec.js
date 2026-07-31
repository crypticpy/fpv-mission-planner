// Deterministic view screenshots (M4 exit gate, item 4).
//
// Four view classes — desktop, tablet, the no-WebGL2 fallback, and the app's
// maximum-contrast theme — each rendered from the same seeded mission and each
// left behind as a PNG attached to the run.
//
// What this spec asserts and what it does not is a deliberate line. There is no
// golden image and no byte comparison: the map is drawn by whatever GPU (or
// software rasteriser) the runner has, and a suite that fails because a driver
// changed its anti-aliasing teaches nobody anything and gets muted within a
// month. So the *assertions* are structural — the landmarks exist, they are
// visible, they are inside the viewport, and the page does not scroll sideways —
// and the *screenshots* are evidence for a human who wants to look. A layout
// that collapses, a control that lands off-screen, or a theme that renders text
// on top of its own background all fail here; a different shade of grey does not.
//
// Everything external is stubbed (harness.js), so the pictures are the same
// offline as on CI.

import { expect, test } from '@playwright/test';

import { FIXTURE_ORIGIN, pointAt } from '../fixtures/synthetic-dem.mjs';
import {
  attachJson, importMissionFile, missionDoc, seedTheme, stubExternals, stubImagery,
  watchConsole,
} from './harness.js';

/* ---------- one mission, so every class shows the same thing ---------- */

const GROUND_M = 150;

/** Metres east and north of the fixture origin, as a point on the globe. */
const at = (/** @type {number} */ east, /** @type {number} */ north) =>
  pointAt(pointAt(FIXTURE_ORIGIN, 0, north), 90, east);

const LAUNCH = at(0, 0);
/* A four-leg dogleg: enough rows for the route table to have a shape, small
 * enough that the whole thing fits the footprint framing at any viewport. */
const WAYPOINTS = [at(900, 400), at(1500, -500), at(300, -1200)];

const seed = () => missionDoc({
  launch: LAUNCH,
  waypoints: WAYPOINTS,
  altitudeMslM: GROUND_M + 120,
  title: 'Screenshot fixture',
  tag: 'shot',
});

/* ---------- what "renders correctly" means without a golden image ---------- */

/**
 * The landmarks every view class must show, whatever its width.
 *
 * Ids rather than text: this is a layout assertion, and a spec that also
 * pinned the wording would fail on a copy edit and say "the tablet layout
 * broke". Navigation is deliberately absent from both lists — it is checked on
 * its own in `nav()`, because a width that renders every landmark perfectly and
 * cannot be steered is still broken.
 */
const PLANNER_LANDMARKS = ['.masthead', '#verdict-badge', '#hero-value'];
const MAP_LANDMARKS = ['#btn-fit', '#btn-brief', '#map-canvas', '#route-card'];

/**
 * The controls this width steers with.
 *
 * M9 gave every width one vocabulary: the destnav (`#nav-*`) is a left icon
 * rail above 900 px and the bottom dock below it, but it is the same element
 * with the same ids either way, and Plan's Overview/Map tab row rides above
 * both workspace modes. So the pair a spec presses is now a constant — what is
 * not constant, and is therefore asserted rather than assumed, is that both are
 * actually on screen: a breakpoint that withdrew either would leave a tablet
 * with no way to reach the map at all, and that should fail here rather than be
 * screenshotted.
 *
 * @param {import('@playwright/test').Page} page
 */
async function nav(page) {
  await expect(page.locator('#nav-plan'),
    'the destnav is not on screen — this width cannot be navigated').toBeVisible();
  await expect(page.locator('#tab-map'),
    "Plan's workspace tabs are not on screen — this width cannot reach the map").toBeVisible();
  return { map: '#tab-map', planner: '#tab-dash' };
}

/**
 * Every landmark is on screen, and on screen *in the viewport* — not merely in
 * the document with its right edge past the window.
 *
 * The horizontal-overflow check is the one that earns its keep at 768 px. A
 * layout that overflows sideways is still perfectly screenshottable, and still
 * broken; `documentElement.scrollWidth` is how the browser admits it. One pixel
 * of slack, because sub-pixel layout rounding is not a bug.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string[]} selectors
 * @param {number} width  the viewport width these are expected to fit
 */
async function expectLaidOut(page, selectors, width) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    await expect(locator, `${selector} is not visible`).toBeVisible();
    const box = await locator.boundingBox();
    expect(box, `${selector} has no box`).toBeTruthy();
    const { x, width: w, height: h } = /** @type {*} */ (box);
    expect(w, `${selector} has no width`).toBeGreaterThan(0);
    expect(h, `${selector} has no height`).toBeGreaterThan(0);
    expect(x, `${selector} starts off the left edge`).toBeGreaterThanOrEqual(-1);
    expect(x + w, `${selector} runs off the right edge at ${width}px`).toBeLessThanOrEqual(width + 1);
  }

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth,
    `the page scrolls sideways at ${width}px (${overflow.scrollWidth} > ${overflow.clientWidth})`)
    .toBeLessThanOrEqual(overflow.clientWidth + 1);
}

/**
 * Open the app with the fixture loaded, on the planner.
 * @param {import('@playwright/test').Page} page
 */
async function boot(page) {
  await page.goto('/');
  await expect(page.locator('#verdict-badge')).toHaveText(/^(GO|CAUTION|DON’T FLY)$/);
  const to = await nav(page);
  await page.locator(to.map).click();
  await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();
  await importMissionFile(page, seed());
  // The route table filling is the app's own signal that the mission arrived and
  // an analysis ran over it — the point at which a screenshot shows something.
  await expect(page.locator('#route-rows tr')).toHaveCount(WAYPOINTS.length + 2);

  /* The terrain card is the app's slowest surface — it asks the elevation
   * service for a profile along the outbound leg and says "Fetching the
   * ground…" until one arrives. The stub answers, so this settles; waiting for
   * it is what keeps a screenshot from catching a card mid-sentence. */
  await expect(page.locator('#terrain-empty')).toBeHidden();

  /* Seeding is a trip to Library and back now, so nothing it does can leave a
   * sheet over the view — but a picture is only deterministic if the conditions
   * sheet is shut, and that is worth saying rather than assuming. Below 900 px
   * `body.sheet-open` is what puts the rail over the map (src/shell.js). */
  await expect(page.locator('body')).not.toHaveClass(/\bsheet-open\b/);
  return to;
}

/**
 * Keep the picture with the run, as a file rather than as bytes in a report.
 *
 * `attach({ path })` rather than `attach({ body })` is the difference between an
 * artifact and nothing at all: the repo's reporter is `list`, which materialises
 * no attachment bodies, so a screenshot handed over as a buffer exists only for
 * as long as the process does. Written through `outputPath` it lands in
 * test-results/<test>/ — gitignored, kept after the run, and uploadable by CI —
 * and is still attached for anyone who runs an HTML report over it.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function shoot(page, name, subject = null) {
  /* Framed on purpose. Seeding the fixture drives the file input in Library's
   * mission fold, and the window can come back from that trip scrolled — so an
   * unframed screenshot of "the map view" is a picture of whatever the scroll
   * position left under the viewport. */
  await page.evaluate((sel) => {
    if (sel) document.querySelector(sel)?.scrollIntoView({ block: 'start', behavior: 'instant' });
    else window.scrollTo({ top: 0, behavior: 'instant' });
  }, subject);
  const file = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  await test.info().attach(`${name}.png`, { contentType: 'image/png', path: file });
}

/* ---------- WCAG contrast, for the class that is about contrast ---------- */

/** sRGB relative luminance (WCAG 2.1 §relative luminance). */
function luminance(/** @type {number[]} */ [r, g, b]) {
  const chan = (/** @type {number} */ v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

/** WCAG contrast ratio between two `rgb()` triples, 1:1 … 21:1. */
function contrast(/** @type {number[]} */ a, /** @type {number[]} */ b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The colour a selector's text is painted in, and the colour actually behind it.
 *
 * "Actually behind it" is the whole difficulty: an element's own background is
 * usually `transparent`, so the honest answer is the nearest ancestor that
 * paints one. Walking up until a non-transparent background appears is what a
 * reader's eye does.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 * @returns {Promise<{ fg: number[], bg: number[] }>}
 */
function inkAndPaper(page, selector) {
  return page.evaluate((sel) => {
    const parse = (/** @type {string} */ value) =>
      (value.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
    const el = /** @type {HTMLElement} */ (document.querySelector(sel));
    const fg = parse(getComputedStyle(el).color);
    let node = /** @type {HTMLElement|null} */ (el);
    while (node) {
      const paint = parse(getComputedStyle(node).backgroundColor);
      // A fourth component is alpha; 0 means this element paints nothing.
      if (paint.length === 3 || (paint[3] ?? 1) > 0.99) return { fg, bg: paint.slice(0, 3) };
      node = node.parentElement;
    }
    return { fg, bg: [255, 255, 255] };
  }, selector);
}

/* ---------- the four classes ---------- */

test.describe('view screenshots', () => {
  /* A screenshot taken while something is sliding is a screenshot of a
   * different picture every run. The app already honours the preference —
   * style.css drops the sheet and scrim transitions under it — so asking for it
   * is both the deterministic choice and a real configuration a pilot can be
   * in, rather than a test-only freeze. */
  test.use({ reducedMotion: 'reduce' });

  for (const [name, viewport] of /** @type {const} */ ([
    ['desktop', { width: 1280, height: 800 }],
    ['tablet', { width: 768, height: 1024 }],
  ])) {
    test(`the ${name} layout holds at ${viewport.width}×${viewport.height}`, async ({ context, page }) => {
      await page.setViewportSize(viewport);
      await stubExternals(context, { elevationM: GROUND_M });
      await stubImagery(context);
      await seedTheme(page);
      const errors = watchConsole(page);

      const to = await boot(page);

      // The map, where the fixture is.
      await expectLaidOut(page, [...MAP_LANDMARKS, to.map, to.planner], viewport.width);
      const map = page.locator('#map-canvas');
      expect((await map.boundingBox())?.height ?? 0,
        'the map collapsed to nothing').toBeGreaterThan(160);
      // Drawn, not merely sized: the footprint ring is the map's own read of the
      // solve, and an empty overlay pane means nothing reached it.
      await expect(page.locator('#map-canvas .leaflet-overlay-pane path').first()).toBeAttached();
      await shoot(page, `${name}-map`, '.map-card');

      // ...and the planner, which is the first thing anyone sees.
      await page.locator(to.planner).click();
      await expect(page.locator('#view-dash')).toBeVisible();
      await expectLaidOut(page, [...PLANNER_LANDMARKS, to.map, to.planner], viewport.width);
      await shoot(page, `${name}-planner`);

      expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
    });
  }

  /* The fallback is a *product* behaviour, not an error path: map-view.js hides
   * the 3D button where WebGL2 is missing and says why, because "offering a
   * button that cannot work is worse than not offering it, and a button that
   * vanishes without explanation is worse than both". This is the only view
   * class that cannot be reached by resizing a window, and the only one whose
   * screenshot is of something a developer never sees on their own machine. */
  test('without WebGL2 the app stays in 2D and says so', async ({ context, page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await stubExternals(context, { elevationM: GROUND_M });
    await stubImagery(context);
    await seedTheme(page);

    /* Exactly the probe map-view.js runs (`supports3d()`), and nothing else:
     * every other context type still answers, so Leaflet, the charts and the
     * brief behave as they do everywhere. A browser launch flag would disable
     * WebGL wholesale and prove a different, larger claim than the app's. */
    await page.addInitScript(() => {
      const real = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function getContext(kind, ...rest) {
        if (kind === 'webgl2') return null;
        return real.call(this, kind, ...rest);
      };
    });

    const errors = watchConsole(page);
    await boot(page);

    // ---- the button is gone, and the reason is on screen ----
    await expect(page.locator('#btn-3d')).toBeHidden();
    const note = page.locator('#map-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText('3D needs WebGL2, which this browser or device does not provide.');

    // ---- and the 2D map is unharmed, which is the actual promise ----
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();
    await expect(page.locator('#map-canvas .leaflet-tile').first()).toBeAttached();
    await expect(page.locator('#map-canvas .leaflet-overlay-pane path').first()).toBeAttached();
    await expect(page.locator('#map-3d')).toBeHidden();
    // Every control except the one that was withdrawn still lays out.
    await expectLaidOut(page, [...MAP_LANDMARKS, '#tab-map'], 1280);
    await shoot(page, 'fallback-no-webgl2', '.map-card');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  /* There is no theme literally named "high contrast"; `sun-glare` is what the
   * app ships for the case — "Maximum contrast in direct sun" (themes.js) — and
   * testing the theme that exists beats emulating a mode the app never reads.
   * The assertion is a measurement rather than an eyeball: WCAG AA, computed
   * from the colours the browser actually resolved. */
  test('the maximum-contrast theme is legible by measurement', async ({ context, page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await stubExternals(context, { elevationM: GROUND_M });
    await stubImagery(context);
    await seedTheme(page, 'sun-glare');
    const errors = watchConsole(page);

    await boot(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sun-glare');

    /* Body text, a heading, and the two places the app puts its answer. The
     * verdict badge and the hero figure are painted on their own backgrounds
     * rather than the page's, which is exactly why they are worth measuring:
     * they are the parts a theme is most likely to get wrong.
     *
     * Each is scoped to the panel it lives in and measured while that panel is
     * open. The two tab panels are `hidden`, so an unscoped `.card-sub` finds
     * the planner's copy first and measures a colour nobody is looking at.
     */
    const measured = [];
    const measure = async (/** @type {readonly (readonly [string, number])[]} */ group) => {
      for (const [selector, floor] of group) {
        await expect(page.locator(selector).first()).toBeVisible();
        const { fg, bg } = await inkAndPaper(page, selector);
        const ratio = contrast(fg, bg);
        measured.push({ selector, fg, bg, ratio: Number(ratio.toFixed(2)), floor });
        expect(ratio, `${selector} is ${ratio.toFixed(2)}:1 against its background, under WCAG AA`)
          .toBeGreaterThanOrEqual(floor);
      }
    };

    // On the map, where boot() left us.
    await measure(/** @type {const} */ ([
      ['.masthead h1', 4.5],
      ['#verdict-badge', 4.5],
      ['#view-map .card-sub', 4.5],
      ['#route-rows td', 4.5],
    ]));

    await expectLaidOut(page, [...MAP_LANDMARKS, '#tab-map'], 1280);
    await shoot(page, 'high-contrast-map', '.map-card');

    // ...and the planner, for the hero figure and its own body copy.
    await page.locator('#tab-dash').click();
    await expect(page.locator('#view-dash')).toBeVisible();
    await measure(/** @type {const} */ ([
      // Large text (the hero figure is far past 24 px); WCAG AA asks 3:1 of it.
      ['#hero-value', 3],
      ['#view-dash .card-sub', 4.5],
    ]));
    await shoot(page, 'high-contrast-planner');

    await attachJson(test.info(), 'sun-glare-contrast.json', measured);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
