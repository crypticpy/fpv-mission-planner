// route-checks.js — the three questions that need the ground under the whole
// route, rather than the ground along one bearing (M3b).
//
// The terrain card has always asked its questions of a single profile: one
// bearing out of the launch point, to the footprint radius, drawn against the
// planned cruise altitude. That is the right shape for the footprint ring and
// the wrong shape for an authored route, which turns, climbs, and comes home
// across ground the outbound bearing never crossed.
//
// This module reads the corridor's TerrainField — the same samples, under the
// same ids, that the renderer and the altitude resolver read — and answers:
//
//   *Does each leg clear the ground under it?* Per corridor sample, through
//     convertAltitude, anchored at the sample that was worst.
//
//   *Can the pilot see the aircraft at each waypoint?* The launch-to-waypoint
//     sightline, with the corridor's own samples projected onto it, through the
//     same Fresnel geometry the terrain card uses.
//
//   *Can the aircraft get home from each waypoint?* The direct line back —
//     terrain on it, and the energy the turn commits the pack to once M3b's
//     climb is counted.
//
// The rule this whole module exists to hold: **an unknown is never a pass.** A
// station with no elevation is not clear ground, an unsampled return path is
// not a clear return path, and an empty obstruction list is not a clear
// sightline. Every one of those produces a stated constraint, and every check
// below refuses to report a verdict it does not have the data for.
//
// Noise has a budget too. At most one constraint per code, each anchored at the
// segment or sample that drives it, because a twelve-waypoint route through
// rough ground would otherwise produce a rail nobody reads.

import { ANTENNA_HEIGHT_M, worstFresnelMargin } from '../../domain/fresnel.js';
import { distanceKm, trackOffsetKm } from '../../domain/geo.js';
import { convertAltitude } from '../../domain/mission/altitude.js';
import {
  TERRAIN_CLEARANCE_FLOOR_M, TERRAIN_CLEARANCE_WARN_M, anchorAt,
} from './analysis-contracts.js';
import { draftConstraint } from './constraints.js';

/**
 * @typedef {import('./analysis-contracts.js').CorridorRequest} CorridorRequest
 * @typedef {import('./analysis-contracts.js').RouteHold} RouteHold
 * @typedef {import('./analysis-contracts.js').SegmentClearance} SegmentClearance
 * @typedef {import('./constraints.js').ConstraintDraft} ConstraintDraft
 * @typedef {import('../terrain/terrain-contracts.js').TerrainField} TerrainField
 * @typedef {import('../terrain/terrain-contracts.js').TerrainSample} TerrainSample
 */

/** @typedef {{ lat: number, lng: number }} LatLng */

/**
 * How far off a sightline a corridor sample may sit and still be treated as
 * ground on it, in metres.
 *
 * The DEM behind these samples is 90 m and the corridor's own along-track step
 * is tens to hundreds of metres, so nothing in this module claims lateral
 * precision finer than that. 200 m is "near enough to be the same ground at this
 * resolution" — wider would import a hillside the aircraft flies past into a
 * sightline it does not cross, which is a fabricated obstruction, and narrower
 * would throw away real ridges over a rounding error in the projection.
 */
export const SIGHTLINE_CORRIDOR_M = 200;

/**
 * The longest stretch of a direct return path this module will accept with no
 * corridor sample on it, in corridor steps.
 *
 * Longer than this and the honest answer is "nobody looked", which is what
 * W-RETURN-TERRAIN-UNKNOWN says. A dogleg's flight home cuts across country the
 * route never sampled, and a "clear" verdict drawn from the third of it that
 * happens to overlap the outbound leg would be exactly the failure this
 * milestone's exit gate forbids.
 *
 * Measured as the largest gap rather than as a fraction of the line covered,
 * because a fraction has to be counted in bins and the only sensible bin width
 * is the sampling step — at which point two samples rounding into one bin reads
 * as a hole, and a route flown straight out and straight back, sampled end to
 * end, reports a third of its return unsurveyed. A gap is the thing actually
 * being asked about, and it needs no bins.
 */
export const RETURN_GAP_MAX_STEPS = 3;

/**
 * One leg, in the terms these checks need: which segment, where it ends, and
 * how high the aircraft is when it gets there.
 * @typedef {object} CheckedLeg
 * @property {string} segmentId
 * @property {LatLng} to
 * @property {number|null} altitudeMslM
 */

/**
 * @typedef {object} RouteChecksSpec
 * @property {LatLng} launch
 * @property {readonly CheckedLeg[]} legs
 * @property {CorridorRequest} corridor
 * @property {TerrainField|null} field       null when nothing has landed yet
 * @property {boolean} fieldPortWired        whether a field was asked for at all
 * @property {number|null} returnAltitudeMslM  the return policy's own height
 * @property {number|null} linkGhz
 */

/**
 * @typedef {object} RouteChecksResult
 * @property {Record<string, SegmentClearance>} clearance  by segment id
 * @property {ConstraintDraft[]} drafts
 */

/**
 * Every route-wide check, in one pass over the field.
 * @param {RouteChecksSpec} spec
 * @returns {RouteChecksResult}
 */
export function routeWideChecks(spec) {
  /** @type {Record<string, SegmentClearance>} */
  const clearance = {};
  /** @type {ConstraintDraft[]} */
  const drafts = [];
  if (spec.legs.length === 0) return { clearance, drafts };

  /* Not asked for is not the same as asked for and absent. With no field port
   * wired the pipeline already says W-DATA-TERRAIN-ABSENT and there is nothing
   * to add; with a port wired and nothing usable back, silence would be the one
   * unacceptable answer. */
  if (!spec.fieldPortWired) return { clearance, drafts };
  if (!usableField(spec.field, spec.corridor)) {
    drafts.push(draftConstraint('W-DATA-TERRAIN-SAMPLE-MISSING',
      spec.field
        ? 'The ground samples in hand describe an earlier version of this route, so no clearance, '
          + 'sightline or return check was run against them. Nothing below says the route is clear of '
          + 'terrain — it says nobody has looked at this version of it yet.'
        : 'The ground under this route has not been sampled yet. No clearance, sightline or return '
          + 'check has run — this is an unknown, not a clear route.'));
    return { clearance, drafts };
  }

  const field = /** @type {TerrainField} */ (spec.field);
  const centre = field.samples.filter((s) => s.track === 'centre');

  drafts.push(...clearanceChecks(spec, centre, clearance));
  drafts.push(...sightlineChecks(spec, centre, field.launchGroundMslM));
  drafts.push(...returnChecks(spec, centre));
  return { clearance, drafts };
}

/**
 * Whether a field in hand actually answers the corridor in hand.
 *
 * The test is geometric, not chronological. A field carries the `revision` it
 * was sampled for, but that stamp is the document's `updatedAt` and it moves for
 * a renamed mission as readily as for a moved waypoint — keying validity on it
 * would throw away good ground every time the pilot typed in the title box, and
 * replace real clearance figures with a data-absence constraint for a second.
 * What actually matters is whether this field describes *these* points: the same
 * mission, and every corridor sample present at the same id and the same place.
 *
 * Coordinates are compared as well as ids because ids are positional
 * (`seg_1:4`), so a moved launch point re-uses every id in the corridor while
 * describing entirely different ground.
 *
 * @param {TerrainField|null} field
 * @param {CorridorRequest} corridor
 * @returns {boolean}
 */
export function usableField(field, corridor) {
  if (!field || !Array.isArray(field.samples) || field.samples.length === 0) return false;
  if (field.missionId !== corridor.missionId) return false;
  for (const want of corridor.samples) {
    const have = field.byId[want.id];
    if (!have) return false;
    // ~0.1 m at the equator: far below the DEM's own 90 m posts, so this is an
    // identity check on the request, not a tolerance on the ground.
    if (Math.abs(have.lat - want.latitude) > 1e-6) return false;
    if (Math.abs(have.lng - want.longitude) > 1e-6) return false;
  }
  return true;
}

/* ---------- clearance ---------- */

/**
 * The ground under every leg, per corridor sample.
 * @param {RouteChecksSpec} spec
 * @param {readonly TerrainSample[]} centre
 * @param {Record<string, SegmentClearance>} out written into
 * @returns {ConstraintDraft[]}
 */
function clearanceChecks(spec, centre, out) {
  /** @type {ConstraintDraft[]} */
  const drafts = [];
  /** @type {{ segmentId: string, minM: number, atSampleId: string }|null} */
  let worst = null;
  /** @type {string[]} */
  const holed = [];

  for (const leg of spec.legs) {
    const mine = centre.filter((s) => s.segmentId === leg.segmentId);
    let minM = /** @type {number|null} */ (null);
    let atSampleId = /** @type {string|null} */ (null);
    let checked = 0;
    let missing = 0;

    for (const sample of mine) {
      if (sample.groundMslM == null) { missing++; continue; }
      if (leg.altitudeMslM == null) continue;
      // ADR 0003: the clearance over a sample is the cruise altitude expressed
      // as AGL at that sample, through the one site allowed to do it.
      const agl = convertAltitude({
        value: leg.altitudeMslM,
        from: 'msl',
        to: 'agl',
        terrainElevMslM: sample.groundMslM,
      });
      if (!agl.resolved || agl.value == null) continue;
      checked++;
      if (minM == null || agl.value < minM) { minM = agl.value; atSampleId = sample.id; }
    }

    out[leg.segmentId] = Object.freeze({ minM, atSampleId, checked, missing });
    if (missing > 0) holed.push(leg.segmentId);
    if (minM != null && atSampleId != null && (!worst || minM < worst.minM)) {
      worst = { segmentId: leg.segmentId, minM, atSampleId };
    }
  }

  if (worst && worst.minM <= TERRAIN_CLEARANCE_FLOOR_M) {
    drafts.push(draftConstraint('W-TERR-CLEARANCE',
      `The ground under this route reaches ${Math.abs(worst.minM).toFixed(0)} m above the altitude the `
      + 'aircraft is flying at. As planned this leg goes through the hill, not over it.',
      anchorAt('sample', worst.atSampleId)));
  } else if (worst && worst.minM < TERRAIN_CLEARANCE_WARN_M) {
    drafts.push(draftConstraint('W-TERR-CLEARANCE-LOW',
      `The closest this route comes to the ground is ${worst.minM.toFixed(0)} m, under the `
      + `${TERRAIN_CLEARANCE_WARN_M} m this tool treats as clear. The DEM is bare earth — whatever is `
      + 'growing or standing there is not in this figure.',
      anchorAt('sample', worst.atSampleId)));
  }

  if (holed.length > 0) {
    const missingCount = holed.reduce((a, id) => a + out[id].missing, 0);
    drafts.push(draftConstraint('W-DATA-TERRAIN-SAMPLE-MISSING',
      `${missingCount} point${missingCount === 1 ? '' : 's'} under this route `
      + `${missingCount === 1 ? 'has' : 'have'} no elevation, across `
      + `${holed.length} leg${holed.length === 1 ? '' : 's'}. Clearance there was not checked and is not `
      + 'known — treat those stretches as unsurveyed rather than clear.',
      anchorAt('segment', holed[0])));
  }

  return drafts;
}

/* ---------- the sightline to each waypoint ---------- */

/**
 * The radio link from the pilot to the aircraft at each waypoint, over the
 * corridor's own ground.
 * @param {RouteChecksSpec} spec
 * @param {readonly TerrainSample[]} centre
 * @param {number|null} launchGroundMslM
 * @returns {ConstraintDraft[]}
 */
function sightlineChecks(spec, centre, launchGroundMslM) {
  /** @type {ConstraintDraft[]} */
  const drafts = [];
  if (launchGroundMslM == null || !(Number(spec.linkGhz) > 0)) return drafts;
  const ghz = Number(spec.linkGhz);
  const txMslM = launchGroundMslM + ANTENNA_HEIGHT_M;

  /** @type {{ segmentId: string, sampleId: string, marginM: number }|null} */
  let worstLos = null;
  /** @type {{ segmentId: string, sampleId: string, marginM: number }|null} */
  let worstFresnel = null;

  for (const leg of spec.legs) {
    if (leg.altitudeMslM == null) continue;
    const totalKm = distanceKm(spec.launch, leg.to);
    if (!(totalKm > 0)) continue;

    /** @type {{ id: string, alongM: number, groundMslM: number }[]} */
    const obstacles = [];
    for (const sample of centre) {
      if (sample.groundMslM == null) continue;
      const off = trackOffsetKm(spec.launch, leg.to, { lat: sample.lat, lng: sample.lng });
      if (!(off.alongKm > 0) || !(off.alongKm < totalKm)) continue;
      if (Math.abs(off.crossKm) * 1000 > SIGHTLINE_CORRIDOR_M) continue;
      obstacles.push({ id: sample.id, alongM: off.alongKm * 1000, groundMslM: sample.groundMslM });
    }

    const reading = worstFresnelMargin({
      txMslM,
      rxMslM: leg.altitudeMslM,
      totalM: totalKm * 1000,
      ghz,
      obstacles,
      groundRefMslM: launchGroundMslM,
    });
    // Nothing on the ray is not a clear ray — it is a ray with nothing sampled
    // on it, and the clearance check above already reports the holes.
    if (reading.counted === 0) continue;

    if (reading.los.atId && (!worstLos || reading.los.marginM < worstLos.marginM)) {
      worstLos = { segmentId: leg.segmentId, sampleId: reading.los.atId, marginM: reading.los.marginM };
    }
    if (reading.fresnel.atId && (!worstFresnel || reading.fresnel.marginM < worstFresnel.marginM)) {
      worstFresnel = {
        segmentId: leg.segmentId, sampleId: reading.fresnel.atId, marginM: reading.fresnel.marginM,
      };
    }
  }

  if (worstLos && worstLos.marginM < 0) {
    drafts.push(draftConstraint('W-RF-LOS-BLOCKED',
      `Ground on the line from the launch point to this waypoint stands ${Math.abs(worstLos.marginM).toFixed(0)} m `
      + `above the sightline at ${(ghz * 1000).toFixed(0)} MHz. With the aircraft out there the pilot has `
      + 'no line of sight to it at all.',
      anchorAt('sample', worstLos.sampleId)));
  } else if (worstFresnel && worstFresnel.marginM < 0) {
    drafts.push(draftConstraint('W-RF-FRESNEL',
      `Ground on the line to this waypoint eats ${Math.abs(worstFresnel.marginM).toFixed(0)} m into the `
      + `first Fresnel zone at ${(ghz * 1000).toFixed(0)} MHz. The ray still passes over it, but this is `
      + 'where the picture starts breaking up.',
      anchorAt('sample', worstFresnel.sampleId)));
  }

  return drafts;
}

/* ---------- the flight home from each waypoint ---------- */

/**
 * The direct return from every waypoint: ground on the line, and energy.
 * @param {RouteChecksSpec} spec
 * @param {readonly TerrainSample[]} centre
 * @returns {ConstraintDraft[]}
 */
function returnChecks(spec, centre) {
  /** @type {ConstraintDraft[]} */
  const drafts = [];
  const spacingKm = Math.max(spec.corridor.spacingM, 1) / 1000;

  /** @type {{ segmentId: string, sampleId: string, intrusionM: number }|null} */
  let blocked = null;
  /** @type {string[]} */
  const unsurveyed = [];

  for (const leg of spec.legs) {
    const homeKm = distanceKm(leg.to, spec.launch);
    if (!(homeKm > 0)) continue;
    // The height the aircraft comes home at: the return policy's own, or — with
    // none authored — the height it is already at when it turns. Never a guess.
    const returnMslM = spec.returnAltitudeMslM ?? leg.altitudeMslM;
    /** Where along the line home each usable sample falls, km. */
    /** @type {number[]} */
    const along = [];

    for (const sample of centre) {
      if (sample.groundMslM == null) continue;
      const off = trackOffsetKm(leg.to, spec.launch, { lat: sample.lat, lng: sample.lng });
      if (!(off.alongKm >= 0) || off.alongKm > homeKm) continue;
      if (Math.abs(off.crossKm) * 1000 > SIGHTLINE_CORRIDOR_M) continue;
      along.push(off.alongKm);
      if (returnMslM == null) continue;
      const agl = convertAltitude({
        value: returnMslM, from: 'msl', to: 'agl', terrainElevMslM: sample.groundMslM,
      });
      if (!agl.resolved || agl.value == null || agl.value > TERRAIN_CLEARANCE_FLOOR_M) continue;
      const intrusionM = -agl.value;
      if (!blocked || intrusionM > blocked.intrusionM) {
        blocked = { segmentId: leg.segmentId, sampleId: sample.id, intrusionM };
      }
    }

    if (largestGapKm(along, homeKm) > RETURN_GAP_MAX_STEPS * spacingKm) {
      unsurveyed.push(leg.segmentId);
    }
  }


  if (blocked) {
    const hit = /** @type {{ segmentId: string, sampleId: string, intrusionM: number }} */ (blocked);
    drafts.push(draftConstraint('W-RETURN-TERRAIN-BLOCKED',
      `Flying straight home from a waypoint on this route runs into ground ${hit.intrusionM.toFixed(0)} m `
      + 'above the return altitude. A failsafe return-to-home from there does not clear the terrain — it '
      + 'flies into it.',
      anchorAt('sample', hit.sampleId)));
  }

  if (unsurveyed.length > 0) {
    drafts.push(draftConstraint('W-RETURN-TERRAIN-UNKNOWN',
      `The direct line home from ${unsurveyed.length} of this route's waypoint`
      + `${unsurveyed.length === 1 ? '' : 's'} crosses ground the corridor never sampled. Nothing here `
      + 'says that return is clear; it says the ground on it was not looked at.',
      anchorAt('segment', unsurveyed[0])));
  }

  return drafts;
}

/**
 * The longest run of a `lengthKm` line with no sample on it, in km. Both ends
 * count: a line whose samples all sit in its first third is unsurveyed for the
 * other two, and a gap measured only between samples would miss that entirely.
 *
 * @param {readonly number[]} alongKm positions along the line, any order
 * @param {number} lengthKm
 * @returns {number}
 */
function largestGapKm(alongKm, lengthKm) {
  if (alongKm.length === 0) return lengthKm;
  const sorted = [...alongKm].sort((a, b) => a - b);
  let gap = sorted[0];                              // the run before the first
  for (let i = 1; i < sorted.length; i++) {
    gap = Math.max(gap, sorted[i] - sorted[i - 1]);
  }
  return Math.max(gap, lengthKm - sorted[sorted.length - 1]); // …and after the last
}

/* ---------- the energy of the flight home ---------- */

/**
 * @typedef {object} ReturnEnergySpec
 * @property {readonly { segmentId: string }[]} legs
 * @property {readonly RouteHold[]} holds
 * @property {number|null} deliveredWh
 * @property {boolean} routeFits              what planRoute already decided
 * @property {readonly number[]} verticalWhTo cumulative climb/descent Wh at each waypoint
 */

/**
 * The waypoints whose flight home stops fitting once M3b's climb is counted.
 *
 * A separate entry point from the ground checks above because it needs a figure
 * they run before: the per-leg vertical energy is computed while the segment
 * records are being built, which is after the clearance those records carry.
 * Two seams rather than one pass that has to be handed a half-filled spec.
 *
 * Deliberately silent when `planRoute` has already called the route short:
 * W-ROUTE-RESERVE-SHORT is that finding, and repeating it under a second code
 * would be the same fact twice. What is new here is the vertical energy the
 * route integrator never saw — a waypoint 300 m up cost the pack a climb before
 * the reserve was ever measured against it.
 *
 * @param {ReturnEnergySpec} spec
 * @returns {ConstraintDraft[]}
 */
export function returnEnergyChecks(spec) {
  if (!spec.routeFits || spec.deliveredWh == null || !(spec.deliveredWh > 0)) return [];
  /** @type {{ segmentId: string, overWh: number }|null} */
  let worst = null;
  spec.holds.forEach((hold, k) => {
    const climbWh = spec.verticalWhTo[k] ?? 0;
    if (!(climbWh > 0)) return;
    const overWh = hold.needWh + climbWh - Number(spec.deliveredWh);
    if (!(overWh > 0)) return;
    const leg = spec.legs[k];
    if (!leg) return;
    if (!worst || overWh > worst.overWh) worst = { segmentId: leg.segmentId, overWh };
  });
  if (!worst) return [];
  const short = /** @type {{ segmentId: string, overWh: number }} */ (worst);
  return [draftConstraint('W-RETURN-ENERGY-SHORT',
    `Once the climb to it is paid for, this waypoint commits the pack to ${short.overWh.toFixed(1)} Wh more `
    + 'than it delivers — the flight home from there no longer fits. The route totals do not show this '
    + 'because the route integrator costs level flight only.',
    anchorAt('segment', short.segmentId))];
}
