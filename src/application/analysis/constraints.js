// constraints.js — every warning this tool can emit, with a name.
//
// Until now a warning was `{ level, text }`: a sentence and a colour. That is
// enough to render and not enough for anything else — you cannot dismiss one,
// test that it still fires, point at the segment it is about, or tell a pilot
// where the claim came from. ADR 0008 asks for a stable code, a fixed severity
// taxonomy, an anchor, and an explanation. This module supplies all four
// *without touching the sentences*: the prose in physics.js, render/terrain.js
// and render/dashboard.js is preserved verbatim and carried through as `text`.
// M2 is a migration, not a rewrite.
//
// Two things are worth reading before adding a code.
//
//   The legacy levels are three, not four. The codebase emits `critical`,
//   `serious` and `warning` — never `info`. They map onto ADR 0008's six-level
//   taxonomy as critical → critical, serious → warning, warning → caution,
//   which preserves the ordering renderWarnings() already sorts by. Collapsing
//   `serious` and `warning` into one level would flatten a distinction the
//   existing UI depends on, and every one of those sentences was written
//   knowing which of the two it was.
//
//   An unmatched warning is a finding, not a shrug. A producer that grows a
//   new sentence without a code here surfaces as W-ANALYSIS-UNCLASSIFIED at
//   `unknown` severity, carrying its text intact. Nothing is ever dropped for
//   want of a registry entry, and the registry's own test notices.

/**
 * @typedef {import('./analysis-contracts.js').Constraint} Constraint
 * @typedef {import('./analysis-contracts.js').ConstraintAnchor} ConstraintAnchor
 * @typedef {import('./analysis-contracts.js').ConstraintExplanation} ConstraintExplanation
 * @typedef {import('./analysis-contracts.js').LegacyWarning} LegacyWarning
 * @typedef {import('./analysis-contracts.js').Severity} Severity
 */

import {
  DIVE_CURRENT_MARGIN_FRAC, DIVE_PULLOUT_CLEARANCE_WARN_M, MISSION_ANCHOR, constraintId,
} from './analysis-contracts.js';

/** The current-margin threshold as the sentences say it: "10%", not "0.1". */
const DIVE_MARGIN_PCT = (DIVE_CURRENT_MARGIN_FRAC * 100).toFixed(0);

/**
 * ADR 0008's taxonomy read against the levels this codebase actually emits.
 * `info` has no producer today and is mapped anyway, so the table is complete
 * rather than merely sufficient.
 * @type {Readonly<Record<string, Severity>>}
 */
export const LEGACY_SEVERITY = Object.freeze({
  critical: 'critical',
  serious: 'warning',
  warning: 'caution',
  info: 'advisory',
});

/**
 * Which part of the system authored a constraint. `wind` is M5's mountain-flow
 * advisory: a producer of its own rather than another `analysis` code, because
 * everything it emits rests on two model baselines (B1 terrain forcing, B2
 * stability regime) that the rest of the pipeline knows nothing about, and a
 * reader deciding how much weight to put on a finding is entitled to see that
 * in the record.
 */
/** @typedef {'plan'|'terrain'|'link'|'analysis'|'wind'} ConstraintProducer */

/**
 * @typedef {object} ConstraintCode
 * @property {string} code
 * @property {ConstraintProducer} producer
 * @property {Severity} severity
 * @property {string|null} legacyLevel  the `{level}` this used to be, or null
 * @property {ConstraintExplanation} explanation
 */

/** @type {(inputs: string[], baseline: string, limitations: string[]) => ConstraintExplanation} */
const why = (inputs, baseline, limitations) => Object.freeze({
  inputs: Object.freeze(inputs.slice()),
  baseline,
  limitations: Object.freeze(limitations.slice()),
});

/* The three limitation clauses that are true of nearly everything here, named
 * once so they read identically wherever they apply. */
const ONE_BEARING = 'only the planned bearing is profiled';
const NO_VERTICAL = 'climb and descent energy are not modelled';
const BENCH_DATA = 'the figures behind this come off bench data, not this airframe';

/* Two producers now raise the terrain and link codes: the single-bearing card
 * (render/terrain.js) and M3b's route-wide pass over the corridor. Neither is
 * "the planned bearing" alone any more, so these four codes carry the limitation
 * that is true of both — the ground is known where somebody sampled it, and
 * nowhere else. */
const SAMPLED_GROUND = 'the ground is only known where it was sampled';
const BARE_EARTH = 'the DEM is bare earth — trees, towers and wires are not in it';

/* M3b's vertical model, stated once. Every constraint that leans on a climb or
 * descent figure repeats these, because a pilot reading one of them is entitled
 * to know the number was chosen to be pessimistic rather than measured. */
const CLIMB_BOUND = 'climb energy is the potential energy gained over the drivetrain efficiency, '
  + 'which is an upper bound on the rotor model rather than a measurement';
const NO_REGEN = 'a descent never returns energy to the pack in this model';

/* M5's mountain-flow advisory, stated once for all seven W-WIND-* codes below.
 * These are the milestone's prohibited claims written as their opposites, and
 * every advisory constraint carries the ones that bear on it — a pilot reading
 * "lee side" has to meet "this cannot locate a rotor" in the same breath, not
 * three panels away. */
const W_PROXY = 'w* is a relative terrain-forcing proxy (V·∇h), not a forecast vertical velocity';
const NO_ROTOR = 'no rotor, separation or turbulence physics is modelled — this cannot say '
  + 'where a rotor is, only which flank the flow is descending';
const SURFACE_FLOW = 'the forcing is computed from the ground the wind crosses, and describes '
  + 'that, not the air at flight altitude';
const NOT_SAFE = 'this is a relative picture: an area with no modelled forcing has not been '
  + 'found safe, it has only produced no signal in a proxy that models very little';
const ONE_WIND = 'one wind, from one coarse forecast cell, is applied across the whole area';

/* M16's mountain dive, stated once for the ten W-DIVE-* codes below. NO_THERMAL
 * is the milestone's prohibited claim written as its opposite and it rides on
 * every code that touches the propulsion: a pilot reading "the pull draws 82% of
 * the motors' ceiling" has to meet "and nothing here knows what that does to
 * their temperature" in the same breath. */
const NO_THERMAL = 'nothing in this tool measures or estimates motor, ESC or pack temperature, '
  + 'so no thermal limit is checked and none is quoted';
const PULL_AT_GATE = 'the pull is measured from the gate itself, which is the latest defensible '
  + 'start — beginning it earlier only clears by more';
const CONSTANT_SPEED_ARC = 'the arc is flown at constant speed, so the sink quoted is at or above '
  + 'the one a real pull that bleeds speed into drag would produce';
const HOVER_SCALED = 'the pullout draw is hover power scaled by n^1.5, which overstates it — at '
  + 'pullout speeds the rotors are in clean forward flow, not hover';
const AUTHORED_LINE = 'this describes the line as authored; nothing here models what the pilot\'s '
  + 'thumb does on the way down';

/**
 * Every code this tool can emit, frozen. The tests assert this object's shape,
 * so a rename is a deliberate, visible act — which is the point: these ids will
 * end up in saved dismissals, exported briefs and, eventually, other people's
 * tooling.
 * @type {Readonly<Record<string, ConstraintCode>>}
 */
export const CONSTRAINT_CODES = Object.freeze(/** @type {Record<string, ConstraintCode>} */ ({

  /* ---- lift and thrust (physics.js) ---- */
  'W-LIFT-NO-LIFT': {
    code: 'W-LIFT-NO-LIFT', producer: 'plan', severity: 'critical', legacyLevel: 'critical',
    explanation: why(
      ['all-up mass', 'prop diameter', 'rotor count', 'air density'],
      'continuous hover thrust from the lift envelope at this density altitude',
      [BENCH_DATA, 'a measured thrust curve replaces this estimate when one exists'],
    ),
  },
  'W-LIFT-NO-MARGIN': {
    code: 'W-LIFT-NO-MARGIN', producer: 'plan', severity: 'warning', legacyLevel: 'serious',
    explanation: why(
      ['all-up mass', 'estimated hover thrust'],
      'thrust-to-weight below the ratio that leaves usable climb authority',
      [BENCH_DATA],
    ),
  },
  'W-LIFT-MARGINAL': {
    code: 'W-LIFT-MARGINAL', producer: 'plan', severity: 'caution', legacyLevel: 'warning',
    explanation: why(
      ['all-up mass', 'estimated hover thrust'],
      'thrust-to-weight inside the band where gusts eat the margin',
      [BENCH_DATA],
    ),
  },

  /* ---- pack and energy (physics.js) ---- */
  'W-ENERGY-PARALLEL-PACKS': {
    code: 'W-ENERGY-PARALLEL-PACKS', producer: 'plan', severity: 'caution', legacyLevel: 'warning',
    explanation: why(
      ['pack count', 'harness mass allowance'],
      'parallel packs modelled as identical cells at equal state of charge',
      ['mismatched packs share current unevenly and this model cannot see that'],
    ),
  },
  'W-ENERGY-HOVER-OVER-RATING': {
    code: 'W-ENERGY-HOVER-OVER-RATING', producer: 'plan', severity: 'critical', legacyLevel: 'critical',
    explanation: why(
      ['hover current', 'pack continuous current rating'],
      "the manufacturer's continuous discharge rating",
      ['ratings are optimistic and are quoted at room temperature'],
    ),
  },
  'W-ENERGY-HOVER-NEAR-RATING': {
    code: 'W-ENERGY-HOVER-NEAR-RATING', producer: 'plan', severity: 'warning', legacyLevel: 'serious',
    explanation: why(
      ['hover current', 'pack continuous current rating'],
      'hover draw past 60% of the continuous rating',
      ['ratings are optimistic and are quoted at room temperature'],
    ),
  },
  'W-ENERGY-SAG-LIMITED': {
    code: 'W-ENERGY-SAG-LIMITED', producer: 'plan', severity: 'warning', legacyLevel: 'serious',
    explanation: why(
      ['pack internal resistance', 'cell count', 'mission average power'],
      'the discharge integration hitting the voltage floor before the capacity floor',
      ['internal resistance is a single figure, not a curve against temperature and age'],
    ),
  },
  'W-ENERGY-PACK-COLD': {
    code: 'W-ENERGY-PACK-COLD', producer: 'plan', severity: 'caution', legacyLevel: 'warning',
    explanation: why(
      ['pack temperature', 'cell chemistry'],
      'the chemistry table\'s cold-capacity and cold-resistance derates',
      ['derived from a gentle bench discharge, so first-pull sag is under-stated'],
    ),
  },
  'W-ENERGY-PACK-PREHEATED': {
    code: 'W-ENERGY-PACK-PREHEATED', producer: 'plan', severity: 'caution', legacyLevel: 'warning',
    explanation: why(
      ['pack temperature override', 'air temperature', 'cell chemistry'],
      'a pack held above ambient with no cooling model behind it',
      ['nothing here models the pack cooling in the airstream'],
    ),
  },

  /* ---- air and wind (physics.js) ---- */
  'W-WIND-NO-CLOSE': {
    code: 'W-WIND-NO-CLOSE', producer: 'plan', severity: 'critical', legacyLevel: 'critical',
    explanation: why(
      ['planning wind', 'cruise policy', 'loaded top speed'],
      'an out-and-back that closes at the planned speed against the planned wind',
      [ONE_BEARING, 'wind is one figure for the whole flight'],
    ),
  },
  'W-WIND-GUST-AUTHORITY': {
    code: 'W-WIND-GUST-AUTHORITY', producer: 'plan', severity: 'warning', legacyLevel: 'serious',
    explanation: why(
      ['gust speed', 'loaded top speed'],
      'gusts past 45% of the airframe\'s top speed',
      ['control authority is inferred from speed margin, not simulated'],
    ),
  },
  'W-AIR-DENSITY-ALTITUDE': {
    code: 'W-AIR-DENSITY-ALTITUDE', producer: 'plan', severity: 'caution', legacyLevel: 'warning',
    explanation: why(
      ['elevation', 'temperature', 'humidity'],
      'density altitude past 2,500 m',
      ['one density figure is used for the whole flight'],
    ),
  },

  /* ---- terrain (render/terrain.js's card, and M3b's route-wide pass) ---- */
  'W-TERR-CLEARANCE': {
    code: 'W-TERR-CLEARANCE', producer: 'terrain', severity: 'critical', legacyLevel: 'critical',
    explanation: why(
      ['elevation profile along the planned bearing', 'corridor terrain samples',
        'each leg\'s resolved altitude'],
      'ground staying below the height the aircraft is flying at',
      [SAMPLED_GROUND, BARE_EARTH],
    ),
  },
  'W-TERR-CLEARANCE-LOW': {
    code: 'W-TERR-CLEARANCE-LOW', producer: 'terrain', severity: 'warning', legacyLevel: 'serious',
    explanation: why(
      ['elevation profile along the planned bearing', 'corridor terrain samples',
        'each leg\'s resolved altitude'],
      'at least 30 m of clearance over the ground everywhere the route goes',
      [SAMPLED_GROUND, BARE_EARTH],
    ),
  },

  /* ---- radio link (render/terrain.js's card, and M3b's route-wide pass) ---- */
  'W-RF-LOS-BLOCKED': {
    code: 'W-RF-LOS-BLOCKED', producer: 'link', severity: 'critical', legacyLevel: 'critical',
    explanation: why(
      ['elevation profile', 'corridor terrain samples', 'flight altitude',
        'antenna height', 'radio band'],
      'a clear line of sight from the pilot to the aircraft',
      [SAMPLED_GROUND, 'antenna pattern, polarisation and transmit power are not modelled'],
    ),
  },
  'W-RF-FRESNEL': {
    code: 'W-RF-FRESNEL', producer: 'link', severity: 'warning', legacyLevel: 'serious',
    explanation: why(
      ['elevation profile', 'corridor terrain samples', 'flight altitude',
        'antenna height', 'radio band'],
      'the first Fresnel zone kept 60% clear of the ground',
      [SAMPLED_GROUND, 'antenna pattern, polarisation and transmit power are not modelled'],
    ),
  },

  /* ---- authored by the analysis itself ---- */
  'W-ANALYSIS-UNCLASSIFIED': {
    code: 'W-ANALYSIS-UNCLASSIFIED', producer: 'analysis', severity: 'unknown', legacyLevel: null,
    explanation: why(
      ['a warning from a producer with no registry entry'],
      'every emitted warning carrying a stable code',
      ['the sentence is intact but this finding cannot be tracked across recomputes'],
    ),
  },
  'W-ENERGY-NO-PACK': {
    code: 'W-ENERGY-NO-PACK', producer: 'analysis', severity: 'critical', legacyLevel: null,
    explanation: why(
      ['the selected battery'],
      'a pack the model can integrate a discharge for',
      ['nothing about this mission can be answered without one'],
    ),
  },
  'W-DATA-TERRAIN-ABSENT': {
    code: 'W-DATA-TERRAIN-ABSENT', producer: 'analysis', severity: 'unknown', legacyLevel: null,
    explanation: why(
      ['the terrain provider'],
      'an elevation profile along the planned course',
      ['no ground was checked — the ring and the route are energy only'],
    ),
  },
  'W-DATA-FORECAST-AGE': {
    code: 'W-DATA-FORECAST-AGE', producer: 'analysis', severity: 'caution', legacyLevel: null,
    explanation: why(
      ['the environment reference\'s fetch provenance', 'analysis time'],
      'a fetched forecast read within the last 6 hours',
      ['fires only for a fetched source — a manual or preset environment has no fetch time to age'],
    ),
  },
  'W-DATA-FORECAST-STALE': {
    code: 'W-DATA-FORECAST-STALE', producer: 'analysis', severity: 'warning', legacyLevel: null,
    explanation: why(
      ['the environment reference\'s fetch provenance', 'analysis time'],
      'a fetched forecast read within the last 24 hours',
      ['the numbers are the last real forecast, not padding — refetch once connectivity returns',
        'fires only for a fetched source — a manual or preset environment has no fetch time to age'],
    ),
  },
  'W-DATA-LINK-ABSENT': {
    code: 'W-DATA-LINK-ABSENT', producer: 'analysis', severity: 'unknown', legacyLevel: null,
    explanation: why(
      ['the radio-link provider'],
      'a line-of-sight and Fresnel check along the planned course',
      ['no link check ran — video and control range are unstated'],
    ),
  },
  'W-DATA-ALTITUDE-UNRESOLVED': {
    code: 'W-DATA-ALTITUDE-UNRESOLVED', producer: 'analysis', severity: 'unknown', legacyLevel: null,
    explanation: why(
      ['segment altitude', 'launch elevation', 'terrain samples'],
      'every authored height resolving to metres MSL (ADR 0003)',
      ['an unresolved height is left null rather than assumed to be zero'],
    ),
  },
  'W-ROUTE-UNFLYABLE': {
    code: 'W-ROUTE-UNFLYABLE', producer: 'analysis', severity: 'critical', legacyLevel: null,
    explanation: why(
      ['leg courses', 'planning wind', 'cruise policy'],
      'every leg of the route solvable at the planned speed',
      ['wind is one figure for the whole flight'],
    ),
  },
  'W-ROUTE-RESERVE-SHORT': {
    code: 'W-ROUTE-RESERVE-SHORT', producer: 'analysis', severity: 'warning', legacyLevel: null,
    explanation: why(
      ['route energy', 'delivered energy', 'landing floor', 'hunt-and-land allowance'],
      'the worst waypoint still affording an adverse-wind flight home',
      [NO_VERTICAL, 'the return is flown direct from the worst point, not retraced'],
    ),
  },
  'W-RESERVE-ONE-WAY': {
    code: 'W-RESERVE-ONE-WAY', producer: 'analysis', severity: 'warning', legacyLevel: null,
    explanation: why(
      ['return policy'],
      'a plan that brings the aircraft back to the launch point',
      ['no return leg is costed — the reserve here protects nothing'],
    ),
  },
  'W-RESERVE-HOLD-BUDGET': {
    code: 'W-RESERVE-HOLD-BUDGET', producer: 'analysis', severity: 'warning', legacyLevel: null,
    explanation: why(
      ['dwell times', 'planning wind', 'station-keeping and orbit airspeeds',
        'loiter budget at the last waypoint'],
      'total dwell fitting inside the energy left after the route is flown',
      ['a hold is charged at the power to fly at the wind\'s own speed, which is what holding a '
        + 'position over the ground costs',
      'an orbit is charged at its worst quarter — tangential speed plus the wind — so an orbit in '
        + 'wind reads pessimistic on purpose rather than average'],
    ),
  },
  'W-SHOT-SUBJECT-MISSING': {
    code: 'W-SHOT-SUBJECT-MISSING', producer: 'analysis', severity: 'warning', legacyLevel: null,
    explanation: why(
      ['segment intent', 'the segment\'s subject reference', 'the scene\'s subjects'],
      'every framing intent naming the subject it frames',
      ['nothing here infers what a shot was aimed at — an unattached shot has no geometry, not a '
        + 'guessed one',
      'the leg still flies and still costs what it costs; it is the camera figures that are absent'],
    ),
  },
  'W-SHOT-ORBIT-RADIUS': {
    code: 'W-SHOT-ORBIT-RADIUS', producer: 'analysis', severity: 'warning', legacyLevel: null,
    explanation: why(
      ['authored orbit radius', 'the subject\'s own radius'],
      'an orbit flown outside the thing it circles',
      ['a subject radius is an authored bounding figure, not a measured footprint — a wide flat '
        + 'subject reads smaller than it is',
      'this compares two authored radii and nothing else: no obstacle clearance is implied by it'],
    ),
  },
  'W-SHOT-HOLD-WIND': {
    code: 'W-SHOT-HOLD-WIND', producer: 'analysis', severity: 'warning', legacyLevel: null,
    explanation: why(
      ['planning wind', 'the orbit\'s tangential speed', 'the aircraft snapshot\'s top speed'],
      'a hold the airframe can actually hold — the wind\'s own speed to stay over a point, '
      + 'tangential plus wind to carry an orbit through its upwind quarter',
      ['the top speed is the airframe\'s recorded figure, not one measured at this all-up mass',
        'wind is one figure for the whole flight',
        'the orbit figure is its worst quarter — the other three ask for less'],
    ),
  },
  'W-SPEED-POLICY-UNSUPPORTED': {
    code: 'W-SPEED-POLICY-UNSUPPORTED', producer: 'analysis', severity: 'caution', legacyLevel: null,
    explanation: why(
      ['segment speed policy'],
      'each segment flown at the speed it was authored with',
      ['the leg solver takes one cruise policy for the whole route (M3)'],
    ),
  },
  /**
   * Retired by M3b, and deliberately still here.
   *
   * Nothing produces this any more: climb and descent now cost something, so the
   * sentence this code carried ("the change is recorded and costs nothing") is no
   * longer true and W-ALT-VERTICAL-CONSERVATIVE says the true thing instead. The
   * entry stays because these ids travel — a brief exported last week, a
   * dismissal saved in someone's browser — and a reader that meets this code has
   * to be able to look it up. A registered code with no producer is fine; an
   * unregistered one that turns up in saved state is not.
   */
  'W-ALT-VERTICAL-UNMODELLED': {
    code: 'W-ALT-VERTICAL-UNMODELLED', producer: 'analysis', severity: 'advisory', legacyLevel: null,
    explanation: why(
      ['segment altitudes'],
      'level flight between waypoints',
      [NO_VERTICAL, 'retired in M3b: superseded by W-ALT-VERTICAL-CONSERVATIVE'],
    ),
  },
  'W-ALT-VERTICAL-CONSERVATIVE': {
    code: 'W-ALT-VERTICAL-CONSERVATIVE', producer: 'analysis', severity: 'advisory', legacyLevel: null,
    explanation: why(
      ['segment altitudes', 'all-up mass', 'drivetrain efficiency', 'hover power'],
      'a climb charged at the potential energy it buys, and a descent charged at no less '
      + 'than level flight',
      [CLIMB_BOUND, NO_REGEN,
        'the climb and descent times are reported but not added to the leg, so a leg too '
        + 'short to make its own height change is stated rather than lengthened'],
    ),
  },
  'W-ALT-DENSITY-OPTIMISTIC': {
    code: 'W-ALT-DENSITY-OPTIMISTIC', producer: 'analysis', severity: 'caution', legacyLevel: null,
    explanation: why(
      ['launch elevation', 'temperature', 'humidity', 'each leg\'s resolved altitude'],
      'the air the plan was solved in being the air the route actually flies through',
      ['the plan is solved at one density for the whole flight; this compares that '
        + 'density against the air at each leg\'s own height',
        'humidity is carried up unchanged, and the temperature is lapsed at the ISA rate '
        + 'rather than forecast'],
    ),
  },
  'W-WIND-LEVEL-MISMATCH': {
    code: 'W-WIND-LEVEL-MISMATCH', producer: 'analysis', severity: 'caution', legacyLevel: null,
    explanation: why(
      ['the forecast\'s published wind levels', 'the planning level', 'each leg\'s height above launch'],
      'the route being flown in the wind it was planned against',
      ['the plan takes one wind for the whole flight; nothing here re-solves a leg at its own wind',
        'levels between two published heights are interpolated, and a forecast with one '
        + 'level supports no gradient at all'],
    ),
  },
  'W-DATA-TERRAIN-SAMPLE-MISSING': {
    code: 'W-DATA-TERRAIN-SAMPLE-MISSING', producer: 'analysis', severity: 'unknown', legacyLevel: null,
    explanation: why(
      ['corridor terrain samples', 'the elevation provider\'s coverage'],
      'ground under every station of the route',
      ['a station with no elevation is checked against nothing — it is not clear, it is unknown',
        SAMPLED_GROUND],
    ),
  },
  'W-RETURN-TERRAIN-BLOCKED': {
    code: 'W-RETURN-TERRAIN-BLOCKED', producer: 'analysis', severity: 'critical', legacyLevel: null,
    explanation: why(
      ['corridor terrain samples', 'the direct line home from each waypoint', 'return altitude'],
      'a flight home from any waypoint that stays above the ground under it',
      [SAMPLED_GROUND, BARE_EARTH,
        'the return is flown at one height — nothing here plans a climb to clear the ridge'],
    ),
  },
  'W-RETURN-TERRAIN-UNKNOWN': {
    code: 'W-RETURN-TERRAIN-UNKNOWN', producer: 'analysis', severity: 'unknown', legacyLevel: null,
    explanation: why(
      ['corridor terrain samples', 'the direct line home from each waypoint'],
      'ground under the direct flight home from every waypoint',
      ['only the route corridor was sampled, and a direct return cuts across ground '
        + 'nobody looked at',
        SAMPLED_GROUND],
    ),
  },
  'W-RETURN-ENERGY-SHORT': {
    code: 'W-RETURN-ENERGY-SHORT', producer: 'analysis', severity: 'warning', legacyLevel: null,
    explanation: why(
      ['energy spent reaching each waypoint', 'the adverse-wind flight home from it',
        'the hunt-and-land allowance', 'delivered energy'],
      'every waypoint on the route still affording the flight home from it',
      ['the return is direct and level — a climb to clear terrain on the way back is not costed',
        NO_VERTICAL],
    ),
  },

  /* ---- the mountain-flow advisory (M5) ----
   *
   * Aggregate, not per-cell. The forcing field classifies every cell of an area
   * grid, and the map draws all of them; the constraints below say once, for the
   * whole mission, which of those classes turned up around this route. One
   * constraint per lee cell would be four hundred sentences saying the same
   * thing, and a warning list nobody reads is a warning list that does not work.
   */
  'W-WIND-LEE': {
    code: 'W-WIND-LEE', producer: 'wind', severity: 'warning', legacyLevel: null,
    explanation: why(
      ['area elevation grid around the route', 'the wind at the level the plan flies',
        'the terrain-forcing proxy w* = V·∇h'],
      'B1 terrain forcing: cells on a downwind slope, where the modelled flow is being '
      + 'driven down the ground rather than over it — the setting descending air and '
      + 'rotors are associated with',
      [W_PROXY, NO_ROTOR, SURFACE_FLOW, ONE_WIND, BARE_EARTH],
    ),
  },
  'W-WIND-UPLIFT': {
    code: 'W-WIND-UPLIFT', producer: 'wind', severity: 'advisory', legacyLevel: null,
    explanation: why(
      ['area elevation grid around the route', 'the wind at the level the plan flies',
        'the terrain-forcing proxy w* = V·∇h'],
      'B1 terrain forcing: cells on a windward slope, where the modelled flow is being '
      + 'driven up the ground',
      [W_PROXY, SURFACE_FLOW,
        'relative uplift potential is not lift you can plan on, and the same terrain that '
        + 'lifts on one bearing sinks on the reciprocal',
        ONE_WIND, BARE_EARTH],
    ),
  },
  'W-WIND-ACCEL': {
    code: 'W-WIND-ACCEL', producer: 'wind', severity: 'caution', legacyLevel: null,
    explanation: why(
      ['area elevation grid around the route', 'the wind at the level the plan flies',
        'local relief across each cell'],
      'B1 terrain forcing: crest and gap cells — ground that stands above its surroundings '
      + 'or confines the flow between higher ground, the geometry where a wind speeds up',
      [W_PROXY, SURFACE_FLOW,
        'the speed-up itself is not computed: this reports the geometry, not a wind figure',
        NO_ROTOR, ONE_WIND, BARE_EARTH],
    ),
  },
  'W-WIND-REGIME': {
    code: 'W-WIND-REGIME', producer: 'wind', severity: 'caution', legacyLevel: null,
    explanation: why(
      ['forecast pressure-level sounding', 'the wind crossing the barrier',
        'the relief of the terrain around the route'],
      'B2 stability regime: the Froude-like ratio Fr = U/(N·h), which says whether the air '
      + 'has the momentum to climb the terrain or is more likely to be blocked by it and '
      + 'divert around',
      ['a single bulk number for a whole area — real flow splits, and this cannot say where',
        'the sounding is a coarse forecast column, not a measured ascent, and the layer it '
        + 'spans is the forecast\'s vertical resolution rather than the barrier\'s',
        'a low Fr says the flow may be blocked; it does not locate the lee eddy or the '
        + 'hydraulic jump that blocking is associated with',
        NOT_SAFE],
    ),
  },
  'W-WIND-SENSITIVE': {
    code: 'W-WIND-SENSITIVE', producer: 'wind', severity: 'caution', legacyLevel: null,
    explanation: why(
      ['the classified forcing field', 'a ±20° / ±30% envelope around the forecast wind'],
      'B1 re-run across that envelope: the share of classified cells that change class '
      + 'under any member, against the bound the baseline was validated to',
      ['above the bound the picture is describing the forecast\'s uncertainty as much as '
        + 'the terrain — the classes are not wrong, they are not settled',
        'the envelope is a fixed spread, not the forecast\'s own stated error',
        W_PROXY, NOT_SAFE],
    ),
  },
  'W-WIND-STALE': {
    code: 'W-WIND-STALE', producer: 'wind', severity: 'unknown', legacyLevel: null,
    explanation: why(
      ['where the sounding was fetched for', 'where this mission launches'],
      'a stability regime computed from air over the launch point',
      ['the sounding on hand was fetched for somewhere else, so the regime describes that '
        + 'place and not this one — refetch the sky for this launch',
        'the forcing field and its wind are unaffected; this is about the regime only'],
    ),
  },
  'W-WIND-NODATA': {
    code: 'W-WIND-NODATA', producer: 'wind', severity: 'unknown', legacyLevel: null,
    explanation: why(
      ['the elevation provider\'s coverage over the area grid'],
      'an elevation for every cell of the area around the route',
      ['a cell with no elevation is classified against nothing — it is not low-forcing, '
        + 'it is unknown, and it is drawn as missing rather than left blank',
        'per ADR 0008 missing data is a stated warning, never silence',
        SAMPLED_GROUND, NOT_SAFE],
    ),
  },

  /* ---- the mountain dive (M16) ----
   *
   * Ten codes over one model, and the limitations named above them are why they
   * read the way they do. Every figure here is closed-form mechanics over what
   * the pilot authored — a gate's height, a stated speed, a stated load — and
   * none of it is a measurement of this airframe. The claim this family is
   * forbidden to make is stated once, as NO_THERMAL, and rides on every code it
   * bears on: nothing in this tool knows how hot a motor gets, so no code here
   * quotes a temperature or a thermal margin — not even an empty one.
   *
   * The producer is `analysis`, not `plan`, and the distinction is load-bearing
   * rather than cosmetic: `plan` means planMission wrote the sentence and
   * classifyLegacy recognised it, which the registry's own fixture test asserts
   * for every code carrying that producer. These ten are drafted by the pipeline
   * itself — dive-checks.js over dive-dynamics.js — exactly as route-checks.js's
   * W-RETURN-* and W-RESERVE-* are, and they sit with them.
   */
  'W-DIVE-PULLOUT-GROUND': {
    code: 'W-DIVE-PULLOUT-GROUND', producer: 'analysis', severity: 'critical', legacyLevel: null,
    explanation: why(
      ['the dive leg\'s pitch', 'the authored dive speed', 'the authored pullout load',
        'the dive gate\'s altitude', 'the ground under the dive gate'],
      'the lowest point of the pullout arc staying above the ground under the gate',
      [PULL_AT_GATE, CONSTANT_SPEED_ARC, SAMPLED_GROUND, BARE_EARTH, AUTHORED_LINE],
    ),
  },
  'W-DIVE-PULLOUT-THIN': {
    code: 'W-DIVE-PULLOUT-THIN', producer: 'analysis', severity: 'warning', legacyLevel: null,
    explanation: why(
      ['the dive leg\'s pitch', 'the authored dive speed', 'the authored pullout load',
        'the dive gate\'s altitude', 'the ground under the dive gate'],
      `at least ${DIVE_PULLOUT_CLEARANCE_WARN_M} m under the bottom of the pullout arc`,
      [PULL_AT_GATE, CONSTANT_SPEED_ARC, SAMPLED_GROUND, BARE_EARTH, AUTHORED_LINE],
    ),
  },
  'W-DIVE-PULLOUT-UNSTATED': {
    code: 'W-DIVE-PULLOUT-UNSTATED', producer: 'analysis', severity: 'unknown', legacyLevel: null,
    explanation: why(
      ['the authored dive speed', 'the authored pullout load'],
      'a dive line carrying the speed and the load its pullout is flown at',
      ['without both figures there is no arc to compute, so the ground under the pullout '
        + 'is unchecked rather than clear',
      'a stated load of 1 g or less describes no arc either — at that load the rotors hold '
        + 'the weight or bend the path, not both — and it lands here for the same reason',
      'neither figure is guessed at: a house cruise speed standing in for the authored '
        + 'one would put a number under this constraint that nobody planned'],
    ),
  },
  'W-DIVE-SAG-LIMITED': {
    code: 'W-DIVE-SAG-LIMITED', producer: 'analysis', severity: 'warning', legacyLevel: null,
    explanation: why(
      ['hover power', 'the authored pullout load', 'pack internal resistance', 'cell count',
        'pack temperature', 'state of charge at the pullout'],
      'the pack holding a terminal voltage while delivering the pullout draw',
      [HOVER_SCALED,
        'internal resistance is a single figure, not a curve against temperature and age',
        NO_THERMAL],
    ),
  },
  'W-DIVE-MOTOR-MARGIN': {
    code: 'W-DIVE-MOTOR-MARGIN', producer: 'analysis', severity: 'warning', legacyLevel: null,
    explanation: why(
      ['pack current during the pullout', 'rotor count', 'the catalog\'s per-motor current limit'],
      `at least ${DIVE_MARGIN_PCT}% of the motors' current ceiling left unused by the pull`,
      [HOVER_SCALED,
        'the limit is a catalog figure for this motor, not one measured on this build',
        NO_THERMAL],
    ),
  },
  'W-DIVE-ESC-MARGIN': {
    code: 'W-DIVE-ESC-MARGIN', producer: 'analysis', severity: 'warning', legacyLevel: null,
    explanation: why(
      ['pack current during the pullout', 'rotor count', 'the catalog\'s per-ESC current limit'],
      `at least ${DIVE_MARGIN_PCT}% of the ESCs' current ceiling left unused by the pull`,
      [HOVER_SCALED,
        'the limit is a catalog figure for this ESC, not one measured on this build',
        NO_THERMAL],
    ),
  },
  'W-DIVE-RESERVE-SHORT': {
    code: 'W-DIVE-RESERVE-SHORT', producer: 'analysis', severity: 'warning', legacyLevel: null,
    explanation: why(
      ['usable pack energy', 'the mission\'s planned energy', 'the climb to the lost-link altitude',
        'the distance home from the last gate', 'the landing floor'],
      'the pack still holding its landing floor once the dive is flown and the ride home is paid for',
      ['the whole mission\'s planned energy is charged before the recovery, which is the '
        + 'least reserve the plan can leave rather than the most',
        'the dive line\'s own descent and pullout are not in that figure — no leg of the '
        + 'dive reaches the route integrator',
        'the flight home is charged at the route\'s own cruise power over the closing speed '
        + 'left after the planning wind, and is flown direct rather than retraced',
        NO_REGEN],
    ),
  },
  'W-DIVE-RTH-BELOW-TERRAIN': {
    code: 'W-DIVE-RTH-BELOW-TERRAIN', producer: 'analysis', severity: 'critical', legacyLevel: null,
    explanation: why(
      ['the authored lost-link altitude', 'the ground under each gate of the dive line'],
      'a lost-link altitude above every piece of ground the dive line crosses',
      [SAMPLED_GROUND, BARE_EARTH,
        'the ground is read under the gates, not along the whole line between them — a '
        + 'ridge standing between two gates is not in this comparison'],
    ),
  },
  'W-DIVE-NO-BAILOUT': {
    code: 'W-DIVE-NO-BAILOUT', producer: 'analysis', severity: 'advisory', legacyLevel: null,
    explanation: why(
      ['the dive plan\'s bailout landing'],
      'a dive plan naming somewhere to put the aircraft down if the run is abandoned',
      ['nothing here judges whether a named bailout is landable — this is about whether '
        + 'one was named at all',
        'no bailout is costed: naming one adds no energy, distance or time to any figure '
        + 'in this plan'],
    ),
  },
  'W-DIVE-GROUND-UNKNOWN': {
    code: 'W-DIVE-GROUND-UNKNOWN', producer: 'analysis', severity: 'unknown', legacyLevel: null,
    explanation: why(
      ['the elevation provider\'s coverage under the dive line'],
      'ground under the pad and every gate of the dive line',
      ['a gate with no elevation under it is checked against nothing — its clearance is '
        + 'unknown, not clear',
        SAMPLED_GROUND],
    ),
  },
}));

/**
 * Explanation codes for per-segment notes — the machine-readable half of "why
 * does this segment read the way it does". They ride on SegmentAnalysis rather
 * than raising a constraint, because one per segment would be noise.
 * @type {Readonly<Record<string, string>>}
 */
export const EXPLANATION_CODES = Object.freeze({
  'X-SPEED-POLICY-FALLBACK': 'Authored speed policy not honoured; flown at the plan\'s cruise policy.',
  // Retired with W-ALT-VERTICAL-UNMODELLED, and kept for the same reason: it is
  // on segments inside briefs that were exported before M3b.
  'X-ALT-VERTICAL-UNMODELLED': 'Altitude change recorded; no vertical energy is modelled.',
  'X-ALT-VERTICAL-CHARGED': 'Altitude change costed: climb at m·g·h/η, descent at no credit.',
  'X-ALT-UNRESOLVED': 'Altitude has no metres-MSL figure, so nothing was derived from it.',
  // Retired in M7, and kept for the reason above: dwell is charged at the power
  // to stay put in the planning wind now, but briefs exported before M7 carry
  // this code on their hold segments and a reader has to be able to look it up.
  'X-HOLD-HOVER-POWER': 'Dwell charged at hover power for the authored time.',
  'X-HOLD-STATION-POWER': 'Dwell charged at the power to hold position against the planning wind.',
  'X-HOLD-ORBIT-AIRSPEED': 'Orbit charged at its worst quarter: tangential speed plus the wind.',
  'X-SHOT-FRAMED': 'Camera geometry computed against this leg\'s resolved altitudes.',
  'X-TERR-SAMPLE-MISSING': 'Some ground under this leg has no elevation; clearance there is unknown.',
});

/* ---------- legacy warning classification ---------- */

/**
 * Text patterns that identify each legacy warning, scoped to the producer that
 * emits it. Anchored on the fixed prose, never on an interpolated number.
 * @type {readonly { producer: ConstraintProducer, code: string, match: RegExp }[]}
 */
const LEGACY_MATCHERS = Object.freeze([
  { producer: 'plan', code: 'W-LIFT-NO-LIFT', match: /^WILL NOT FLY:/ },
  { producer: 'plan', code: 'W-LIFT-NO-MARGIN', match: /thrust-to-weight — it may lift/ },
  { producer: 'plan', code: 'W-LIFT-MARGINAL', match: /thrust-to-weight is marginal for gusts/ },
  { producer: 'plan', code: 'W-ENERGY-PARALLEL-PACKS', match: /^Parallel mode assumes/ },
  { producer: 'plan', code: 'W-WIND-NO-CLOSE', match: /^Wind or loaded propulsion limits/ },
  { producer: 'plan', code: 'W-ENERGY-HOVER-OVER-RATING', match: /^Hover draw ~/ },
  { producer: 'plan', code: 'W-ENERGY-HOVER-NEAR-RATING', match: /^Hover draw is/ },
  { producer: 'plan', code: 'W-ENERGY-SAG-LIMITED', match: /^Voltage sag cuts the flight/ },
  { producer: 'plan', code: 'W-WIND-GUST-AUTHORITY', match: /^Gusts are a large fraction/ },
  { producer: 'plan', code: 'W-ENERGY-PACK-COLD', match: /pack: less capacity than the plan/ },
  { producer: 'plan', code: 'W-ENERGY-PACK-PREHEATED', match: /^Preheated pack in cold air/ },
  { producer: 'plan', code: 'W-AIR-DENSITY-ALTITUDE', match: /^Density altitude/ },
  { producer: 'terrain', code: 'W-TERR-CLEARANCE', match: /^Terrain above your cruise altitude/ },
  { producer: 'terrain', code: 'W-TERR-CLEARANCE-LOW', match: /of clearance/ },
  { producer: 'link', code: 'W-RF-LOS-BLOCKED', match: /^Energy OK, link blocked/ },
  { producer: 'link', code: 'W-RF-FRESNEL', match: /^Energy OK, link degrading/ },
]);

/**
 * The code for a legacy warning, or W-ANALYSIS-UNCLASSIFIED when no matcher
 * claims it. The producer scopes the search so two producers can never fight
 * over one sentence.
 * @param {ConstraintProducer} producer
 * @param {string} text
 * @returns {string}
 */
export function classifyLegacy(producer, text) {
  for (const m of LEGACY_MATCHERS) {
    if (m.producer === producer && m.match.test(text)) return m.code;
  }
  return 'W-ANALYSIS-UNCLASSIFIED';
}

/* ---------- building constraints ---------- */

/** A constraint before ids are assigned. @typedef {Omit<Constraint, 'id'>} ConstraintDraft */

/**
 * A draft from a registered code. `text` is the sentence to show — supplied by
 * the caller in every case, because the pilot-facing prose belongs to whoever
 * wrote it, not to this registry.
 * @param {string} code
 * @param {string} text
 * @param {ConstraintAnchor} [anchor]
 * @param {Severity} [severityOverride]
 * @returns {ConstraintDraft}
 */
export function draftConstraint(code, text, anchor = MISSION_ANCHOR, severityOverride) {
  const entry = CONSTRAINT_CODES[code];
  if (!entry) throw new RangeError(`Unknown constraint code: ${code}`);
  return {
    code: entry.code,
    severity: severityOverride ?? entry.severity,
    text,
    anchor,
    explanation: entry.explanation,
  };
}

/**
 * A draft from one of today's `{ level, text }` warnings. The text survives
 * intact; the level decides severity only when the registry has no entry for
 * the matched code, so a producer that changes a level cannot quietly demote a
 * classified finding.
 * @param {ConstraintProducer} producer
 * @param {LegacyWarning} warning
 * @param {ConstraintAnchor} [anchor]
 * @returns {ConstraintDraft}
 */
export function draftFromLegacy(producer, warning, anchor = MISSION_ANCHOR) {
  const code = classifyLegacy(producer, warning.text);
  const severity = code === 'W-ANALYSIS-UNCLASSIFIED'
    ? (LEGACY_SEVERITY[warning.level] ?? 'unknown')
    : undefined;
  return draftConstraint(code, warning.text, anchor, severity);
}

/**
 * Assign deterministic ids and freeze. Order is preserved — it is the order the
 * producers ran in, which is the order the rail has always shown — and the
 * `#n` suffix only appears on a genuine repeat of the same code at the same
 * anchor.
 * @param {ConstraintDraft[]} drafts
 * @returns {Constraint[]}
 */
export function finalizeConstraints(drafts) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  return drafts.map((d) => {
    const key = `${d.code}\u0000${d.anchor.scope}\u0000${d.anchor.refId ?? ''}`;
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return Object.freeze({ ...d, id: constraintId(d.code, d.anchor, occurrence) });
  });
}
