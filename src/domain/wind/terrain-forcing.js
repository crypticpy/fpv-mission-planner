// terrain-forcing.js — baseline B1: what a wind does when it meets the ground (M5).
//
// One quantity carries this module: `w* = V · ∇h`, the vertical motion a
// horizontal wind *would* have if the air followed the terrain surface exactly.
// The feasibility artifact is blunt about what that is and is not — "`V · ∇h` is
// a terrain-forcing proxy at the surface, not measured or forecast vertical
// velocity along the flight path" — so every name here says *forcing*, never
// *updraft*, and nothing in this file is allowed to promise a number a pilot
// could fly to. `wStarMs` is in m/s because ∇h is dimensionless and V is a
// speed; the unit is a consequence of the arithmetic, not a claim that the air
// is doing this.
//
// What the module *can* say honestly is a sign, a relative magnitude, and a
// shape: air pushed up a windward slope, air pulled down a lee one, air crossing
// a crest, air squeezed through a col or a valley. Those four plus "little
// modelled forcing" and "we could not tell" are the whole vocabulary.
//
// Three rules inherited from the terrain work upstream (src/domain/terrain/
// terrain-features.js), and one this module adds:
//
//   *A gap is not a shape.* Where an elevation is null there is no gradient, and
//     a cell with no derivable gradient is 'unknown' — never 'low'. Differences
//     are taken across known pairs only, never across a hole.
//
//   *Cross-flow evidence separates a pass from a ridge.* terrain-features.js
//     decides 'pass' vs 'ridge' on whether the ground rises or falls to the
//     sides; the same test decides 'gap' vs 'ridge' here, with the flow
//     direction playing the part the course direction plays there.
//
//   *Missing data is louder than a fact.* ADR 0008 ranks `unknown` above
//     `advisory` and `low-forcing` for exactly this reason.
//
//   *A shape only matters if the wind is doing something with it.* A crest in
//     near-calm air is scenery. Every shape class is gated on the forcing that
//     shape actually imposes at the wind speed supplied, using the same
//     magnitude floor the uplift/lee classes use, so one threshold governs the
//     whole classifier rather than four unrelated ones.
//
// This file is grid-based, unlike terrain-features.js, which reads one
// along-track corridor. The *approach* is shared; none of the code is, because
// a corridor knows a course direction and a grid does not.

import { U } from '../physics.js';
import { wrapBearing } from '../geo.js';

/* ---------- the shapes the caller hands in (frozen for wave 2's sampler) ---------- */

/**
 * One cell of the advisory grid. `elevM` is null where the DEM had nothing —
 * a first-class value, not an error.
 * @typedef {{ lat: number, lng: number, elevM: number|null }} AdvisoryGridCell
 */

/**
 * Row-major area grid; `index = row * cols + col`; row 0 is the northernmost
 * row and col 0 the westernmost, so a step of +1 in `col` is a step east and a
 * step of +1 in `row` is a step south. `cellSizeM` is the ground spacing
 * between adjacent cell centres in both directions.
 *
 * Latitude and longitude ride along for the renderer's benefit. Nothing in this
 * module reads them: every derivative below is taken in metres off `cellSizeM`,
 * which is what keeps a synthetic fixture and a live DEM on identical
 * arithmetic.
 *
 * @typedef {{ rows: number, cols: number, cellSizeM: number,
 *             cells: readonly AdvisoryGridCell[] }} AdvisoryGrid
 */

/**
 * A background wind in the units the rest of the app speaks: miles per hour and
 * a meteorological FROM bearing.
 * @typedef {{ windMph: number, windFromDeg: number }} WindVector
 */

/* ---------- the vocabulary this module emits ---------- */

/**
 * The six things a cell can be.
 *
 * `uplift` — flow climbing terrain (positive forcing).
 * `lee`    — flow descending terrain (negative forcing).
 * `ridge`  — the flow crosses a crest: convex along the flow direction.
 * `gap`    — the flow is confined: the ground rises either side of it, which is
 *            a col crossed transversely or a valley aligned with the wind.
 * `low`    — the modelled forcing is small. *Not* calm, and never "safe"
 *            (ADR 0001, ADR 0008, and the artifact's warning semantics all say
 *            so in the same words).
 * `unknown`— no elevation, or no gradient derivable without inventing one.
 *
 * @typedef {'uplift'|'lee'|'ridge'|'gap'|'low'|'unknown'} ForcingClassId
 */

/** @type {readonly ForcingClassId[]} */
export const FORCING_CLASS_IDS = Object.freeze([
  'uplift', 'lee', 'ridge', 'gap', 'low', 'unknown',
]);

/**
 * ADR 0008's fixed six, in display-priority order, repeated here as a type.
 *
 * Deliberately *not* imported from src/application/analysis/analysis-contracts.js:
 * the domain layer imports nothing above itself (ADR 0009), and a warning
 * taxonomy is not going to be the exception. The lockstep is held by a test
 * instead — tests/wind-forcing.test.mjs asserts every severity this module can
 * emit is a member of the exported `SEVERITIES` array — which catches a
 * divergence at the same moment an import would have, without the edge.
 *
 * @typedef {'critical'|'warning'|'caution'|'unknown'|'advisory'|'low-forcing'} ForcingSeverity
 */

/**
 * Class → severity, straight out of ADR 0008's taxonomy:
 * advisory (blue) is "relative uplift potential"; warning (orange) is "lee-side
 * descent risk"; caution (yellow) is "acceleration zones … narrow pass/gap
 * concern"; low-forcing (green-gray) is "low modeled terrain forcing"; unknown
 * (purple/gray hatch) is "missing data or high uncertainty".
 *
 * `critical` is unreachable from B1 and that is the point. ADR 0008 reserves red
 * for reserve/clearance violations, a blocked link, and the *rotor-prone*
 * advisory — and rotor-prone needs stability, shear and ensemble agreement
 * (artifact, warning semantics #4), none of which a terrain gradient knows. B1
 * escalating to red on its own would be the module claiming evidence it does not
 * have.
 *
 * @type {Readonly<Record<ForcingClassId, ForcingSeverity>>}
 */
export const CLASS_SEVERITY = Object.freeze({
  uplift: /** @type {ForcingSeverity} */ ('advisory'),
  lee: /** @type {ForcingSeverity} */ ('warning'),
  ridge: /** @type {ForcingSeverity} */ ('caution'),
  gap: /** @type {ForcingSeverity} */ ('caution'),
  low: /** @type {ForcingSeverity} */ ('low-forcing'),
  unknown: /** @type {ForcingSeverity} */ ('unknown'),
});

/* ---------- thresholds ---------- */

/**
 * The three numbers that decide a class, and where each comes from.
 *
 * `lowForcingMs` (0.5 m/s) is the floor below which forcing is reported as
 * `low`. The artifact gives no calibrated figure — it says thresholds "must be
 * calibrated and shown as regimes" — so this one is argued rather than cited,
 * from two directions that agree:
 *
 *   - *DEM noise.* The elevation products behind this (Copernicus/3DEP at
 *     30–90 m, Open-Meteo's 90 m) carry a few metres of vertical RMSE. Over a
 *     90 m stencil that is a spurious slope near 0.02, which at a 20 mph wind
 *     (8.9 m/s) manufactures ≈0.15 m/s of forcing out of nothing. 0.5 m/s sits
 *     about three times above that.
 *   - *Detectability.* 0.5 m/s is ≈100 ft/min. The artifact notes that throttle,
 *     flight-controller compensation and pilot input confound inference of
 *     ambient vertical wind; a forcing proxy smaller than that is not something
 *     a pilot could attribute to the air even if it were real.
 *
 * For reference at the other end of the scale, 2 m/s of forcing is the
 * `DEFAULT_DESCENT_RATE_MS` of src/domain/vertical.js — a lee proxy that size is
 * the same order as the aircraft's own planned descent, which is where it starts
 * to move vertical margins. That comparison belongs to whoever renders
 * `wStarMs`; this module does not tier severity on it, because ADR 0008 gives
 * lee-side descent exactly one colour.
 *
 * `minCrestReliefM` and `minConfineReliefM` (5 m each) are
 * `DEFAULT_FEATURE_THRESHOLDS.minReliefM` from src/domain/terrain/
 * terrain-features.js, adopted unchanged and for the reason stated there: above
 * the vertical error of a 30–90 m DEM, and well under anything a pilot would
 * call a ridge. They are metres of shape, not curvatures, because a curvature
 * threshold cannot be sanity-checked against a DEM's error bar — see
 * `crestRelief` and `confineRelief` for the conversions.
 *
 * Both are read over a single cell's stencil, and that has a consequence worth
 * stating plainly: **the shape classes see features at the grid's own scale.**
 * A metres-of-shape threshold over spacing `d` grows as `d²`, so a broad
 * mountain ridge — 300 m of relief spread over a kilometre — is not *curved* at
 * 90 m sampling and will not be called `ridge`; it is a slope, and it shows up
 * in the uplift and lee fields where it belongs. `cellSizeM` is therefore part
 * of what a classification means, which is why it is echoed in the meta block.
 *
 * @typedef {object} ForcingThresholds
 * @property {number} lowForcingMs      m/s of |w*| below which a cell is `low`
 * @property {number} minCrestReliefM   metres a cell must stand above the mean
 *                                      of its two along-flow neighbours to be a
 *                                      crest
 * @property {number} minConfineReliefM metres the *lower* cross-flow neighbour
 *                                      must stand above the cell to be a channel
 */

/** @type {ForcingThresholds} */
export const DEFAULT_FORCING_THRESHOLDS = Object.freeze({
  lowForcingMs: 0.5,
  minCrestReliefM: 5,
  minConfineReliefM: 5,
});

/**
 * The perturbation envelope for `classificationSensitivity`, taken verbatim from
 * the artifact's validation section: "perturb wind direction by at least ±20°,
 * speed by about ±30%". Zero is included in each list so the cross product reads
 * naturally; the (0, 0) member is the unperturbed field and is dropped.
 *
 * @typedef {{ directionDeg: readonly number[], speedFrac: readonly number[] }} ForcingPerturbations
 */

/** @type {ForcingPerturbations} */
export const DEFAULT_PERTURBATIONS = Object.freeze({
  directionDeg: Object.freeze([-20, 0, 20]),
  speedFrac: Object.freeze([-0.3, 0, 0.3]),
});

/* ---------- results ---------- */

/**
 * One classified cell, at the same index as the grid cell it describes.
 *
 * `wStarMs` is the relative terrain-forcing proxy `V · ∇h`, positive upward. It
 * is null exactly when `classId` is 'unknown'. Read the module header before
 * putting it in front of a pilot: it is not a forecast vertical velocity, and it
 * describes the air at the surface, not at flight altitude.
 *
 * @typedef {object} ForcingCell
 * @property {number|null} wStarMs
 * @property {ForcingClassId} classId
 * @property {ForcingSeverity} severity
 */

/**
 * What produced the field. Every consumer that renders a cell owes the pilot
 * this block (ADR 0008: inputs, model baseline, limitations), so it is returned
 * beside the cells rather than left to be reconstructed.
 *
 * @typedef {object} ForcingFieldMeta
 * @property {'B1-terrain-forcing'} baseline
 * @property {'relative-forcing-proxy'} quantity what `wStarMs` is — see the typedef
 * @property {{ windMph: number, windFromDeg: number, flowToDeg: number,
 *              speedMs: number, source: string }} wind the wind actually used,
 *              echoed so a brief can state it; `source` is the caller's label
 *              for where it came from ('caller' when unlabelled)
 * @property {ForcingThresholds} thresholds the values actually applied
 * @property {{ rows: number, cols: number, cellSizeM: number }} grid
 * @property {{ total: number, classified: number, unknown: number,
 *              shapeUnavailable: number,
 *              byClass: Readonly<Record<ForcingClassId, number>> }} counts
 */

/**
 * @typedef {object} ForcingField
 * @property {readonly ForcingCell[]} cells row-major, parallel to `grid.cells`
 * @property {ForcingFieldMeta} meta
 */

/**
 * @typedef {object} ForcingOptions
 * @property {Partial<ForcingThresholds>} [thresholds]
 * @property {string} [windSource] label recorded in meta, e.g. 'forecast-80m'
 */

/* ---------- small helpers ---------- */

const RAD = Math.PI / 180;

/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** @param {unknown} v @returns {boolean} */
const isCount = (v) => isNum(v) && Number.isInteger(v) && v > 0;

/**
 * The elevation at a grid position, or null — out of bounds, no cell, no
 * reading. All three are the same answer to this module: nothing to difference.
 *
 * @param {AdvisoryGrid} grid
 * @param {number} row
 * @param {number} col
 * @returns {number|null}
 */
function elevAt(grid, row, col) {
  if (row < 0 || col < 0 || row >= grid.rows || col >= grid.cols) return null;
  const cell = grid.cells[row * grid.cols + col];
  if (!cell || !isNum(cell.elevM)) return null;
  return cell.elevM;
}

/**
 * A first derivative from a neighbour pair: central where both answer, one-sided
 * where one does, null where neither does. Never across a gap — the two points
 * either side of a hole describe the line between them, not the hole.
 *
 * @param {number|null} plus  the neighbour in the +axis direction
 * @param {number} here
 * @param {number|null} minus the neighbour in the −axis direction
 * @param {number} d spacing, metres
 * @returns {number|null}
 */
function firstDiff(plus, here, minus, d) {
  if (plus != null && minus != null) return (plus - minus) / (2 * d);
  if (plus != null) return (plus - here) / d;
  if (minus != null) return (here - minus) / d;
  return null;
}

/**
 * A second derivative from a neighbour pair. Both sides required: a one-sided
 * second difference is not a curvature, it is a guess about the side that is
 * missing.
 *
 * @param {number|null} plus
 * @param {number} here
 * @param {number|null} minus
 * @param {number} d
 * @returns {number|null}
 */
function secondDiff(plus, here, minus, d) {
  if (plus == null || minus == null) return null;
  return (plus - 2 * here + minus) / (d * d);
}

/**
 * ∇h in metres per metre, as (east, north) components.
 *
 * Both components are required. A grid cell whose whole east–west neighbourhood
 * is missing has no east–west slope, and substituting zero for it would be this
 * module reporting flat ground where it has no ground at all — the one thing
 * ADR 0008 forbids by name. (terrain-features.js does substitute zero for a
 * missing cross-track gradient, but there the absence means the corridor asked
 * for no width, which is a decision rather than a hole.)
 *
 * @param {AdvisoryGrid} grid
 * @param {number} row
 * @param {number} col
 * @returns {{ east: number, north: number }|null}
 */
function gradientAt(grid, row, col) {
  const d = grid.cellSizeM;
  const here = elevAt(grid, row, col);
  if (here == null || !isNum(d) || d <= 0) return null;
  const east = firstDiff(elevAt(grid, row, col + 1), here, elevAt(grid, row, col - 1), d);
  // Row indices grow southward, so the +north neighbour is row − 1.
  const north = firstDiff(elevAt(grid, row - 1, col), here, elevAt(grid, row + 1, col), d);
  if (east == null || north == null) return null;
  return { east, north };
}

/**
 * The three second derivatives of the surface at a cell: ∂²h/∂x², ∂²h/∂y² and
 * the mixed ∂²h/∂x∂y, with x east and y north. Null when the eight-cell
 * neighbourhood is not complete — the mixed term needs all four diagonals, and
 * without it the surface cannot be re-expressed in flow-relative axes.
 *
 * @param {AdvisoryGrid} grid
 * @param {number} row
 * @param {number} col
 * @returns {{ xx: number, yy: number, xy: number }|null}
 */
function hessianAt(grid, row, col) {
  const d = grid.cellSizeM;
  const here = elevAt(grid, row, col);
  if (here == null || !isNum(d) || d <= 0) return null;
  const xx = secondDiff(elevAt(grid, row, col + 1), here, elevAt(grid, row, col - 1), d);
  const yy = secondDiff(elevAt(grid, row - 1, col), here, elevAt(grid, row + 1, col), d);
  if (xx == null || yy == null) return null;
  const ne = elevAt(grid, row - 1, col + 1);
  const nw = elevAt(grid, row - 1, col - 1);
  const se = elevAt(grid, row + 1, col + 1);
  const sw = elevAt(grid, row + 1, col - 1);
  if (ne == null || nw == null || se == null || sw == null) return null;
  return { xx, yy, xy: (ne - nw - se + sw) / (4 * d * d) };
}

/**
 * How far the cell stands above the mean of its two neighbours in a direction,
 * in metres.
 *
 * A central second difference over spacing `d` is `κ = (h₊ − 2h₀ + h₋) / d²`, so
 * `−κ d² / 2` is exactly that height. Expressing the threshold in metres is what
 * lets it be compared with a DEM's vertical error and with terrain-features.js's
 * 5 m — a curvature in 1/m can be argued with, but nobody can eyeball whether
 * 8e-4 is a ridge.
 *
 * This is the crest test: a flow crossing a convex crown is compressed and
 * separates whether or not the crown's highest point happens to land on a
 * sample, so convexity is the criterion and a strict local maximum is not.
 *
 * @param {number} kappa 1/m, the second derivative along the direction
 * @param {number} d metres, the stencil spacing
 * @returns {number} metres; positive when the cell stands above its neighbours
 */
function crestRelief(kappa, d) {
  return -kappa * d * d / 2;
}

/**
 * How far the *lower* of the two neighbours across the flow stands above the
 * cell, in metres.
 *
 * Confinement is not concavity. Fit the local quadratic
 * `h(t) = h₀ + g t + ½ κ t²` across the flow and the two neighbours sit at
 * `h₀ ± g d + ½ κ d²`, so the lower of them clears the cell by
 * `½ κ d² − |g| d`. Dropping the `|g| d` term — testing concavity alone — calls
 * the concave foot of a single slope a channel, which is how a wind blowing
 * *along* a ridge came back as a hundred gap cells at the ridge's feet in
 * testing. Ground has to rise on both sides for flow to be squeezed between it,
 * which is the same evidence terrain-features.js requires before it will say
 * 'pass' instead of 'ridge'.
 *
 * @param {number} kappa 1/m, the second derivative across the flow
 * @param {number} slope m/m, the first derivative across the flow
 * @param {number} d metres, the stencil spacing
 * @returns {number} metres; positive when both neighbours stand above the cell
 */
function confineRelief(kappa, slope, d) {
  return kappa * d * d / 2 - Math.abs(slope) * d;
}

/* ---------- the field ---------- */

/**
 * Classify every cell of an advisory grid against one background wind.
 *
 * More than one class can be true of a cell at once — the windward flank of a
 * crest is both uplift and a ridge crossing — so the classifier needs a
 * precedence, and inventing one would be a place for a bug to hide. It takes the
 * only one that cannot make the map quieter than the evidence: **the class whose
 * ADR 0008 severity is highest wins.** In that taxonomy `lee` is a warning,
 * `ridge` and `gap` are cautions, `uplift` is an advisory and `low` is the floor,
 * which resolves to:
 *
 *   1. `unknown` — no elevation here, or no gradient derivable without
 *      inventing one. Decided first because it is a statement about the data,
 *      not about the air.
 *   2. `lee` — `w*` at or below −`lowForcingMs`. Descending flow outranks both
 *      shape classes, which matters most exactly where the two coincide: the
 *      cells immediately downwind of a crest are convex *and* strongly
 *      descending, and reporting them as a ridge-crossing caution would put the
 *      quieter colour on the strongest modelled descent in the neighbourhood.
 *   3. `gap` — the ground rises on both sides across the flow by at least
 *      `minConfineReliefM`. Ahead of `ridge` for the reason terrain-features.js
 *      calls the same shape a 'pass' rather than a 'ridge': cross-flow evidence
 *      is what distinguishes a col the flow is squeezed through from a crest it
 *      goes over. The same test serves a valley aligned with the wind
 *      ("valley-convergence geometry aligned with flow", artifact warning
 *      semantics #3).
 *   4. `ridge` — the cell is convex along the flow by at least
 *      `minCrestReliefM`: the flow crosses a crest here. Ahead of `uplift`
 *      because a crest is where `w*` passes *through* zero on its way from
 *      windward to lee, so the crest line would otherwise read as the quietest
 *      cells in the neighbourhood.
 *   5. `uplift` — `w*` at or above `lowForcingMs`.
 *   6. `low` — everything else. Low modelled forcing, which is not calm and not
 *      safe.
 *
 * Both shape classes are additionally gated on the forcing that shape imposes at
 * this wind speed: `U · 2·relief / cellSizeM` is the change in `w*` across one
 * cell implied by that curvature, and it has to clear the same `lowForcingMs`
 * floor the uplift/lee classes clear. A crest in near-calm air is scenery, and
 * this is what stops the module calling it a caution.
 *
 * Wind direction is meteorological FROM; the flow travels toward FROM + 180.
 *
 * @param {AdvisoryGrid} grid
 * @param {WindVector} wind
 * @param {ForcingOptions} [opts]
 * @returns {ForcingField}
 */
export function computeForcingField(grid, wind, opts = {}) {
  const limits = { ...DEFAULT_FORCING_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const rows = isCount(grid?.rows) ? grid.rows : 0;
  const cols = isCount(grid?.cols) ? grid.cols : 0;
  const cellSizeM = isNum(grid?.cellSizeM) && grid.cellSizeM > 0 ? grid.cellSizeM : 0;

  const windMph = isNum(wind?.windMph) ? wind.windMph : 0;
  const windFromDeg = isNum(wind?.windFromDeg) ? wrapBearing(wind.windFromDeg) : 0;
  const speedMs = Math.max(0, U.mphToMs(windMph));
  const flowToDeg = wrapBearing(windFromDeg + 180);
  // Unit vector the air travels along, as (east, north).
  const sx = Math.sin(flowToDeg * RAD);
  const sy = Math.cos(flowToDeg * RAD);

  /** @type {Record<ForcingClassId, number>} */
  const byClass = { uplift: 0, lee: 0, ridge: 0, gap: 0, low: 0, unknown: 0 };
  /** @type {ForcingCell[]} */
  const cells = [];
  let shapeUnavailable = 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const grad = cellSizeM > 0 ? gradientAt(grid, row, col) : null;
      if (!grad) {
        byClass.unknown += 1;
        cells.push(cell(null, 'unknown'));
        continue;
      }
      const wStarMs = speedMs * sx * grad.east + speedMs * sy * grad.north;

      const hess = hessianAt(grid, row, col);
      if (!hess) shapeUnavailable += 1;
      // The surface re-expressed in flow-relative axes: `s` along the flow,
      // `n = (−sy, sx)` across it.
      const alongKappa = hess
        ? sx * sx * hess.xx + 2 * sx * sy * hess.xy + sy * sy * hess.yy
        : null;
      const acrossKappa = hess
        ? sy * sy * hess.xx - 2 * sx * sy * hess.xy + sx * sx * hess.yy
        : null;
      const crestReliefM = alongKappa == null ? null : crestRelief(alongKappa, cellSizeM);
      const acrossSlope = -sy * grad.east + sx * grad.north;
      const confineReliefM = acrossKappa == null
        ? null
        : confineRelief(acrossKappa, acrossSlope, cellSizeM);

      const classId = classifyCell({
        wStarMs, crestReliefM, confineReliefM, speedMs, cellSizeM, limits,
      });
      byClass[classId] += 1;
      cells.push(cell(wStarMs, classId));
    }
  }

  const total = cells.length;
  return Object.freeze({
    cells: Object.freeze(cells),
    meta: Object.freeze({
      baseline: /** @type {'B1-terrain-forcing'} */ ('B1-terrain-forcing'),
      quantity: /** @type {'relative-forcing-proxy'} */ ('relative-forcing-proxy'),
      wind: Object.freeze({
        windMph, windFromDeg, flowToDeg, speedMs,
        source: typeof opts.windSource === 'string' ? opts.windSource : 'caller',
      }),
      thresholds: Object.freeze({ ...limits }),
      grid: Object.freeze({ rows, cols, cellSizeM }),
      counts: Object.freeze({
        total,
        classified: total - byClass.unknown,
        unknown: byClass.unknown,
        // Cells whose 3×3 neighbourhood was incomplete, so `ridge` and `gap`
        // could not be tested for. They are still classified on `w*`, which is
        // derivable from fewer neighbours — this count is how a consumer knows
        // some of them might have been shapes.
        shapeUnavailable,
        byClass: Object.freeze({ ...byClass }),
      }),
    }),
  });
}

/**
 * @param {number|null} wStarMs
 * @param {ForcingClassId} classId
 * @returns {ForcingCell}
 */
function cell(wStarMs, classId) {
  return Object.freeze({ wStarMs, classId, severity: CLASS_SEVERITY[classId] });
}

/**
 * The precedence described on `computeForcingField`, in one place so the
 * sensitivity metric and the field cannot drift apart.
 *
 * @param {object} args
 * @param {number} args.wStarMs
 * @param {number|null} args.crestReliefM
 * @param {number|null} args.confineReliefM
 * @param {number} args.speedMs
 * @param {number} args.cellSizeM
 * @param {ForcingThresholds} args.limits
 * @returns {ForcingClassId}
 */
function classifyCell({ wStarMs, crestReliefM, confineReliefM, speedMs, cellSizeM, limits }) {
  // The change in w* across one cell that a curvature of this size implies at
  // this wind speed. Same units, same floor as the forcing tests.
  /** @param {number} reliefM */
  const shapeForcing = (reliefM) => speedMs * 2 * reliefM / cellSizeM;
  /** @param {number|null} reliefM @param {number} floorM */
  const shapeCounts = (reliefM, floorM) => reliefM != null
    && reliefM >= floorM
    && shapeForcing(reliefM) >= limits.lowForcingMs;

  // warning
  if (wStarMs <= -limits.lowForcingMs) return 'lee';
  // caution, cross-flow evidence first
  if (shapeCounts(confineReliefM, limits.minConfineReliefM)) return 'gap';
  if (shapeCounts(crestReliefM, limits.minCrestReliefM)) return 'ridge';
  // advisory
  if (wStarMs >= limits.lowForcingMs) return 'uplift';

  return 'low';
}

/* ---------- sensitivity ---------- */

/**
 * How much of the classification survives the forecast being wrong.
 *
 * @typedef {object} SensitivityMember
 * @property {number} directionDeg    the offset applied, degrees
 * @property {number} speedFrac       the fractional speed offset applied
 * @property {number} windMph
 * @property {number} windFromDeg
 * @property {number|null} changedFraction of the base-classified cells, how many
 *                        this member classifies differently
 */

/**
 * @typedef {object} SensitivityReport
 * @property {number} members            how many perturbed fields were computed
 * @property {number} classifiedCells    the denominator: cells the unperturbed
 *                                       field classified as something other than
 *                                       'unknown'
 * @property {number|null} changedFraction 0–1: the share of those cells that
 *                                       change class under *any* member. Null
 *                                       when nothing was classifiable, because
 *                                       zero would claim a stability that was
 *                                       never tested.
 * @property {number|null} worstMemberFraction 0–1: the largest single-member share
 * @property {readonly SensitivityMember[]} byMember
 */

/**
 * Re-classify the grid across the artifact's perturbation envelope and report
 * the fraction of cells that move.
 *
 * The denominator is the cells the unperturbed field *classified* — 'unknown'
 * cells are excluded, and legitimately so: a cell is 'unknown' because its
 * elevations are missing, which no amount of perturbing the wind will change.
 * Including them would dilute the metric with cells that are constant by
 * construction, and a grid that is mostly holes would read as reassuringly
 * stable.
 *
 * The number is bounded in [0, 1] by construction. What a *useful* bound is —
 * how much movement makes a warning too soft to draw sharply — is the artifact's
 * "a warning that moves substantially under plausible inputs should become a
 * broader yellow uncertainty zone, not a sharper red prediction", and it is a
 * rendering decision, not one this module should make.
 *
 * @param {AdvisoryGrid} grid
 * @param {WindVector} wind
 * @param {Partial<ForcingPerturbations>} [perturbations]
 * @param {ForcingOptions} [opts]
 * @returns {SensitivityReport}
 */
export function classificationSensitivity(grid, wind, perturbations = {}, opts = {}) {
  const envelope = { ...DEFAULT_PERTURBATIONS, ...perturbations };
  const base = computeForcingField(grid, wind, opts);
  const baseCells = base.cells;

  /** @type {number[]} */
  const tracked = [];
  for (let i = 0; i < baseCells.length; i++) {
    if (baseCells[i].classId !== 'unknown') tracked.push(i);
  }

  const windMph = isNum(wind?.windMph) ? wind.windMph : 0;
  const windFromDeg = isNum(wind?.windFromDeg) ? wind.windFromDeg : 0;

  /** @type {Set<number>} */
  const moved = new Set();
  /** @type {SensitivityMember[]} */
  const byMember = [];

  for (const directionDeg of envelope.directionDeg) {
    for (const speedFrac of envelope.speedFrac) {
      // The unperturbed member is the base field itself; running it would only
      // add a guaranteed zero to the report.
      if (directionDeg === 0 && speedFrac === 0) continue;
      const memberWind = {
        windMph: Math.max(0, windMph * (1 + speedFrac)),
        windFromDeg: wrapBearing(windFromDeg + directionDeg),
      };
      const field = computeForcingField(grid, memberWind, opts);
      let changed = 0;
      for (const i of tracked) {
        if (field.cells[i].classId !== baseCells[i].classId) {
          changed += 1;
          moved.add(i);
        }
      }
      byMember.push(Object.freeze({
        directionDeg,
        speedFrac,
        windMph: memberWind.windMph,
        windFromDeg: memberWind.windFromDeg,
        changedFraction: tracked.length > 0 ? changed / tracked.length : null,
      }));
    }
  }

  const worst = byMember.reduce(
    /** @param {number|null} acc @param {SensitivityMember} m */
    (acc, m) => (m.changedFraction == null ? acc
      : acc == null ? m.changedFraction : Math.max(acc, m.changedFraction)),
    /** @type {number|null} */ (null),
  );

  return Object.freeze({
    members: byMember.length,
    classifiedCells: tracked.length,
    changedFraction: tracked.length > 0 ? moved.size / tracked.length : null,
    worstMemberFraction: worst,
    byMember: Object.freeze(byMember),
  });
}
