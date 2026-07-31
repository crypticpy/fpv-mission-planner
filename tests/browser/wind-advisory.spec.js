// The mountain-flow advisory on screen (M5 exit gate).
//
// Waves 1–4 built the finding and drew it; tests/wind-forcing.test.mjs,
// tests/analysis-advisory.test.mjs and tests/wind-reference-cases.test.mjs prove
// the physics, the pass and the published reference cases at the unit level.
// What none of them can prove is that a pilot in a browser, in front of the
// built bundle, is shown that finding rather than something the render path
// invented. That is this file, and it is the automated half of M5's exit gate:
//
//   * do the zones actually draw — cells, boundary, key and the honesty card —
//     over ground the fixture DEM controls?
//   * does reversing the wind swap the windward and lee flanks *on screen*, and
//     not merely in the domain module? A sign convention that survived the
//     domain and got flipped by a projection would be an advisory that colours
//     the wrong side of the ridge, which is worse than no advisory at all.
//   * does the toggle actually clear the wash?
//   * with no sounding — a stored preset — does the advisory still draw its
//     forcing zones while saying plainly that no regime was established, and
//     without a W-WIND-REGIME row nagging about a baseline that never ran?
//   * are the rail and the brief naming the same findings, by code and by
//     sentence?
//
// Two techniques are worth stating once.
//
//   *Layer output is read as SVG, not as pixels.* The 2D adapter gives every
//     overlay the layer's className, so an advisory cell is a
//     `path.advisory-cell.advisory-cell-<classId>` under #map-canvas and the
//     sampled area is a single `path.advisory-extent`. Reading class and
//     geometry off those paths is exactly how route-parity.spec.js and
//     segment-inspector.spec.js assert their layers, and it names what was drawn
//     instead of guessing at colours.
//
//   *The wind codes come from the registry.* Three codes outside this producer
//     share the W-WIND- prefix — W-WIND-NO-CLOSE, W-WIND-GUST-AUTHORITY and
//     W-WIND-LEVEL-MISMATCH all come from the planner — so selecting on the
//     prefix would quietly fold planner findings into an advisory assertion.
//     Everything here filters on `producer: 'wind'` in CONSTRAINT_CODES.
//
// Neither surface puts the full constraint id (`CODE@scope:refId`) in the DOM;
// the rail and the brief both carry `data-code` and `data-severity`, so "the
// same identifiers" is checked the way analysis-snapshot.spec.js checks it —
// code, severity and the producer's verbatim sentence.
//
// The 3D scene is deliberately not covered. Its zones are the same
// advisoryZones() output (tests/advisory-layer.test.mjs asserts the shared
// geometry), but exercising it means a 1.7 MB engine chunk plus network terrain
// and imagery, which is what scene-3d.spec.js exists for.
//
// Nothing here reaches the network: elevations come from a synthetic ridge, the
// forecast is answered by the harness, and tiles are a blank PNG.

import { expect, test } from '@playwright/test';

import { CONSTRAINT_CODES } from '../../src/application/analysis/constraints.js';
import { FIXTURE_ORIGIN, pointAt, ridgeDem } from '../fixtures/synthetic-dem.mjs';
import { importMissionFile, missionDoc, stubExternals, watchConsole } from './harness.js';

/**
 * Every code this producer can raise, from the registry itself.
 * @type {string[]}
 */
const WIND_CODES = Object.values(CONSTRAINT_CODES)
  .filter((c) => c.producer === 'wind')
  .map((c) => c.code);

/** How many warnings the brief prints before it starts holding them back. */
const MAX_BRIEF_WARNINGS = 4;

/**
 * A north–south ridge 200 m high and 1.2 km wide, centred on the fixture origin:
 * with `axisDeg: 0` the crest runs north–south, so elevation is a function of
 * easting alone and every cell west of the crest is the mirror of one east of
 * it. That symmetry is what makes the reversal assertion below exact rather than
 * statistical.
 */
const RIDGE = ridgeDem({ base: 200, heightM: 200, widthM: 1200, axisDeg: 0 });

/** Metres from the origin to each side of the route box. */
const HALF_M = 700;

/** @param {number} east @param {number} north @returns {{lat: number, lng: number}} */
function at(east, north) {
  return pointAt(pointAt(FIXTURE_ORIGIN, 0, north), 90, east);
}

/* A square that straddles the crest, so the sampled grid covers both flanks. */
const LAUNCH = at(-HALF_M, -HALF_M);
const WAYPOINTS = [at(HALF_M, -HALF_M), at(HALF_M, HALF_M), at(-HALF_M, HALF_M)];

/**
 * Open the app on the map tab with the ridge mission loaded.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ altitudeMslM?: number, title?: string }} [opts]
 */
async function boot(page, { altitudeMslM = 400, title = 'Ridge advisory' } = {}) {
  await page.goto('/');
  await expect(page.locator('#verdict-badge')).toHaveText(/^(GO|CAUTION|DON’T FLY)$/);
  await page.locator('#tab-map').click();
  await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();
  await importMissionFile(page, missionDoc({
    launch: LAUNCH, waypoints: WAYPOINTS, altitudeMslM, title,
  }));
}

/**
 * Drive the weather panel by hand. Custom is the one source whose direction a
 * spec can set outright, which is what the reversal case needs; the app's live
 * fetch and its presets both arrive with a direction of their own.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, number>} fields  input id → value
 */
async function setCustomWeather(page, fields) {
  await page.locator('#sel-weather').selectOption('custom');
  for (const [id, value] of Object.entries(fields)) {
    await page.locator(`#${id}`).fill(String(value));
    await page.locator(`#${id}`).dispatchEvent('input');
  }
}

/**
 * Every cell the advisory layer drew: its class, its geometry and where the
 * geometry landed on screen.
 *
 * The path's own `d` is the cell's identity — it is the projected polygon, so it
 * is unique per cell and stable while the map view is — and the bounding-rect
 * centre is where it sits relative to the crest. Cells whose rect has no width
 * (clipped out of the viewport) report a null x and are compared by identity
 * only.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ classId: string|null, key: string, x: number|null }[]>}
 */
function readCells(page) {
  return page.evaluate(() => [...document.querySelectorAll('#map-canvas path.advisory-cell')]
    .map((path) => {
      const rect = path.getBoundingClientRect();
      const marker = [...path.classList].find((name) => name.startsWith('advisory-cell-'));
      return {
        classId: marker ? marker.replace('advisory-cell-', '') : null,
        key: path.getAttribute('d') ?? '',
        x: rect.width > 0 ? rect.x + rect.width / 2 : null,
      };
    }));
}

/**
 * classId → how many cells of it were drawn.
 * @param {{ classId: string|null }[]} cells
 * @returns {Record<string, number>}
 */
function countByClass(cells) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const cell of cells) counts[cell.classId ?? 'null'] = (counts[cell.classId ?? 'null'] ?? 0) + 1;
  return counts;
}

/**
 * The screen-x span of one class, over the cells that are actually on screen.
 * @param {{ classId: string|null, x: number|null }[]} cells
 * @param {string} classId
 * @returns {{ min: number, max: number, n: number }}
 */
function span(cells, classId) {
  const xs = cells.filter((c) => c.classId === classId && c.x != null).map((c) => /** @type {number} */(c.x));
  return { min: Math.min(...xs), max: Math.max(...xs), n: xs.length };
}

/**
 * The provenance rows, label → { value, note }. The value is the dd's own text
 * node and the note is the span after it, kept apart so a spec can assert the
 * fact without matching the caveat glued to the end of it.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Record<string, { value: string, note: string }>>}
 */
function readFacts(page) {
  return page.evaluate(() => {
    /** @type {Record<string, { value: string, note: string }>} */
    const facts = {};
    const values = [...document.querySelectorAll('#advisory-facts dd')];
    [...document.querySelectorAll('#advisory-facts dt')].forEach((dt, i) => {
      const dd = values[i];
      facts[dt.textContent ?? ''] = {
        value: dd?.childNodes[0]?.textContent ?? '',
        note: dd?.querySelector('.segment-note')?.textContent ?? '',
      };
    });
    return facts;
  });
}

/** `{ code, severity, text }` for every row of a warning list, in DOM order. */
function readRows(page, selector) {
  return page.$$eval(selector, (nodes) => nodes.map((n) => ({
    code: n.dataset.code ?? null,
    severity: n.dataset.severity ?? null,
    text: n.textContent ?? '',
  })));
}

/**
 * Wait until the advisory has drawn a field: the card is up, cells are on the
 * map, and the key names them. Every one of those is written by the same render
 * pass, so this is one wait rather than three.
 * @param {import('@playwright/test').Page} page
 */
async function waitForZones(page) {
  await expect(page.locator('#advisory-card')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#map-canvas path.advisory-cell').first()).toBeAttached();
  await expect(page.locator('#advisory-legend')).toBeVisible();
}

/**
 * Wait until the westernmost drawn cell carries `classId`.
 *
 * The redraw after a wind change goes through the sampler's debounce and an
 * analysis pass, and the only honest signal that it has landed is the picture
 * itself having changed. The westernmost cell is the sharpest available: on this
 * ridge it is windward under a west wind and lee under an east one, so waiting
 * for it is waiting for exactly the thing the caller is about to assert — never
 * a sleep.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} classId
 */
async function waitForWestmostClass(page, classId) {
  await page.waitForFunction((want) => {
    /** @type {{ x: number, id: string|null }|null} */
    let west = null;
    for (const path of document.querySelectorAll('#map-canvas path.advisory-cell')) {
      const rect = path.getBoundingClientRect();
      if (rect.width === 0) continue;
      const x = rect.x + rect.width / 2;
      if (west && x >= west.x) continue;
      const marker = [...path.classList].find((name) => name.startsWith('advisory-cell-'));
      west = { x, id: marker ? marker.replace('advisory-cell-', '') : null };
    }
    return west?.id === want;
  }, classId, { timeout: 30_000 });
}

test.describe('the mountain-flow advisory in a browser', () => {
  /* Wide enough that the whole sampled grid is inside the viewport, so the
   * screen-x geometry below is reading every cell rather than the survivors of a
   * clip. */
  test.use({ viewport: { width: 1280, height: 900 } });

  test('the zones, the key and the limits are drawn over the ridge', async ({ context, page }) => {
    // Boot, import, sample a 24 × 24 grid, analyse, draw — generous, because a
    // slow machine failing this on the clock says nothing about the advisory.
    test.setTimeout(90_000);
    await stubExternals(context, { dem: RIDGE });
    const errors = watchConsole(page);

    await boot(page);
    await setCustomWeather(page, { 'in-wind': 20, 'in-gust': 22, 'in-winddir': 270 });
    await waitForZones(page);

    const cells = await readCells(page);
    const counts = countByClass(cells);
    // A ridge across the wind is the one shape the proxy is unambiguous about:
    // air is forced up one flank and down the other, so both classes have to be
    // on screen. Which cells fall where is asserted in the reversal case.
    expect(counts.uplift ?? 0, `no windward cells drawn: ${JSON.stringify(counts)}`).toBeGreaterThan(0);
    expect(counts.lee ?? 0, `no lee cells drawn: ${JSON.stringify(counts)}`).toBeGreaterThan(0);
    // `low` is counted by the model and deliberately never drawn (ADR 0008): a
    // green carpet would read as a clearance.
    expect(counts.low ?? 0, 'a low-forcing cell was shaded').toBe(0);
    // One boundary, so the edge of what was analysed is legible.
    await expect(page.locator('#map-canvas path.advisory-extent')).toHaveCount(1);

    // The key names what is on the map, and counts it. `ridge` and `gap` share a
    // row because they share W-WIND-ACCEL; a class with no cells is left out.
    const legend = await page.locator('#advisory-legend .viz-legend-item').allTextContents();
    const expected = [
      ['Lee slope', counts.lee ?? 0],
      ['Crest or gap', (counts.ridge ?? 0) + (counts.gap ?? 0)],
      ['Windward slope', counts.uplift ?? 0],
      ['No elevation', counts.unknown ?? 0],
    ].filter(([, n]) => Number(n) > 0).map(([label, n]) => `${label} · ${n}`);
    expect(legend.slice(0, expected.length), 'the key disagrees with the cells on the map')
      .toEqual(expected);
    // The class that is deliberately not a swatch: the sentence that stops empty
    // space inside the outline from being read as a clearance.
    expect(legend.at(-1)).toContain('not a safety claim');

    // The two claims M5 is forbidden from making are denied on screen before any
    // click — the card's standing line, not something behind the fold.
    const heading = page.locator('#advisory-card .card-sub');
    await expect(heading).toBeVisible();
    await expect(heading).toContainText('it cannot locate a rotor');
    await expect(heading).toContainText('Low forcing is not a statement that an area is safe');

    // And the producer's limitations, verbatim, where a pilot can open them.
    await page.locator('#advisory-fold summary').click();
    const limits = page.locator('#advisory-limits li');
    await expect(limits).toHaveCount(6);
    const limitText = (await limits.allTextContents()).join(' | ');
    for (const clause of [
      'relative terrain-forcing proxy (V·∇h), not a forecast vertical velocity',
      'not the air at flight altitude',
      'it cannot locate a rotor',
      'not a statement that an area is safe',
      'bare-earth DEM',
      'one wind for the whole area',
    ]) {
      expect(limitText, `the stated limitations dropped: ${clause}`).toContain(clause);
    }

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('reversing the wind swaps the windward and lee flanks on screen', async ({ context, page }) => {
    test.setTimeout(90_000);
    await stubExternals(context, { dem: RIDGE });
    const errors = watchConsole(page);

    await boot(page);
    await setCustomWeather(page, { 'in-wind': 20, 'in-gust': 22, 'in-winddir': 270 });
    await waitForZones(page);
    await waitForWestmostClass(page, 'uplift');
    const west = await readCells(page);

    // A west wind climbs the western flank and descends the eastern one, and the
    // ridge is a clean partition: every windward cell is west of every lee cell.
    // Nothing weaker would catch a sign that survived the domain and got flipped
    // by the projection.
    const westUplift = span(west, 'uplift');
    const westLee = span(west, 'lee');
    // Both spans have to exist before they can be compared: an empty span is
    // ±Infinity, which would satisfy the ordering below without a cell on screen.
    expect(westUplift.n, 'no windward cells on screen to compare').toBeGreaterThan(0);
    expect(westLee.n, 'no lee cells on screen to compare').toBeGreaterThan(0);
    expect(westUplift.max, 'a windward cell landed east of a lee cell under a west wind')
      .toBeLessThan(westLee.min);

    // Same mission, same grid, same everything but 180° of wind.
    await setCustomWeather(page, { 'in-winddir': 90 });
    await waitForWestmostClass(page, 'lee');
    const east = await readCells(page);

    const eastLee = span(east, 'lee');
    const eastUplift = span(east, 'uplift');
    expect(eastLee.n).toBe(westUplift.n);
    expect(eastUplift.n).toBe(westLee.n);
    expect(eastLee.max, 'the flanks did not swap when the wind reversed')
      .toBeLessThan(eastUplift.min);

    // Stronger than "the sides swapped": w* = V·∇h is linear in V, so a 180°
    // reversal negates it exactly, and on a symmetric ridge every cell must come
    // back with its opposite class — same grid, same geometry, classes mirrored.
    expect(east.map((c) => c.key).sort(), 'the grid moved between the two winds')
      .toEqual(west.map((c) => c.key).sort());
    const after = new Map(east.map((c) => [c.key, c.classId]));
    const opposite = /** @type {Record<string, string>} */ ({ uplift: 'lee', lee: 'uplift' });
    const wrong = west
      .filter((c) => after.get(c.key) !== (opposite[c.classId ?? ''] ?? c.classId))
      .map((c) => `${c.classId} → ${after.get(c.key)}`);
    expect(wrong, `cells that did not mirror when the wind reversed: ${wrong.slice(0, 5).join(', ')}`)
      .toEqual([]);
    // The two classes trade places wholesale, not by a cell or two at the crest.
    expect(countByClass(east).lee).toBe(countByClass(west).uplift);
    expect(countByClass(east).uplift).toBe(countByClass(west).lee);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('the wind-zones toggle clears the wash and brings it back', async ({ context, page }) => {
    test.setTimeout(90_000);
    await stubExternals(context, { dem: RIDGE });
    const errors = watchConsole(page);

    await boot(page);
    await setCustomWeather(page, { 'in-wind': 20, 'in-gust': 22, 'in-winddir': 270 });
    await waitForZones(page);
    const drawn = (await readCells(page)).length;
    expect(drawn).toBeGreaterThan(0);

    const toggle = page.locator('#btn-advisory');
    // On by default and saying so: an advisory a pilot has to discover a button
    // for is one they will fly without.
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveText('Wind zones · on');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toHaveText('Wind zones');
    // The cells and the boundary go together — a boundary with nothing inside it
    // would claim an analysed area with no finding in it.
    await expect(page.locator('#map-canvas path.advisory-cell')).toHaveCount(0);
    await expect(page.locator('#map-canvas path.advisory-extent')).toHaveCount(0);
    // The key follows the marks it is a key to; the card does not, because what
    // was computed and what it cannot say are true whether or not the colours
    // are up.
    await expect(page.locator('#advisory-legend')).toBeHidden();
    await expect(page.locator('#advisory-card')).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#advisory-legend')).toBeVisible();
    await expect(page.locator('#map-canvas path.advisory-extent')).toHaveCount(1);
    await expect.poll(() => page.locator('#map-canvas path.advisory-cell').count(),
      { message: 'the wash came back short of what it had been' }).toBe(drawn);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('a preset draws its zones and says no regime was established', async ({ context, page }) => {
    test.setTimeout(90_000);
    /* No `sky`, so nothing answers the forecast: a stored preset carries a wind
     * and no sounding, which is the ordinary offline case and the one where an
     * advisory could most easily overclaim. */
    await stubExternals(context, { dem: RIDGE });
    const errors = watchConsole(page);

    await boot(page);
    await page.locator('#sel-weather').selectOption('comtn');
    await waitForZones(page);

    // Baseline 1 needs a wind and a DEM, both of which it has.
    const counts = countByClass(await readCells(page));
    expect(counts.uplift ?? 0, 'a preset wind drew no windward cells').toBeGreaterThan(0);
    expect(counts.lee ?? 0, 'a preset wind drew no lee cells').toBeGreaterThan(0);

    // Baseline 2 needs a sounding, which it does not have — and says so in
    // words, in both rows, rather than showing a default.
    const facts = await readFacts(page);
    expect(facts.Sounding.value).toBe('none — no regime could be read');
    expect(facts['Stability regime'].value).toContain('unknown');
    expect(facts['Stability regime'].value).toContain('Fr = —');
    expect(facts['Wind it ran on'].value).toMatch(/^\d+ mph from \d+°$/);
    expect(facts['Wind it ran on'].note).toContain('one wind for the whole area');

    // The rail carries what the advisory found...
    const rail = await readRows(page, '#warnings .warn');
    const wind = rail.filter((r) => WIND_CODES.includes(r.code ?? ''));
    expect(wind.length, 'the advisory drew zones but told the rail nothing').toBeGreaterThan(0);
    // ...and not a nag about a baseline that never ran. W-WIND-REGIME reports a
    // regime the flow is in; with no sounding there is no regime to report, and
    // a caution here would be the tool inventing a finding out of missing data.
    expect(rail.map((r) => r.code)).not.toContain('W-WIND-REGIME');
    // The prefix trap, asserted rather than commented: these three are planner
    // and analysis codes that happen to start W-WIND-, and selecting on the
    // prefix above would have folded them into the advisory's own findings.
    for (const outsider of ['W-WIND-NO-CLOSE', 'W-WIND-GUST-AUTHORITY', 'W-WIND-LEVEL-MISMATCH']) {
      expect(WIND_CODES, `${outsider} is not an advisory code`).not.toContain(outsider);
    }

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('a forecast sounding reaches the regime row', async ({ context, page }) => {
    test.setTimeout(90_000);
    /* `sky` opts this spec into the harness's forecast payload — pressure-level
     * wind, temperature and geopotential height at 850, 700 and 500 hPa, which is
     * what src/weather.js `sounding` parses. This is the one spec that proves
     * baseline 2 survives the trip through the real fetch path in a browser. */
    await stubExternals(context, {
      dem: RIDGE, sky: { windMph: 20, windFromDeg: 270, gustMph: 24 },
    });
    const errors = watchConsole(page);

    await boot(page);
    await waitForZones(page);

    const facts = await readFacts(page);
    expect(facts.Sounding.value, 'the pressure levels never reached the advisory')
      .toBe('3 pressure levels');
    // A regime, and the Froude number it was read off — not 'not established'.
    expect(facts['Stability regime'].value).toMatch(/^(flow-over|flow-around|transitional|unknown) · Fr = \d/);
    expect(facts['Stability regime'].value).not.toContain('Fr = —');
    // The sensitivity row is the bound M5 was validated to, stated either way.
    expect(facts.Sensitivity.value).toMatch(/\d+% of classified cells change class/);
    expect(facts.Sensitivity.note).toContain('25%');

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('the rail and the brief name the same wind findings', async ({ context, page }) => {
    test.setTimeout(90_000);
    await stubExternals(context, { dem: RIDGE });
    const errors = watchConsole(page);

    /* A high cruise over the ridge in a modest, barely gusting wind. The
     * altitude keeps the energy findings from crowding four unrelated criticals
     * into the brief's cap, and the low gust factor keeps the planner's own
     * W-WIND- codes off the top of the list — so what reaches the brief is the
     * advisory's, which is the thing this case is about. */
    await boot(page, { altitudeMslM: 800, title: 'Ridge brief' });
    await setCustomWeather(page, { 'in-wind': 12, 'in-gust': 13, 'in-winddir': 270 });
    await waitForZones(page);

    const rail = await readRows(page, '#warnings .warn');
    const railWind = rail.filter((r) => WIND_CODES.includes(r.code ?? ''));
    expect(railWind.length, `no advisory codes on the rail: ${rail.map((r) => r.code).join(', ')}`)
      .toBeGreaterThan(0);

    await page.locator('#btn-brief').click();
    await expect(page.locator('#brief')).toBeVisible();
    const brief = await readRows(page, '#brief-sheet .brief-warn');
    expect(brief.length).toBe(Math.min(rail.length, MAX_BRIEF_WARNINGS));

    const briefWind = brief.filter((r) => WIND_CODES.includes(r.code ?? ''));
    expect(briefWind.length, `the brief printed no advisory findings from ${railWind.map((r) => r.code).join(', ')}`)
      .toBeGreaterThan(0);

    // Every wind row the brief prints is one of the rail's, in the rail's order,
    // at the rail's severity, in the producer's own words. A stable code exists
    // so two surfaces can be checked against each other; this is that check.
    const railByCode = new Map(railWind.map((r) => [r.code, r]));
    expect(briefWind.map((r) => r.code))
      .toEqual(railWind.map((r) => r.code).filter((code) => briefWind.some((r) => r.code === code)));
    for (const row of briefWind) {
      const source = railByCode.get(row.code);
      expect(source, `${row.code} is in the brief and not on the rail`).toBeTruthy();
      expect(row.severity, `${row.code} changed severity between the rail and the brief`)
        .toBe(source?.severity);
      // The rail row reads "icon severity text", the brief row "severity text";
      // neither surface edits the sentence, so it has to appear in both.
      const sentence = (source?.text ?? '').slice((source?.severity ?? '').length + 1).trim();
      expect(sentence).not.toBe('');
      expect(row.text, `${row.code} was reworded between the rail and the brief`).toContain(sentence);
    }

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
