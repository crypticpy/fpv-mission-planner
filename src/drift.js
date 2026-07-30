// drift.js — the two things §6.2 asks for once residuals exist: the model's own
// historical error, and the band the fit's spread puts around the headline.
// Pure over physics.js — no DOM, no storage, and the logs and packs are passed
// in, so both readings are testable against the model's own ground truth.
//
//   driftPoints()  actual vs predicted energy economy, per logged cruise leg
//   rangeBandKm()  mission radius at the edges of an applied fit's ±σ band
//
// Two decisions worth stating, because both could reasonably have gone the
// other way:
//
//   - Hover tests are not on the drift chart. Economy is Wh per km and a hover
//     has no km; the doc's intent here is cruise-economy drift, and a hover
//     test's contribution is already visible as the η half of the status line.
//   - Both sides of a point are divided by the same ground speed — the leg's own
//     distance ÷ time. Wh/km = W / (3.6·v_ground) for actual and predicted
//     alike, exactly as planMission computes a leg's whPerKm, so the residual is
//     the power model's error and nothing else. A leg where the pilot typed an
//     average speed instead of a distance is plotted the same way; the number it
//     is divided by is the same number the fit was solved against.

import { airDensity, discAreaM2, powerAtSpeed, planMission } from './domain/physics.js';

/**
 * Actual vs predicted economy for every cruise leg in `solves`, sorted by
 * airspeed.
 *
 * `solves` are flightlog.fitForDrone()'s entries — each carries the log, the
 * average electrical power the flight actually drew (`pAvgW`) and the airspeed
 * it was flown at (`airspeedMs`). Both are properties of the flight rather than
 * of any airframe, which is why they can be reused here: the prediction is the
 * only half that reads `drone`, and `drone` is whatever the planner is flying
 * right now — the calibrated overlay when the switch is on, the catalog record
 * when it is off. That is the whole point: the residuals visibly shrink when the
 * pilot applies their own numbers.
 *
 * Refused legs are left out. They are not in the fit, so plotting them would
 * report an error the fit never claimed; `renderDriftChart` says how many were
 * held back instead.
 *
 * Each point: `{ log, airspeedMs, groundSpeedMs, actualWhPerKm,
 * predictedWhPerKm, residualWhPerKm }`.
 */
export function driftPoints({ drone, solves, batteries }) {
  const out = [];
  if (!drone) return out;
  const packs = batteries || [];
  for (const s of solves || []) {
    const log = s?.log;
    if (!log || log.kind !== 'cruise' || !s.ok) continue;
    if (!(s.pAvgW > 0) || !(s.airspeedMs > 0) || !(log.avgSpeedMs > 0)) continue;
    const battery = packs.find(b => b.id === log.batteryId);
    if (!battery) continue;
    const { rho } = airDensity(log.elevM, log.tempC, log.rhPct);
    const predictedW = powerAtSpeed({
      massKg: (drone.dryMassG + battery.massG + (log.payloadG || 0) + (log.extraG || 0)) / 1000,
      rho,
      areaM2: discAreaM2(drone),
      cdA: drone.cdA + (log.payloadCdA || 0),
      etaProp: drone.etaProp,
      avionicsW: drone.avionicsW,
    }, s.airspeedMs);
    const perKm = 1 / (3.6 * log.avgSpeedMs);
    const actualWhPerKm = s.pAvgW * perKm;
    const predictedWhPerKm = predictedW * perKm;
    out.push({
      log,
      airspeedMs: s.airspeedMs,
      groundSpeedMs: log.avgSpeedMs,
      actualWhPerKm,
      predictedWhPerKm,
      residualWhPerKm: actualWhPerKm - predictedWhPerKm,
    });
  }
  return out.sort((a, b) => a.airspeedMs - b.airspeedMs);
}

/**
 * How far off the model has been, over the plotted legs: signed and absolute
 * mean residual, and the same as a share of what the flights actually burned —
 * which is the figure the note under the chart quotes, because "6% high" means
 * something to a pilot and "0.42 Wh/km" does not.
 */
export function driftSummary(points) {
  const n = points.length;
  if (!n) return null;
  const sum = (f) => points.reduce((a, p) => a + f(p), 0);
  const actual = sum(p => p.actualWhPerKm) / n;
  const signed = sum(p => p.residualWhPerKm) / n;
  const abs = sum(p => Math.abs(p.residualWhPerKm)) / n;
  return {
    n,
    meanActualWhPerKm: actual,
    meanSignedWhPerKm: signed,
    meanAbsWhPerKm: abs,
    signedPct: actual > 0 ? (signed / actual) * 100 : null,
    absPct: actual > 0 ? (abs / actual) * 100 : null,
  };
}

// The fit's numbers are the pilot's own, but the class ranges are still the
// outer edge of believable, and a band pushed past them would plan a rig that
// cannot exist. Clamped rather than refused: it is the *edge* of the band that
// gets trimmed, and the headline figure in the middle is untouched.
const clampEta = (v) => Math.min(0.9, Math.max(0.1, v));
const clampCdA = (v) => Math.max(1e-4, v);

/**
 * Mission radius at the two ends of an applied fit's ±σ band.
 *
 * The pairing is physical, not per-field: efficiency and drag are both being
 * asked "how bad could this be?" at the same time, so the pessimistic corner is
 * the *low* efficiency with the *high* drag (η − σ, CdA + σ) and the optimistic
 * corner is the opposite (η + σ, CdA − σ). Pairing them the other way round
 * would report the width of a corner nobody flies in — a rig that is both
 * inefficient and slippery — and would understate the spread the pilot's own
 * flights actually show.
 *
 * `inputs` is state.missionInputs(): its `drone` is already the calibrated
 * record, so σ is applied around the fitted values rather than the catalog's.
 * `calibration` is that record's own `calibration` block, which exists only
 * while the switch is on. Returns null when there is no band to report or when
 * either corner does not close an out-and-back — a "7.9–8.8" whose low end is a
 * mission that never comes home would be a lie in the shape of a range.
 */
export function rangeBandKm(inputs, calibration) {
  const cal = calibration;
  if (!cal || !inputs?.drone) return null;
  const etaBand = cal.etaProp?.band > 0 ? cal.etaProp.band : 0;
  const cdaBand = cal.cdA?.band > 0 ? cal.cdA.band : 0;
  if (!etaBand && !cdaBand) return null;
  const at = (sign) => {
    const drone = {
      ...inputs.drone,
      etaProp: clampEta(inputs.drone.etaProp + sign * etaBand),
      cdA: clampCdA(inputs.drone.cdA - sign * cdaBand),
    };
    // No shared `_pCache`: the memo is only valid while the drag and efficiency
    // config is fixed, and moving them is the entire point of this call.
    return planMission({ ...inputs, drone, lite: true }).radiusKm;
  };
  const lo = at(-1);
  const hi = at(1);
  if (!(lo > 0) || !(hi > 0)) return null;
  return {
    loKm: Math.min(lo, hi),
    hiKm: Math.max(lo, hi),
    nFlights: cal.nFlights,
  };
}
