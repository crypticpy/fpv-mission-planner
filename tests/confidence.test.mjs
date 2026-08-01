import test from 'node:test';
import assert from 'node:assert/strict';

import { modelConfidence } from '../src/confidence.js';

// Minimal records shaped like the real inputs: state.drone() output for
// `drone`, flightlog.fitForDrone() for `fit`, drift.driftSummary() for `drift`.
const catalogDrone = { id: 'moz7v2', name: 'Mozzie 7' };
const customDrone = { id: 'custom-1', name: 'My 7"', custom: true, confidence: 'datasheet' };

test('provenance names the numbers flying right now', () => {
  // A built-in wears 'catalog': anchored figures, neither a guess nor the
  // pilot's own flying.
  assert.equal(modelConfidence({ drone: catalogDrone }).provenance, 'catalog');
  // A custom rig wears the confidence it was authored with…
  assert.equal(modelConfidence({ drone: customDrone }).provenance, 'datasheet');
  assert.equal(modelConfidence({ drone: { ...customDrone, confidence: 'measured' } }).provenance, 'measured');
  // …and an unstated/unknown field falls to schema's floor, 'estimated'.
  assert.equal(modelConfidence({ drone: { ...customDrone, confidence: undefined } }).provenance, 'estimated');
  assert.equal(modelConfidence({ drone: { ...customDrone, confidence: 'psychic' } }).provenance, 'estimated');
  // The applied-calibration overlay outranks everything — even on a built-in,
  // and even over an authored word: the flying etaProp/cdA are the pilot's fit.
  assert.equal(modelConfidence({ drone: { ...catalogDrone, calibration: { nFlights: 5 } } }).provenance, 'measured');
  assert.equal(modelConfidence({ drone: { ...customDrone, confidence: 'estimated', calibration: {} } }).provenance, 'measured');
  // No drone, no answer.
  assert.equal(modelConfidence({ drone: null }), null);
});

test('the percentage is never invented', () => {
  // No drift bag, or one with no accepted cruise legs: provenance words only.
  const unflown = modelConfidence({ drone: catalogDrone });
  assert.equal(unflown.pct, null);
  assert.equal(unflown.driftN, 0);
  assert.equal(unflown.nFlights, 0);
  assert.equal(unflown.tier, 'none');
  assert.equal(modelConfidence({ drone: catalogDrone, drift: { n: 0, absPct: null } }).pct, null);

  // With legs, pct is 100 minus the mean absolute economy error, rounded.
  const flown = modelConfidence({
    drone: catalogDrone,
    fit: { nFlights: 4, tier: 'offer' },
    drift: { n: 3, absPct: 8.4 },
  });
  assert.equal(flown.pct, 92);
  assert.equal(flown.driftN, 3);
  assert.equal(flown.nFlights, 4);
  assert.equal(flown.tier, 'offer');

  // Clamped: a model that is off by more than 100% reads 0, never negative.
  assert.equal(modelConfidence({ drone: catalogDrone, drift: { n: 2, absPct: 140 } }).pct, 0);
  // A perfect model reads 100, not more.
  assert.equal(modelConfidence({ drone: catalogDrone, drift: { n: 2, absPct: 0 } }).pct, 100);
});
