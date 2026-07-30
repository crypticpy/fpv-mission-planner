// The analysis snapshot on screen (M2 exit gate).
//
// M2b made one AnalysisSnapshot the only thing the render pass draws from. The
// questions that needs answering in a real browser, against the built bundle:
//
//   * does a coded constraint reach the rail at all — code, severity and the
//     producer's own sentence — and in ADR 0008's order?
//   * does the mission brief show the *same* findings? The whole point of a
//     stable code is that two surfaces can be checked against each other; before
//     M2b the rail and the brief each sorted a loose `{ level, text }` list with
//     their own comparator and nothing stopped them drifting.
//   * and does any of it log an error?
//
// The stale-drop half of §5 is proved in tests/analysis-host.test.mjs, where the
// network can be held open mid-flight; nothing here needs to race a fetch.
//
// External hosts are stubbed exactly as in smoke.spec.js; nothing here contacts
// a tile or weather provider.

import { expect, test } from '@playwright/test';

/** A 1×1 transparent PNG, as the stand-in for every map tile. */
const BLANK_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** ADR 0008's six severities, in the order the rail must show them. */
const SEVERITY_ORDER = ['critical', 'warning', 'caution', 'unknown', 'advisory', 'low-forcing'];

/** How many warnings the brief prints before it starts holding them back. */
const MAX_BRIEF_WARNINGS = 4;

/** Stub the third-party origins the app can reach (see smoke.spec.js). */
async function stubExternals(context) {
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

/** `{ code, severity, text }` for every row of a warning list, in DOM order. */
function readRows(page, selector) {
  return page.$$eval(selector, (nodes) => nodes.map((n) => ({
    code: n.dataset.code ?? null,
    severity: n.dataset.severity ?? null,
    text: n.textContent ?? '',
  })));
}

/**
 * Push the plan somewhere it has to complain about: a 45 mph gusting wind on the
 * smallest usable reserve. Which codes come back is the model's business — that
 * there are several, at more than one severity, is what this file needs.
 */
async function makeItComplain(page) {
  await page.locator('#sel-weather').selectOption('custom');
  await page.locator('#in-wind').fill('45');
  await page.locator('#in-wind').dispatchEvent('input');
  await page.locator('#in-gust').fill('60');
  await page.locator('#in-gust').dispatchEvent('input');
  await expect(page.locator('#warnings .warn').first()).toBeAttached();
}

test.describe('coded constraints on every surface', () => {
  test('the warning rail is the snapshot: codes, severities, ADR 0008 order', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await expect(page.locator('#verdict-badge')).toHaveText(/^(GO|CAUTION|DON’T FLY)$/);

    await makeItComplain(page);
    const rows = await readRows(page, '#warnings .warn');
    expect(rows.length, 'a 45 mph wind produced no warnings at all').toBeGreaterThan(0);

    for (const row of rows) {
      // A W-* code on every row: this is what makes "this warning" a thing a
      // test, a dismissal or an export can name rather than a sentence to match.
      expect(row.code, `a warning row with no code: ${row.text}`).toMatch(/^W-[A-Z0-9-]+$/);
      expect(SEVERITY_ORDER, `unknown severity on ${row.code}`).toContain(row.severity);
      // The severity is also a class, because the colour is how a pilot reads it.
      expect(row.text.trim(), `${row.code} rendered without its sentence`).not.toBe('');
    }
    await expect(page.locator(`#warnings .warn-${rows[0].severity}`).first()).toBeAttached();

    // Worst first, in the taxonomy's own order — never mixed.
    const ranks = rows.map((r) => SEVERITY_ORDER.indexOf(r.severity));
    expect(ranks, `out of ADR 0008 order: ${rows.map((r) => r.severity).join(', ')}`)
      .toEqual([...ranks].sort((a, b) => a - b));

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('the brief prints the rail’s own findings, not a second opinion', async ({ context, page }) => {
    await stubExternals(context);
    const errors = watchConsole(page);

    await page.goto('/');
    await expect(page.locator('#verdict-badge')).toHaveText(/^(GO|CAUTION|DON’T FLY)$/);
    await makeItComplain(page);

    // The brief is opened from the map toolbar. The warning rail lives outside
    // both tab panels — it is the one thing on screen whichever tab is up — so
    // the list read here is the list the brief was built beside.
    await page.locator('#tab-map').click();
    await expect(page.locator('#map-canvas.leaflet-container')).toBeVisible();
    const rail = await readRows(page, '#warnings .warn');
    expect(rail.length, 'the map tab lost the warning rail').toBeGreaterThan(0);

    // The button opens the overlay; #brief-print is what reaches window.print(),
    // and is deliberately never clicked here.
    await page.locator('#btn-brief').click();
    await expect(page.locator('#brief')).toBeVisible();

    const brief = await readRows(page, '#brief-sheet .brief-warn');
    expect(brief.length, 'the brief printed no warnings while the rail had some').toBeGreaterThan(0);
    // The brief holds back everything past its cap, so it shows the worst N of
    // the same list — same codes, same severities, same sentences, same order.
    expect(brief.length).toBe(Math.min(rail.length, MAX_BRIEF_WARNINGS));
    expect(brief.map((r) => r.code)).toEqual(rail.slice(0, brief.length).map((r) => r.code));
    expect(brief.map((r) => r.severity)).toEqual(rail.slice(0, brief.length).map((r) => r.severity));
    for (const [i, row] of brief.entries()) {
      // The rail row is "icon severity text"; the brief row is "severity text".
      // Neither wording is edited, so the sentence has to appear in both.
      const sentence = rail[i].text.slice(rail[i].severity.length + 1).trim();
      expect(row.text, `${row.code} was reworded between the rail and the brief`).toContain(sentence);
    }

    const held = await page.locator('#brief-sheet .brief-note').allTextContents();
    if (rail.length > MAX_BRIEF_WARNINGS) {
      const n = rail.length - MAX_BRIEF_WARNINGS;
      expect(held.join(' '), 'the brief dropped warnings without saying so')
        .toContain(`${n} further note`);
    }

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
