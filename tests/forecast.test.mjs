import test from 'node:test';
import assert from 'node:assert/strict';

import { shapeForecast, envAtHour, goldenHour, nearestHourIndex } from '../src/weather.js';
import { U } from '../src/domain/physics.js';

// Small hand-built Open-Meteo-shaped fixture, in the already-imperial units
// the real request asks for (temperature_unit=fahrenheit, wind_speed_unit=mph).
const apiFixture = {
  hourly: {
    time: [
      '2026-07-29T12:00',
      '2026-07-29T13:00',
      '2026-07-29T14:00',
    ],
    wind_speed_80m: [10, 15.6, null],
    wind_direction_80m: [90, 200, 10],
    wind_gusts_10m: [5, 20.4, 8],
    temperature_2m: [88.4, 90, null],
    relative_humidity_2m: [40, 35, 38],
    precipitation_probability: [0, 10, null],
    // M5 wave 2: height-level temperature and the pressure-level sounding.
    // Row 0 is fully populated at every level. Row 1 drops the 850 hPa
    // temperature alone, so that whole level is omitted while 700/500 survive.
    // Row 2 has no pressure data at all, the "no usable level" case.
    // 120 m/180 m wind is added here too (the pre-existing fixture only ever
    // carried 80 m wind) so that levels[120]/levels[180] exist to hang a
    // tempC assertion off of, the same way levels[80] already does.
    wind_speed_120m: [12, 16, null],
    wind_direction_120m: [95, 205, null],
    wind_speed_180m: [14, 18, null],
    wind_direction_180m: [100, 210, null],
    temperature_80m: [80.6, 78.8, null],
    temperature_120m: [79.0, 77.2, null],
    temperature_180m: [76.5, 75.0, null],
    wind_speed_850hPa: [10, 12, null],
    wind_direction_850hPa: [180, 190, null],
    temperature_850hPa: [72.0, null, null],
    geopotential_height_850hPa: [1540, 1550, null],
    wind_speed_700hPa: [5, 6, null],
    wind_direction_700hPa: [100, 110, null],
    temperature_700hPa: [55, 54, null],
    geopotential_height_700hPa: [3200, 3210, null],
    wind_speed_500hPa: [9, 10, null],
    wind_direction_500hPa: [80, 85, null],
    temperature_500hPa: [26, 25, null],
    geopotential_height_500hPa: [5950, 5960, null],
  },
  daily: {
    time: ['2026-07-29', '2026-07-30'],
    sunrise: ['2026-07-29T06:45', '2026-07-30T06:46'],
    sunset: ['2026-07-29T20:30', '2026-07-30T20:29'],
    wind_speed_10m_max: [12, null],
    wind_gusts_10m_max: [22, 18],
    precipitation_probability_max: [10, null],
  },
};

test('shapeForecast converts hourly rows into the imperial-canonical shape', () => {
  const { hours } = shapeForecast(apiFixture);
  assert.equal(hours.length, 3);
  assert.equal(hours[0].windMph, 10);
  assert.equal(hours[0].windFromDeg, 90);
  // gust floor: max(5, 10) = 10, not the raw 5 mph gust reading.
  assert.equal(hours[0].gustMph, 10);
  assert.equal(hours[0].tempF, 88);
  assert.equal(hours[0].rhPct, 40);
  assert.equal(hours[0].precipPct, 0);
  assert.ok(hours[0].time instanceof Date);

  // Known-value unit/rounding check on a non-trivial row.
  assert.equal(hours[1].windMph, 16); // 15.6 rounds to 16
  assert.equal(hours[1].gustMph, 20); // max(20.4, 15.6) rounds to 20
});

test('shapeForecast maps null API fields to null instead of fabricating zeros', () => {
  const { hours } = shapeForecast(apiFixture);
  assert.equal(hours[2].windMph, null);
  assert.equal(hours[2].tempF, null);
  assert.equal(hours[2].precipPct, null);
  // gust floor: sustained wind missing, gust present -> falls back to the gust.
  assert.equal(hours[2].gustMph, 8);
});

test('shapeForecast converts daily rows and applies the same gust floor', () => {
  const { days } = shapeForecast(apiFixture);
  assert.equal(days.length, 2);
  assert.equal(days[0].date, '2026-07-29');
  assert.deepEqual(days[0].sunrise, new Date('2026-07-29T06:45'));
  assert.deepEqual(days[0].sunset, new Date('2026-07-29T20:30'));
  assert.equal(days[0].windMaxMph, 12);
  assert.equal(days[0].gustMaxMph, 22); // max(22, 12)
  assert.equal(days[0].precipMaxPct, 10);

  // Day 2: wind max missing, gust max present -> gust wins the floor.
  assert.equal(days[1].windMaxMph, null);
  assert.equal(days[1].gustMaxMph, 18);
  assert.equal(days[1].precipMaxPct, null);
});

test('shapeForecast tolerates a missing hourly/daily block entirely', () => {
  assert.deepEqual(shapeForecast({}), { hours: [], days: [] });
  assert.deepEqual(shapeForecast(null), { hours: [], days: [] });
});

test('envAtHour picks the nearest hour, including exact boundary matches', () => {
  const forecast = shapeForecast(apiFixture);
  // Exact match on hour 0.
  let patch = envAtHour(forecast, '2026-07-29T12:00');
  assert.equal(patch.windMph, 10);
  assert.equal(patch.gustMph, 10);
  assert.equal(patch.tempF, 88);

  // Halfway between hour 0 (12:00) and hour 1 (13:00): ties resolve to the
  // first-scanned (earliest) candidate since delta is strictly-less-than.
  patch = envAtHour(forecast, '2026-07-29T12:30');
  assert.equal(patch.windMph, 10);

  // Just past the midpoint should snap forward to hour 1.
  patch = envAtHour(forecast, '2026-07-29T12:31');
  assert.equal(patch.windMph, 16);

  // Past the last hour still snaps to the nearest (last) entry.
  patch = envAtHour(forecast, '2026-07-29T23:00');
  assert.equal(patch.windMph, null); // hour 2's wind was null in the fixture
  assert.equal(patch.gustMph, 8);
});

test('envAtHour returns the same shape as the live patch, no forecast extras', () => {
  const forecast = shapeForecast(apiFixture);
  const patch = envAtHour(forecast, '2026-07-29T12:00');
  assert.deepEqual(Object.keys(patch).sort(), ['gustMph', 'rhPct', 'tempF', 'windFromDeg', 'windMph'].sort());
});

test('envAtHour returns null for empty, missing, or invalid input', () => {
  assert.equal(envAtHour({ hours: [] }, '2026-07-29T12:00'), null);
  assert.equal(envAtHour({}, '2026-07-29T12:00'), null);
  assert.equal(envAtHour(null, '2026-07-29T12:00'), null);
  const forecast = shapeForecast(apiFixture);
  assert.equal(envAtHour(forecast, 'not-a-date'), null);
});

test('nearestHourIndex positions the scrubber on the nearest hour', () => {
  const forecast = shapeForecast(apiFixture);
  assert.equal(nearestHourIndex(forecast, '2026-07-29T12:00'), 0);
  assert.equal(nearestHourIndex(forecast, '2026-07-29T12:30'), 0); // tie -> earlier hour
  assert.equal(nearestHourIndex(forecast, '2026-07-29T12:31'), 1);
  assert.equal(nearestHourIndex(forecast, '2026-07-29T14:00'), 2);
  // Outside the span in either direction, clamp to the nearest end.
  assert.equal(nearestHourIndex(forecast, '2026-07-28T03:00'), 0);
  assert.equal(nearestHourIndex(forecast, '2026-07-29T23:00'), 2);
});

test('nearestHourIndex returns -1 for empty, missing, or invalid input', () => {
  assert.equal(nearestHourIndex({ hours: [] }, '2026-07-29T12:00'), -1);
  assert.equal(nearestHourIndex({}, '2026-07-29T12:00'), -1);
  assert.equal(nearestHourIndex(null, '2026-07-29T12:00'), -1);
  assert.equal(nearestHourIndex(shapeForecast(apiFixture), 'not-a-date'), -1);
  // Every hour unparseable is the same as having none.
  assert.equal(nearestHourIndex({ hours: [{ time: 'nope' }] }, '2026-07-29T12:00'), -1);
});

test('goldenHour is sunset minus 60 minutes', () => {
  const { days } = shapeForecast(apiFixture);
  const g = goldenHour(days[0]);
  assert.deepEqual(g.sunset, new Date('2026-07-29T20:30'));
  assert.deepEqual(g.goldenStart, new Date('2026-07-29T19:30'));
});

test('goldenHour returns null when the day has no sunset', () => {
  assert.equal(goldenHour({ sunset: null }), null);
  assert.equal(goldenHour(null), null);
  assert.equal(goldenHour({}), null);
});

/* ---------- M5 wave 2: height-level tempC and the pressure-level sounding ---------- */

test('shapeForecast levels gain tempC when the block published a temperature at that height', () => {
  const { hours } = shapeForecast(apiFixture);
  assert.equal(hours[0].levels[80].tempC, U.fToC(80.6));
  assert.equal(hours[0].levels[120].tempC, U.fToC(79.0));
  assert.equal(hours[0].levels[180].tempC, U.fToC(76.5));
  // windMph/windFromDeg are unchanged by the addition.
  assert.equal(hours[0].levels[80].windMph, 10);
  assert.equal(hours[0].levels[80].windFromDeg, 90);
});

test('shapeForecast levels omit tempC rather than fabricate it, and 10 m never has one', () => {
  const { hours } = shapeForecast(apiFixture);
  // The fixture (like the real request) never publishes 10 m wind, so the
  // level itself is absent — and 10 m has no temperature var at all even when
  // it is present (see HEIGHT_TEMP_ALTS_M), so there is nothing to fabricate.
  assert.equal(hours[0].levels[10], undefined);
  // Row 2's 80 m level is absent entirely (wind_speed_80m is null there) —
  // pre-existing behaviour, unaffected by tempC.
  assert.equal(hours[2].levels[80], undefined);
});

test('shapeForecast sounding is lowest-first and only includes fully-answered levels', () => {
  const { hours } = shapeForecast(apiFixture);
  // Row 0: every field present at every level.
  assert.deepEqual(hours[0].sounding.map((s) => s.hPa), [850, 700, 500]);
  assert.deepEqual(hours[0].sounding[0], {
    hPa: 850, windMph: 10, windFromDeg: 180, tempC: U.fToC(72.0), heightM: 1540,
  });
  assert.deepEqual(hours[0].sounding[2], {
    hPa: 500, windMph: 9, windFromDeg: 80, tempC: U.fToC(26), heightM: 5950,
  });
});

test('shapeForecast sounding omits a level with any missing field, rather than reporting a hole', () => {
  const { hours } = shapeForecast(apiFixture);
  // Row 1's 850 hPa temperature is null: the whole 850 entry drops out, 700
  // and 500 survive.
  assert.deepEqual(hours[1].sounding.map((s) => s.hPa), [700, 500]);
});

test('shapeForecast sounding is [] when no level has full data, not a crash', () => {
  const { hours } = shapeForecast(apiFixture);
  assert.deepEqual(hours[2].sounding, []);
});

test('shapeForecast tolerates a missing hourly block entirely, sounding included', () => {
  assert.deepEqual(shapeForecast({}), { hours: [], days: [] });
  assert.deepEqual(shapeForecast(null), { hours: [], days: [] });
});
