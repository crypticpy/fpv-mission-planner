// analyze.js — one pass over a mission, one snapshot out.
//
// Before this module the app computed its answer in the middle of a render:
// app.js probed for a radius, planned, fetched terrain, planned again, pushed
// terrain warnings onto the plan's own array, computed the link, pushed those
// on too, patched one warning's text in place, and handed the mutated object to
// six renderers. Every one of those steps was correct; the arrangement was the
// problem. Nothing could be recomputed without re-rendering, nothing could be
// exported, and a slow terrain fetch could land after the inputs had moved on.
//
// The pipeline is the same arithmetic in one place, with the impure parts held
// at arm's length (ADR 0007): the planner and the route integrator are handed
// in, the terrain and link providers are handed in and may be null, and a null
// provider produces a stated absence rather than silence. What comes out is an
// AnalysisSnapshot — immutable, provenanced, cache-keyed, and safe to hand to a
// renderer, a brief, or an exporter.
//
// Three things this module deliberately does *not* do:
//
//   It does not re-derive physics. `deps.plan` is planMission and `deps.routePlan`
//     is planRoute; every number in the snapshot came out of one of them. The
//     parity test exists to keep it that way.
//
//   It does not do the vertical arithmetic itself. M3b charges climb and
//     descent, reads the air and the wind at each leg's own height, and checks
//     the ground under every segment — but the equations live in
//     domain/vertical.js and domain/fresnel.js, and the per-leg and route-wide
//     bookkeeping around them lives in vertical-flight.js and route-checks.js.
//     What stays here is the pass that calls them in order.
//
//   It does not import a provider. Not terrain.js, not rf.js, not state.js, not
//     a render module — the layer check enforces it and the injected ports make
//     it easy to honour. The terrain field arrives the same way everything else
//     impure does: as a nullable accessor in `deps`.

import { fovDeg, orbitAirspeedMs, shotGeometry, subjectFraming } from '../../domain/camera.js';
import { destination, distanceKm, bearingTo } from '../../domain/geo.js';
import { CAMERA_INTENTS } from '../../domain/mission/compile.js';
import { HOLD_INTENTS } from '../../domain/mission/mission-schema.js';
import { U, powerAtSpeed } from '../../domain/physics.js';
import {
  ANALYSIS_MODEL_VERSION, CORRIDOR_MAX_SAMPLES, CORRIDOR_MIN_SPACING_M,
  CORRIDOR_SAMPLE_TARGET, CORRIDOR_WIDTH_M,
  anchorAt, hashKey, provenanceOf, stableStringify,
} from './analysis-contracts.js';
import { draftConstraint, draftFromLegacy, finalizeConstraints } from './constraints.js';
import { returnEnergyChecks, routeWideChecks } from './route-checks.js';
import { legVerticalFlight, verticalFlightDrafts } from './vertical-flight.js';
import { windAdvisory } from './wind-advisory.js';

/**
 * @typedef {import('../../domain/mission/mission-schema.js').MissionDocumentV1} MissionDocumentV1
 * @typedef {import('../../domain/mission/mission-schema.js').Segment} Segment
 * @typedef {import('../../domain/mission/mission-schema.js').Subject} Subject
 * @typedef {import('../../domain/mission/mission-schema.js').Waypoint} Waypoint
 * @typedef {import('../../domain/camera.js').Fov} Fov
 * @typedef {import('./analysis-contracts.js').ConstraintAnchor} ConstraintAnchor
 * @typedef {import('./analysis-contracts.js').SegmentShot} SegmentShot
 * @typedef {import('./analysis-contracts.js').AnalysisInputs} AnalysisInputs
 * @typedef {import('./analysis-contracts.js').AnalysisProvenance} AnalysisProvenance
 * @typedef {import('./analysis-contracts.js').AnalysisRevision} AnalysisRevision
 * @typedef {import('./analysis-contracts.js').AnalysisSnapshot} AnalysisSnapshot
 * @typedef {import('./analysis-contracts.js').CorridorRequest} CorridorRequest
 * @typedef {import('./analysis-contracts.js').CorridorSample} CorridorSample
 * @typedef {import('./analysis-contracts.js').LegacyWarning} LegacyWarning
 * @typedef {import('./analysis-contracts.js').LinkResult} LinkResult
 * @typedef {import('./analysis-contracts.js').HalfSweep} HalfSweep
 * @typedef {import('./analysis-contracts.js').MissionFootprint} MissionFootprint
 * @typedef {import('./analysis-contracts.js').MissionPlan} MissionPlan
 * @typedef {import('./analysis-contracts.js').RouteResult} RouteResult
 * @typedef {import('./analysis-contracts.js').SweepKit} SweepKit
 * @typedef {import('./analysis-contracts.js').SegmentAnalysis} SegmentAnalysis
 * @typedef {import('./analysis-contracts.js').SegmentClearance} SegmentClearance
 * @typedef {import('./analysis-contracts.js').SolvedPlan} SolvedPlan
 * @typedef {import('./analysis-contracts.js').AdvisoryField} AdvisoryField
 * @typedef {import('./analysis-contracts.js').AdvisoryGridReading} AdvisoryGridReading
 * @typedef {import('./analysis-contracts.js').SoundingReading} SoundingReading
 * @typedef {import('./constraints.js').ConstraintDraft} ConstraintDraft
 * @typedef {import('../terrain/terrain-contracts.js').AdvisoryGridField} AdvisoryGridField
 * @typedef {import('../terrain/terrain-contracts.js').TerrainField} TerrainField
 * @typedef {import('./vertical-flight.js').TaggedLegFlight} TaggedLegFlight
 */

/** @typedef {{ lat: number, lng: number }} LatLng */

/**
 * What one analysis pass is asked about.
 * @typedef {object} AnalysisRequest
 * @property {MissionDocumentV1} doc
 * @property {AnalysisInputs} inputs   the bag `missionInputs()` builds
 * @property {AnalysisRevision} revision
 */

/**
 * The ports. `plan` and `routePlan` are required and are the pure domain
 * functions — they are injected rather than imported because the domain
 * modules they live in are not yet on the typecheck ratchet, and a static
 * import would drag their unannotated bodies into `tsc --noEmit`. Everything
 * below them is impure and may be null, which is a statement the snapshot then
 * carries as an `unknown`-severity constraint.
 *
 * `terrainField` is M3b's seam and it is an accessor rather than a value on
 * purpose. Corridor sampling is asynchronous and lands whenever the network
 * lets it; the host holds the newest field it has accepted and hands the
 * pipeline a way to read it at the instant of the pass. That keeps this module
 * synchronous and pure — one call, one answer, no awaiting — while the freshness
 * question stays where it belongs, with the host that owns the clock. What makes
 * the memo honest is `terrainSignature`: the host derives it from the field it
 * is holding, so a new field is a new question rather than a cache hit on the
 * old one.
 *
 * @typedef {object} AnalysisDeps
 * @property {(inputs: AnalysisInputs) => MissionPlan} plan
 * @property {(plan: SolvedPlan, opts: { launch: LatLng, waypoints: LatLng[],
 *            windFromDeg: number, inputs: AnalysisInputs }) => RouteResult} routePlan
 * @property {((plan: SolvedPlan) => LinkResult|null)|null} [linkStats]
 * @property {((plan: SolvedPlan, link: LinkResult|null) => LegacyWarning[])|null} [linkWarnings]
 * @property {((plan: SolvedPlan) => LegacyWarning[])|null} [terrainWarnings]
 * @property {(() => { points?: unknown[], spanKm?: number }|null)|null} [elevationProfile]
 * @property {((plan: SolvedPlan) => string|null)|null} [strandedNote]
 * @property {SweepKit|null} [sweepKit] the footprint geometry; absent, the
 *   snapshot carries `footprint: null` rather than half a ring
 * @property {(() => TerrainField|null)|null} [terrainField] the corridor's ground
 * @property {(() => unknown)|null} [windLevels] the forecast's published wind levels
 * @property {(() => AdvisoryGridReading)|null} [advisoryGrid] M5's area grid, read
 *   the same way and for the same reason `terrainField` is: the host samples it
 *   asynchronously and this pass reads whatever has landed. It answers with the
 *   field *and* whether a sample for this route is still in flight, because
 *   "not yet" and "there is none" are different statements to the pilot
 * @property {(() => SoundingReading)|null} [sounding] the pressure-level sounding
 *   and the point it was fetched for
 * @property {number|null} [windLevelM] the height the planning wind was read at
 * @property {number|null} [linkGhz] the band the pilot selected
 * @property {string|null} [advisorySignature] identifies the active area grid
 * @property {string|null} [terrainSignature] identifies the active terrain data
 * @property {string|null} [forecastSignature] overrides the document's own
 * @property {Partial<AnalysisProvenance>} [provenance] what the callers know
 * @property {() => string} [now] ISO instant; injected for deterministic tests
 */

/* ---------- the planned bearing ---------- */

/**
 * The course the footprint plan flies out on. This is the same rule
 * src/terrain.js's `plannedCourseDeg()` applies, deliberately restated here
 * rather than imported: that module holds a fetch and a module-level cache, and
 * the application layer may not import it. The duplication is pinned by a test
 * that asserts the two agree on every mode.
 *
 * @param {number|undefined} windFromDeg meteorological, degrees from north
 * @param {string|undefined} windMode 'headOut' | 'tailOut' | 'cross'
 * @returns {number}
 */
export function primaryBearingDeg(windFromDeg, windMode) {
  const from = Number.isFinite(windFromDeg) ? /** @type {number} */ (windFromDeg) : 0;
  const up = ((Math.round(from) % 360) + 360) % 360;
  if (windMode === 'tailOut') return (up + 180) % 360;
  if (windMode === 'cross') return (up + 90) % 360;
  return up;
}

/* ---------- corridor geometry ---------- */

/** One leg of the authored route, resolved to coordinates. */
/** @typedef {{ segment: Segment, from: LatLng, to: LatLng, distKm: number, courseDeg: number }} DocLeg */

/**
 * The document's legs in flight order. A segment whose `to` names a waypoint
 * that is not in the list is skipped rather than guessed at — the schema's
 * validator is the place that complains about it.
 * @param {MissionDocumentV1} doc
 * @returns {DocLeg[]}
 */
function documentLegs(doc) {
  /** @type {Map<string, Waypoint>} */
  const byId = new Map();
  for (const w of doc.route.waypoints) byId.set(w.id, w);
  /** @type {DocLeg[]} */
  const legs = [];
  let from = { lat: doc.launch.latitude, lng: doc.launch.longitude };
  for (const segment of doc.route.segments) {
    const w = byId.get(segment.to);
    if (!w) continue;
    const to = { lat: w.latitude, lng: w.longitude };
    legs.push({ segment, from, to, distKm: distanceKm(from, to), courseDeg: bearingTo(from, to) });
    from = to;
  }
  return legs;
}

/**
 * The along-track step for a corridor of this length: aim for the same sample
 * count src/terrain.js's profile uses, never finer than the DEM behind it, and
 * never more points than one request should carry. Rounded to a tenth of a
 * metre so the figure is stable in a cache key.
 * @param {number} totalKm
 * @returns {number}
 */
function corridorSpacingM(totalKm) {
  const totalM = totalKm * 1000;
  if (!(totalM > 0)) return CORRIDOR_MIN_SPACING_M;
  let spacing = Math.max(totalM / (CORRIDOR_SAMPLE_TARGET - 1), CORRIDOR_MIN_SPACING_M);
  const maxSteps = CORRIDOR_MAX_SAMPLES - 1;
  if (totalM / spacing > maxSteps) spacing = totalM / maxSteps;
  return Math.round(spacing * 10) / 10;
}

/**
 * What the ground under this mission would have to be, for anyone able to
 * answer it. Samples run launch-first along the authored route; a mission with
 * no waypoints yet falls back to the planned bearing out to the turnaround,
 * which is exactly the profile the footprint has always been drawn against.
 *
 * Sample ids are `${segmentId}:${step}` — deterministic, so an elevation cache
 * keyed on them survives a recompute, and readable, so a constraint anchored to
 * one names the leg it is on.
 *
 * @param {MissionDocumentV1} doc
 * @param {DocLeg[]} legs
 * @param {number} bearingDeg the fallback course
 * @param {number} fallbackKm the fallback span (the plan's radius)
 * @returns {CorridorRequest}
 */
function buildCorridor(doc, legs, bearingDeg, fallbackKm) {
  const launch = { lat: doc.launch.latitude, lng: doc.launch.longitude };
  /** @type {{ prefix: string, segmentId: string|null, from: LatLng, distKm: number, courseDeg: number }[]} */
  const spans = legs.map((l) => ({
    prefix: l.segment.id, segmentId: l.segment.id, from: l.from, distKm: l.distKm, courseDeg: l.courseDeg,
  }));
  if (spans.length === 0 && fallbackKm > 0) {
    spans.push({ prefix: 'primary', segmentId: null, from: launch, distKm: fallbackKm, courseDeg: bearingDeg });
  }

  const totalKm = spans.reduce((a, s) => a + s.distKm, 0);
  const spacingM = corridorSpacingM(totalKm);
  const headingDeg = spans.length > 0 ? spans[0].courseDeg : bearingDeg;

  /** @type {CorridorSample[]} */
  const samples = [{
    id: 'launch:0',
    latitude: launch.lat,
    longitude: launch.lng,
    distanceKm: 0,
    bearingDeg: headingDeg,
    segmentId: spans.length > 0 ? spans[0].segmentId : null,
  }];
  let cumulativeKm = 0;
  for (const span of spans) {
    const steps = Math.max(1, Math.round(span.distKm * 1000 / spacingM));
    for (let k = 1; k <= steps; k++) {
      const alongKm = span.distKm * k / steps;
      const [lat, lng] = destination(span.from.lat, span.from.lng, span.courseDeg, alongKm);
      samples.push({
        id: `${span.prefix}:${k}`,
        latitude: lat,
        longitude: lng,
        distanceKm: cumulativeKm + alongKm,
        bearingDeg: span.courseDeg,
        segmentId: span.segmentId,
      });
    }
    cumulativeKm += span.distKm;
  }

  return Object.freeze({
    missionId: doc.id,
    revision: doc.updatedAt,
    samples,
    spacingM,
    corridorWidthM: CORRIDOR_WIDTH_M,
  });
}

/* ---------- the shot ---------- */

/**
 * A point as metres east and north of `origin` — the local frame
 * `domain/camera.js` works in, built from the same great-circle distance and
 * bearing every other figure in this module comes from, so a shot and the leg
 * it belongs to cannot disagree about where anything is.
 *
 * The tangent plane is flat. Over a leg of a few kilometres that costs far less
 * than the metre the authored altitudes are rounded to, and the alternative is
 * a projection this module would then have to keep honest.
 * @param {LatLng} origin
 * @param {LatLng} p
 * @returns {{ eM: number, nM: number }}
 */
function enuOffset(origin, p) {
  const rangeM = distanceKm(origin, p) * 1000;
  const brgRad = bearingTo(origin, p) * Math.PI / 180;
  return { eM: rangeM * Math.sin(brgRad), nM: rangeM * Math.cos(brgRad) };
}

/**
 * What one leg makes of the subject it frames (ADR 0011 §3), computed once here
 * so the map, the 3D scene, the inspector and the brief read it rather than
 * repeat it.
 *
 * The altitudes handed in are the ones the rest of the analysis already
 * resolved for this leg — not a second resolution of the same question — and an
 * unresolved one takes the whole geometry block to null, because
 * `shotGeometry` refuses a shot missing one of its three points rather than
 * inventing a height for it. Framing is separately null: it needs the subject's
 * radius and the scene's lens, and a scene with neither still has a distance
 * and a screen direction worth showing.
 * @param {DocLeg} docLeg
 * @param {Subject} subject
 * @param {number|null} startMslM  the altitude the leg departs at
 * @param {number|null} endMslM    the altitude it arrives at
 * @param {Fov|null} fov           the scene's camera profile, resolved once
 * @returns {SegmentShot}
 */
function shotFor(docLeg, subject, startMslM, endMslM, fov) {
  const subjectMslM = typeof subject.elevationMslM === 'number' ? subject.elevationMslM : null;
  const geometry = startMslM != null && endMslM != null && subjectMslM != null
    ? shotGeometry({
      start: { eM: 0, nM: 0, uM: startMslM },
      end: { ...enuOffset(docLeg.from, docLeg.to), uM: endMslM },
      subject: {
        ...enuOffset(docLeg.from, { lat: subject.latitude, lng: subject.longitude }),
        uM: subjectMslM,
      },
    })
    : null;
  const radiusM = typeof subject.radiusM === 'number' ? subject.radiusM : null;
  return Object.freeze({
    subjectId: subject.id,
    subjectName: subject.name,
    distanceStartM: geometry ? geometry.distanceStartM : null,
    distanceEndM: geometry ? geometry.distanceEndM : null,
    bearingToSubjectDeg: geometry ? geometry.bearingToSubjectDeg : null,
    elevationAngleDeg: geometry ? geometry.elevationAngleDeg : null,
    screenDirection: geometry ? geometry.screenDirection : null,
    framingStart: geometry ? subjectFraming(geometry.distanceStartM, radiusM, fov) : null,
    framingEnd: geometry ? subjectFraming(geometry.distanceEndM, radiusM, fov) : null,
    subjectRadiusM: radiusM,
    fov,
  });
}

/**
 * The three findings a shot can raise on its own (ADR 0011 §4). All of them
 * anchor to the segment and name the subject in their text: `AnchorScope` stays
 * closed, and prose already carries the pointer an extra scope would have.
 *
 * None of these is about energy or ground clearance. A cinematic segment goes
 * through every gate a transit leg does; these sit beside those findings rather
 * than in front of them.
 * @param {Segment} seg
 * @param {Subject|null} subject   the subject the scene still holds, or null
 * @param {number|null} holdAirspeedMs  what staying here asks of the airframe
 * @param {number|null} maxSpeedMs      what the aircraft snapshot says it has
 * @param {ConstraintAnchor} anchor
 * @returns {ConstraintDraft[]}
 */
function shotDrafts(seg, subject, holdAirspeedMs, maxSpeedMs, anchor) {
  /** @type {ConstraintDraft[]} */
  const drafts = [];
  const around = subject ? ` around '${subject.name}'` : '';

  if (subject == null && CAMERA_INTENTS.includes(seg.intent)) {
    drafts.push(draftConstraint(
      'W-SHOT-SUBJECT-MISSING',
      `This leg is authored as a '${seg.intent}' shot but frames nothing — no subject is attached to it, `
      + 'so its distance, framing and screen direction are absent rather than zero.',
      anchor,
    ));
  }

  if (seg.intent === 'orbit') {
    const orbit = seg.camera?.orbit ?? null;
    const radiusM = orbit && typeof orbit.radiusM === 'number' ? orbit.radiusM : null;
    const subjectRadiusM = subject && typeof subject.radiusM === 'number' ? subject.radiusM : null;
    if (radiusM == null) {
      drafts.push(draftConstraint(
        'W-SHOT-ORBIT-RADIUS',
        `This orbit${around} has no radius authored, and none is inferable from the route — the circle `
        + 'it flies is undetermined, so nothing here says how close to the subject it comes.',
        anchor,
      ));
    } else if (subjectRadiusM != null && radiusM <= subjectRadiusM) {
      drafts.push(draftConstraint(
        'W-SHOT-ORBIT-RADIUS',
        `This orbit is flown at ${radiusM} m${around || ' around its subject'}, whose own radius is `
        + `${subjectRadiusM} m — the circle is inside the thing it is meant to be circling.`,
        anchor,
      ));
    }
  }

  if (holdAirspeedMs != null && maxSpeedMs != null && holdAirspeedMs > maxSpeedMs) {
    const asks = seg.intent === 'orbit'
      ? `The upwind quarter of this orbit${around}`
      : `Holding station here${subject ? ` on '${subject.name}'` : ''}`;
    drafts.push(draftConstraint(
      'W-SHOT-HOLD-WIND',
      `${asks} needs ${holdAirspeedMs.toFixed(1)} m/s of airspeed against the planning wind, past the `
      + `${maxSpeedMs} m/s this airframe is recorded at — the shot cannot be flown as authored, whatever `
      + 'the energy budget says.',
      anchor,
    ));
  }

  return drafts;
}

/* ---------- per-segment reading ---------- */

/**
 * What `readSegments` needs beyond the document: the plan's own figures, the
 * air it was solved in, and the forecast levels — all of them read, none of
 * them re-derived.
 * @typedef {object} SegmentContext
 * @property {SolvedPlan} plan
 * @property {number} massKg
 * @property {number} etaProp
 * @property {number} planRho
 * @property {number} refElevM
 * @property {number} refTempC
 * @property {number} rhPct
 * @property {number|null} launchElevMslM
 * @property {unknown} windLevels
 * @property {Record<string, SegmentClearance>} clearance
 */

/**
 * @param {MissionDocumentV1} doc
 * @param {DocLeg[]} legs
 * @param {RouteResult|null} route
 * @param {SegmentContext} ctx
 * @returns {{ segments: Record<string, SegmentAnalysis>, holdWh: number, verticalWh: number,
 *            verticalWhTo: number[], flights: TaggedLegFlight[], drafts: ConstraintDraft[] }}
 */
function readSegments(doc, legs, route, ctx) {
  const hoverW = ctx.plan.hover.pW;
  /* The scene, resolved once for the whole pass: the lens every framing fraction
   * is taken through, and the subjects segments point at by id. */
  const fov = fovDeg(doc.scene?.cameraProfile ?? null);
  const subjects = new Map((doc.scene?.subjects ?? []).map((s) => [s.id, s]));
  const maxSpeedMs = typeof doc.aircraftSnapshot?.maxSpeedMs === 'number'
    ? doc.aircraftSnapshot.maxSpeedMs
    : null;
  /* Non-negative and finite, because it is about to be handed to the rotor model
   * and to `orbitAirspeedMs`, both of which refuse a negative speed. */
  const windMs = typeof ctx.plan.wind.planningMs === 'number' && ctx.plan.wind.planningMs > 0
    ? ctx.plan.wind.planningMs
    : 0;
  /** @type {Record<string, SegmentAnalysis>} */
  const segments = {};
  /** @type {ConstraintDraft[]} */
  const drafts = [];
  /** @type {TaggedLegFlight[]} */
  const flights = [];
  /** @type {number[]} */
  const verticalWhTo = [];
  let holdWh = 0;
  let verticalWh = 0;

  legs.forEach((docLeg, i) => {
    const seg = docLeg.segment;
    const anchor = anchorAt('segment', seg.id);
    // Out-legs come back in document order, so leg i is segment i whatever the
    // return policy appended after them.
    const leg = route && !route.empty ? (route.legs[i] ?? null) : null;
    /** @type {string[]} */
    const explanations = [];

    const holdsStation = HOLD_INTENTS.includes(seg.intent);
    const holdS = holdsStation && typeof seg.holdS === 'number' && seg.holdS > 0
      ? seg.holdS
      : null;
    /* What the aircraft actually has to fly to stay where the shot wants it.
     * Station-keeping over a point is flying at the wind's own speed — the same
     * physics route.js has always charged loiter-at-range at — and an orbit adds
     * its tangential rate to that on the upwind quarter, which is a bound rather
     * than an average (ADR 0011 §3). In calm air this is powerAtSpeed(cfg, 0),
     * which *is* hover power, so a windless plan's numbers do not move at all.
     * An unsolved leg has no tangential rate to add, so its orbit degrades to
     * station-keeping — the route is already flagged unflyable above that. */
    const tangentialMs = leg && typeof leg.vgMs === 'number' && leg.vgMs > 0 ? leg.vgMs : 0;
    const holdAirspeedMs = !holdsStation
      ? null
      : seg.intent === 'orbit'
        // Both inputs are clamped non-negative and finite, so the null branch is
        // unreachable; it degrades to station-keeping rather than to a NaN.
        ? (orbitAirspeedMs(tangentialMs, windMs) ?? windMs)
        : windMs;
    const holdPowerW = holdAirspeedMs == null ? null : powerAtSpeed(ctx.plan.cfg, holdAirspeedMs);
    const segHoldWh = holdS != null && holdPowerW != null ? holdS * holdPowerW / 3600 : 0;
    if (holdS) {
      holdWh += segHoldWh;
      explanations.push(seg.intent === 'orbit' ? 'X-HOLD-ORBIT-AIRSPEED' : 'X-HOLD-STATION-POWER');
    }

    const speedMode = seg.speedPolicy.mode;
    const speedHonoured = speedMode === 'cruise';
    if (!speedHonoured) {
      explanations.push('X-SPEED-POLICY-FALLBACK');
      drafts.push(draftConstraint(
        'W-SPEED-POLICY-UNSUPPORTED',
        speedMode === 'fixed' && seg.speedPolicy.targetMs != null
          ? `This leg was authored at ${seg.speedPolicy.targetMs} m/s, but the route is solved at the `
            + 'plan\'s own cruise policy — the numbers beside it are the cruise ones, not that speed.'
          : `This leg was authored as a '${speedMode}' segment, but the route is solved at the plan's own `
            + 'cruise policy — the numbers beside it are the cruise ones.',
        anchor,
      ));
    }

    const altitudeMslM = typeof seg.altitude.resolvedMslM === 'number' ? seg.altitude.resolvedMslM : null;
    const prevMslM = i === 0
      ? (typeof doc.launch.elevationMslM === 'number' ? doc.launch.elevationMslM : null)
      : (typeof legs[i - 1].segment.altitude.resolvedMslM === 'number'
        ? legs[i - 1].segment.altitude.resolvedMslM
        : null);
    const altitudeDeltaM = altitudeMslM != null && prevMslM != null ? altitudeMslM - prevMslM : null;
    if (altitudeMslM == null) {
      explanations.push('X-ALT-UNRESOLVED');
      drafts.push(draftConstraint(
        'W-DATA-ALTITUDE-UNRESOLVED',
        `This leg's altitude (${seg.altitude.authored} m ${seg.altitude.reference}) has no metres-MSL `
        + 'figure yet, so nothing here was derived from it — not the climb, not the clearance.',
        anchor,
      ));
    }

    /* The level power this leg already costs, from the leg the route integrator
     * solved — never re-derived, so the descent's "no credit below level flight"
     * rule is measured against the same number on screen beside it. An unsolved
     * leg falls back to hover, which is the conservative stand-in. */
    const levelPowerW = leg && leg.whLeg != null && leg.timeMin != null && leg.timeMin > 0
      ? leg.whLeg * 60 / leg.timeMin
      : hoverW;
    const flight = legVerticalFlight({
      massKg: ctx.massKg,
      etaProp: ctx.etaProp,
      hoverW,
      levelPowerW,
      planRho: ctx.planRho,
      altitudeMslM,
      deltaM: altitudeDeltaM,
      launchElevMslM: ctx.launchElevMslM,
      refElevM: ctx.refElevM,
      refTempC: ctx.refTempC,
      rhPct: ctx.rhPct,
      windLevels: ctx.windLevels,
    });
    flights.push({ segmentId: seg.id, flight });
    if (flight.vertical) {
      verticalWh += flight.vertical.wh;
      explanations.push('X-ALT-VERTICAL-CHARGED');
    }
    verticalWhTo.push(verticalWh);

    const clearance = ctx.clearance[seg.id] ?? null;
    if (clearance && clearance.missing > 0) explanations.push('X-TERR-SAMPLE-MISSING');

    /* The shot, against the altitudes resolved directly above — the same two
     * figures the climb and the clearance were taken from, not a second answer
     * to the same question (ADR 0002). */
    const subjectRef = typeof seg.subjectRef === 'string' ? seg.subjectRef : null;
    const subject = subjectRef != null ? (subjects.get(subjectRef) ?? null) : null;
    const shot = subject ? shotFor(docLeg, subject, prevMslM, altitudeMslM, fov) : null;
    if (shot) explanations.push('X-SHOT-FRAMED');
    drafts.push(...shotDrafts(seg, subject, holdAirspeedMs, maxSpeedMs, anchor));

    segments[seg.id] = Object.freeze({
      segmentId: seg.id,
      index: i,
      intent: seg.intent,
      distanceKm: docLeg.distKm,
      courseDeg: docLeg.courseDeg,
      groundSpeedMs: leg ? leg.vgMs : null,
      airSpeedMs: leg ? leg.vMs : null,
      timeMin: leg ? leg.timeMin : null,
      flightWh: leg ? leg.whLeg : null,
      holdWh: segHoldWh,
      energyWh: leg && leg.whLeg != null ? leg.whLeg + segHoldWh : null,
      holdS,
      holdAirspeedMs,
      holdPowerW,
      speedMode,
      speedTargetMs: seg.speedPolicy.targetMs,
      speedHonoured,
      altitudeMslM,
      altitudeDeltaM,
      /* Carried through untouched so a reader can show the pilot the figure they
       * typed beside the metres-MSL one every calculation used (ADR 0003). */
      altitudeAuthoredM: typeof seg.altitude.authored === 'number' ? seg.altitude.authored : null,
      altitudeReference: typeof seg.altitude.reference === 'string' ? seg.altitude.reference : 'unknown',
      vertical: flight.vertical,
      clearance,
      air: flight.air,
      wind: flight.wind,
      subjectRef,
      /* Carried verbatim: M1P owns this bag's shape and the schema has already
       * validated it, so this layer reads it without normalising it. */
      camera: seg.camera ?? null,
      shot,
      explanations,
    });
  });

  drafts.push(...verticalFlightDrafts(flights, { planningWindMs: ctx.plan.wind.planningMs }));

  return { segments, holdWh, verticalWh, verticalWhTo, flights, drafts };
}

/* ---------- constraints from the injected providers ---------- */

/**
 * @param {SolvedPlan} plan
 * @param {AnalysisDeps} deps
 * @returns {ConstraintDraft[]}
 */
function planDrafts(plan, deps) {
  const drafts = (plan.warnings ?? []).map((w) => draftFromLegacy('plan', w));
  // The one text substitution app.js has always made: when the dashboard can
  // name the lever that would let the mission close, that sentence replaces the
  // generic one. Same code either way — it is the same finding.
  const stranded = deps.strandedNote ? deps.strandedNote(plan) : null;
  if (typeof stranded === 'string' && stranded) {
    const at = drafts.findIndex((d) => d.code === 'W-WIND-NO-CLOSE');
    const replacement = draftConstraint('W-WIND-NO-CLOSE', stranded);
    if (at >= 0) drafts[at] = replacement;
    else drafts.unshift(replacement);
  }
  return drafts;
}

/**
 * @param {SolvedPlan} plan
 * @param {AnalysisDeps} deps
 * @param {{ points?: unknown[] }|null} profile
 * @returns {ConstraintDraft[]}
 */
function terrainDrafts(plan, deps, profile) {
  if (!deps.terrainWarnings) {
    return [draftConstraint('W-DATA-TERRAIN-ABSENT',
      'No terrain data was checked for this mission. The range figures are energy only — they know '
      + 'nothing about the ground between here and the turnaround.')];
  }
  if (deps.elevationProfile && (!profile || !Array.isArray(profile.points) || profile.points.length === 0)) {
    return [draftConstraint('W-DATA-TERRAIN-ABSENT',
      'The terrain service has no elevation profile for this course yet, so no clearance was checked. '
      + 'The range figures are energy only.')];
  }
  return deps.terrainWarnings(plan).map((w) => draftFromLegacy('terrain', w));
}

/**
 * @param {SolvedPlan} plan
 * @param {AnalysisDeps} deps
 * @returns {{ link: LinkResult|null, drafts: ConstraintDraft[] }}
 */
function linkDrafts(plan, deps) {
  if (!deps.linkStats) {
    return {
      link: null,
      drafts: [draftConstraint('W-DATA-LINK-ABSENT',
        'No radio-link check ran for this mission. Nothing here says how far the video or the control '
        + 'link actually reaches.')],
    };
  }
  const link = deps.linkStats(plan);
  if (!link) {
    return {
      link: null,
      drafts: [draftConstraint('W-DATA-LINK-ABSENT',
        'The link check has no profiled ground for this course yet, so the reach of the video and '
        + 'control links is unstated.')],
    };
  }
  const warnings = deps.linkWarnings ? deps.linkWarnings(plan, link) : [];
  return { link, drafts: warnings.map((w) => draftFromLegacy('link', w)) };
}

/**
 * The route's own verdicts: the ones planRoute already decided, given names.
 * @param {RouteResult} route
 * @param {number} holdWh
 * @returns {ConstraintDraft[]}
 */
function routeDrafts(route, holdWh) {
  /** @type {ConstraintDraft[]} */
  const drafts = [];
  if (route.unflyable) {
    drafts.push(draftConstraint('W-ROUTE-UNFLYABLE',
      'At least one leg of this route cannot be flown at the planned speed against the planned wind. '
      + 'The totals below stop at the legs that do solve.'));
  } else if (route.fits === false) {
    drafts.push(draftConstraint('W-ROUTE-RESERVE-SHORT',
      `This route runs ${Math.abs(route.marginWh).toFixed(1)} Wh past what the pack can give it — the `
      + `${route.binds === 'getHome' ? 'get-home reserve' : 'landing floor'} is what it breaks.`));
  }
  const budgetWh = route.loiter ? route.loiter.wh : 0;
  if (holdWh > 0 && holdWh > budgetWh) {
    drafts.push(draftConstraint('W-RESERVE-HOLD-BUDGET',
      `The holds on this route ask for ${holdWh.toFixed(1)} Wh of station-keeping and only ${budgetWh.toFixed(1)} `
      + 'Wh is left for them once the flying is paid for. Shorten the dwell, or fly a shorter route.'));
  }
  return drafts;
}

/* ---------- the footprint sweep ---------- */

/**
 * The wind-shaped turnaround envelope, swept twice: once at the cruise the pilot
 * chose, once at best-range speed, so the map can show what the choice costs.
 *
 * This arithmetic used to run inside src/map.js's render. ADR 0004 is why it
 * moved: a layer draws from the snapshot and computes nothing, and while the
 * footprint lived in the map it existed nowhere a brief or an export could reach
 * without redrawing the map first. Every call below is the one map.js made, in
 * the order it made it — this is a move, not a rewrite.
 *
 * Both sweeps share one `_pCache`, planMission's `powerAtSpeed` memo: they fly
 * the same aircraft through the same air and differ only in which speed they
 * pick, so the second sweep costs almost nothing.
 *
 * @param {AnalysisInputs} inputs
 * @param {LatLng} launch
 * @param {number} plannedCourseDeg the course the planning case flies out on
 * @param {SweepKit} kit
 * @param {(inputs: AnalysisInputs) => MissionPlan} plan
 * @returns {MissionFootprint}
 */
function sweepFootprint(inputs, launch, plannedCourseDeg, kit, plan) {
  const windFromDeg = Number.isFinite(inputs.env?.windFromDeg) ? Number(inputs.env?.windFromDeg) : 0;
  /** @type {Map<number, number>} */
  const cache = new Map();

  /**
   * Half a sweep, 0…180° off the wind axis. The other half is its mirror image:
   * the wind decomposition depends only on cos and |sin| of the offset.
   * @param {string|undefined} cruiseMode
   * @returns {HalfSweep}
   */
  const half = (cruiseMode) => kit.adaptiveHalfSweep((alpha) => {
    /* `courseDeg`, `lite` and `_pCache` are the planner's own vocabulary rather
     * than this layer's — AnalysisInputs names what the analysis itself reads,
     * and the rest of the bag has always been passed through untouched. */
    const probe = /** @type {AnalysisInputs} */ (/** @type {unknown} */ ({
      ...inputs, cruiseMode, courseDeg: windFromDeg + alpha, lite: true, _pCache: cache,
    }));
    const solved = plan(probe);
    /* Unreachable while the pass owns a plan: a probe differs from the planning
     * case only in course and cruise, and neither decides whether a pack exists.
     * Stated anyway, because a sweep of `undefined` radii would draw a ring made
     * of NaN rather than fail. */
    return 'code' in solved ? 0 : solved.radiusKm;
  });

  const halfReal = half(inputs.cruiseMode);
  const halfBest = half('range');
  const real = kit.fullCircle(halfReal, windFromDeg);
  const best = kit.fullCircle(halfBest, windFromDeg);

  return {
    launch: { ...launch },
    windFromDeg,
    plannedCourseDeg,
    courses: real.courses.slice(),
    radii: real.radii.slice(),
    byCourse: real.byCourse.slice(),
    bestByCourse: best.byCourse.slice(),
    areaKm2: kit.polarAreaKm2(real.courses, real.radii),
    bestCourses: best.courses.slice(),
    bestRadii: best.radii.slice(),
    /* Read off the half-sweep at the exact offset, not out of `byCourse`. The
     * per-degree table is sampled on whole courses; the wind is not necessarily
     * on one, and the tiles quote the axis itself. */
    upwindKm: kit.radiusAtAlpha(halfReal, 0),
    downwindKm: kit.radiusAtAlpha(halfReal, 180),
    crosswindKm: kit.radiusAtAlpha(halfReal, 90),
  };
}

/**
 * One slot, not a map. The footprint depends on the rail and the launch point
 * and on nothing else in the document, so a route edit — which invalidates the
 * snapshot memo, since it is a different mission — leaves the ring untouched and
 * hands back the identical object rather than re-flying ~80 planMission probes.
 * The rail only ever moves in one direction at a time, so one slot catches it.
 * @type {{ sig: string, footprint: MissionFootprint }|null}
 */
let footprintMemo = null;

/**
 * @param {AnalysisInputs} inputs
 * @param {LatLng} launch
 * @param {number} plannedCourseDeg
 * @param {AnalysisDeps} deps
 * @returns {MissionFootprint|null}
 */
function footprintOf(inputs, launch, plannedCourseDeg, deps) {
  const kit = deps.sweepKit;
  if (!kit) return null;
  const sig = hashKey(stableStringify({ inputs, launch, plannedCourseDeg }));
  if (footprintMemo && footprintMemo.sig === sig) return footprintMemo.footprint;
  const footprint = Object.freeze(
    sweepFootprint(inputs, launch, plannedCourseDeg, kit, deps.plan));
  footprintMemo = { sig, footprint };
  return footprint;
}

/* ---------- the mountain-flow advisory (M5) ---------- */

/**
 * The wind the advisory runs on, labelled. The pass takes the wind the plan
 * actually flies in — `plan.wind.planningMs` is the figure the solver used,
 * gust policy and all — and falls back to the env's own average when there is
 * no plan to have solved anything. Both are one wind for the whole area; the
 * label says which, and rides into `advisories.provenance`.
 *
 * @param {SolvedPlan|null} plan
 * @param {AnalysisInputs} inputs
 * @param {number|null} levelM
 * @returns {{ windMph: number|null, source: string }}
 */
function advisoryWindOf(plan, inputs, levelM) {
  const env = inputs.env ?? {};
  const planningMs = plan && Number.isFinite(plan.wind?.planningMs)
    ? Number(plan.wind.planningMs)
    : null;
  const envMs = Number.isFinite(env.windAvgMs) ? Number(env.windAvgMs) : null;
  const ms = planningMs ?? envMs;
  const from = planningMs != null ? 'planning-wind' : 'mission-env';
  return {
    windMph: ms == null ? null : U.msToMph(ms),
    source: levelM == null ? from : `${from}@${levelM}m`,
  };
}

/**
 * Run the advisory pass for this snapshot. Every branch of `compute` calls this
 * — a mission with no pack still flies through the same air, and the absence of
 * a battery is no reason to stop stating what the terrain does to the wind.
 *
 * @param {MissionDocumentV1} doc
 * @param {AnalysisInputs} inputs
 * @param {SolvedPlan|null} plan
 * @param {AnalysisDeps} deps
 * @returns {{ advisories: AdvisoryField, drafts: ConstraintDraft[] }}
 */
function advisoryOf(doc, inputs, plan, deps) {
  const reading = deps.advisoryGrid ? deps.advisoryGrid() : null;
  const sounding = deps.sounding ? deps.sounding() : null;
  const levelM = Number.isFinite(deps.windLevelM) ? Number(deps.windLevelM) : null;
  const wind = advisoryWindOf(plan, inputs, levelM);
  const env = inputs.env ?? {};
  return windAdvisory({
    launch: { lat: doc.launch.latitude, lng: doc.launch.longitude },
    field: reading?.field ?? null,
    portWired: !!deps.advisoryGrid,
    pending: reading?.pending ?? false,
    windMph: wind.windMph,
    windFromDeg: Number.isFinite(env.windFromDeg) ? Number(env.windFromDeg) : null,
    windLevelM: levelM,
    windSource: wind.source,
    sounding: sounding?.levels ?? [],
    soundingAt: sounding?.at ?? null,
  });
}

/* ---------- the pipeline ---------- */

/**
 * Analyse one mission. Pure with respect to its arguments: every impure thing
 * it consults arrives in `deps`, and the same request with the same deps
 * signature returns the identical snapshot object from the memo.
 *
 * @param {AnalysisRequest} request
 * @param {AnalysisDeps} deps
 * @returns {AnalysisSnapshot}
 */
export function analyzeMission(request, deps) {
  const doc = request?.doc;
  if (!doc || !doc.route || !doc.launch) {
    throw new TypeError('analyzeMission: request.doc must be a MissionDocumentV1');
  }
  if (typeof deps?.plan !== 'function' || typeof deps?.routePlan !== 'function') {
    throw new TypeError('analyzeMission: deps.plan and deps.routePlan are required');
  }
  const inputs = request.inputs ?? {};
  const revision = request.revision ?? { missionId: doc.id, missionUpdatedAt: doc.updatedAt };
  const now = deps.now ?? (() => new Date().toISOString());

  const cacheKey = hashKey(stableStringify({
    model: ANALYSIS_MODEL_VERSION,
    revision,
    route: routeSignatureOf(doc),
    inputs,
    forecast: deps.forecastSignature ?? forecastSignatureOf(doc),
    terrain: deps.terrainSignature ?? null,
    // Which ports are wired up changes the answer — an absent provider is a
    // constraint the snapshot carries — so the shape of `deps` is part of the
    // question, not an implementation detail of asking it.
    providers: {
      link: !!deps.linkStats,
      linkText: !!deps.linkWarnings,
      terrain: !!deps.terrainWarnings,
      profile: !!deps.elevationProfile,
      stranded: !!deps.strandedNote,
      field: !!deps.terrainField,
      footprint: !!deps.sweepKit,
      advisoryGrid: !!deps.advisoryGrid,
      sounding: !!deps.sounding,
    },
    // Not a provider flag but an input: the band decides the Fresnel radius, and
    // the wind levels decide what the legs are flying in. Both are read straight
    // out of `deps` — neither is in the document or in `missionInputs()`.
    linkGhz: deps.linkGhz ?? null,
    windLevels: deps.windLevels ? deps.windLevels() : null,
    // M5's two async inputs, keyed the way the corridor's field is: the host
    // derives a signature from what it is holding, so a landed grid is a new
    // question rather than a cache hit on the pass that was still waiting for
    // it. The sounding is small enough to key on directly.
    advisory: deps.advisorySignature ?? null,
    sounding: deps.sounding ? deps.sounding() : null,
    windLevelM: deps.windLevelM ?? null,
    provenance: deps.provenance ?? null,
  }));
  const hit = CACHE.get(cacheKey);
  if (hit) return hit;

  const snapshot = compute(doc, inputs, revision, deps, cacheKey, now());
  remember(cacheKey, snapshot);
  return snapshot;
}

/**
 * @param {MissionDocumentV1} doc
 * @param {AnalysisInputs} inputs
 * @param {AnalysisRevision} revision
 * @param {AnalysisDeps} deps
 * @param {string} cacheKey
 * @param {string} computedAt
 * @returns {AnalysisSnapshot}
 */
function compute(doc, inputs, revision, deps, cacheKey, computedAt) {
  const bearingDeg = primaryBearingDeg(inputs.env?.windFromDeg, inputs.env?.windMode);
  const legs = documentLegs(doc);
  const planResult = deps.plan(inputs);

  /* No pack, no plan. The mission still has geometry, so the corridor is still
   * worth stating — a terrain fetch does not need a battery. */
  if ('code' in planResult) {
    const corridor = buildCorridor(doc, legs, bearingDeg, 0);
    /* The air over the terrain does not depend on the pack, so the advisory
     * runs here too: a pilot with no battery selected still gets to see what
     * the wind does to the hills they are looking at. */
    const advisory = advisoryOf(doc, inputs, null, deps);
    const drafts = [
      draftConstraint('W-ENERGY-NO-PACK',
        'No battery is selected, so there is nothing to plan: every energy, range and time figure here '
        + 'is unavailable until one is.'),
      ...(planResult.warnings ?? []).map((w) => draftFromLegacy('plan', w)),
      ...advisory.drafts,
    ];
    return freezeSnapshot({
      id: `ana_${cacheKey}`,
      revision,
      inputs,
      corridor,
      plan: null,
      route: null,
      link: null,
      // No plan, no ring: every ray of the sweep is a mission this pack cannot
      // fly. The absence is the same statement W-ENERGY-NO-PACK already makes.
      footprint: null,
      segments: {},
      advisories: advisory.advisories,
      constraints: finalizeConstraints(drafts),
      provenance: buildProvenance(doc, deps, corridor,
        deps.terrainField ? deps.terrainField() : null, null, cacheKey, computedAt),
    });
  }

  const plan = planResult;
  const corridor = buildCorridor(doc, legs, bearingDeg, plan.radiusKm);

  /* The return policy, expressed as geometry rather than as new arithmetic.
   * planRoute always flies home from its last waypoint, so a retrace is the
   * waypoint list with its own reverse appended — the solver then produces the
   * return legs itself, at the same speeds, out of the same solver. */
  const returnMode = doc.route.returnPolicy?.mode ?? 'direct';
  const wps = legs.map((l) => l.to);
  const routeWps = returnMode === 'retrace' && wps.length > 1
    ? [...wps, ...wps.slice(0, -1).reverse()]
    : wps;
  const windFromDeg = Number.isFinite(inputs.env?.windFromDeg) ? Number(inputs.env?.windFromDeg) : 0;
  const raw = routeWps.length > 0
    ? deps.routePlan(plan, {
      launch: { lat: doc.launch.latitude, lng: doc.launch.longitude },
      waypoints: routeWps,
      windFromDeg,
      inputs,
    })
    : null;

  /* The ground, as of this instant. The host holds it; this reads it once and
   * hands the same object to every check, so nothing in one pass can see two
   * different fields. */
  const field = deps.terrainField ? deps.terrainField() : null;
  const launch = { lat: doc.launch.latitude, lng: doc.launch.longitude };
  const launchElevMslM = typeof doc.launch.elevationMslM === 'number'
    ? doc.launch.elevationMslM
    : null;

  /* Clearance first, because the segment records carry it. The other two checks
   * in this pass need figures readSegments has not produced yet, so the pass is
   * deliberately split around it rather than run twice over the field. */
  const groundChecks = routeWideChecks({
    launch,
    legs: legs.map((l) => ({
      segmentId: l.segment.id,
      to: l.to,
      altitudeMslM: typeof l.segment.altitude.resolvedMslM === 'number'
        ? l.segment.altitude.resolvedMslM
        : null,
    })),
    corridor,
    field,
    fieldPortWired: !!deps.terrainField,
    returnAltitudeMslM: typeof doc.route.returnPolicy?.altitude?.resolvedMslM === 'number'
      ? doc.route.returnPolicy.altitude.resolvedMslM
      : null,
    linkGhz: deps.linkGhz ?? null,
  });

  const env = inputs.env ?? {};
  const { segments, holdWh, verticalWh, verticalWhTo, drafts: segmentDrafts } = readSegments(
    doc, legs, raw, {
      plan,
      massKg: plan.cfg.massKg,
      etaProp: plan.cfg.etaProp,
      planRho: plan.rho,
      // The reading the plan's own density came off, so `atmosphereAt` lapses
      // from the same place planMission started rather than from a second one.
      refElevM: Number.isFinite(env.elevM) ? Number(env.elevM) : (launchElevMslM ?? 0),
      refTempC: Number.isFinite(env.tempC) ? Number(env.tempC) : 15,
      rhPct: Number.isFinite(env.rhPct) ? Number(env.rhPct) : 50,
      launchElevMslM,
      windLevels: deps.windLevels ? deps.windLevels() : null,
      clearance: groundChecks.clearance,
    });

  /* The one check that had to wait for the climb figures: whether a waypoint
   * still affords the flight home once the height it sits at is paid for. */
  const returnEnergyDrafts = returnEnergyChecks({
    legs: legs.map((l) => ({ segmentId: l.segment.id })),
    holds: raw?.holds ?? [],
    deliveredWh: raw?.budget?.deliveredWh ?? null,
    routeFits: raw ? raw.fits !== false : false,
    verticalWhTo,
  });

  /* `none` means no return leg is flown, so the mission's own totals are the
   * outbound ones. planRoute's home leg is still in `legs` and still costed —
   * it is what the reserve is measured against, and dropping it would silently
   * turn a reserve check into nothing. */
  const oneWay = returnMode === 'none';
  const route = raw ? Object.freeze({
    ...raw,
    returnMode,
    // What the pilot drew, which is not what was flown: a retrace doubles the
    // list before it reaches the integrator, so `raw.legs` counts the mirror too.
    // The map needs the authored count to put one pin on each authored waypoint.
    waypointCount: wps.length,
    plannedKm: oneWay ? raw.outKm : raw.totalKm,
    plannedMin: oneWay ? raw.outMin : raw.totalMin,
    plannedWh: oneWay ? raw.outWh : raw.totalWh,
    holdWh,
    verticalWh,
    // `plannedWh` is planRoute's own figure and stays exactly that. The climb
    // and the dwell are siblings beside it, so a reader can subtract either one
    // back out and land on the integrator's number.
    missionWh: (oneWay ? raw.outWh : raw.totalWh) + holdWh + verticalWh,
  }) : null;

  const profile = deps.elevationProfile ? deps.elevationProfile() : null;
  const { link, drafts: linkConstraintDrafts } = linkDrafts(plan, deps);
  const advisory = advisoryOf(doc, inputs, plan, deps);

  /** @type {ConstraintDraft[]} */
  const drafts = [
    ...planDrafts(plan, deps),
    ...terrainDrafts(plan, deps, profile),
    ...linkConstraintDrafts,
    ...(raw ? routeDrafts(raw, holdWh) : []),
    ...segmentDrafts,
    ...groundChecks.drafts,
    ...returnEnergyDrafts,
    ...advisory.drafts,
  ];
  if (oneWay) {
    drafts.push(draftConstraint('W-RESERVE-ONE-WAY',
      'This mission is planned one way: nothing here costs the flight home. The reserve figures still '
      + 'assume the aircraft comes back, so treat them as a check on the outbound leg only.'));
  }

  return freezeSnapshot({
    id: `ana_${cacheKey}`,
    revision,
    inputs,
    corridor,
    plan,
    route,
    link,
    footprint: footprintOf(inputs, launch, bearingDeg, deps),
    segments,
    advisories: advisory.advisories,
    constraints: finalizeConstraints(drafts),
    provenance: buildProvenance(doc, deps, corridor, field, profile, cacheKey, computedAt),
  });
}

/**
 * The geometry the analysis actually read, as a string. The revision stamp
 * *should* be enough — every edit goes through the reducer, which restamps
 * `updatedAt` — but two edits inside the same millisecond, or a fixture with a
 * frozen clock, produce equal revisions for different documents. A cache that
 * would then serve the wrong route is not worth the bytes this saves.
 * @param {MissionDocumentV1} doc
 * @returns {string}
 */
function routeSignatureOf(doc) {
  return stableStringify({
    launch: doc.launch,
    returnPolicy: doc.route.returnPolicy,
    waypoints: doc.route.waypoints,
    segments: doc.route.segments.map((s) => ({
      id: s.id, to: s.to, intent: s.intent, holdS: s.holdS ?? null,
      altitude: s.altitude, speedPolicy: s.speedPolicy,
      // M7: the shot is part of the answer now, so it is part of the question.
      subjectRef: s.subjectRef ?? null, camera: s.camera ?? null,
    })),
    // Moving a subject or changing the lens moves the shot without touching a
    // single waypoint — a signature blind to the scene would serve the old one.
    scene: {
      subjects: doc.scene?.subjects ?? [],
      cameraProfile: doc.scene?.cameraProfile ?? null,
    },
  });
}

/**
 * @param {MissionDocumentV1} doc
 * @returns {string}
 */
function forecastSignatureOf(doc) {
  const env = doc.environmentReference;
  return stableStringify({
    source: env?.source ?? null,
    presetId: env?.presetId ?? null,
    capturedAt: env?.capturedAt ?? null,
    values: env?.values ?? null,
  });
}

/**
 * Provenance from what the document and the ports actually said. Anything the
 * composition layer knows better is passed in `deps.provenance` and wins.
 * @param {MissionDocumentV1} doc
 * @param {AnalysisDeps} deps
 * @param {CorridorRequest} corridor
 * @param {TerrainField|null} field
 * @param {{ points?: unknown[], spanKm?: number }|null} profile
 * @param {string} cacheKey
 * @param {string} computedAt
 * @returns {AnalysisProvenance}
 */
function buildProvenance(doc, deps, corridor, field, profile, cacheKey, computedAt) {
  const env = doc.environmentReference;
  const prov = /** @type {Record<string, unknown>} */ (env?.provenance ?? {});
  const aircraft = doc.aircraftSnapshot;
  const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : null);
  /* The field describes the whole route and the profile describes one bearing,
   * so where a field landed it is the better answer to "how finely was this
   * sampled" — and its attribution is the licence line the DEM travels under,
   * which every surface printing ground has to be able to reach without
   * importing an infrastructure module to get it. */
  const sampled = field
    ? `${field.samples.length} corridor samples at ${field.provenance.spacingM} m spacing `
      + `(${field.provenance.coverage} coverage)`
    : (profile && Array.isArray(profile.points) && profile.points.length > 0
      ? `${profile.points.length} elevation points over ${(profile.spanKm ?? 0).toFixed(1)} km`
      : `${corridor.samples.length} corridor samples at ${corridor.spacingM} m spacing`);
  return provenanceOf({
    forecastIssue: str(prov.forecastIssue),
    forecastValid: str(prov.forecastValid),
    terrainSource: field?.provenance.source ?? (profile ? str(prov.terrainSource) : null),
    terrainAttribution: field?.provenance.attribution ?? null,
    samplingResolution: sampled,
    calibrationSource: aircraft
      ? (aircraft.calibrated ? 'flight-log calibration' : str(aircraft.confidence))
      : null,
    retrievedAt: env?.capturedAt ?? str(prov.retrievedAt),
    ...deps.provenance,
    modelVersion: ANALYSIS_MODEL_VERSION,
    computedAt,
    cacheKey,
  });
}

/**
 * Shallow-freeze the snapshot and the collections hanging off it. Deep freezing
 * the plan would mean freezing objects two other modules still hand around; the
 * contract this enforces is that *the snapshot* is not edited in place.
 * @param {AnalysisSnapshot} snapshot
 * @returns {AnalysisSnapshot}
 */
function freezeSnapshot(snapshot) {
  Object.freeze(snapshot.constraints);
  Object.freeze(snapshot.segments);
  return Object.freeze(snapshot);
}

/* ---------- memo ---------- */

/**
 * A small map, not an unbounded one: the same mission re-analysed while a pilot
 * drags a slider produces a new key every time, and a cache that never forgets
 * would hold every intermediate plan of the session.
 * @type {Map<string, AnalysisSnapshot>}
 */
const CACHE = new Map();
const CACHE_LIMIT = 8;

/** @param {string} key @param {AnalysisSnapshot} snapshot */
function remember(key, snapshot) {
  CACHE.set(key, snapshot);
  while (CACHE.size > CACHE_LIMIT) {
    const oldest = CACHE.keys().next().value;
    if (oldest === undefined) break;
    CACHE.delete(oldest);
  }
}

/** Forget every memoised snapshot — and the footprint beside it, which outlives
 * any single snapshot. For tests and for a hard reset. */
export function clearAnalysisCache() {
  CACHE.clear();
  footprintMemo = null;
}

/* ---------- stale-drop ---------- */

/**
 * @typedef {object} NewestOnlyGuard
 * @property {(revision: AnalysisRevision) => number} begin  a token for this pass
 * @property {(revision: AnalysisRevision, result?: unknown) => unknown} accept
 *   `false` when the revision is stale, otherwise the result (or `true`).
 */

/**
 * The guard against an answer arriving after the question changed.
 *
 * An analysis that waits on a terrain fetch can finish after the pilot has
 * moved the launch point, and the old app.js had no way to notice: whatever
 * resolved last won. `begin()` announces the revision being computed; `accept()`
 * reports whether that revision is still the newest one begun, and returns
 * `false` if it is not.
 *
 * `accept(revision, result)` passes `result` back through when the revision is
 * current, so a caller can write `const kept = guard.accept(rev, snapshot)` and
 * test it in one step.
 *
 * @returns {NewestOnlyGuard}
 */
export function newestOnly() {
  let seq = 0;
  /** @type {string|null} */
  let newestKey = null;
  /** @param {AnalysisRevision} r */
  const keyOf = (r) => `${r?.missionId ?? ''}@${r?.missionUpdatedAt ?? ''}`;
  return {
    begin(revision) {
      newestKey = keyOf(revision);
      return ++seq;
    },
    accept(revision, result) {
      if (newestKey === null || keyOf(revision) !== newestKey) return false;
      return result === undefined ? true : result;
    },
  };
}
