// dive-checks.js — the questions a mountain dive raises, once the model has run
// (M16 wave D).
//
// domain/dive-dynamics.js turns an authored dive plan into phases and a block of
// system figures. It does not judge them: a pullout that bottoms out 4 m under
// the ridge and one that clears it by 400 m come back through the same fields.
// This module is the judging, and it reads exactly what that model produced —
// nothing here re-enters dive.js, samples the ground a second time, or knows a
// formula. Two places computing the same clearance would eventually disagree,
// and the surface that disagreed would be the one the pilot happened to be
// looking at.
//
// The rule route-checks.js states and this module inherits: **an unknown is
// never a pass.** A gate with no elevation under it is not a clear gate; a dive
// with no authored speed has not passed its pullout check, it has not had one.
// Both produce a stated constraint at `unknown` severity, because a silent
// absence reads exactly like a clean bill of health.
//
// Noise has the same budget it has everywhere else: at most one constraint per
// code, anchored at the mission. A dive plan is one line with three gates on it,
// and the anchor vocabulary (mission / segment / sample) has no gate scope — a
// gate id filed under `segment` would send the fix link to a route leg that does
// not exist, which is worse than a mission anchor and a clear sentence.

import {
  DIVE_CURRENT_MARGIN_FRAC, DIVE_PULLOUT_CLEARANCE_WARN_M, TERRAIN_CLEARANCE_FLOOR_M,
} from './analysis-contracts.js';
import { draftConstraint } from './constraints.js';

/**
 * @typedef {import('../../domain/mission/mission-schema.js').DivePlan} DivePlan
 * @typedef {import('../../domain/dive-dynamics.js').DiveDynamics} DiveDynamics
 * @typedef {import('./constraints.js').ConstraintDraft} ConstraintDraft
 */

/**
 * @typedef {object} DiveChecksSpec
 * @property {DivePlan|null} dive         the authored plan, for what it states
 * @property {DiveDynamics|null} dynamics what the model made of it
 * @property {number|null} landFloorFrac  the mission's landing floor, 0–1
 */

/**
 * One point on the chain the line is flown along, as the model left it.
 * @typedef {{ mslM: number, clearanceM: number|null }} ChainPoint
 */

/** @param {number} v @returns {string} */
const m0 = (v) => v.toFixed(0);

/** @param {number} frac @returns {string} */
const pct0 = (frac) => (frac * 100).toFixed(0);

/**
 * Every check this milestone adds, in one pass over the model.
 *
 * @param {DiveChecksSpec} spec
 * @returns {ConstraintDraft[]}
 */
export function diveChecks(spec) {
  /** @type {ConstraintDraft[]} */
  const drafts = [];
  const dive = spec?.dive ?? null;
  if (!dive) return drafts;

  /* Asked of the plan rather than of the model, because it is true of a plan
   * with one gate on it — a line that cannot be flown yet still has nowhere to
   * break off to, and that is worth saying while the pilot is still drawing. */
  if (!dive.bailout) {
    drafts.push(draftConstraint('W-DIVE-NO-BAILOUT',
      'This dive plan names no bailout landing. If the run is abandoned part-way down there is '
      + 'nowhere stated to put the aircraft, which is a decision to make on the ground rather '
      + 'than on the line.'));
  }

  const dynamics = spec.dynamics ?? null;
  if (!dynamics) return drafts;
  const sys = dynamics.systems;
  const points = chainPointsOf(dynamics);

  drafts.push(...pulloutDrafts(dive, sys));
  drafts.push(...propulsionDrafts(sys));
  drafts.push(...reserveDrafts(sys, spec.landFloorFrac ?? null));
  drafts.push(...groundDrafts(dive, dynamics, points));
  return drafts;
}

/* ---------- the pullout ---------- */

/**
 * The arc at the dive gate, against the ground under it.
 * @param {DivePlan} dive
 * @param {DiveDynamics['systems']} sys
 * @returns {ConstraintDraft[]}
 */
function pulloutDrafts(dive, sys) {
  const speedMs = typeof dive.speedMs === 'number' ? dive.speedMs : null;
  const loadG = typeof dive.pulloutLoadG === 'number' ? dive.pulloutLoadG : null;

  if (sys.pulloutRadiusM == null) {
    return [draftConstraint('W-DIVE-PULLOUT-UNSTATED', unstatedText(speedMs, loadG))];
  }
  /* An arc exists and the ground under the gate did not answer. The clearance is
   * unknown rather than clear, and W-DIVE-GROUND-UNKNOWN below is where that is
   * said — repeating it here under a pullout code would be the same hole twice. */
  if (sys.pulloutClearanceM == null) return [];

  const clearanceM = sys.pulloutClearanceM;
  const sinkM = sys.pulloutSinkM ?? 0;
  if (clearanceM <= TERRAIN_CLEARANCE_FLOOR_M) {
    return [draftConstraint('W-DIVE-PULLOUT-GROUND',
      `Pulled at the dive gate, the arc sinks ${m0(sinkM)} m and finishes ${m0(-clearanceM)} m below the `
      + 'ground under that gate. As planned the pullout goes into the hill, not over it — start the pull '
      + 'higher, fly the dive slower, or pull harder.')];
  }
  if (clearanceM < DIVE_PULLOUT_CLEARANCE_WARN_M) {
    return [draftConstraint('W-DIVE-PULLOUT-THIN',
      `Pulled at the dive gate, the arc sinks ${m0(sinkM)} m and clears the ground under that gate by `
      + `${m0(clearanceM)} m, under the ${DIVE_PULLOUT_CLEARANCE_WARN_M} m this tool treats as clear. The `
      + 'DEM is bare earth — whatever is growing or standing there is not in that figure.')];
  }
  return [];
}

/**
 * Why no arc was checked, in the terms of whichever figure is absent.
 * @param {number|null} speedMs
 * @param {number|null} loadG
 * @returns {string}
 */
function unstatedText(speedMs, loadG) {
  if (speedMs == null && loadG == null) {
    return 'This dive states neither a speed nor a pullout load, so no pullout arc was computed and the '
      + 'ground under it is unchecked. Nothing here says the pull clears — it says nobody has stated '
      + 'what the pull is.';
  }
  if (speedMs == null) {
    return `This dive states a ${loadG} g pullout load but no speed, so no pullout arc was computed and the `
      + 'ground under it is unchecked. A house cruise speed is not substituted for the one nobody stated.';
  }
  if (loadG == null) {
    return `This dive states ${speedMs} m/s but no pullout load, so no pullout arc was computed and the `
      + 'ground under it is unchecked. The load a pull is flown at is a pilot\'s decision, not a default.';
  }
  return `A pullout load of ${loadG} g leaves no arc to fly: at 1 g or less the rotors hold the weight or `
    + 'turn the path, not both. No arc was computed, so the ground under the pull is unchecked.';
}

/* ---------- what the pull asks of the machine ---------- */

/**
 * The pack and the propulsion, under the pullout draw.
 * @param {DiveDynamics['systems']} sys
 * @returns {ConstraintDraft[]}
 */
function propulsionDrafts(sys) {
  /** @type {ConstraintDraft[]} */
  const drafts = [];

  if (sys.sagDeliverable === false) {
    const drawW = sys.pulloutPowerW;
    drafts.push(draftConstraint('W-DIVE-SAG-LIMITED',
      `The pullout asks the pack for ${drawW == null ? 'more' : `${m0(drawW)} W`}, past what it can deliver `
      + 'at the state of charge the dive reaches it with. The model returns no terminal voltage for that '
      + 'draw at all rather than a low one: the pack cannot hold the pull, so the aircraft does not fly it.'));
  }

  if (sys.motorMarginFrac != null && sys.motorMarginFrac <= DIVE_CURRENT_MARGIN_FRAC) {
    drafts.push(draftConstraint('W-DIVE-MOTOR-MARGIN', marginText('motors', sys.motorMarginFrac)));
  }
  if (sys.escMarginFrac != null && sys.escMarginFrac <= DIVE_CURRENT_MARGIN_FRAC) {
    drafts.push(draftConstraint('W-DIVE-ESC-MARGIN', marginText('ESCs', sys.escMarginFrac)));
  }
  return drafts;
}

/**
 * One current-margin sentence, in the terms of the limit it is measured against.
 * @param {'motors'|'ESCs'} what
 * @param {number} frac
 * @returns {string}
 */
function marginText(what, frac) {
  const tail = 'That draw is hover power scaled by the pull\'s own load factor, which overstates it — '
    + 'the figure is a bound on the demand, not a measurement of it.';
  if (frac < 0) {
    return `The pullout draws past the ${what}' rated current by ${pct0(-frac)}% of that ceiling. ${tail}`;
  }
  return `The pullout leaves ${pct0(frac)}% of the ${what}' rated current unused, at or under the `
    + `${pct0(DIVE_CURRENT_MARGIN_FRAC)}% this tool treats as margin. ${tail}`;
}

/* ---------- getting home afterward ---------- */

/**
 * Whether the pack still holds its floor once the dive and the ride home are paid.
 * @param {DiveDynamics['systems']} sys
 * @param {number|null} landFloorFrac
 * @returns {ConstraintDraft[]}
 */
function reserveDrafts(sys, landFloorFrac) {
  const frac = sys.recoveryReserveFrac;
  if (frac == null || landFloorFrac == null) return [];
  if (frac >= landFloorFrac) return [];
  if (frac < 0) {
    return [draftConstraint('W-DIVE-RESERVE-SHORT',
      `The dive and the flight home from it together commit ${pct0(-frac)}% more than the pack delivers, `
      + `against a ${pct0(landFloorFrac)}% landing floor. This plan does not close.`)];
  }
  return [draftConstraint('W-DIVE-RESERVE-SHORT',
    `Once the mission is flown and the climb and cruise home from the last gate are paid for, `
    + `${pct0(frac)}% of the pack is left — under the ${pct0(landFloorFrac)}% this plan says it will not `
    + 'land below.')];
}

/* ---------- the ground under the line ---------- */

/**
 * The lost-link altitude against the ground, and the holes in that ground.
 * @param {DivePlan} dive
 * @param {DiveDynamics} dynamics
 * @param {readonly ChainPoint[]} points
 * @returns {ConstraintDraft[]}
 */
function groundDrafts(dive, dynamics, points) {
  /** @type {ConstraintDraft[]} */
  const drafts = [];

  const rthM = typeof dive.rthAltitudeMslM === 'number' ? dive.rthAltitudeMslM : null;
  const highestM = highestGroundOf(points);
  if (rthM != null && highestM != null && rthM <= highestM) {
    drafts.push(draftConstraint('W-DIVE-RTH-BELOW-TERRAIN',
      `The lost-link altitude is ${m0(rthM)} m MSL and the highest ground sampled under this dive line `
      + `stands at ${m0(highestM)} m MSL. A failsafe climb to that height does not clear the terrain — it `
      + 'flies into it.'));
  }

  if (!dynamics.groundComplete) {
    const unknown = points.filter((p) => p.clearanceM == null).length;
    drafts.push(draftConstraint('W-DIVE-GROUND-UNKNOWN', unknown > 0
      ? `${unknown} of the ${points.length} points on this dive line ${unknown === 1 ? 'has' : 'have'} no `
        + 'elevation under them. Clearance there was not checked and is not known — treat those gates as '
        + 'unsurveyed rather than clear.'
      : 'The ground under this dive line was not sampled, so no clearance under it was checked. This is '
        + 'an unknown, not a clear line.'));
  }
  return drafts;
}

/**
 * The chain the line is flown along, as points: the first phase's start and then
 * every phase's end.
 *
 * Read off the flown legs only. The pullout band sits across the beginning of
 * the recovery leg rather than adding a station of its own, so counting its
 * endpoints would report the dive gate twice and inflate every count taken here.
 *
 * @param {DiveDynamics} dynamics
 * @returns {ChainPoint[]}
 */
export function chainPointsOf(dynamics) {
  const legs = dynamics.phases.filter((p) => p.kind !== 'pullout');
  if (legs.length === 0) return [];
  /** @type {ChainPoint[]} */
  const points = [{ mslM: legs[0].startMslM, clearanceM: legs[0].startClearanceM }];
  for (const leg of legs) points.push({ mslM: leg.endMslM, clearanceM: leg.endClearanceM });
  return points;
}

/**
 * The highest ground any point on the line answered with, in metres MSL.
 *
 * Reconstructed from what the model already read — altitude less the clearance
 * it reported — rather than sampled again. One terrain reading per pass is what
 * keeps the constraint and the phase it is about from describing two different
 * hillsides.
 *
 * @param {readonly ChainPoint[]} points
 * @returns {number|null}
 */
function highestGroundOf(points) {
  /** @type {number|null} */
  let highest = null;
  for (const p of points) {
    if (p.clearanceM == null) continue;
    const groundMslM = p.mslM - p.clearanceM;
    if (highest == null || groundMslM > highest) highest = groundMslM;
  }
  return highest;
}
