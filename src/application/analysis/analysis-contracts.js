// analysis-contracts.js — the shapes M2 freezes so M3–M8 can be additive.
//
// Nothing here computes anything. This module is the vocabulary: the snapshot
// the whole app will read from, the constraint record that replaces the loose
// `{ level, text }` warning, the corridor demand a terrain provider answers,
// and the provenance block ADR 0008 requires on every one of them. Pure data
// plus the handful of helpers that keep ids and cache keys deterministic.
//
// Three rules the rest of the pipeline inherits from these definitions:
//
//   *Absence is a value.* Every provenance field is present on every snapshot,
//     carrying null when nothing supplied it. A field that is simply missing
//     from the object is indistinguishable from a field nobody thought about,
//     and ADR 0007 is explicit that the tool states what it does not know.
//
//   *Ids are derived, never generated.* A constraint's id falls out of its code
//     and the thing it is anchored to, so the same finding about the same
//     segment is the same id on every recompute — which is what lets the UI
//     keep a dismissal, a scroll position, or a highlight across a re-plan.
//
//   *Nothing carried here is impure.* This file has no imports at all, and the
//     application layer that builds these records reaches its providers through
//     injected ports (ADR 0007), never by importing them.

/* ---------- identity of the model itself ---------- */

/**
 * Bumped whenever a change to the pipeline would move numbers or constraints
 * for unchanged inputs. It is part of every cache key, so a bump invalidates
 * every memoised snapshot rather than serving yesterday's arithmetic.
 */
export const ANALYSIS_MODEL_VERSION = 'analysis-v1';

/* ---------- severity ---------- */

/**
 * ADR 0008's fixed taxonomy. Six levels, no more, in display-priority order:
 * the first entry is the one that wins the top of the rail. `unknown` outranks
 * `advisory` and `low-forcing` deliberately — "we could not check this" is a
 * louder statement than "here is a fact", which is the whole point of having
 * the level.
 * @typedef {'critical'|'warning'|'caution'|'unknown'|'advisory'|'low-forcing'} Severity
 */

/** @type {readonly Severity[]} */
export const SEVERITIES = Object.freeze([
  'critical', 'warning', 'caution', 'unknown', 'advisory', 'low-forcing',
]);

/** @type {Readonly<Record<Severity, number>>} */
export const SEVERITY_RANK = Object.freeze({
  critical: 0, warning: 1, caution: 2, unknown: 3, advisory: 4, 'low-forcing': 5,
});

/** @param {unknown} v @returns {v is Severity} */
export const isSeverity = (v) => typeof v === 'string'
  && SEVERITIES.includes(/** @type {Severity} */ (v));

/* ---------- anchors ---------- */

/**
 * What a constraint is about. `mission` carries a null refId; `segment` carries
 * a segment id from the document; `sample` carries a corridor sample id, which
 * is how M3's terrain findings will point at a specific metre of ground.
 * @typedef {'mission'|'segment'|'sample'} AnchorScope
 */

/** @type {readonly AnchorScope[]} */
export const ANCHOR_SCOPES = Object.freeze(['mission', 'segment', 'sample']);

/** @typedef {{ scope: AnchorScope, refId: string|null }} ConstraintAnchor */

/** The mission-wide anchor, shared because it is immutable and very common. */
export const MISSION_ANCHOR = /** @type {ConstraintAnchor} */ (
  Object.freeze({ scope: 'mission', refId: null }));

/**
 * @param {AnchorScope} scope
 * @param {string|null} [refId]
 * @returns {ConstraintAnchor}
 */
export function anchorAt(scope, refId = null) {
  if (scope === 'mission') return MISSION_ANCHOR;
  return Object.freeze({ scope, refId });
}

/* ---------- constraints ---------- */

/**
 * Why this constraint exists, in the terms ADR 0008 demands: which inputs
 * produced it, what the baseline behind those inputs is, and what the model
 * cannot see. `inputs` and `limitations` are short phrases, not sentences —
 * the sentence is `text`.
 * @typedef {object} ConstraintExplanation
 * @property {readonly string[]} inputs
 * @property {string} baseline
 * @property {readonly string[]} limitations
 */

/**
 * One finding. `text` is the pilot-facing sentence and is preserved verbatim
 * from whatever produced it — M2 adds codes and anchors to the existing
 * warnings, it does not rewrite their prose.
 * @typedef {object} Constraint
 * @property {string} id        deterministic; see constraintId()
 * @property {string} code      stable W-* code from the registry
 * @property {Severity} severity
 * @property {string} text
 * @property {ConstraintAnchor} anchor
 * @property {ConstraintExplanation} explanation
 */

/**
 * The stable half of a constraint id: code plus the thing it is about. Two
 * findings that collide here are the same finding recomputed, which is exactly
 * what the UI wants to treat as one.
 * @param {string} code
 * @param {ConstraintAnchor} anchor
 * @returns {string}
 */
export function constraintKey(code, anchor) {
  return `${code}@${anchor.scope}:${anchor.refId ?? 'mission'}`;
}

/**
 * The full id. `occurrence` is 1 for the first constraint with this key, and
 * only a repeat earns a suffix — so the common case (one finding, one anchor)
 * has an id a human can read and a test can write down.
 * @param {string} code
 * @param {ConstraintAnchor} anchor
 * @param {number} [occurrence]
 * @returns {string}
 */
export function constraintId(code, anchor, occurrence = 1) {
  const key = constraintKey(code, anchor);
  return occurrence > 1 ? `${key}#${occurrence}` : key;
}

/* ---------- the corridor demand ---------- */

/**
 * One point a terrain provider is being asked about. `id` is deterministic and
 * survives a recompute, so an elevation cache can be keyed on it.
 * @typedef {object} CorridorSample
 * @property {string} id
 * @property {number} latitude
 * @property {number} longitude
 * @property {number} distanceKm   along the corridor from launch
 * @property {number} bearingDeg   the course being flown through this point
 * @property {string|null} segmentId  the document segment this point lies on
 */

/**
 * What the route needs to know about the ground, stated independently of who
 * answers it. M2 produces this; M3's terrain service consumes it. `spacingM`
 * is the along-track step actually used, and `corridorWidthM` is the half-width
 * demanded either side of the centreline — 0 while M2 asks only about the line
 * the aircraft flies down.
 * @typedef {object} CorridorRequest
 * @property {string} missionId
 * @property {string} revision      the document's updatedAt stamp
 * @property {CorridorSample[]} samples
 * @property {number} spacingM
 * @property {number} corridorWidthM
 */

/** Points a full-length corridor aims for, matching src/terrain.js's profile. */
export const CORRIDOR_SAMPLE_TARGET = 28;

/** No finer than the DEM behind it: Copernicus 30 m is the best case available. */
export const CORRIDOR_MIN_SPACING_M = 30;

/** A ceiling on one request, so a 200 km route does not ask for 7,000 points. */
export const CORRIDOR_MAX_SAMPLES = 128;

/**
 * M2 samples the centreline only. A width is what M3 needs to say anything
 * about the ground beside the track (lee turbulence, a ridge the route passes
 * rather than crosses), and stating 0 here is the honest version of "this
 * analysis has not looked either side of the line".
 */
export const CORRIDOR_WIDTH_M = 0;

/* ---------- provenance ---------- */

/**
 * ADR 0008's block, extended with the two fields a memoised snapshot needs to
 * describe itself. Every field is always present; null means "nothing supplied
 * this", which is a different statement from a default.
 * @typedef {object} AnalysisProvenance
 * @property {string} modelVersion
 * @property {string|null} forecastIssue        when the forecast was issued
 * @property {string|null} forecastValid        the hour it describes
 * @property {string|null} terrainSource        who supplied the ground
 * @property {string|null} samplingResolution   how finely it was sampled
 * @property {string|null} calibrationSource    the flight-log fit behind the model
 * @property {string|null} retrievedAt          when the evidence was fetched
 * @property {string} computedAt                when this snapshot was built
 * @property {string} cacheKey
 */

/**
 * A provenance block with every field present. Overrides are applied over the
 * nulls, so a caller states only what it actually knows.
 * @param {Partial<AnalysisProvenance>} [overrides]
 * @returns {AnalysisProvenance}
 */
export function provenanceOf(overrides = {}) {
  return Object.freeze({
    modelVersion: ANALYSIS_MODEL_VERSION,
    forecastIssue: null,
    forecastValid: null,
    terrainSource: null,
    samplingResolution: null,
    calibrationSource: null,
    retrievedAt: null,
    computedAt: '',
    cacheKey: '',
    ...overrides,
  });
}

/* ---------- the snapshot ---------- */

/**
 * What "the same question" means to the cache and to the async-staleness guard.
 * `missionUpdatedAt` is an opaque freshness token, not a timestamp: the host
 * composes the document's updatedAt with a hash of the rail inputs that change
 * the answer without touching the document. Compare it for equality; never
 * parse it.
 * @typedef {{ missionId: string, missionUpdatedAt: string }} AnalysisRevision
 */

/**
 * The air the plan ran in, as `missionInputs()` builds it. Only `env` is read
 * here; the rest of the bag is passed through to the injected planner, which
 * owns its meaning.
 * @typedef {object} EnvironmentInputs
 * @property {number} [elevM]
 * @property {number} [tempC]
 * @property {number} [rhPct]
 * @property {number} [windAvgMs]
 * @property {number} [windGustMs]
 * @property {number} [windFromDeg]
 * @property {string} [windMode]
 */

/** @typedef {{ env?: EnvironmentInputs }} AnalysisInputs */

/** The legacy warning shape every producer emits today. */
/** @typedef {{ level: string, text: string }} LegacyWarning */

/**
 * The subset of `planMission()`'s result this layer reads. The planner is
 * injected, so this is a structural description of what analyze.js needs from
 * it rather than an import of the module that returns it.
 * @typedef {object} SolvedPlan
 * @property {{ pW: number }} hover
 * @property {{ planningMs: number, gustFactor: number }} wind
 * @property {{ deliveredWh: number, huntLandWh: number, landFloorPct: number,
 *              getHomeWindMs: number|null, reserveWh: number, reservePct: number,
 *              reserveBinds: string }} energy
 * @property {number} radiusKm
 * @property {number} totalKm
 * @property {number} timeMin
 * @property {LegacyWarning[]} warnings
 * @property {{ viable: boolean }} [flight]
 */

/** The planner's handled refusal: no pack chosen, so there is nothing to solve. */
/** @typedef {{ code: string, warnings: LegacyWarning[] }} UnplannablePlan */

/** @typedef {SolvedPlan|UnplannablePlan} MissionPlan */

/**
 * One leg of `planRoute()`'s answer.
 * @typedef {object} RouteLeg
 * @property {string} phase
 * @property {number} distKm
 * @property {number} courseDeg
 * @property {number} headMs
 * @property {number} crossMs
 * @property {number|null} vMs
 * @property {number|null} vgMs
 * @property {number|null} whPerKm
 * @property {number|null} whLeg
 * @property {number|null} timeMin
 */

/**
 * The subset of `planRoute()`'s result this layer reads.
 * @typedef {object} RouteResult
 * @property {boolean} empty
 * @property {RouteLeg[]} legs
 * @property {number} totalKm
 * @property {number} totalMin
 * @property {number} totalWh
 * @property {number} outKm
 * @property {number} outMin
 * @property {number} outWh
 * @property {boolean|null} fits
 * @property {boolean} unflyable
 * @property {string|null} binds
 * @property {number} marginWh
 * @property {{ wh: number, pHoverW: number, holdPw: number, min: number,
 *              holdMin: number, binds: string }|null} loiter
 */

/**
 * The route as the analysis reports it: planRoute's own answer, plus the four
 * figures that depend on the document's return policy. `planRoute` always costs
 * a flight home from the last waypoint — that is what the reserve is measured
 * against and it stays in `legs` — so a one-way mission is expressed by which
 * totals the analysis publishes, not by deleting a leg from the integration.
 * @typedef {object} RouteTotals
 * @property {'direct'|'retrace'|'none'} returnMode
 * @property {number} plannedKm   distance actually planned under that policy
 * @property {number} plannedMin
 * @property {number} plannedWh
 * @property {number} holdWh      every segment's dwell, at hover power
 * @property {number} missionWh   plannedWh + holdWh
 */

/** @typedef {RouteResult & RouteTotals} AnalysedRoute */

/** The link picture, when an RF provider supplied one. Shape owned by src/rf.js. */
/** @typedef {{ blocked?: boolean, [key: string]: unknown }} LinkResult */

/**
 * What the pipeline could say about one authored segment. Energy is split so
 * the hold contribution is checkable on its own, and the vertical figures are
 * *recorded, not modelled* — M2 states the altitude change and says plainly
 * that no vertical energy went into the number beside it.
 * @typedef {object} SegmentAnalysis
 * @property {string} segmentId
 * @property {number} index
 * @property {string} intent
 * @property {number} distanceKm
 * @property {number} courseDeg
 * @property {number|null} groundSpeedMs
 * @property {number|null} airSpeedMs
 * @property {number|null} timeMin
 * @property {number|null} flightWh      the leg itself
 * @property {number} holdWh             dwell at the far end, hover power × time
 * @property {number|null} energyWh      flightWh + holdWh, or null when unsolved
 * @property {number|null} holdS
 * @property {'cruise'|'fixed'|'maxRange'} speedMode
 * @property {number|null} speedTargetMs
 * @property {boolean} speedHonoured     false when the solver could not take it
 * @property {number|null} altitudeMslM
 * @property {number|null} altitudeDeltaM
 * @property {string[]} explanations     X-* codes; see EXPLANATION_CODES
 */

/**
 * Everything one analysis pass knows, as one immutable record. This is what
 * M2b's `update()` will hand the renderers, and what M6 will export.
 * @typedef {object} AnalysisSnapshot
 * @property {string} id
 * @property {AnalysisRevision} revision
 * @property {AnalysisInputs} inputs
 * @property {CorridorRequest} corridor
 * @property {SolvedPlan|null} plan
 * @property {AnalysedRoute|null} route
 * @property {LinkResult|null} link
 * @property {Record<string, SegmentAnalysis>} segments
 * @property {Constraint[]} constraints
 * @property {AnalysisProvenance} provenance
 */

/* ---------- deterministic keys ---------- */

/**
 * JSON with object keys in sorted order, so two structurally equal values
 * always produce the same string. Undefined properties are dropped (they are
 * absent, and `{a: undefined}` must key the same as `{}`); non-finite numbers
 * become their names rather than JSON's `null`, because NaN and Infinity are
 * distinguishable states this tool cares about.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  return JSON.stringify(normalize(value)) ?? 'undefined';
}

/** @param {unknown} v @returns {unknown} */
function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const bag = /** @type {Record<string, unknown>} */ (v);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of Object.keys(bag).sort()) {
      if (bag[k] === undefined) continue;
      out[k] = normalize(bag[k]);
    }
    return out;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return v;
}

/**
 * FNV-1a over the stable string. Not a security hash — a short, stable name for
 * a long key, so a cache map and a snapshot id stay readable in a debugger.
 * @param {string} text
 * @returns {string}
 */
export function hashKey(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}
