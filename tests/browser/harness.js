// harness.js — what the M4 exit-gate specs share, and nothing else.
//
// Not a spec: the name carries no `.spec.`, so Playwright's testMatch never
// collects it. It is imported by route-parity, terrain-fixtures,
// view-screenshots and perf-budgets.
//
// The three older browser specs each carry their own copy of `stubExternals` and
// `watchConsole`, and that was the right call while a copy was six lines. The
// M4 gate needs a synthetic *DEM tile server* as well — terrarium encoding, tile
// arithmetic, a per-run cache — and four copies of that is a fixture with four
// slightly different opinions about what a ridge is. So the tile stubs, the
// mission seeding and the pixel arithmetic live here once.
//
// Two reuse decisions worth naming:
//
//   *The PNG codec is the spike's* (`spike/occlusion/png.mjs`) — encoder for the
//     DEM tiles served to MapLibre, decoder for the screenshots probed
//     afterwards. Committed, tested by the spike, and the alternative was a
//     second hand-rolled deflate.
//
//   *The surfaces are the unit suite's* (`tests/fixtures/synthetic-dem.mjs`)
//     rather than the spike's own. That module's header asks for exactly one
//     definition of each surface in the repository, and M3's terrain tests
//     already build their ridge and valley from it. The spike's `SURFACES` are
//     shaped for the spike's fixed camera; these are shaped for the analysis,
//     which is what this gate is about.

import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';

import { expect } from '@playwright/test';

import { decode, encodeRGB, pixelAt } from '../../spike/occlusion/png.mjs';

/** A 1×1 transparent PNG, as the stand-in for every map tile (smoke.spec.js's). */
export const BLANK_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** The localStorage key the launch point and the map view live in. */
export const MAP_KEY = 'fpv:v1:map';

/** Longer than the bridge's autosave debounce, with room for the IndexedDB write. */
export const SAVE_SETTLE_MS = 600;

/* ---------- the world outside the tab ---------- */

/**
 * The sky the forecast endpoint answers with. Every figure is in the units the
 * app asks that endpoint for — °F and mph — because that is what the request
 * says (`temperature_unit=fahrenheit&wind_speed_unit=mph`) and a stub that
 * answered in SI would be testing a conversion the real provider never makes.
 *
 * @typedef {object} Sky
 * @property {number} windMph      the sustained wind, published at every height
 * @property {number} windFromDeg
 * @property {number} gustMph      10 m gusts; the only height that publishes any
 * @property {number} tempF
 * @property {number} rhPct
 * @property {number} elevationM   what the provider says the ground is here
 */

/** @type {Sky} */
const DEFAULT_SKY = Object.freeze({
  windMph: 12, windFromDeg: 270, gustMph: 18, tempF: 68, rhPct: 45, elevationM: 150,
});

/**
 * The pressure-level sounding the forecast answers with, lowest first.
 *
 * A stable troposphere on a standard-ish day: ~5 °C at 850 hPa falling to
 * ~−5 °C at 700 hPa over 1500 m of geopotential. That gradient is what
 * `computeRegime` reads N out of, and this one is deliberately ordinary — the
 * browser gate is asking whether a sounding *parses and reaches the regime at
 * all*, which is a question about wiring, not about a particular Froude number.
 * Temperatures are °F for the reason the typedef above gives; the direction
 * rides on the sky's own, so a reversed wind reverses the whole column.
 */
const SOUNDING = Object.freeze([
  Object.freeze({ hPa: 850, windMph: 25, tempF: 41, heightM: 1500 }),
  Object.freeze({ hPa: 700, windMph: 30, tempF: 23, heightM: 3000 }),
  Object.freeze({ hPa: 500, windMph: 40, tempF: -4, heightM: 5600 }),
]);

/** The heights src/weather.js asks for wind at, and the subset it asks temperature at. */
const LEVELS_M = [10, 80, 120, 180];
const TEMP_LEVELS_M = [80, 120, 180];

/** Hours in the stubbed forecast, and days in its daily block. */
const FORECAST_HOURS = 24;
const FORECAST_DAYS = 3;

/**
 * Stub the third-party origins the app can reach (see smoke.spec.js).
 *
 * Fulfilled rather than aborted, always: an aborted request is itself a console
 * error, and every spec here ends by insisting the console was clean.
 *
 * `/v1/elevation` is the ground — one sample per point, from `dem` when a spec
 * brought a surface and a single flat figure otherwise.
 *
 * `/v1/forecast` is the sky, and it answers only when a spec asked for one.
 * That opt-in is deliberate rather than shy: the app fetches live weather on
 * boot (src/app.js), so a stub that always answered would change the wind,
 * temperature and launch elevation under every spec written before this one —
 * eighteen of them, four of which compare screenshots. Absent `sky`, the
 * forecast keeps the empty-but-well-formed payload it has always returned,
 * which the app reports as a failed live fetch and carries on from its defaults.
 * With `sky`, it answers in the full shape src/weather.js parses: the wind at
 * every published height, the temperatures beside them, and the 850/700/500 hPa
 * sounding M5's regime baseline is read off.
 *
 * Everything else — the ERA5 archive — keeps the empty payload either way.
 *
 * The returned handle is how a spec changes the sky between two fetches: the
 * app asks for live weather again, and the second answer is the new one. It is
 * inert when no sky was asked for.
 *
 * @param {import('@playwright/test').BrowserContext} context
 * @param {{ elevationM?: number, dem?: ((lat: number, lng: number) => number|null)|null,
 *           sky?: Partial<Sky>|null }} [opts]
 * @returns {Promise<{ setSky: (patch: Partial<Sky>) => void }>}
 */
export async function stubExternals(context, { elevationM = 150, dem = null, sky = null } = {}) {
  await context.route(/(^|\/\/|\.)((server\.)?arcgisonline\.com|tile\.openstreetmap\.org)/, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_TILE }));

  /** @type {Sky} */
  const live = { ...DEFAULT_SKY, elevationM, ...(sky ?? {}) };

  await context.route(/open-meteo\.com/, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/elevation')) {
      const lats = numberList(url.searchParams.get('latitude'));
      const lngs = numberList(url.searchParams.get('longitude'));
      // One answer per point asked for, in the order asked — the port's whole
      // promise (src/infrastructure/elevation/open-meteo-elevation.js). A DEM
      // that has nothing for a point answers null, which is the wire form of
      // "no reading" and is what the grid draws as missing.
      const elevation = lats.map((lat, i) => (dem
        ? dem(lat, lngs[i] ?? 0)
        : live.elevationM));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ elevation }),
      });
    }
    if (sky && url.pathname.includes('/v1/forecast')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(forecastPayload(live)),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  return { setSky: (patch) => { Object.assign(live, patch); } };
}

/** `"1.5,2.5"` as numbers, and an absent parameter as no points at all. */
function numberList(raw) {
  return (raw ?? '').split(',').filter((s) => s !== '').map(Number);
}

/**
 * One Open-Meteo `/v1/forecast` response for `sky`.
 *
 * Shaped from the request src/weather.js actually builds rather than from the
 * provider's documentation at large: `current`, `hourly` and `daily` carry
 * exactly the variables that URL names, so a field added to the client without
 * being added here shows up as the client's own "malformed response" rather
 * than as a silent null.
 *
 * The hours run from local midnight today, in the offset-less wall-clock form
 * `timezone=auto` returns — the frame shapeForecast() documents, and the frame
 * the scrubber compares against. Every hour is the same weather: this stub
 * answers "what does the app do with a sky", not "what does a day look like".
 *
 * @param {Sky} sky
 * @returns {Record<string, unknown>}
 */
export function forecastPayload(sky) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const times = Array.from({ length: FORECAST_HOURS }, (_, i) =>
    wallClock(new Date(midnight.getTime() + i * 3_600_000)));
  const hours = (/** @type {number} */ v) => new Array(FORECAST_HOURS).fill(v);

  /** @type {Record<string, unknown>} */
  const current = {
    temperature_2m: sky.tempF,
    relative_humidity_2m: sky.rhPct,
    wind_gusts_10m: sky.gustMph,
  };
  /** @type {Record<string, unknown>} */
  const hourly = {
    time: times,
    temperature_2m: hours(sky.tempF),
    relative_humidity_2m: hours(sky.rhPct),
    precipitation_probability: hours(10),
    wind_gusts_10m: hours(sky.gustMph),
  };

  for (const m of LEVELS_M) {
    current[`wind_speed_${m}m`] = sky.windMph;
    current[`wind_direction_${m}m`] = sky.windFromDeg;
    hourly[`wind_speed_${m}m`] = hours(sky.windMph);
    hourly[`wind_direction_${m}m`] = hours(sky.windFromDeg);
  }
  for (const m of TEMP_LEVELS_M) {
    current[`temperature_${m}m`] = sky.tempF;
    hourly[`temperature_${m}m`] = hours(sky.tempF);
  }
  for (const level of SOUNDING) {
    current[`wind_speed_${level.hPa}hPa`] = level.windMph;
    current[`wind_direction_${level.hPa}hPa`] = sky.windFromDeg;
    current[`temperature_${level.hPa}hPa`] = level.tempF;
    current[`geopotential_height_${level.hPa}hPa`] = level.heightM;
    hourly[`wind_speed_${level.hPa}hPa`] = hours(level.windMph);
    hourly[`wind_direction_${level.hPa}hPa`] = hours(sky.windFromDeg);
    hourly[`temperature_${level.hPa}hPa`] = hours(level.tempF);
    hourly[`geopotential_height_${level.hPa}hPa`] = hours(level.heightM);
  }

  const days = Array.from({ length: FORECAST_DAYS }, (_, i) =>
    new Date(midnight.getTime() + i * 86_400_000));
  return {
    elevation: sky.elevationM,
    current,
    hourly,
    daily: {
      time: days.map((d) => wallClock(d).slice(0, 10)),
      sunrise: days.map((d) => wallClock(new Date(d.getTime() + 6.5 * 3_600_000))),
      sunset: days.map((d) => wallClock(new Date(d.getTime() + 20 * 3_600_000))),
      wind_speed_10m_max: days.map(() => sky.windMph),
      wind_gusts_10m_max: days.map(() => sky.gustMph),
      precipitation_probability_max: days.map(() => 10),
    },
  };
}

/** `YYYY-MM-DDTHH:mm` in the runtime's own zone — what `timezone=auto` returns. */
function wallClock(date) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Imagery for the 3D scene: one flat colour, so the only thing that can change
 * between two screenshots of the same view is the geometry drawn over it.
 * @param {import('@playwright/test').BrowserContext} context
 * @param {number} [grey]
 */
export async function stubImagery(context, grey = 96) {
  const tile = Buffer.from(encodeRGB(256, 256, new Uint8Array(256 * 256 * 3).fill(grey)));
  await context.route(/(^|\/\/|\.)((server\.)?arcgisonline\.com|tile\.openstreetmap\.org)/, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: tile }));
}

/**
 * A 256×256 terrarium DEM tile of `dem`, rendered from the tile's own Web
 * Mercator footprint.
 *
 * Terrarium packs elevation as `R*256 + G + B/256 - 32768` — the encoding
 * scene.js declares on its `raster-dem` source — and a tile MapLibre cannot
 * decode becomes a hole in the mesh rather than an error, which reads exactly
 * like "the route is visible here". So this generates real elevations for real
 * coordinates rather than a placeholder.
 *
 * @param {(lat: number, lng: number) => number|null} dem
 * @param {number} z @param {number} x @param {number} y
 * @param {number} [size]
 * @returns {Buffer}
 */
export function terrariumTile(dem, z, x, y, size = 256) {
  const n = 2 ** z;
  const rgb = new Uint8Array(size * size * 3);
  for (let py = 0; py < size; py++) {
    const t = Math.PI - 2 * Math.PI * ((y + py / size) / n);
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));
    for (let px = 0; px < size; px++) {
      const lng = ((x + px / size) / n) * 360 - 180;
      const v = Math.min(65535.99, Math.max(0, (dem(lat, lng) ?? 0) + 32768));
      const whole = Math.floor(v);
      const i = (py * size + px) * 3;
      rgb[i] = Math.floor(whole / 256);
      rgb[i + 1] = whole % 256;
      rgb[i + 2] = Math.floor((v - whole) * 256);
    }
  }
  return Buffer.from(encodeRGB(size, size, rgb));
}

/**
 * Serve the whole AWS terrain pyramid from `dem`. Memoised per run: MapLibre
 * asks for the same tile again on every re-terrain, and each one is 65k DEM
 * samples.
 * @param {import('@playwright/test').BrowserContext} context
 * @param {(lat: number, lng: number) => number|null} dem
 */
export async function stubTerrain(context, dem) {
  /** @type {Map<string, Buffer>} */
  const cache = new Map();
  await context.route(/elevation-tiles-prod/, (route) => {
    const m = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(new URL(route.request().url()).pathname);
    // Every URL scene.js builds matches; anything else is a bug in the test, and
    // a flat tile keeps it from being reported as a decode failure instead.
    const [z, x, y] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
    const key = `${z}/${x}/${y}`;
    let body = cache.get(key);
    if (!body) { body = terrariumTile(dem, z, x, y); cache.set(key, body); }
    return route.fulfill({ status: 200, contentType: 'image/png', body });
  });
}

/** Console errors and uncaught page errors, for later assertion. */
export function watchConsole(page) {
  /** @type {string[]} */
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

/**
 * Pin the theme before the app boots.
 *
 * The default is `auto`, which resolves off `prefers-color-scheme` — and
 * Playwright's default is light, so an unpinned run draws the route in Sun
 * Glare's palette rather than Night Ops'. Every colour probe below reads the
 * live custom property rather than a literal, but the *screenshots* want one
 * answer per view class, and so does a reader comparing two runs.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} [theme]
 */
export async function seedTheme(page, theme = 'night-ops') {
  await page.addInitScript(([key, value]) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  }, ['fpv:v1:theme', theme]);
}

/* ---------- seeding a mission the app will actually open ---------- */

let seq = 0;

/**
 * A valid MissionDocumentV1 with every leg at an explicit MSL altitude.
 *
 * Explicit MSL is the point: `resolveAltitude` passes an `msl` reference through
 * untouched (ADR 0003), so the height the 3D scene draws each leg at is the
 * number in this file and not a terrain reading — which is what makes "did it
 * render above the right ground" a question with a known answer.
 *
 * The three loadout snapshots are deliberately null. They are completeness
 * warnings, never errors, and the analysis takes its aircraft from the rail;
 * hand-authoring three snapshots here would only add three ways for this fixture
 * to disagree with the app's own defaults.
 *
 * @param {object} spec
 * @param {{ lat: number, lng: number }} spec.launch
 * @param {{ lat: number, lng: number }[]} spec.waypoints
 * @param {number} spec.altitudeMslM
 * @param {string} [spec.title]
 * @param {string} [spec.tag]  fixes the waypoint and segment ids across re-imports
 * @param {number|null} [spec.launchElevationMslM]
 * @param {'direct'|'retrace'|'none'} [spec.returnMode]
 */
export function missionDoc({
  launch, waypoints, altitudeMslM, title = 'Gate fixture', tag = null,
  launchElevationMslM = null, returnMode = 'direct',
}) {
  const at = '2026-01-01T00:00:00.000Z';
  const unique = `${Date.now().toString(36)}${(seq++).toString(36)}`;
  /* The mission id is always fresh — the repository re-identifies a colliding
   * import, and a spec that re-imported its fixture would otherwise be asserting
   * against a document the app renamed behind it. The node ids are the caller's
   * to fix, because re-importing the same route and expecting the same segment
   * to open is exactly what the parity suite is for. */
  const node = tag ?? unique;
  return {
    schemaVersion: 1,
    id: `msn_${unique}`,
    title,
    createdAt: at,
    updatedAt: at,
    launch: {
      latitude: launch.lat,
      longitude: launch.lng,
      elevationMslM: launchElevationMslM,
    },
    aircraftSnapshot: null,
    batterySnapshot: null,
    payloadSnapshot: null,
    environmentReference: {
      source: 'manual', presetId: null, capturedAt: null, values: null, provenance: null,
    },
    route: {
      waypoints: waypoints.map((w, i) => ({
        id: `wpt_${node}_${i}`, latitude: w.lat, longitude: w.lng,
      })),
      segments: waypoints.map((_, i) => ({
        id: `seg_${node}_${i}`,
        from: i === 0 ? 'launch' : `wpt_${node}_${i - 1}`,
        to: `wpt_${node}_${i}`,
        intent: 'transit',
        altitude: { authored: altitudeMslM, reference: 'msl', resolvedMslM: altitudeMslM },
        speedPolicy: { mode: 'cruise', targetMs: null },
        holdS: null,
        subjectRef: null,
        camera: null,
        overrides: null,
      })),
      returnPolicy: { mode: returnMode, altitude: null },
    },
    planningPolicy: {
      reserve: { landFloorPct: 20 }, gustFactor: 0.35, windLevel: 80, radioBand: '5g8',
    },
    scene: { subjects: [], cameraProfile: null },
    provenance: {
      createdBy: 'fpv-planner', appVersion: null, origin: 'authored',
      sourceFormat: null, notes: null,
    },
  };
}

/**
 * Open a mission through the app's own import path — the file picker in the
 * mission fold — rather than by writing IndexedDB behind its back. The document
 * therefore goes through `validateMission`, the repository, altitude resolution
 * and `launchRestored` exactly as a pilot's own export would.
 *
 * @param {import('@playwright/test').Page} page
 * @param {ReturnType<typeof missionDoc>} doc
 */
export async function importMissionFile(page, doc) {
  /* Below 900 px the rail is not on the page at all — it becomes a sheet behind
   * the dock's Loadout button (style.css `@media (max-width: 900px)`), and the
   * mission fold goes with it. Opened by the same control a pilot on a tablet
   * would press, so narrow view classes seed their fixture the same way wide
   * ones do rather than through a back door only tests know about. */
  const fold = page.locator('#mission-fold');
  if (!await fold.isVisible()) {
    const loadout = page.locator('#dock-loadout');
    if (await loadout.isVisible()) {
      await loadout.click();
      await expect(fold).toBeVisible();
    }
  }
  if (!await fold.evaluate((el) => el.open)) await fold.locator('summary').click();
  await page.locator('#mission-file').setInputFiles({
    name: `${doc.id}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await expect(page.locator('#mission-note')).toContainText(doc.title);
  await expect(page.locator('#route-rows tr'))
    .toHaveCount(doc.route.waypoints.length + 2);
}

/**
 * Press the 3D toggle and wait out the whole init handshake.
 *
 * `aria-pressed` flips only after `scene.ready` resolves, and that resolves
 * inside `map.once('idle')` *following* `setTerrain` — ADR 0004's ordering. One
 * attribute, and it proves the chunk arrived, MapLibre booted, the DEM loaded
 * and the deck overlay went on against a settled view.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function activate3d(page) {
  const toggle = page.locator('#btn-3d');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true', { timeout: 45_000 });
  await expect(page.locator('#map-3d canvas.maplibregl-canvas')).toBeVisible();
}

/**
 * The point on the 2D map furthest from anything that would take the click:
 * every pin, every invisible hit line, and every Leaflet control. The drawn
 * route and the footprint rings are `interactive: false` in leaflet-adapter.js,
 * so they are not in the way and are not asked about.
 *
 * Returned in canvas coordinates, ready for `locator.click({ position })`.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ x: number, y: number }>}
 */
export async function emptyPoint2d(page) {
  const canvas = /** @type {NonNullable<Awaited<ReturnType<typeof page.locator>['boundingBox']>>} */
    (await page.locator('#map-canvas').boundingBox());
  /** @type {{ x: number, y: number, width: number, height: number }[]} */
  const taken = [];
  for (const selector of ['.route-marker', '.launch-marker', 'path.route-hit', '.leaflet-control']) {
    for (const el of await page.locator(`#map-canvas ${selector}`).all()) {
      const box = await el.boundingBox();
      if (box) taken.push({ ...box, x: box.x - canvas.x, y: box.y - canvas.y });
    }
  }
  const gap = (/** @type {typeof taken[0]} */ r, /** @type {number} */ x, /** @type {number} */ y) =>
    Math.hypot(Math.max(r.x - x, 0, x - (r.x + r.width)), Math.max(r.y - y, 0, y - (r.y + r.height)));

  let best = null;
  for (let y = 24; y < canvas.height - 24; y += 8) {
    for (let x = 24; x < canvas.width - 24; x += 8) {
      const clearance = Math.min(...taken.map((r) => gap(r, x, y)));
      if (!best || clearance > best.clearance) best = { x, y, clearance };
    }
  }
  if (!best || best.clearance < 30) throw new Error('no clear ground anywhere on the 2D map');
  return { x: best.x, y: best.y };
}

/**
 * Record measured numbers with the run, as a file rather than as bytes.
 *
 * The repo's reporter is `list`, which materialises no attachment *bodies* — so
 * data handed over as a buffer exists only for as long as the process. Written
 * through `outputPath` it lands in test-results/<test>/, which is gitignored,
 * survives the run and is what CI uploads.
 *
 * @param {import('@playwright/test').TestInfo} info
 * @param {string} name  file name, `.json` included
 * @param {unknown} data
 */
export async function attachJson(info, name, data) {
  const file = info.outputPath(name);
  await writeFile(file, JSON.stringify(data, null, 2));
  await info.attach(name, { contentType: 'application/json', path: file });
}

/* ---------- reading the picture back ---------- */

/**
 * A palette entry as the page resolves it, in canonical `rgb()` form.
 *
 * Read from the live document rather than pasted as a literal: the scene reads
 * the same custom properties (scene-layers.js `readPalette`), so a theme edit
 * moves the probe and the drawing together instead of silently parting them.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string[]} names
 * @returns {Promise<[number, number, number][]>}
 */
export async function cssColors(page, names) {
  const resolved = await page.evaluate((props) => props.map((name) => {
    const probe = document.createElement('span');
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }), names);
  return resolved.map((value) => {
    const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(value);
    if (!m) throw new Error(`unreadable colour: ${value}`);
    return /** @type {[number, number, number]} */ ([Number(m[1]), Number(m[2]), Number(m[3])]);
  });
}

/**
 * Is this pixel one of `colors`, allowing for the antialiased edge?
 *
 * A tolerance rather than an equality because the line is drawn with coverage
 * antialiasing over a flat grey, so its own colour appears at full strength only
 * in the core of the stroke. 40 per channel keeps a half-blend with the grey
 * imagery out (`#ff784f` over `rgb(96,96,96)` is 80 away in red) and keeps the
 * core in.
 *
 * @param {[number, number, number][]} colors
 * @param {number} r @param {number} g @param {number} b
 * @param {number} [tolerance]
 */
export function matchesAny(colors, r, g, b, tolerance = 40) {
  for (const [cr, cg, cb] of colors) {
    if (Math.abs(r - cr) <= tolerance
      && Math.abs(g - cg) <= tolerance
      && Math.abs(b - cb) <= tolerance) return true;
  }
  return false;
}

/**
 * Count the pixels of `image` that match `colors`, and note the columns they
 * fall in.
 *
 * The column histogram is what makes "where" answerable without reproducing
 * MapLibre's projection in the test: the fixtures below are symmetric about the
 * screen's own centre line, so a *fraction along the drawn route's own screen
 * footprint* is a position on the ground, and the footprint is measured from the
 * frame in which the whole route is visible.
 *
 * @param {ReturnType<typeof decode>} image
 * @param {[number, number, number][]} colors
 * @returns {{ total: number, columns: number[] }}
 */
export function colorScan(image, colors) {
  const columns = new Array(image.width).fill(0);
  let total = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const [r, g, b] = pixelAt(image, x, y);
      if (!matchesAny(colors, r, g, b)) continue;
      columns[x] += 1;
      total += 1;
    }
  }
  return { total, columns };
}

/**
 * Sum a fractional column band of a scan, measured against the extent `extent`
 * — normally the extent of the frame where everything is visible.
 * @param {number[]} columns
 * @param {{ first: number, last: number }} extent
 * @param {number} from  0..1
 * @param {number} to    0..1
 */
export function bandTotal(columns, extent, from, to) {
  const width = extent.last - extent.first;
  const a = Math.round(extent.first + width * from);
  const b = Math.round(extent.first + width * to);
  let sum = 0;
  for (let x = a; x <= b; x++) sum += columns[x] ?? 0;
  return sum;
}

/**
 * Screenshot the canvas until two consecutive frames agree, then hand back the
 * second one.
 *
 * There is no "the scene is drawn" event to await. Under reduced motion the
 * camera jump is instant, but a new view asks for DEM tiles it has not seen and
 * the scene re-renders 150 ms after each one lands — so "the frame after the
 * click" is not the frame that answers the question. Two identical counts is the
 * cheapest honest definition of settled, and it is the same definition whether
 * the caller is counting route pixels or looking for a pin.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} canvas
 * @param {[number, number, number][]} colors
 * @param {{ settleMs?: number, gapMs?: number, tries?: number }} [opts]
 * @returns {Promise<{ image: ReturnType<typeof decode>, scan: { total: number, columns: number[] } }>}
 */
export async function settledScan(page, canvas, colors, opts = {}) {
  const { settleMs = 1200, gapMs = 400, tries = 24 } = opts;
  await page.waitForTimeout(settleMs);
  let previous = null;
  for (let i = 0; i < tries; i++) {
    const image = decode(await canvas.screenshot());
    const scan = colorScan(image, colors);
    if (previous != null && scan.total === previous) return { image, scan };
    previous = scan.total;
    await page.waitForTimeout(gapMs);
  }
  throw new Error('the 3D scene never settled');
}

/** The first and last column carrying any matching pixel. @param {number[]} columns */
export function columnExtent(columns) {
  const first = columns.findIndex((n) => n > 0);
  let last = -1;
  for (let x = columns.length - 1; x >= 0; x--) { if (columns[x] > 0) { last = x; break; } }
  return { first, last };
}

/** Decode a PNG buffer (a screenshot, or one of the tiles above). */
export { decode, pixelAt };
