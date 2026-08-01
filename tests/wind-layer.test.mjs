// The W-04 legend line (design evolution M11). The arrows themselves are
// canvas drawing and are exercised by the browser specs; what is pinned here
// is the wording — in particular the preset-honesty rule, which must never
// name a height for a wind figure that was not read at one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { windLegendLine } from '../src/presentation/map/layers/wind-layer.js';

test('the legend names the level the advisory provenance recorded', () => {
  assert.equal(windLegendLine({ speedMs: 8.5, levelM: 80 }),
    'Arrows point downwind · read at 80 m');
});

test('a preset wind belongs to no level and the legend claims none', () => {
  assert.equal(windLegendLine({ speedMs: 8.5, levelM: null }),
    'Arrows point downwind');
});

test('calm air draws no arrows and the legend says why', () => {
  assert.equal(windLegendLine({ speedMs: 0, levelM: 80 }), 'Calm — no arrows to draw');
  assert.equal(windLegendLine({ speedMs: 0.49, levelM: null }), 'Calm — no arrows to draw');
  // A wind that is not a number is not a wind — the calm wording, not a crash.
  assert.equal(windLegendLine({ speedMs: NaN, levelM: 80 }), 'Calm — no arrows to draw');
});
