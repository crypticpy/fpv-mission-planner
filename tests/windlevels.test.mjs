import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CRUISE_ALTS_M, CRUISE_ALT_DEFAULT_M, isCruiseAlt, levelLabel,
  windAtLevel, levelWindPatch, setWindLevels, windLevels, activeWindAt, activeLevelPatch,
  launchWind, windAtAltitude,
} from '../src/windprofile.js';
import { fetchLiveEnv, fetchArchiveEnv, shapeForecast, envAtHour } from '../src/weather.js';
import { planMission, U } from '../src/domain/physics.js';

/* Phase 4 item 9: the wind at more than one height.
 *
 * Open-Meteo returns 10, 80, 120 and 180 m in the same forecast call the app
 * already makes. Three things have to hold. The default has to be inert — 80 m
 * is what every plan in this app's history flew, so choosing nothing changes
 * nothing. The gust floor has to be re-applied per level, or planning the 180 m
 * wind would report a gust below the average it rides on. And the chosen level
 * has to reach the model, not just the label. */

const LEVELS = {
  10: { windMph: 8, windFromDeg: 170 },
  80: { windMph: 15, windFromDeg: 180 },
  120: { windMph: 19, windFromDeg: 185 },
  180: { windMph: 24, windFromDeg: 190 },
};

test.afterEach(() => setWindLevels(null, null));

/* ---------- 1. the levels themselves ---------- */

test('the levels are the ones the forecast call returns, and 80 m is the default', () => {
  assert.deepEqual(CRUISE_ALTS_M, [10, 80, 120, 180]);
  assert.equal(CRUISE_ALT_DEFAULT_M, 80);
  for (const m of CRUISE_ALTS_M) assert.equal(isCruiseAlt(m), true);
  for (const bad of [0, 50, 100, '80', null, undefined, NaN]) assert.equal(isCruiseAlt(bad), false);
  assert.equal(levelLabel(120), '120 m');
});

test('a level with no reading is a gap, not a dead calm', () => {
  assert.deepEqual(windAtLevel(LEVELS, 120), { windMph: 19, windFromDeg: 185 });
  assert.equal(windAtLevel(LEVELS, 60), null, 'a level nobody published');
  assert.equal(windAtLevel(null, 80), null);
  assert.equal(windAtLevel({ 80: { windMph: null, windFromDeg: 180 } }, 80), null);
  assert.equal(windAtLevel({ 80: { windMph: 15, windFromDeg: null } }, 80), null);
  // And a gap leaves the caller on whatever wind it already had.
  assert.equal(levelWindPatch(LEVELS, 60, 20), null);
});

test('the gust floor is re-applied to whichever level the plan flies', () => {
  // Gusts only publish at 10 m. At the surface the reading stands…
  assert.deepEqual(levelWindPatch(LEVELS, 10, 22), { windMph: 8, windFromDeg: 170, gustMph: 22 });
  // …and aloft it is a floor, never a ceiling: a 24 mph average cannot ride
  // under a 22 mph gust.
  assert.deepEqual(levelWindPatch(LEVELS, 180, 22), { windMph: 24, windFromDeg: 190, gustMph: 24 });
  assert.deepEqual(levelWindPatch(LEVELS, 80, 22), { windMph: 15, windFromDeg: 180, gustMph: 22 });
  // A missing gust is not a gust of zero below the wind either.
  assert.equal(levelWindPatch(LEVELS, 120, null).gustMph, 19);
});

test('the latched profile is fetched data, and a failed refetch clears it', () => {
  setWindLevels(LEVELS, 22);
  assert.deepEqual(windLevels(), LEVELS);
  assert.deepEqual(activeWindAt(180), { windMph: 24, windFromDeg: 190 });
  assert.equal(activeLevelPatch(180).gustMph, 24);
  setWindLevels(null, null);
  assert.equal(windLevels(), null);
  assert.equal(activeWindAt(80), null);
  assert.equal(activeLevelPatch(80), null, 'and nothing to apply to the next point');
  setWindLevels('breezy', 22);
  assert.equal(windLevels(), null, 'nor whatever else a cached payload holds');
});

test('the launch and landing wind is the 10 m one, said to be measured or not', () => {
  setWindLevels(LEVELS, 22);
  assert.deepEqual(launchWind(15), { mph: 8, measured: true });
  // Without a profile the app falls back to the rule of thumb it has always
  // printed — roughly half the wind aloft — and says which one it is.
  setWindLevels(null, null);
  assert.deepEqual(launchWind(15), { mph: 7.5, measured: false });
  // A profile with no 10 m level in it is the same case.
  setWindLevels({ 80: LEVELS[80] }, 22);
  assert.deepEqual(launchWind(15), { mph: 7.5, measured: false });
});

/* ---------- 1b. the wind between the published levels (M3b) ---------- */

/* A route that climbs over a ridge does not fly at 80 m because the forecast
 * happens to publish 80 m. windAtAltitude answers "the wind at height h" for the
 * heights in between — and it is asserted here, through windprofile.js's
 * re-export, because this module is the one that owns that question. The
 * arithmetic itself is pinned in tests/vertical-physics.test.mjs. */

test('a height between two published levels reads as a blend of them, and says so', () => {
  const mid = windAtAltitude(LEVELS, 100);
  assert.ok(mid, 'two bracketing levels is an answer');
  assert.equal(mid.basis, 'interpolated');
  assert.ok(mid.windMph > 15 && mid.windMph < 19, `${mid.windMph} mph sits between 80 m and 120 m`);
  assert.deepEqual(mid.levelsM, [80, 120], 'and names which two it came off');
});

test('a height above the top published level is clamped, not extrapolated upward', () => {
  const high = windAtAltitude(LEVELS, 400);
  assert.equal(high.basis, 'clamped');
  assert.equal(high.windMph, 24, '180 m is the highest thing anyone measured');
  assert.deepEqual(high.levelsM, [180]);
});

test('one published level is one wind at every height, and no level is no wind', () => {
  // The rule that matters most: where the forecast gives a single level there is
  // no gradient to report, so none is invented.
  const only = windAtAltitude({ 80: LEVELS[80] }, 300);
  assert.equal(only.basis, 'single-level');
  assert.equal(only.windMph, 15);
  assert.equal(windAtAltitude(null, 100), null, 'and no profile is a stated nothing');
  assert.equal(windAtAltitude({}, 100), null);
});

/* ---------- 2. one call carries the whole profile ---------- */

const apiCurrent = {
  elevation: 180,
  current: {
    temperature_2m: 88.4, relative_humidity_2m: 41, wind_gusts_10m: 21.6,
    wind_speed_10m: 8.2, wind_direction_10m: 170,
    wind_speed_80m: 14.6, wind_direction_80m: 181,
    wind_speed_120m: 19.4, wind_direction_120m: -175, // i.e. 185°
    wind_speed_180m: 23.5, wind_direction_180m: 190,
  },
  hourly: {
    time: ['2026-07-29T12:00', '2026-07-29T13:00'],
    wind_gusts_10m: [20, 30],
    temperature_2m: [88.4, 90],
    relative_humidity_2m: [40, 35],
    precipitation_probability: [0, 10],
    wind_speed_10m: [6, 7],
    wind_direction_10m: [160, 165],
    wind_speed_80m: [12, 15.6],
    wind_direction_80m: [180, 200],
    wind_speed_120m: [16, null], // a model gap at one level of one hour
    wind_direction_120m: [185, 205],
    wind_speed_180m: [21, 26],
    wind_direction_180m: [190, 210],
  },
  daily: {
    time: ['2026-07-29'],
    sunrise: ['2026-07-29T06:45'], sunset: ['2026-07-29T20:30'],
    wind_speed_10m_max: [12], wind_gusts_10m_max: [22], precipitation_probability_max: [10],
  },
};

async function withFetch(impl, run) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await run(); } finally { globalThis.fetch = prev; }
}

test('every level rides along on the forecast call the app already made', async () => {
  let url = null;
  const res = await withFetch(
    async (u) => { url = u; return { ok: true, json: async () => apiCurrent }; },
    () => fetchLiveEnv({ lat: 30.2672, lng: -97.7431 }),
  );
  // One request, carrying all four levels in both blocks.
  for (const m of CRUISE_ALTS_M) {
    assert.ok(url.includes(`wind_speed_${m}m`), `${m} m speed asked for`);
    assert.ok(url.includes(`wind_direction_${m}m`), `${m} m direction asked for`);
  }
  // The patch is still the 80 m sky: a plan that never touches the new control
  // is the plan this app has always made.
  assert.deepEqual(res.patch, {
    tempF: 88, rhPct: 41, windMph: 15, gustMph: 22, windFromDeg: 181, elevFt: 591,
  });
  assert.equal(res.gust10Mph, 22);
  assert.deepEqual(res.levels, {
    10: { windMph: 8, windFromDeg: 170 },
    80: { windMph: 15, windFromDeg: 181 },
    120: { windMph: 19, windFromDeg: 185 }, // −175° normalized onto the compass
    180: { windMph: 24, windFromDeg: 190 },
  });
});

test('a level the model had nothing for is left out rather than faked', async () => {
  const gapped = {
    ...apiCurrent,
    current: { ...apiCurrent.current, wind_speed_120m: null, wind_direction_180m: null },
  };
  const res = await withFetch(
    async () => ({ ok: true, json: async () => gapped }),
    () => fetchLiveEnv({ lat: 30, lng: -97 }),
  );
  assert.deepEqual(Object.keys(res.levels), ['10', '80']);
  // The plan can still be made — the missing level simply has nothing to select.
  assert.equal(res.patch.windMph, 15);
  assert.equal(activeLevelPatch(120), null);
});

/* ---------- 3. the scrubber reads the same profile, hour by hour ---------- */

test('each forecast hour carries its own profile and its own 10 m gust', () => {
  const { hours } = shapeForecast(apiCurrent);
  assert.equal(hours[0].windMph, 12, 'the hour itself is still the 80 m figure');
  assert.equal(hours[0].gust10Mph, 20);
  assert.deepEqual(hours[0].levels, {
    10: { windMph: 6, windFromDeg: 160 },
    80: { windMph: 12, windFromDeg: 180 },
    120: { windMph: 16, windFromDeg: 185 },
    180: { windMph: 21, windFromDeg: 190 },
  });
  // The 120 m gap in hour 2 drops out of that hour alone.
  assert.deepEqual(Object.keys(hours[1].levels), ['10', '80', '180']);
});

test('an hour read at a level is that level, and an hour read plainly is unchanged', () => {
  const fc = shapeForecast(apiCurrent);
  const when = new Date('2026-07-29T13:00');
  const plain = envAtHour(fc, when);
  assert.deepEqual(plain, { windMph: 16, windFromDeg: 200, gustMph: 30, tempF: 90, rhPct: 35 });
  // The default argument is the 80 m answer this function has always given.
  assert.deepEqual(envAtHour(fc, when, 80), plain);

  const aloft = envAtHour(fc, when, 180);
  assert.equal(aloft.windMph, 26);
  assert.equal(aloft.windFromDeg, 210);
  assert.equal(aloft.gustMph, 30, 'the 10 m gust still floors it');
  // Temperature and humidity are the hour's, whichever level the wind came from.
  assert.equal(aloft.tempF, 90);
  assert.equal(aloft.rhPct, 35);
  // The key set is exactly what every caller merges into state.env — a level
  // swaps values, it never adds a field.
  assert.deepEqual(Object.keys(aloft).sort(), Object.keys(plain).sort());

  // A gap at the asked-for level falls back to the 80 m hour rather than
  // handing back a different hour's sky.
  assert.deepEqual(envAtHour(fc, when, 120), plain);
  // The surface is a real choice too — the same hour, read at 10 m.
  const surface = envAtHour(fc, when, 10);
  assert.equal(surface.windMph, 7);
  assert.equal(surface.windFromDeg, 165);
  assert.equal(surface.gustMph, 30);
});

/* ---------- 4. the level reaches the model, not just the label ---------- */

test('the chosen level is the wind the mission is planned on', async () => {
  const { state, missionInputs, restoreSession } = await freshState(makeStorage());
  restoreSession();
  assert.equal(state.cruiseAltM, 80, 'the level every plan before this control flew');

  setWindLevels(LEVELS, 22);
  const at = (m) => {
    state.cruiseAltM = m;
    state.env = { ...state.env, ...activeLevelPatch(m) };
    const inp = missionInputs();
    return { inp, r: planMission(inp) };
  };
  const low = at(10);
  assert.equal(low.inp.env.windAvgMs.toFixed(6), U.mphToMs(8).toFixed(6));
  assert.equal(low.inp.env.windGustMs.toFixed(6), U.mphToMs(22).toFixed(6));
  assert.equal(low.inp.env.windFromDeg, 170);

  const high = at(180);
  assert.equal(high.inp.env.windAvgMs.toFixed(6), U.mphToMs(24).toFixed(6));
  assert.equal(high.inp.env.windGustMs.toFixed(6), U.mphToMs(24).toFixed(6));
  assert.equal(high.inp.env.windFromDeg, 190);
  // Three times the wind is a different mission, not a different caption.
  assert.ok(high.r.radiusKm < low.r.radiusKm);
});

/* ---------- 5. the session remembers it, tolerantly ---------- */

// The same Map-backed localStorage stub the other state tests use, and the same
// cache-busting import: `state` is a module singleton, so each case needs its
// own instance of the module to restore into.
function makeStorage(session = undefined) {
  const map = new Map();
  if (session !== undefined) map.set('fpv:v1:session', JSON.stringify(session));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}
let seq = 0;
async function freshState(storage) {
  globalThis.localStorage = storage;
  return import(`../src/state.js?windlevels=${seq++}`);
}

async function savedBlob(mutate = (s) => s) {
  const ls = makeStorage();
  const mod = await freshState(ls);
  mutate(mod.state);
  mod.saveSession();
  return JSON.parse(ls.getItem('fpv:v1:session'));
}

test('a cruise altitude survives a save/restore round trip', async () => {
  const blob = await savedBlob((s) => { s.cruiseAltM = 180; });
  assert.equal(blob.cruiseAltM, 180);
  const mod = await freshState(makeStorage(blob));
  assert.equal(mod.state.cruiseAltM, 80, 'a fresh boot flies the default');
  assert.equal(mod.restoreSession(), '2d');
  assert.equal(mod.state.cruiseAltM, 180);
});

test('a session written before the cruise-altitude control existed restores unharmed', async () => {
  const blob = await savedBlob();
  delete blob.cruiseAltM;
  const mod = await freshState(makeStorage(blob));
  assert.equal(mod.restoreSession(), '2d', 'a missing knob must not void the loadout');
  assert.equal(mod.state.cruiseAltM, 80);
});

test('an altitude the control could never show voids the blob', async () => {
  for (const bad of [0, 100, 500, '80', null, true]) {
    const blob = await savedBlob((s) => { s.cruiseAltM = 120; });
    blob.cruiseAltM = bad;
    const mod = await freshState(makeStorage(blob));
    assert.equal(mod.restoreSession(), null, `${bad} should void the whole blob`);
    assert.equal(mod.state.cruiseAltM, 80, 'and leave the default alone');
  }
});

/* ---------- 6. provenance and cancellation (ADR 0012 §1, §3) ---------- */

/* Neither fetch used to say where its numbers came from or how old they were —
 * a preset environment and a freshly-fetched one looked identical once merged
 * into state.env. provenance is the fix: every caller downstream (starting
 * with the forecast-age constraints in analysis-pipeline) can now tell the
 * two apart, and a caller passing a signal can cut either request loose. */

test('fetchLiveEnv stamps who it asked and when the response landed', async () => {
  const before = Date.now();
  const res = await withFetch(
    async () => ({ ok: true, json: async () => apiCurrent }),
    () => fetchLiveEnv({ lat: 30.2672, lng: -97.7431 }),
  );
  assert.equal(res.provenance.source, 'open-meteo-forecast');
  assert.ok(Date.parse(res.provenance.retrievedAt) >= before, 'retrievedAt is a fresh instant');
  // apiCurrent's `current` block carries no `time` field of its own — a forecast
  // hour is never guessed when Open-Meteo did not say which one "current" was.
  assert.equal(res.provenance.validAt, null);
});

test('fetchLiveEnv reads validAt off current.time when Open-Meteo publishes one', async () => {
  const withTime = { ...apiCurrent, current: { ...apiCurrent.current, time: '2026-07-29T12:00' } };
  const res = await withFetch(
    async () => ({ ok: true, json: async () => withTime }),
    () => fetchLiveEnv({ lat: 30.2672, lng: -97.7431 }),
  );
  assert.equal(res.provenance.validAt, '2026-07-29T12:00');
});

test('fetchLiveEnv passes its signal straight through to fetch', async () => {
  let seenSignal;
  const controller = new AbortController();
  await withFetch(
    async (url, opts) => { seenSignal = opts?.signal; return { ok: true, json: async () => apiCurrent }; },
    () => fetchLiveEnv({ lat: 30.2672, lng: -97.7431 }, { signal: controller.signal }),
  );
  assert.equal(seenSignal, controller.signal);
});

const archiveFixture = {
  elevation: 175,
  hourly: {
    time: ['2026-07-29T00:00', '2026-07-29T01:00'],
    wind_speed_100m: [12, 14],
    wind_direction_100m: [180, 190],
    temperature_2m: [70, 71],
    relative_humidity_2m: [55, 50],
  },
};

test('fetchArchiveEnv stamps the archive source and the reanalysis hour it actually matched', async () => {
  const before = Date.now();
  const res = await withFetch(
    async () => ({ ok: true, json: async () => archiveFixture }),
    () => fetchArchiveEnv({ lat: 30.2672, lng: -97.7431 }, '2026-07-29T01:15'),
  );
  assert.equal(res.provenance.source, 'open-meteo-archive');
  assert.ok(Date.parse(res.provenance.retrievedAt) >= before);
  // validAt names the archive's own hour, not the requested one — a reanalysis
  // hour a day old is the whole point of this endpoint, never padded to look fresh.
  assert.equal(res.provenance.validAt, '2026-07-29T01:00');
});

test('fetchArchiveEnv passes its signal straight through to fetch', async () => {
  let seenSignal;
  const controller = new AbortController();
  await withFetch(
    async (url, opts) => { seenSignal = opts?.signal; return { ok: true, json: async () => archiveFixture }; },
    () => fetchArchiveEnv({ lat: 30.2672, lng: -97.7431 }, '2026-07-29T01:15', { signal: controller.signal }),
  );
  assert.equal(seenSignal, controller.signal);
});
