// confidence.js — one honest answer to "how much should I trust this model?"
// (M15, E-01/E-04). Pure over records other modules own: the drone the plan is
// flying (flightlog.calibratedDrone()'s overlay or the catalog literal),
// fitForDrone()'s aggregate, and driftSummary()'s error figure. No DOM, no
// storage — the same layering as drift.js, and for the same reason: both
// readings must be testable against the model's own ground truth.
//
// Two rules, each of which could have gone the other way:
//
//   - The percentage is never invented. It exists only once logged cruise legs
//     exist to measure the model against, and it is 100 minus the model's mean
//     absolute economy error over those legs (drift.absPct). A drone nobody
//     has flown gets provenance words, not a number — a made-up "68%" on a
//     class-template rig would be confidence theater.
//   - Provenance names the numbers the plan is flying *right now*. 'measured'
//     only while the pilot's own fit is applied; a custom rig otherwise wears
//     the confidence it was authored with (§6.1's field); a built-in wears
//     'catalog' — its etaProp/cdA were anchored against the logged flights in
//     the README's calibration-anchors table, which is neither a guess nor the
//     pilot's own flying, so neither existing word fits.

import { normalizeConfidence } from './schema.js';

/**
 * @typedef {object} ModelConfidence
 * @property {'measured'|'datasheet'|'estimated'|'catalog'} provenance
 *   where the flying etaProp/cdA come from
 * @property {number|null} pct  0–100, how close the model's cruise economy has
 *   been to the logged flights; null until at least one accepted cruise leg
 * @property {number} driftN  cruise legs behind `pct` (0 when pct is null)
 * @property {number} nFlights  accepted flights in the fit, cruise and hover
 * @property {'none'|'show'|'offer'|'default'} tier  calibrate.confidence()'s gate
 */

/**
 * Badge-ready trust data for the airframe model the plan is flying.
 *
 * `drone` is whatever state.drone() returns — the calibrated overlay when the
 * switch is on (its `calibration` block is the applied marker), the catalog or
 * custom record when it is off. `fit` is flightlog.fitForDrone()'s bag, `drift`
 * is drift.driftSummary()'s (either may be null/absent).
 *
 * @param {{drone: object|null, fit?: object|null, drift?: object|null}} args
 * @returns {ModelConfidence|null} null only when there is no drone at all
 */
export function modelConfidence({ drone, fit, drift }) {
  if (!drone) return null;
  const provenance = drone.calibration ? 'measured'
    : drone.custom ? normalizeConfidence(drone.confidence)
      : 'catalog';
  const absPct = drift && Number.isFinite(drift.absPct) ? drift.absPct : null;
  return {
    provenance,
    pct: absPct == null ? null : Math.max(0, Math.min(100, Math.round(100 - absPct))),
    driftN: absPct == null ? 0 : (drift.n ?? 0),
    nFlights: fit?.nFlights ?? 0,
    tier: fit?.tier ?? 'none',
  };
}
