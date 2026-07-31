// wind-advisory.js — the mountain-flow advisory pass (M5).
//
// Wave 1 put two baselines in the domain: B1 classifies every cell of an area
// grid by the terrain forcing `w* = V·∇h` the wind imposes on it, and B2 reads a
// Froude-like `Fr = U/(N·h)` off a sounding to say whether the air can climb the
// ground at all. Wave 2 put an area-grid elevation sampler behind an injected
// port. This module is the join: one pass, one advisory block for the snapshot,
// and the aggregate constraints that make the finding readable without the map.
//
// Two decisions are worth reading before changing anything here.
//
//   Zones are render data; constraints are aggregate. The forcing field carries
//     a class for every cell and the map draws all of them — but a route past a
//     ridge produces hundreds of lee cells, and hundreds of identical warnings
//     is a warning list nobody reads. So each *class* raises at most one
//     mission-level constraint, counting the cells behind it. The classId →
//     code map is frozen in analysis-contracts.js precisely so the colour on the
//     map and the code in the brief can never drift apart (M5 exit gate: "the
//     mission brief and map use the same warning identifiers").
//
//   Every sentence carries the prohibited claims as their opposites. `w*` is a
//     relative forcing proxy and not a forecast vertical velocity; nothing here
//     locates a rotor; and low modelled forcing is never "safe". Those clauses
//     live on the registry entries in constraints.js and in the advisory's own
//     provenance, so a surface that renders either one cannot omit them.
//
// Pure: the grid, the wind and the sounding all arrive as values. The host owns
// the fetching and the freshness, and hands the result of both in.

import { distanceKm } from '../../domain/geo.js';
import { computeRegime, gridReliefM } from '../../domain/wind/regime.js';
import { classificationSensitivity, computeForcingField } from '../../domain/wind/terrain-forcing.js';
import {
  ADVISORY_CLASS_CODE, ADVISORY_SENSITIVITY_BOUND, SOUNDING_STALE_EPSILON_DEG,
  advisoryProvenanceOf,
} from './analysis-contracts.js';
import { draftConstraint } from './constraints.js';

/**
 * @typedef {import('./analysis-contracts.js').AdvisoryField} AdvisoryField
 * @typedef {import('./analysis-contracts.js').AdvisoryProvenance} AdvisoryProvenance
 * @typedef {import('./analysis-contracts.js').AdvisoryWind} AdvisoryWind
 * @typedef {import('../terrain/terrain-contracts.js').AdvisoryGridField} AdvisoryGridField
 * @typedef {import('../../domain/wind/regime.js').RegimeResult} RegimeResult
 * @typedef {import('../../domain/wind/terrain-forcing.js').ForcingClassId} ForcingClassId
 * @typedef {import('./constraints.js').ConstraintDraft} ConstraintDraft
 */

/** @typedef {{ lat: number, lng: number }} LatLng */

/**
 * What the pass is asked about. Everything impure has already happened: the
 * host either has a grid for this route or does not, and says which.
 *
 * @typedef {object} WindAdvisorySpec
 * @property {LatLng} launch
 * @property {AdvisoryGridField|null} field  the sampled area grid, when one is in
 *   hand *for this route* — a grid for a different route is not this route's
 *   answer and the host holds it back rather than passing it
 * @property {boolean} portWired  whether an area-grid sampler exists at all
 * @property {boolean} pending    whether sampling for this route is in flight
 * @property {number|null} windMph      the wind the plan flies in
 * @property {number|null} windFromDeg
 * @property {number|null} windLevelM   the height that wind was read at, m AGL
 * @property {string} windSource        label recorded in the provenance
 * @property {unknown} sounding         pressure levels, lowest first
 * @property {LatLng|null} soundingAt   where that sounding was fetched for
 */

/**
 * A wind through the barrier layer at or below this is calm for the regime's
 * purposes: `Fr = U/(N·h)` goes to zero with U, and a zero from a calm wind is
 * not evidence of blocking. 0.5 m/s is about 1 mph — below the resolution of
 * any forecast behind this app, and below the speed at which terrain forcing
 * means anything either.
 */
const CALM_MS = 0.5;

/**
 * The classes that raise a constraint, worst first. `low` and `unknown` are
 * absent by design — see ADVISORY_CLASS_CODE. `gap` and `ridge` share
 * W-WIND-ACCEL, so they are counted together and said once.
 * @type {readonly ForcingClassId[]}
 */
const REPORTED_CLASSES = Object.freeze(
  /** @type {ForcingClassId[]} */ (['lee', 'gap', 'ridge', 'uplift']));

/**
 * Run the advisory for one pass.
 *
 * Never throws and never returns a half-answer: when there is no grid the
 * advisory comes back with a status saying why and, when that absence is
 * terminal, the constraint that states it. Per ADR 0008 missing data is a
 * stated warning, never silence.
 *
 * @param {WindAdvisorySpec} spec
 * @returns {{ advisories: AdvisoryField, drafts: ConstraintDraft[] }}
 */
export function windAdvisory(spec) {
  /** @type {ConstraintDraft[]} */
  const drafts = [];
  const wind = advisoryWind(spec);
  const sounding = Array.isArray(spec.sounding) ? spec.sounding : [];
  const offsetKm = spec.soundingAt ? distanceKm(spec.launch, spec.soundingAt) : null;
  const stale = sounding.length > 0 && isElsewhere(spec.launch, spec.soundingAt);

  /* No grid. Two different states wear two different words: 'pending' is "not
   * yet", which the next pass resolves and which nothing should be warned
   * about; 'unavailable' is terminal for this route and is stated out loud. */
  if (!spec.field) {
    const pending = spec.pending && spec.portWired;
    if (!pending) {
      drafts.push(draftConstraint('W-WIND-NODATA', spec.portWired
        ? 'The elevation grid around this route could not be sampled, so nothing here models '
          + 'how the terrain shapes the wind over it. That is missing data, not a clear area.'
        : 'No area elevation data is wired up, so nothing here models how the terrain shapes '
          + 'the wind around this route. That is missing data, not a clear area.'));
    }
    return {
      advisories: Object.freeze({
        status: /** @type {'pending'|'unavailable'} */ (pending ? 'pending' : 'unavailable'),
        grid: null,
        forcing: null,
        regime: null,
        sensitivity: null,
        provenance: advisoryProvenanceOf({
          wind,
          soundingLevels: sounding.length,
          soundingAt: spec.soundingAt ?? null,
          soundingOffsetKm: offsetKm,
          soundingStale: stale,
          notes: Object.freeze([pending
            ? 'the area grid for this route is still being sampled'
            : 'no area grid was available for this route']),
        }),
      }),
      drafts,
    };
  }

  const grid = spec.field.grid;
  const windVector = { windMph: wind.windMph, windFromDeg: wind.windFromDeg };
  const forcing = computeForcingField(grid, windVector, { windSource: wind.source });
  const sensitivity = classificationSensitivity(grid, windVector, undefined,
    { windSource: wind.source });
  const regime = computeRegime({
    sounding, wind: windVector, reliefM: gridReliefM(grid) ?? 0,
  });

  const counts = forcing.meta.counts;
  /* A grid with nothing classifiable is a grid that answered nothing. The field
   * is still published — every cell reads 'unknown', which is what the map
   * hatches — but the status says the advisory has no finding to offer. */
  const status = counts.classified > 0 ? 'ready' : 'unavailable';

  for (const draft of classDrafts(counts)) drafts.push(draft);

  const regimeDraft = regimeConstraint(regime);
  if (regimeDraft) drafts.push(regimeDraft);

  const sensitiveDraft = sensitivityConstraint(sensitivity);
  if (sensitiveDraft) drafts.push(sensitiveDraft);

  if (stale) {
    const where = offsetKm != null && offsetKm >= 0.1
      ? `for a point ${offsetKm.toFixed(1)} km from this launch`
      : 'for a different launch point';
    drafts.push(draftConstraint('W-WIND-STALE',
      `The sounding on hand was fetched ${where}, so the stability regime below describes the `
      + 'air over there rather than the air over here. Refetch the sky for this launch to '
      + 'settle it.'));
  }

  const nodata = coverageConstraint(counts.unknown, counts.total, status);
  if (nodata) drafts.push(nodata);

  const gp = spec.field.provenance;
  return {
    advisories: Object.freeze({
      status: /** @type {'ready'|'unavailable'} */ (status),
      grid,
      forcing,
      regime,
      sensitivity,
      provenance: advisoryProvenanceOf({
        wind,
        soundingLevels: sounding.length,
        soundingAt: spec.soundingAt ?? null,
        soundingOffsetKm: offsetKm,
        soundingStale: stale,
        gridSource: gp.source,
        gridDataset: gp.dataset,
        gridAttribution: gp.attribution,
        retrievedAt: gp.retrievedAt,
        coverage: gp.coverage,
        cellSizeM: grid.cellSizeM,
        rows: grid.rows,
        cols: grid.cols,
        unknownCells: counts.unknown,
        changedFraction: sensitivity.changedFraction,
        notes: gp.notes,
      }),
    }),
    drafts,
  };
}

/* ---------- the wind the advisory ran on ---------- */

/**
 * The wind, normalised. A missing figure becomes zero rather than null: calm is
 * a state the forcing model handles honestly (`w*` is zero everywhere, every
 * cell reads 'low'), and the source label says where the figure came from, so
 * nothing is being passed off as a reading that was not one.
 *
 * @param {WindAdvisorySpec} spec
 * @returns {AdvisoryWind}
 */
function advisoryWind(spec) {
  return Object.freeze({
    windMph: Number.isFinite(spec.windMph) ? Math.max(0, Number(spec.windMph)) : 0,
    windFromDeg: Number.isFinite(spec.windFromDeg) ? Number(spec.windFromDeg) : 0,
    levelM: Number.isFinite(spec.windLevelM) ? Number(spec.windLevelM) : null,
    source: typeof spec.windSource === 'string' && spec.windSource ? spec.windSource : 'caller',
  });
}

/**
 * Whether the sounding was fetched for somewhere other than this launch.
 * Compared per-axis in degrees rather than as a distance, because the question
 * is "is this the same point" and a degree epsilon answers it without pretending
 * to a precision the latch does not have.
 *
 * @param {LatLng} launch
 * @param {LatLng|null|undefined} at
 * @returns {boolean}
 */
function isElsewhere(launch, at) {
  if (!at || !Number.isFinite(at.lat) || !Number.isFinite(at.lng)) return false;
  return Math.abs(at.lat - launch.lat) > SOUNDING_STALE_EPSILON_DEG
    || Math.abs(at.lng - launch.lng) > SOUNDING_STALE_EPSILON_DEG;
}

/* ---------- the aggregate constraints ---------- */

/**
 * One constraint per reported class, counting the cells behind it. `gap` and
 * `ridge` both map to W-WIND-ACCEL and are summed into one sentence.
 *
 * @param {import('../../domain/wind/terrain-forcing.js').ForcingFieldMeta['counts']} counts
 * @returns {ConstraintDraft[]}
 */
function classDrafts(counts) {
  /** @type {ConstraintDraft[]} */
  const out = [];
  const accel = counts.byClass.gap + counts.byClass.ridge;
  /** @type {Set<string>} */
  const said = new Set();

  for (const classId of REPORTED_CLASSES) {
    const code = ADVISORY_CLASS_CODE[classId];
    if (!code || said.has(code)) continue;
    const n = code === 'W-WIND-ACCEL' ? accel : counts.byClass[classId];
    if (n <= 0) continue;
    said.add(code);
    out.push(draftConstraint(code, classText(code, n, counts.classified)));
  }
  return out;
}

/**
 * @param {string} code
 * @param {number} n      cells in this class
 * @param {number} of     cells that were classified at all
 * @returns {string}
 */
function classText(code, n, of) {
  const share = `${n} of the ${of} classified cells around this route`;
  if (code === 'W-WIND-LEE') {
    return `${share} sit on a downwind slope, where the modelled flow is being driven down the `
      + 'ground rather than over it — the setting sink and rough air belong to. This is a '
      + 'relative forcing proxy, not a forecast vertical velocity, and it cannot tell you '
      + 'where a rotor is.';
  }
  if (code === 'W-WIND-ACCEL') {
    return `${share} are crests or gaps: ground that stands above its surroundings, or that `
      + 'squeezes the flow between higher ground on both sides. Expect more wind there than '
      + 'the forecast figure — how much more is not modelled.';
  }
  return `${share} sit on a windward slope with relative uplift potential. That is a modelled `
    + 'tendency and not lift you can plan on, and the same ground sinks on the reciprocal '
    + 'bearing.';
}

/**
 * The regime constraint, or null when the regime is not a finding: 'flow-over'
 * is the benign case and 'unknown' has already said it knows nothing.
 *
 * @param {RegimeResult} regime
 * @returns {ConstraintDraft|null}
 */
function regimeConstraint(regime) {
  if (regime.regime !== 'blocked' && regime.regime !== 'transition') return null;
  const fr = regime.froude;
  const uMs = regime.basis.uMs;

  /* Fr → 0 with the wind, so a calm sounding produces 'blocked' arithmetic out
   * of no evidence at all. Saying "the flow may be blocked" there would be this
   * module inventing a hazard from a still afternoon. The finding is real — the
   * regime test could not be run — so it is stated at `unknown` instead. */
  if (uMs != null && uMs <= CALM_MS) {
    return draftConstraint('W-WIND-REGIME',
      `The stability regime reads Fr = ${fmt(fr)} only because the wind through the barrier `
      + `layer is calm (${uMs.toFixed(1)} m/s). That is arithmetic, not evidence of blocked `
      + 'flow: in calm air this test has nothing to measure. Read it as "not established".',
      undefined, 'unknown');
  }

  if (regime.regime === 'blocked') {
    return draftConstraint('W-WIND-REGIME',
      `Fr = ${fmt(fr)} for the terrain around this route in this air: the modelled flow may not `
      + 'have the momentum to climb the ground and may divert around it or stall against it '
      + 'instead. This is one bulk number for the whole area — it cannot say where the flow '
      + 'splits, and it does not locate the lee eddy that blocking is associated with.');
  }
  return draftConstraint('W-WIND-REGIME',
    `Fr = ${fmt(fr)} and the sensitivity envelope spans more than one regime (${
      regime.band.regimes.join(', ')}): the air is between climbing the terrain and being `
    + 'blocked by it, and the forecast is not sharp enough to say which. Treat the flow around '
    + 'high ground as unsettled rather than predictable.');
}

/**
 * The sensitivity constraint, or null when the classification held together
 * across the perturbation envelope.
 *
 * A null `changedFraction` means nothing was classifiable, which W-WIND-NODATA
 * already states — reporting it here as well would say the same absence twice.
 *
 * @param {import('../../domain/wind/terrain-forcing.js').SensitivityReport} report
 * @returns {ConstraintDraft|null}
 */
function sensitivityConstraint(report) {
  const changed = report.changedFraction;
  if (changed == null) return null;
  if (changed <= ADVISORY_SENSITIVITY_BOUND) return null;
  return draftConstraint('W-WIND-SENSITIVE',
    `${pct(changed)} of the classified cells change class when the wind is varied by ±20° and `
    + `±30% — past the ${pct(ADVISORY_SENSITIVITY_BOUND)} this baseline was validated to. The `
    + 'zones here are a broad area of uncertainty rather than sharp lines: they are not wrong, '
    + 'they are not settled.');
}

/**
 * The missing-data constraint. Fires on a grid that answered nothing at all, and
 * — with a different sentence — on one that answered only partly, because a hole
 * in the coverage is exactly the thing this milestone refuses to let pass as
 * quiet ground.
 *
 * @param {number} unknown
 * @param {number} total
 * @param {string} status
 * @returns {ConstraintDraft|null}
 */
function coverageConstraint(unknown, total, status) {
  if (unknown <= 0) return null;
  if (status !== 'ready') {
    return draftConstraint('W-WIND-NODATA',
      'The area grid around this route came back with no usable elevation, so nothing here '
      + 'models how the terrain shapes the wind over it. That is missing data, not a clear area.');
  }
  return draftConstraint('W-WIND-NODATA',
    `${unknown} of the ${total} cells around this route have no elevation to work from, so the `
    + 'flow over them is unknown rather than low. They are drawn as missing, and missing is not '
    + 'clear.');
}

/* ---------- formatting ---------- */

/** @param {number|null} v @returns {string} */
const fmt = (v) => (v == null ? '—' : v.toFixed(2));

/** @param {number} frac @returns {string} */
const pct = (frac) => `${Math.round(frac * 100)}%`;
