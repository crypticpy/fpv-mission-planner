// vertical-flight.js — what each leg's own height does to it (M3b).
//
// Until M3b the analysis read a segment's altitude, recorded the change between
// one leg and the next, and said out loud that nothing had been charged for it.
// This module is what replaced that sentence. For each leg it answers three
// questions the pipeline then hangs on the segment record:
//
//   what did the height change cost?      → domain/vertical.js's climb/descent
//   what is the air like up there?        → domain/vertical.js's atmosphereAt
//   what is the wind doing up there?      → domain/vertical.js's windAtAltitude
//
// The arithmetic is all in the domain module; this is the application-layer
// bookkeeping around it — which leg gets which inputs, and which of the answers
// are worth raising as a constraint rather than leaving on the segment.
//
// Two rules shape every threshold below.
//
//   *A leg is compared against the plan, not re-solved.* `planMission` picked
//     one density and one wind for the whole flight, and nothing here re-runs
//     it. What this module can honestly say is "the air up on leg 3 is not the
//     air this plan was solved in, by this much" — a statement about the model's
//     own fit, which is what a caution is for.
//
//   *A difference under the forecast's own resolution is not a finding.* The
//     tolerances exist so that a route climbing 40 m does not raise a caution
//     about air it is not measurably flying in.

import {
  atmosphereAt, hoverPowerRatio, legVerticalEnergy, windAtAltitude,
} from '../../domain/vertical.js';
import { anchorAt } from './analysis-contracts.js';
import { draftConstraint } from './constraints.js';

/**
 * @typedef {import('./analysis-contracts.js').SegmentAir} SegmentAir
 * @typedef {import('./analysis-contracts.js').SegmentVertical} SegmentVertical
 * @typedef {import('./analysis-contracts.js').SegmentWind} SegmentWind
 * @typedef {import('./constraints.js').ConstraintDraft} ConstraintDraft
 */

/** mph to m/s, the one conversion this module needs of the forecast's units. */
const MPH_TO_MS = 0.44704;

/**
 * How much more hover power a leg's own air may ask for before the difference is
 * worth saying out loud, as a fraction. 3% is comfortably inside the spread
 * between a calibrated and an estimated drivetrain, so below it the finding
 * would be smaller than the model's own uncertainty and would read as precision
 * this tool does not have.
 */
export const DENSITY_POWER_TOLERANCE = 0.03;

/**
 * How far a leg's own wind may sit from the planning wind before it is a
 * finding, in m/s. Roughly 4 mph: a numerical forecast's own level-to-level
 * agreement is not better than this, so a smaller gap is noise in the input
 * rather than a fact about the flight.
 */
export const WIND_LEVEL_TOLERANCE_MS = 2;

/**
 * How much height a route may span on a forecast with a single usable wind level
 * before the missing gradient is worth saying out loud, in metres.
 *
 * This is the case the exit gate cares about: with one level there is no shear
 * to read, and this module will not invent one — no power law, no log profile,
 * no roughness guess. What it does instead is say that the wind above and below
 * that level is unmeasured, once the route is far enough from it to matter.
 */
export const SINGLE_LEVEL_SPAN_M = 100;

/**
 * What one leg's height did to it. Every field is nullable and null means the
 * input it needed was not established — never a zero standing in for one.
 * @typedef {object} LegVerticalFlight
 * @property {SegmentVertical|null} vertical
 * @property {SegmentAir|null} air
 * @property {SegmentWind|null} wind
 */

/**
 * The inputs one leg's vertical picture is built from. The plan's own figures
 * (`planRho`, `hoverW`, `massKg`, `etaProp`) arrive rather than being re-derived,
 * so a leg is always compared against the plan that is on screen beside it.
 *
 * @typedef {object} LegVerticalSpec
 * @property {number} massKg
 * @property {number} etaProp
 * @property {number} hoverW
 * @property {number} levelPowerW    this leg's own cruise power, or hover when unsolved
 * @property {number} planRho        the density planMission solved at
 * @property {number|null} altitudeMslM
 * @property {number|null} deltaM
 * @property {number|null} launchElevMslM
 * @property {number} refElevM       where the temperature reading was taken
 * @property {number} refTempC
 * @property {number} rhPct
 * @property {unknown} windLevels    the forecast's published levels, or null
 */

/**
 * One leg's climb, air and wind.
 * @param {LegVerticalSpec} spec
 * @returns {LegVerticalFlight}
 */
export function legVerticalFlight(spec) {
  /* A height change costs something whether or not the height itself is known:
   * the delta comes from two resolved altitudes, and if it is there the energy
   * is real. */
  const vertical = spec.deltaM != null && spec.deltaM !== 0
    ? Object.freeze(legVerticalEnergy({
      massKg: spec.massKg,
      etaProp: spec.etaProp,
      hoverW: spec.hoverW,
      levelPowerW: spec.levelPowerW,
      deltaM: spec.deltaM,
    }))
    : null;

  /* Everything below needs to know where the leg actually is. An unresolved
   * altitude produces nulls, and W-DATA-ALTITUDE-UNRESOLVED is already saying
   * why. */
  if (spec.altitudeMslM == null) return Object.freeze({ vertical, air: null, wind: null });

  const at = atmosphereAt({
    mslM: spec.altitudeMslM,
    refElevM: spec.refElevM,
    refTempC: spec.refTempC,
    rhPct: spec.rhPct,
  });
  const air = Object.freeze({
    rho: at.rho,
    tempC: at.tempC,
    densityAltM: at.densityAltM,
    hoverPowerRatio: hoverPowerRatio(spec.planRho, at.rho),
  });

  /* The forecast publishes wind above the *launch point*, so a height above sea
   * level has to come back down to a height above launch before a level lookup
   * means anything. With no launch elevation there is no such height, and a
   * guess here would be a guess about which forecast level the route flies in. */
  const height = spec.launchElevMslM != null ? spec.altitudeMslM - spec.launchElevMslM : null;
  const aloft = height != null ? windAtAltitude(spec.windLevels, height) : null;
  const wind = aloft
    ? Object.freeze({
      windMph: aloft.windMph,
      windFromDeg: aloft.windFromDeg,
      basis: aloft.basis,
      levelsM: aloft.levelsM,
      heightAboveLaunchM: /** @type {number} */ (height),
    })
    : null;

  return Object.freeze({ vertical, air, wind });
}

/**
 * One leg's answer, tagged with the segment it belongs to, as the drafts below
 * need both.
 * @typedef {{ segmentId: string, flight: LegVerticalFlight }} TaggedLegFlight
 */

/**
 * The mission-wide statements a route's worth of leg profiles adds up to.
 *
 * At most one constraint per code, each anchored at the leg that drives it —
 * one caution naming the worst leg is a finding, twelve identical cautions are
 * a wall a pilot learns to scroll past.
 *
 * @param {readonly TaggedLegFlight[]} entries
 * @param {{ planningWindMs: number }} spec
 * @returns {ConstraintDraft[]}
 */
export function verticalFlightDrafts(entries, spec) {
  /** @type {ConstraintDraft[]} */
  const drafts = [];

  let climbWh = 0;
  let descentWh = 0;
  for (const { flight } of entries) {
    if (!flight.vertical) continue;
    climbWh += flight.vertical.climbWh;
    descentWh += flight.vertical.descentWh;
  }
  if (climbWh > 0 || descentWh > 0) {
    drafts.push(draftConstraint('W-ALT-VERTICAL-CONSERVATIVE',
      `This route changes altitude, and ${(climbWh + descentWh).toFixed(1)} Wh of the mission total is `
      + `the change itself — ${climbWh.toFixed(1)} Wh climbing, ${descentWh.toFixed(1)} Wh descending. `
      + 'The climb is charged at the height it buys divided by drivetrain efficiency, which is an upper '
      + 'bound rather than a measurement, and the descent gets no energy back.'));
  }

  /* The thinnest air any leg flies in, against the air the plan was solved in. */
  /** @type {TaggedLegFlight|null} */
  let worstAir = null;
  for (const entry of entries) {
    const ratio = entry.flight.air?.hoverPowerRatio;
    if (ratio == null) continue;
    if (!worstAir || ratio > /** @type {SegmentAir} */ (worstAir.flight.air).hoverPowerRatio) {
      worstAir = entry;
    }
  }
  const worstRatio = worstAir?.flight.air?.hoverPowerRatio ?? 1;
  if (worstAir && worstRatio - 1 > DENSITY_POWER_TOLERANCE) {
    const air = /** @type {SegmentAir} */ (worstAir.flight.air);
    drafts.push(draftConstraint('W-ALT-DENSITY-OPTIMISTIC',
      `The air on this route's highest leg is thin enough to need about ${((worstRatio - 1) * 100).toFixed(0)}% `
      + `more hover power than the plan was solved for (density altitude ${air.densityAltM.toFixed(0)} m up `
      + 'there). Every energy figure here still comes from the plan\'s single density, so treat them as the '
      + 'optimistic end on the high legs.',
      anchorAt('segment', worstAir.segmentId)));
  }

  /* The wind aloft, against the wind the plan was solved in. Two ways this can
   * be a finding, and the text says which one applies. */
  /** @type {TaggedLegFlight|null} */
  let worstWind = null;
  let worstGapMs = 0;
  let heights = /** @type {number[]} */ ([]);
  let singleLevel = false;
  for (const entry of entries) {
    const wind = entry.flight.wind;
    if (!wind) continue;
    heights.push(wind.heightAboveLaunchM);
    if (wind.basis === 'single-level') singleLevel = true;
    const gap = Math.abs(wind.windMph * MPH_TO_MS - spec.planningWindMs);
    if (gap > worstGapMs) { worstGapMs = gap; worstWind = entry; }
  }
  const spanM = heights.length > 0 ? Math.max(...heights) - Math.min(...heights) : 0;

  if (worstWind && worstGapMs > WIND_LEVEL_TOLERANCE_MS) {
    const wind = /** @type {SegmentWind} */ (worstWind.flight.wind);
    drafts.push(draftConstraint('W-WIND-LEVEL-MISMATCH',
      `At ${wind.heightAboveLaunchM.toFixed(0)} m above launch the forecast wind is `
      + `${wind.windMph.toFixed(0)} mph, about ${(worstGapMs / MPH_TO_MS).toFixed(0)} mph away from the `
      + `${(spec.planningWindMs / MPH_TO_MS).toFixed(0)} mph this plan was solved at. The legs were not `
      + 're-solved at their own wind — the speeds and energies beside them are the planning-wind ones.',
      anchorAt('segment', worstWind.segmentId)));
  } else if (singleLevel && spanM > SINGLE_LEVEL_SPAN_M) {
    drafts.push(draftConstraint('W-WIND-LEVEL-MISMATCH',
      `This route spans ${spanM.toFixed(0)} m of height and the forecast publishes wind at one level only, `
      + 'so there is no gradient to read. Nothing here estimates the shear — the same wind is quoted at '
      + 'every height, and the real wind aloft may be well above it.'));
  }

  return drafts;
}
