// Mission persistence (M1 exit gate).
//
// The question no unit test can answer: does the plan a pilot drew survive
// closing the tab? The reducer and the repository are covered in tests/, against
// fake-indexeddb — here the real browser's IndexedDB, the real service worker
// and the real Leaflet event plumbing are all in the loop, running against the
// built bundle in dist/ (see playwright.config.js).
//
// The proof that the launch point came back *from the mission document* rather
// than from the legacy session key is deliberate: `fpv:v1:map` — the localStorage
// key the launch point has always lived in — is deleted before the reload, so a
// pin in the right place afterwards can only have come out of IndexedDB.
//
// External hosts are stubbed exactly as in smoke.spec.js; nothing here contacts
// a tile or weather provider.
//
// The last test is the same store's other promise (ADR 0012 §5, §7): a record
// this build cannot read as a mission is quarantined, never dropped, with one
// recovery affordance — download the untouched bytes.

import { expect, test } from '@playwright/test';

// The two shell helpers only — the stubs below stay this spec's own, as they
// have always been. Where the mission fold lives is not: it is one fact about
// the app, and a second copy of it is a second thing to forget to update.
import { gotoDest, openMissionFold } from './harness.js';

/** A 1×1 transparent PNG, as the stand-in for every map tile. */
const BLANK_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** The localStorage key the launch point lived in before the mission document. */
const LEGACY_MAP_KEY = 'fpv:v1:map';

/** Longer than the bridge's autosave debounce, with room for the IndexedDB write. */
const SAVE_SETTLE_MS = 600;

/** Stub the third-party origins the app can reach (see smoke.spec.js). */
async function stubExternals(context) {
  // A returning pilot: latch M13's first-run tour off, or its overlay would
  // intercept every click this suite makes (see onboarding.spec.js).
  await context.addInitScript(() => localStorage.setItem('fpv:v1:onboarded', 'true'));
  await context.route(/(^|\/\/|\.)((server\.)?arcgisonline\.com|tile\.openstreetmap\.org)/, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_TILE }));

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

/** Collects console errors and uncaught page errors for later assertion. */
function watchConsole(page) {
  /** @type {string[]} */
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

/** The launch point as the app has persisted it, or null. */
function readLaunchKey(page) {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, LEGACY_MAP_KEY);
}

/**
 * Drag a Leaflet marker by a pixel offset. Two details this has to get right:
 * hover() first, because it waits for the element to stop moving — the map pans
 * itself to fit a restored route, and a press landing mid-animation is swallowed;
 * and real intermediate mousemoves, because a single jump from press to release
 * is not a drag as far as Leaflet's Draggable is concerned.
 */
async function dragBy(page, locator, dx, dy) {
  await locator.hover();
  const box = await locator.boundingBox();
  if (!box) throw new Error('nothing to drag');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

/** Wait out the autosave debounce and insist the write landed. */
async function expectSaved(page) {
  await page.waitForTimeout(SAVE_SETTLE_MS);
  const note = page.locator('#mission-storage');
  await expect(note).toHaveAttribute('data-save', 'saved');
  // The point of running this in a real browser: no fake adapter underneath.
  await expect(note).toHaveAttribute('data-adapter', 'indexeddb');
}

test.describe('mission persistence', () => {
  test('launch point and route survive a reload', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await page.locator('#tab-2d').click();
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();

    const canvas = page.locator('#map-canvas');

    // ---- move the launch point ----
    // Route mode is off, so a map click is what it has always been: the pin.
    await canvas.click({ position: { x: 260, y: 300 } });
    await expect(page.locator('#map-canvas .launch-marker')).toBeAttached();
    const launchBefore = await readLaunchKey(page);
    expect(launchBefore, 'the launch point was never persisted').not.toBeNull();

    // ---- draw a two-waypoint route ----
    await page.locator('#btn-route').click();
    await expect(page.locator('#btn-route')).toHaveAttribute('aria-pressed', 'true');
    await canvas.click({ position: { x: 340, y: 240 } });
    await canvas.click({ position: { x: 420, y: 330 } });
    await expect(page.locator('#map-canvas .route-marker')).toHaveCount(2);
    // The card below the map is solved from the same waypoints the pins are
    // drawn from: launch → 1, 1 → 2, 2 → home, plus the whole-route row.
    await expect(page.locator('#route-card')).toBeVisible();
    await expect(page.locator('#route-rows tr')).toHaveCount(4);

    await expectSaved(page);

    // ---- the reload, with the legacy launch key deleted ----
    // Anything that comes back now came out of IndexedDB.
    await page.evaluate((key) => localStorage.removeItem(key), LEGACY_MAP_KEY);
    await page.reload();

    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();
    await expect(page.locator('#map-canvas .launch-marker')).toBeAttached();
    const launchAfter = await readLaunchKey(page);
    expect(launchAfter, 'the launch point did not come back from the mission').not.toBeNull();
    expect(launchAfter.lat).toBeCloseTo(launchBefore.lat, 6);
    expect(launchAfter.lng).toBeCloseTo(launchBefore.lng, 6);

    // Both waypoints, the line through them, and a route card that agrees —
    // route mode came back on by itself because the open mission has a route.
    await expect(page.locator('#map-canvas .route-marker')).toHaveCount(2);
    await expect(page.locator('#route-card')).toBeVisible();
    await expect(page.locator('#route-rows tr')).toHaveCount(4);
    await expect(page.locator('#btn-route')).toHaveAttribute('aria-pressed', 'true');

    // The reload's fit frames the whole turnaround envelope — miles across —
    // and at that zoom the launch pin and waypoint 1 can share pixels: one
    // snap level is the difference between clear and overlapping, and CI's
    // font metrics leave the pane just short enough to lose it. Overlapped,
    // the waypoint's dot intercepts the launch marker's hover and the drag
    // below never starts. Zoom back in around the launch-centred view first.
    const zoomIn = page.locator('.leaflet-control-zoom-in');
    for (let i = 0; i < 2; i += 1) {
      await zoomIn.click();
      await expect(page.locator('#map-canvas')).not.toHaveClass(/leaflet-zoom-anim/);
    }

    // ---- and moving the launch no longer throws the route away ----
    // A map click would drop a waypoint now that route mode is on, so move the
    // pin the way a pilot does with a route drawn: drag it.
    await dragBy(page, page.locator('#map-canvas .launch-marker'), -60, 40);
    await expect
      .poll(async () => (await readLaunchKey(page)).lat, { message: 'the launch drag did not take' })
      .not.toBe(launchAfter.lat);
    await expect(page.locator('#map-canvas .route-marker')).toHaveCount(2);

    // Dragging a waypoint moves it; the synthetic click Leaflet fires after a
    // drag must not be read as the click that removes one.
    await dragBy(page, page.locator('#map-canvas .route-marker').first(), 30, -25);
    await expect(page.locator('#map-canvas .route-marker')).toHaveCount(2);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('rename and save-as-copy leave two missions on the list', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await expect(page.locator('#verdict-badge')).not.toHaveText('—');

    // The fold is in Library now, and it ships open — so this is a walk to it,
    // not a press on it.
    await gotoDest(page, 'library');
    await openMissionFold(page);
    const title = page.locator('#mission-title');
    await expect(title).not.toHaveValue('');

    // Rename in place: change fires on Enter, which is how the rail's other
    // text inputs commit too.
    await title.fill('Ridge line');
    await title.press('Enter');
    await expect(page.locator('#mission-note')).toContainText('Ridge line');
    await expectSaved(page);

    await page.locator('#btn-mission-copy').click();
    await expect(page.locator('#mission-list .spot-row')).toHaveCount(2);
    // The copy is the one being edited now, and the original is untouched.
    await expect(title).toHaveValue('Ridge line copy');
    await expectSaved(page);

    await page.reload();
    // The session remembers the destination, so the reload may land on Library
    // already; either way this is where the list is.
    await gotoDest(page, 'library');
    await openMissionFold(page);
    const rows = page.locator('#mission-list .spot-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.locator('.spot-name')).toHaveText(['Ridge line copy', 'Ridge line']);
    // The most recently touched mission is the one that reopened.
    await expect(page.locator('#mission-title')).toHaveValue('Ridge line copy');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  /* ADR 0012 §5, §7 — the recovery half of persistence. A record `missions`
   * cannot migrate is not the reducer's problem or a unit test's: it is
   * whatever landed in IndexedDB by some other means (a future schema this
   * build predates, a write torn by a crash) and the whole promise is that it
   * is quarantined, not silently gone. This writes a record the repository
   * never wrote itself, straight into the store it reads from, to prove the
   * read path — not the write path — is what catches it. */
  test('a mission record the repository cannot read is quarantined, and its raw bytes download', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await expect(page.locator('#verdict-badge')).not.toHaveText('—');

    // Straight into the `missions` object store, bypassing the repository's
    // own validate-on-write gate entirely — the one way a truly unreadable
    // record could exist on disk.
    await page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('fpv-planner');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('missions', 'readwrite');
        tx.objectStore('missions').put({ id: 'corrupt-e2e-1', notAMission: true });
        tx.oncomplete = () => { db.close(); resolve(undefined); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    }));

    // Opening the fold is what asks the repository to list again — the same
    // read that moves anything it cannot migrate into quarantine
    // (mission-repository.js's `accept`). The fold ships open, so it is shut
    // first: the `toggle` this test needs is the one that opens it, and a
    // single blind click would only take the list off screen.
    await gotoDest(page, 'library');
    const fold = page.locator('#mission-fold');
    await fold.locator('summary').click();
    await expect(fold).toHaveJSProperty('open', false);
    await openMissionFold(page);

    const row = page.locator('#mission-list .spot-row', { hasText: 'corrupt-e2e-1' });
    await expect(row).toBeVisible();
    await expect(row.locator('.spot-meta')).toContainText('could not be read as a mission');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      row.locator('button', { hasText: 'download raw' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('corrupt-e2e-1-quarantined.json');

    // No delete and no repair-in-place (ADR 0012 §5): the row is still there
    // afterwards, and the mission that was actually open never budged.
    await expect(row).toBeVisible();
    await expect(page.locator('#verdict-badge')).not.toHaveText('—');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
