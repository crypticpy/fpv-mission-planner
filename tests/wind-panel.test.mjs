import test from 'node:test';
import assert from 'node:assert/strict';

import { state } from '../src/state.js';
import { setWindLevels, setSounding, peakShear } from '../src/windprofile.js';
import { setupForecast, setForecast, setForecastHour } from '../src/render/forecast.js';
import { windPanelModelFrom, gustCaution } from '../src/components/wind-panel.js';

/* The wind panel's W-01 model (M11 wave A), minus its DOM. What is worth
 * asserting here: every figure is read off state the app already computes (the
 * planning env, the latched 10 m level, the forecast scrubber's own gate), the
 * outlook chips caution on the same gust share the ribbon ambers on and always
 * print the gust as a number, and the no-outlook sentence names the actual
 * reason there is none. */

// The scrubber's "now" is the wall clock, so the fixture hours are anchored to
// it: hours[0] is this instant, each next hour +1h, which pins nowIdx to 0.
const NOW = new Date();
const at = (h) => new Date(NOW.getTime() + h * 3600e3);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const hour = (h, over = {}) => ({
  time: at(h), windMph: 10, windFromDeg: 200, gustMph: 12,
  tempF: 75, rhPct: 40, precipPct: 0, levels: {}, gust10Mph: 12, sounding: [],
  ...over,
});

const hoursN = (n, over = {}) => Array.from({ length: n }, (_, h) => hour(h, over[h] || {}));

// speedLimitMs 20 puts the caution threshold at 0.45 * 20 / 0.44704 ≈ 20.1 mph
// of gust — the fixture's default 12 mph gusts sit well under it.
const plan = { speedLimitMs: 20 };

// A mutable liveError, injected once: flipping it on lets a test move the
// scrubber's selection (setForecastHour) while the gate is closed, so the
// scrubber's DOM-bound re-plan (populateControls) never runs under node.
let failing = false;
setupForecast({ update() {}, liveError: () => failing });

function seed() {
  state.weatherId = 'live';
  state.units = 'imperial';
  state.cruiseAltM = 80;
  state.env = {
    elevFt: 800, tempF: 75, rhPct: 40,
    windMph: 12, gustMph: 21, windFromDeg: 192, windMode: 'headOut',
  };
  state.detail = 'full';
  setWindLevels(null, null);
  setSounding(null);
  setForecast(null, null);
  failing = false;
}

test('gustCaution is the ribbon\'s own gust share, never a guess without a plan', () => {
  assert.equal(gustCaution(25, plan), true);   // 11.2 m/s over 20 → 0.56
  assert.equal(gustCaution(15, plan), false);  // 6.7 m/s over 20 → 0.34
  assert.equal(gustCaution(25, null), false);          // no plan, no threshold
  assert.equal(gustCaution(25, { speedLimitMs: 0 }), false);
  assert.equal(gustCaution(null, plan), false);
});

test('the hero, surface estimate, and gust tile read the planning env verbatim', () => {
  seed();
  state.weatherId = 'custom';
  const m = windPanelModelFrom({ plan });
  assert.equal(m.hero.value, '12');
  assert.equal(m.hero.unit, 'mph');
  assert.equal(m.hero.dir, 'SSW · 192°');
  assert.equal(m.hero.level, 'Flying height 80 m');
  assert.equal(m.windFromDeg, 192);
  // No latched profile: the rule-of-thumb half, labeled as an estimate.
  assert.equal(m.surface.value, '6 mph');
  assert.equal(m.surface.meta, 'estimated · about half the wind aloft');
  // 21 mph of gust is 9.4 m/s over the 20 m/s limit — over the 0.45 share.
  assert.equal(m.gust.value, '21 mph');
  assert.equal(m.gust.caution, true);
  assert.equal(windPanelModelFrom(null).gust.caution, false);
});

test('a latched 10 m level turns the surface tile into a measured reading', () => {
  seed();
  setWindLevels({ 10: { windMph: 8, windFromDeg: 200 } }, 12);
  const m = windPanelModelFrom({ plan });
  assert.equal(m.surface.value, '8 mph · SSW');
  assert.equal(m.surface.meta, 'measured at 10 m');
});

test('no outlook names the actual reason: live unanswered, custom, or preset', () => {
  seed();
  assert.match(windPanelModelFrom(null).noOutlook, /live weather hasn’t answered/);
  state.weatherId = 'custom';
  assert.match(windPanelModelFrom(null).noOutlook, /hand-entered conditions/);
  state.weatherId = 'calm';
  assert.match(windPanelModelFrom(null).noOutlook, /preset sky/);
  // A stashed forecast does not leak past the scrubber's own gate.
  setForecast({ hours: hoursN(13), days: [] }, null);
  assert.equal(windPanelModelFrom(null).outlook, null);
  state.weatherId = 'live';
  failing = true; // failed refetch: the strip hides, so the panel must too
  const m = windPanelModelFrom(null);
  assert.equal(m.outlook, null);
  assert.match(m.noOutlook, /live weather hasn’t answered/);
});

test('outlook chips are the scrubber\'s hours at the offset steps, cautions printed', () => {
  seed();
  setForecast({
    hours: hoursN(13, {
      1: { windMph: null, gustMph: null },
      2: { windMph: 14, gustMph: 25 }, // 11.2 m/s over 20 → over the share
    }),
    days: [{ date: ymd(NOW), sunset: at(5) }],
  }, null);
  const m = windPanelModelFrom({ plan });
  assert.equal(m.noOutlook, null);
  const chips = m.outlook.chips;
  assert.deepEqual(chips.map((c) => c.i), [0, 1, 2, 3, 4, 6, 9, 12]);
  assert.equal(chips[0].label, 'Now');
  assert.equal(chips[0].selected, true);
  assert.equal(chips[0].wind, '10');
  assert.equal(chips[0].caution, false);
  assert.equal(chips[0].gust, null);
  assert.equal(chips[0].sr, 'Now — 10 mph, gusting 12');
  // A model gap is an honest hole, not a zero.
  assert.equal(chips[1].wind, null);
  assert.equal(chips[1].sr.endsWith('— no wind figure'), true);
  // The cautioned hour prints its gust as a figure — never a color alone.
  assert.equal(chips[2].caution, true);
  assert.equal(chips[2].gust, 'g 25');
  // On the Now step there is no honesty banner and no re-plan readout.
  assert.equal(m.outlook.banner, null);
  assert.equal(m.outlook.readout, null);
  assert.match(m.outlook.sun, /^Sunset .+ · golden hour from .+$/);
});

test('the chip row stops at the forecast\'s edge instead of inventing hours', () => {
  seed();
  setForecast({ hours: hoursN(5), days: [] }, null);
  const m = windPanelModelFrom({ plan });
  assert.deepEqual(m.outlook.chips.map((c) => c.i), [0, 1, 2, 3, 4]);
  assert.equal(m.outlook.sun, null); // no day entry, no sun line
});

/* ---------- W-02: the altitude ladder (M11 wave B) ---------- */

test('peakShear ranks adjacent pairs by vector change, not speed alone', () => {
  // 10→80: +2 mph on a steady heading (vector 2). 80→120: a 90° turn at a
  // steady 12 mph — vector 12·√2 ≈ 17, the real shear layer despite Δspeed 0.
  const s = peakShear({
    10: { windMph: 10, windFromDeg: 180 },
    80: { windMph: 12, windFromDeg: 180 },
    120: { windMph: 12, windFromDeg: 270 },
  });
  assert.equal(s.fromM, 80);
  assert.equal(s.toM, 120);
  assert.equal(Math.round(s.vectorMph), 17);
  assert.equal(s.dSpeedMph, 0);
  assert.equal(s.veerDeg, 90);
});

test('peakShear signs the veer across north and needs two answered rungs', () => {
  const s = peakShear({
    80: { windMph: 10, windFromDeg: 10 },
    120: { windMph: 10, windFromDeg: 350 }, // backs 20°, the short way round
  });
  assert.equal(s.veerDeg, -20);
  assert.equal(peakShear({ 80: { windMph: 10, windFromDeg: 180 } }), null);
  assert.equal(peakShear(null), null);
});

test('the ladder reads the latched profile, marks the planning level, holds holes open', () => {
  seed();
  setWindLevels({
    10: { windMph: 8, windFromDeg: 190 },
    80: { windMph: 18, windFromDeg: 200, tempC: 25 },
    180: { windMph: 24, windFromDeg: 215 },
  }, 23);
  const a = windPanelModelFrom({ plan }).altitude;
  assert.equal(a.noLadder, null);
  assert.deepEqual(a.rows.map((r) => r.altM), [10, 80, 120, 180]);
  assert.equal(a.rows[1].wind, '18 mph · SSW');
  assert.equal(a.rows[1].active, true);        // cruiseAltM is 80
  assert.equal(a.rows[1].tempF, 77);           // 25 °C, in the app's °F
  assert.match(a.rows[1].sr, /planning level$/);
  assert.equal(a.rows[2].wind, null);          // 120 m never answered — a hole
  assert.match(a.rows[2].sr, /no reading/);
  assert.equal(a.canSet, true);
  assert.equal(a.hint, null);                  // on the Now step, no provenance line
  // 10→80 m is the vector peak (Δ ≈ 10.2 mph) over 80→180 m (Δ ≈ 8.1 mph).
  assert.match(a.shear, /^Biggest change 10→80 m: \+10 mph, veers 10°$/);
});

test('beginner detail shows the ladder but pins the level — rungs are facts, not controls', () => {
  seed();
  state.detail = 'beginner';
  setWindLevels({ 10: { windMph: 8, windFromDeg: 190 }, 80: { windMph: 18, windFromDeg: 200 } }, 23);
  const a = windPanelModelFrom({ plan }).altitude;
  assert.equal(a.canSet, false);
  assert.match(a.hint, /Beginner detail plans 80 m/);
});

test('no profile names the actual reason, in the same words the outlook uses', () => {
  seed();
  assert.match(windPanelModelFrom(null).altitude.noLadder, /live weather hasn’t answered/);
  state.weatherId = 'custom';
  assert.match(windPanelModelFrom(null).altitude.noLadder, /hand-entered conditions/);
  state.weatherId = 'calm';
  assert.match(windPanelModelFrom(null).altitude.noLadder, /preset sky/);
});

test('the sounding rides along as aloft rows, off the same latch M5 reads', () => {
  seed();
  setWindLevels({ 80: { windMph: 18, windFromDeg: 200 } }, 23);
  setSounding([
    { hPa: 850, windMph: 22, windFromDeg: 210, tempC: 15, heightM: 1540 },
    { hPa: 700, windMph: 30, windFromDeg: 240, tempC: 5, heightM: 3200 },
  ], { lat: 30, lng: -97 });
  const a = windPanelModelFrom({ plan }).altitude;
  assert.equal(a.sounding.length, 2);
  assert.deepEqual(a.sounding[0], { label: '850 hPa · 1.5 km', wind: '22 mph · SSW', tempF: 59 });
});

test('off the Now step the ladder describes the audited hour\'s own profile', () => {
  seed();
  setWindLevels({ 80: { windMph: 10, windFromDeg: 180 } }, 12); // today's latch
  setForecast({
    hours: hoursN(13, {
      3: {
        levels: { 80: { windMph: 25, windFromDeg: 300 }, 120: { windMph: 30, windFromDeg: 310 } },
        sounding: [{ hPa: 850, windMph: 35, windFromDeg: 320, tempC: 10, heightM: 1500 }],
      },
    }),
    days: [],
  }, null);
  failing = true;
  setForecastHour(3);
  failing = false;
  const a = windPanelModelFrom({ plan }).altitude;
  assert.equal(a.rows[1].wind, '25 mph · WNW');   // the hour's 80 m, not today's
  assert.equal(a.rows[0].wind, null);              // that hour has no 10 m reading
  assert.match(a.hint, /^Profile for /);
  assert.equal(a.sounding.length, 1);              // the hour's sounding too
  assert.match(a.shear, /^Biggest change 80→120 m: \+5 mph, veers 10°$/);
});

test('auditioning another hour raises the honesty banner and the readout', () => {
  seed();
  setForecast({ hours: hoursN(13, { 3: { windMph: 22, gustMph: 24 } }), days: [] }, null);
  failing = true;      // close the gate so the selection skips the DOM re-plan
  setForecastHour(3);
  failing = false;
  const m = windPanelModelFrom({ plan });
  assert.equal(m.outlook.chips[3].selected, true);
  assert.equal(m.outlook.chips[0].selected, false);
  assert.match(m.outlook.banner, /^Planning for .+ — forecast, not current conditions\.$/);
  assert.match(m.outlook.readout, /22 gusting 24 mph, from SSW/);
});
