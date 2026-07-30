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
//   It does not model vertical flight. Segment altitudes are read, the change
//     between them is recorded, and the snapshot says plainly that no energy
//     was charged for it. That is M3's work and pretending otherwise here would
//     produce a number nobody had validated.
//
//   It does not import a provider. Not terrain.js, not rf.js, not state.js, not
//     a render module — the layer check enforces it and the injected ports make
//     it easy to honour.

import { destination, distanceKm, bearingTo } from '../../domain/geo.js';
import { HOLD_INTENTS } from '../../domain/mission/mission-schema.js';
import {
  ANALYSIS_MODEL_VERSION, CORRIDOR_MAX_SAMPLES, CORRIDOR_MIN_SPACING_M,
  CORRIDOR_SAMPLE_TARGET, CORRIDOR_WIDTH_M,
  anchorAt, hashKey, provenanceOf, stableStringify,
} from './analysis-contracts.js';
import { draftConstraint, draftFromLegacy, finalizeConstraints } from './constraints.js';

/**
 * @typedef {import('../../domain/mission/mission-schema.js').MissionDocumentV1} MissionDocumentV1
 * @typedef {import('../../domain/mission/mission-schema.js').Segment} Segment
 * @typedef {import('../../domain/mission/mission-schema.js').Waypoint} Waypoint
 * @typedef {import('./analysis-contracts.js').AnalysisInputs} AnalysisInputs
 * @typedef {import('./analysis-contracts.js').AnalysisProvenance} AnalysisProvenance
 * @typedef {import('./analysis-contracts.js').AnalysisRevision} AnalysisRevision
 * @typedef {import('./analysis-contracts.js').AnalysisSnapshot} AnalysisSnapshot
 * @typedef {import('./analysis-contracts.js').CorridorRequest} CorridorRequest
 * @typedef {import('./analysis-contracts.js').CorridorSample} CorridorSample
 * @typedef {import('./analysis-contracts.js').LegacyWarning} LegacyWarning
 * @typedef {import('./analysis-contracts.js').LinkResult} LinkResult
 * @typedef {import('./analysis-contracts.js').MissionPlan} MissionPlan
 * @typedef {import('./analysis-contracts.js').RouteResult} RouteResult
 * @typedef {import('./analysis-contracts.js').SegmentAnalysis} SegmentAnalysis
 * @typedef {import('./analysis-contracts.js').SolvedPlan} SolvedPlan
 * @typedef {import('./constraints.js').ConstraintDraft} ConstraintDraft
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
 * @typedef {object} AnalysisDeps
 * @property {(inputs: AnalysisInputs) => MissionPlan} plan
 * @property {(plan: SolvedPlan, opts: { launch: LatLng, waypoints: LatLng[],
 *            windFromDeg: number, inputs: AnalysisInputs }) => RouteResult} routePlan
 * @property {((plan: SolvedPlan) => LinkResult|null)|null} [linkStats]
 * @property {((plan: SolvedPlan, link: LinkResult|null) => LegacyWarning[])|null} [linkWarnings]
 * @property {((plan: SolvedPlan) => LegacyWarning[])|null} [terrainWarnings]
 * @property {(() => { points?: unknown[], spanKm?: number }|null)|null} [elevationProfile]
 * @property {((plan: SolvedPlan) => string|null)|null} [strandedNote]
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

/* ---------- per-segment reading ---------- */

/**
 * @param {MissionDocumentV1} doc
 * @param {DocLeg[]} legs
 * @param {RouteResult|null} route
 * @param {number} hoverW
 * @returns {{ segments: Record<string, SegmentAnalysis>, holdWh: number, drafts: ConstraintDraft[] }}
 */
function readSegments(doc, legs, route, hoverW) {
  /** @type {Record<string, SegmentAnalysis>} */
  const segments = {};
  /** @type {ConstraintDraft[]} */
  const drafts = [];
  let holdWh = 0;
  let verticalSeen = false;

  legs.forEach((docLeg, i) => {
    const seg = docLeg.segment;
    const anchor = anchorAt('segment', seg.id);
    // Out-legs come back in document order, so leg i is segment i whatever the
    // return policy appended after them.
    const leg = route && !route.empty ? (route.legs[i] ?? null) : null;
    /** @type {string[]} */
    const explanations = [];

    const holdS = HOLD_INTENTS.includes(seg.intent) && typeof seg.holdS === 'number' && seg.holdS > 0
      ? seg.holdS
      : null;
    // The hover power the loiter budget is already quoted at — reused, not
    // re-derived, so a hold costs exactly what route.js says holding costs.
    const segHoldWh = holdS ? holdS * hoverW / 3600 : 0;
    if (holdS) {
      holdWh += segHoldWh;
      explanations.push('X-HOLD-HOVER-POWER');
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
    } else if (altitudeDeltaM != null && altitudeDeltaM !== 0) {
      explanations.push('X-ALT-VERTICAL-UNMODELLED');
      verticalSeen = true;
    }

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
      speedMode,
      speedTargetMs: seg.speedPolicy.targetMs,
      speedHonoured,
      altitudeMslM,
      altitudeDeltaM,
      explanations,
    });
  });

  if (verticalSeen) {
    drafts.push(draftConstraint(
      'W-ALT-VERTICAL-UNMODELLED',
      'This route changes altitude between legs. The change is recorded on each leg, but no climb or '
      + 'descent energy is in these figures — every leg is costed as level flight.',
    ));
  }

  return { segments, holdWh, drafts };
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
      `The holds on this route ask for ${holdWh.toFixed(1)} Wh of hovering and only ${budgetWh.toFixed(1)} `
      + 'Wh is left for them once the flying is paid for. Shorten the dwell, or fly a shorter route.'));
  }
  return drafts;
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
    },
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
    const drafts = [
      draftConstraint('W-ENERGY-NO-PACK',
        'No battery is selected, so there is nothing to plan: every energy, range and time figure here '
        + 'is unavailable until one is.'),
      ...(planResult.warnings ?? []).map((w) => draftFromLegacy('plan', w)),
    ];
    return freezeSnapshot({
      id: `ana_${cacheKey}`,
      revision,
      inputs,
      corridor,
      plan: null,
      route: null,
      link: null,
      segments: {},
      constraints: finalizeConstraints(drafts),
      provenance: buildProvenance(doc, deps, corridor, null, cacheKey, computedAt),
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

  const { segments, holdWh, drafts: segmentDrafts } = readSegments(doc, legs, raw, plan.hover.pW);

  /* `none` means no return leg is flown, so the mission's own totals are the
   * outbound ones. planRoute's home leg is still in `legs` and still costed —
   * it is what the reserve is measured against, and dropping it would silently
   * turn a reserve check into nothing. */
  const oneWay = returnMode === 'none';
  const route = raw ? Object.freeze({
    ...raw,
    returnMode,
    plannedKm: oneWay ? raw.outKm : raw.totalKm,
    plannedMin: oneWay ? raw.outMin : raw.totalMin,
    plannedWh: oneWay ? raw.outWh : raw.totalWh,
    holdWh,
    missionWh: (oneWay ? raw.outWh : raw.totalWh) + holdWh,
  }) : null;

  const profile = deps.elevationProfile ? deps.elevationProfile() : null;
  const { link, drafts: linkConstraintDrafts } = linkDrafts(plan, deps);

  /** @type {ConstraintDraft[]} */
  const drafts = [
    ...planDrafts(plan, deps),
    ...terrainDrafts(plan, deps, profile),
    ...linkConstraintDrafts,
    ...(raw ? routeDrafts(raw, holdWh) : []),
    ...segmentDrafts,
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
    segments,
    constraints: finalizeConstraints(drafts),
    provenance: buildProvenance(doc, deps, corridor, profile, cacheKey, computedAt),
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
    })),
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
 * @param {{ points?: unknown[], spanKm?: number }|null} profile
 * @param {string} cacheKey
 * @param {string} computedAt
 * @returns {AnalysisProvenance}
 */
function buildProvenance(doc, deps, corridor, profile, cacheKey, computedAt) {
  const env = doc.environmentReference;
  const prov = /** @type {Record<string, unknown>} */ (env?.provenance ?? {});
  const aircraft = doc.aircraftSnapshot;
  const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : null);
  const sampled = profile && Array.isArray(profile.points) && profile.points.length > 0
    ? `${profile.points.length} elevation points over ${(profile.spanKm ?? 0).toFixed(1)} km`
    : `${corridor.samples.length} corridor samples at ${corridor.spacingM} m spacing`;
  return provenanceOf({
    forecastIssue: str(prov.forecastIssue),
    forecastValid: str(prov.forecastValid),
    terrainSource: profile ? str(prov.terrainSource) : null,
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

/** Forget every memoised snapshot. For tests and for a hard reset. */
export function clearAnalysisCache() {
  CACHE.clear();
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
