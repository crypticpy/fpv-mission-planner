// The mission brief's Evidence section and coordinate redaction, and the
// evidence store's offline promise (ADR 0012 §2, §6, §7).
//
// src/brief.js's Evidence section is a window onto provenance the analysis
// snapshot already carries — no unit test can prove it reaches the *screen*
// off a real fetch and a real mission document, which is what this spec
// drives through a real service worker and a real IndexedDB, against the
// built bundle in dist/ (see playwright.config.js). It also covers the other
// half of §6: a pilot can withhold coordinates from the one shareable
// artifact without touching the plan underneath them, and the numbers that
// matter — the energy budget — must not move when they do.
//
// `stubExternals(context, { sky: {} })` (harness.js) answers Open-Meteo's live
// endpoints with a real, well-formed payload rather than the empty one most
// specs use, so a live fetch has something real to land — the more
// interesting half of evidenceSection() (src/brief.js) to exercise here.
//
// The forecast-provenance test below re-presses "Live weather" after boot
// rather than trusting the boot-default fetch (state.weatherId === 'live'
// triggers goLive() at module load, src/app.js): that very first fetch races
// the mission repository's own IndexedDB open, and mission-bridge.js's
// dispatch() silently no-ops (`if (!doc) return false`) when the fetch wins
// the race and lands before a document exists to attach its provenance to —
// a pre-existing gap outside this wave's scope (waves A/B, additive-only
// here). Pressing `#btn-live` after the badge shows a verdict asks again
// once the mission is certainly open, which is what this test needs proven.
//
// The offline test below deliberately never opens the brief for the first
// time *after* an offline reload. render/brief.js is a lazy chunk (dynamic
// `import()`, ADR 0012 §4), and `vite preview` — this whole suite's server,
// not the GitHub Pages host the app actually ships to — enables CORS by
// default and stamps every response `Vary: Origin`. A dynamic `import()`
// always sends an `Origin` header where an ordinary same-origin `fetch()`
// does not, so the Cache API's Vary-aware match rejects the very entry the
// service worker precached for that exact URL, and the cold import fails
// offline — confirmed by hand with `caches.match(request, { ignoreVary:
// true })`, which makes it succeed. That is a `vite preview` artifact, not
// sw.js's doing, and out of this wave's scope to change (sw.js edits here
// are precache lines and the cache version only). The claim this test can
// still make honestly: evidence gathered online is still on disk and still
// named after an offline reload — proven through `#terrain-note`, which
// rides the entry bundle and isn't subject to the lazy-chunk import path.

import { expect, test } from '@playwright/test';

import { stubExternals, watchConsole } from './harness.js';

/** The Evidence (or any other named) section of the open brief. */
function briefSection(page, title) {
  return page.locator('section.brief-block', { has: page.locator('h3.brief-h', { hasText: title }) });
}

test.describe('mission brief evidence', () => {
  test('the Evidence section states the forecast, terrain and analysis provenance', async ({ context, page }) => {
    await stubExternals(context, { sky: {} });
    const errors = watchConsole(page);

    await page.goto('/');
    await expect(page.locator('#verdict-badge')).not.toHaveText('—');
    // Past the corridor sample debounce that follows a fresh mission's first
    // analysis (src/analysis-host.js), with room to spare — the mission is
    // certainly open by now (see header comment on the boot-fetch race).
    await page.waitForTimeout(1000);
    // #btn-live lives on the Planner tab; re-press it for a fetch that cannot
    // race mission-bridge.js's open.
    await page.locator('#btn-live').click();
    await page.waitForTimeout(500);

    // #btn-brief lives inside the Map tab's card (see interop.spec.js).
    await page.locator('#tab-map').click();
    await page.locator('#btn-brief').click();
    const evidence = briefSection(page, 'Evidence');
    await expect(evidence).toBeVisible();
    // The forecast really was fetched, not defaulted: source and a fresh age.
    await expect(evidence).toContainText(/Forecast: open-meteo-forecast, captured (moments ago|\d+ min ago)\./);
    // The ground came from the same elevation port every terrain feature does.
    await expect(evidence).toContainText('Open-Meteo elevation API');
    // Unconditional on every snapshot (src/application/analysis/analysis-contracts.js).
    await expect(evidence).toContainText('Analysis model: analysis-v1.');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('hiding coordinates for sharing withholds the launch point and nothing else', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await expect(page.locator('#verdict-badge')).not.toHaveText('—');

    // #btn-brief lives inside the Map tab's card (see interop.spec.js).
    await page.locator('#tab-map').click();
    // The brief prints the footprint's own launch (renderCurrent() reads
    // fp.launch), and the first verdict can render before the mission
    // repository's IndexedDB open seeds a document for the sweep to center on
    // (the boot race in this file's header comment). The footprint ring is the
    // deterministic signal: it is drawn from the same snapshot field the brief
    // is about to print, so once it is on the map the coordinates exist.
    await expect(page.locator('#map-canvas .leaflet-overlay-pane path').first()).toBeAttached();
    await page.locator('#btn-brief').click();
    const launch = briefSection(page, 'Launch point');
    const energy = briefSection(page, 'Energy budget');

    await expect(launch.locator('.brief-mono')).toHaveCount(2);
    const before = await launch.locator('.brief-mono').allTextContents();
    for (const coord of before) expect(coord).toMatch(/\d/);
    const energyBefore = await energy.innerText();

    // Off by default (ADR 0012 §6) — the checkbox lives in the static bar, not
    // the sheet renderSheet() rebuilds, so it survives every re-render.
    await expect(page.locator('#brief-redact-coords')).not.toBeChecked();
    await page.locator('#brief-redact-coords').check();

    await expect(launch.locator('.brief-mono').first()).toHaveText('withheld');
    const after = await launch.locator('.brief-mono').allTextContents();
    expect(after).toEqual(['withheld', 'withheld']);
    // The number the whole brief exists to carry must not move because a
    // coordinate did — energy.js's rows are untouched by redaction.
    expect(await energy.innerText()).toBe(energyBefore);

    // And it is a toggle, not a one-way door: unchecking brings the real
    // coordinates straight back from the same snapshot.
    await page.locator('#brief-redact-coords').uncheck();
    expect(await launch.locator('.brief-mono').allTextContents()).toEqual(before);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});

test.describe('evidence offline', () => {
  test('terrain evidence gathered online survives an offline reload, still named in the brief', async ({ context, page }) => {
    await stubExternals(context, { sky: {} });
    const errors = watchConsole(page);

    await page.goto('/');
    await expect(page.locator('#verdict-badge')).not.toHaveText('—');
    await page.locator('#tab-map').click();
    await expect(page.locator('#terrain-note')).toContainText('CC BY 4.0');

    // "Still named in the brief" (this test's own title), proven online while
    // it's cheap to: opening the brief warms its lazy chunk over the real
    // network, which is exactly the state a pilot who checked their brief
    // before departing would be in.
    await page.locator('#btn-brief').click();
    await expect(briefSection(page, 'Evidence')).toContainText('Open-Meteo elevation API');
    await page.locator('#brief-close').click();

    // The worker claims clients on activate, but the page that triggered the
    // very first install may still be uncontrolled (smoke.spec.js's own
    // offline test) — one online reload guarantees the fetch handler is in
    // front of every request before the network is cut. The mission and its
    // evidence are already on disk by the time this fires.
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.reload();
    await expect(page.locator('#verdict-badge')).toHaveText(/^(GO|CAUTION|DON’T FLY)$/);

    // Past the corridor sample debounce (500 ms) and the evidence save
    // debounce that follows it (300 ms, src/analysis-host.js), with room to
    // spare — this is what the offline read below depends on having landed.
    await page.waitForTimeout(1500);

    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.locator('#verdict-badge')).toHaveText(/^(GO|CAUTION|DON’T FLY)$/);

      // The claim this reload can prove (see header comment for why the brief
      // itself isn't reopened here): the terrain evidence gathered online is
      // still on disk and still named, read back with no network at all.
      await page.locator('#tab-map').click();
      await expect(page.locator('#terrain-note')).toContainText('CC BY 4.0');
    } finally {
      await context.setOffline(false);
    }

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
