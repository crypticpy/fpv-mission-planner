import test from 'node:test';
import assert from 'node:assert/strict';

import { shapeForecast, envAtHour, goldenHour } from '../js/weather.js';

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
