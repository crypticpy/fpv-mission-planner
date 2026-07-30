// terrain-features.js — what the ground is doing under the route (M3a).
//
// Every number here comes from stations the corridor already named: a station
// is one along-track place, carrying the ground under it and — when the
// corridor asked for a width — the ground either side of it. Nothing in this
// module knows how those elevations were obtained, so a synthetic DEM fixture
// and a live provider run through exactly the same arithmetic.
//
// The rule the whole module is built around: **a gap is not a shape.** Where an
// elevation is null the gradient is null and no feature is emitted, because the
// alternative — interpolating across the hole — invents a ridge that isn't
// there or, worse, smooths away one that is. M3's exit gate says an unknown
// clearance may never be presented as clear; upstream of clearance, that means
// an unknown elevation may never be presented as a shape.
//
// The second rule: **cross-track evidence is what separates a pass from a
// ridge.** Along one line you cannot tell a col from a summit — both are a
// local maximum in the direction you happen to be flying. So the classifier
// states which evidence it had (`basis`), and with centreline-only data it says
// 'ridge' or 'valley' and never claims a saddle or a pass. That is not a
// limitation to be papered over: a corridor with `corridorWidthM` of 0 has
// looked at exactly one line of ground, and the honest vocabulary for one line
// is smaller.

import { wrapBearing } from '../geo.js';

/**
 * The five shapes this module names.
 *
 * A `ridge` is a high point along track with the ground falling away to the
 * sides (or with no lateral evidence at all). A `pass` is the same along-track
 * high point with the ground *rising* to the sides — a col crossed transversely,
 * which is the shape a route flies *through* rather than over. A `saddle` is the
 * mirror image: an along-track dip on a line whose sides fall away, which is the
 * col met while flying along a crest. A `valley` is low along track and low
 * across it. A `cliff` is a step between two adjacent stations, not a station.
 *
 * @typedef {'ridge'|'valley'|'saddle'|'pass'|'cliff'} TerrainFeatureKind
 */

/** @type {readonly TerrainFeatureKind[]} */
export const TERRAIN_FEATURE_KINDS = Object.freeze(['ridge', 'valley', 'saddle', 'pass', 'cliff']);

/**
 * One along-track place, with whatever ground is known at it.
 *
 * `leftMslM` and `rightMslM` are the lateral samples at `lateralOffsetM` either
 * side of the course, 90° left and right of `bearingDeg`. Both null (and an
 * offset of 0) is the centreline-only case, and it is a first-class one.
 *
 * @typedef {object} TerrainStation
 * @property {string} id            the corridor's own sample id
 * @property {number} distanceKm    along the corridor from launch
 * @property {number} bearingDeg    the course being flown through this station
 * @property {number|null} groundMslM
 * @property {number|null} leftMslM
 * @property {number|null} rightMslM
 * @property {number} lateralOffsetM
 */

/**
 * How much shape has to be there before it is called shape.
 *
 * `minReliefM` is the height a station must stand above (or below) both of its
 * along-track neighbours to count as an extremum, and the lateral difference
 * that has to be present before cross-track evidence is allowed to decide
 * between a ridge and a pass. Five metres is above the vertical error of the
 * 30–90 m DEMs behind this (a few metres RMSE in open terrain) and well under
 * anything a pilot would call a ridge.
 *
 * `cliffMinSlopeDeg` and `cliffMinDropM` both have to be met: the slope alone
 * would fire on a 2 m kerb sampled 2 m apart, and the drop alone would fire on
 * a gentle 20 m climb spread over a kilometre.
 *
 * @typedef {object} FeatureThresholds
 * @property {number} minReliefM
 * @property {number} cliffMinSlopeDeg
 * @property {number} cliffMinDropM
 */

/** @type {FeatureThresholds} */
export const DEFAULT_FEATURE_THRESHOLDS = Object.freeze({
  minReliefM: 5,
  cliffMinSlopeDeg: 35,
  cliffMinDropM: 15,
});

/**
 * Steepness and the direction of steepest descent at one station.
 *
 * `slopeDeg` is unsigned (0–90): steepness is a magnitude and `aspectDeg`
 * carries the direction, which is the convention every DEM tool uses. Aspect is
 * a compass bearing pointing *downhill*, so a north-facing slope reads 0.
 *
 * `basis` says what the figures were derived from. 'along-track' means the
 * course direction only — the true steepest descent may lie across a line this
 * corridor never sampled, and a consumer that cares (M5's lee-side advisories
 * will) must read this field rather than assume.
 *
 * @typedef {object} TerrainGradient
 * @property {number|null} slopeDeg
 * @property {number|null} aspectDeg
 * @property {'along-track'|'cross-track'|null} basis
 */

/**
 * One named shape, anchored to the station ids the corridor issued. Nothing
 * downstream re-derives a position from a latitude: a feature points at the
 * sample it was found on, which is the same id the physics, the RF check and
 * the renderer use for that metre of ground.
 *
 * `reliefM` is signed and measured against the *nearer* along-track neighbour:
 * positive for a high point (how far it stands above the higher of its two
 * neighbours), negative for a low one. For a cliff it is the step itself,
 * negative when the ground drops away ahead.
 *
 * @typedef {object} TerrainFeature
 * @property {TerrainFeatureKind} kind
 * @property {string} sampleId       the station the feature sits on
 * @property {string|null} throughId a cliff's far side; null for the extrema
 * @property {number} distanceKm
 * @property {number} groundMslM
 * @property {number} reliefM
 * @property {number|null} slopeDeg
 * @property {'along-track'|'cross-track'} basis
 */

/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The along-track rise over run at a station, in metres per metre, or null when
 * no pair of known elevations spans it. Central where both neighbours answer,
 * one-sided at the ends and beside a gap — never across one, because the two
 * points either side of a hole say nothing about the hole.
 *
 * @param {readonly TerrainStation[]} stations
 * @param {number} i
 * @returns {number|null}
 */
function alongGradient(stations, i) {
  const here = stations[i];
  if (!isNum(here?.groundMslM)) return null;
  const prev = stations[i - 1];
  const next = stations[i + 1];
  const prevKnown = prev && isNum(prev.groundMslM);
  const nextKnown = next && isNum(next.groundMslM);

  if (prevKnown && nextKnown) return slopeBetween(prev, next);
  if (nextKnown) return slopeBetween(here, next);
  if (prevKnown) return slopeBetween(prev, here);
  return null;
}

/**
 * @param {TerrainStation} a
 * @param {TerrainStation} b
 * @returns {number|null}
 */
function slopeBetween(a, b) {
  const runM = (b.distanceKm - a.distanceKm) * 1000;
  if (!(runM > 0) || !isNum(a.groundMslM) || !isNum(b.groundMslM)) return null;
  return (b.groundMslM - a.groundMslM) / runM;
}

/**
 * The cross-track rise over run at a station, positive when the ground rises to
 * the right of the course. Null when the corridor asked for no width, or when
 * the lateral sample that would answer it is missing.
 *
 * @param {TerrainStation} station
 * @returns {number|null}
 */
function crossGradient(station) {
  const offset = station.lateralOffsetM;
  if (!isNum(offset) || offset <= 0) return null;
  const left = isNum(station.leftMslM) ? station.leftMslM : null;
  const right = isNum(station.rightMslM) ? station.rightMslM : null;
  if (left != null && right != null) return (right - left) / (2 * offset);
  // One side only still describes a slope across the track; it just describes
  // half of one, so it is measured over the offset it actually spans.
  const centre = isNum(station.groundMslM) ? station.groundMslM : null;
  if (centre == null) return null;
  if (right != null) return (right - centre) / offset;
  if (left != null) return (centre - left) / offset;
  return null;
}

/**
 * Slope and aspect at one station.
 *
 * @param {readonly TerrainStation[]} stations
 * @param {number} index
 * @returns {TerrainGradient}
 */
export function gradientAt(stations, index) {
  const station = stations[index];
  // No ground here, no slope here. Two known neighbours either side of a hole
  // describe the line between them, not the hole — and quoting that line as
  // this station's gradient is the interpolation-across-a-gap this module
  // exists to refuse.
  if (!station || !isNum(station.groundMslM)) return { slopeDeg: null, aspectDeg: null, basis: null };
  const along = alongGradient(stations, index);
  const cross = crossGradient(station);
  if (along == null && cross == null) return { slopeDeg: null, aspectDeg: null, basis: null };

  const gAlong = along ?? 0;
  const gCross = cross ?? 0;
  const slopeDeg = Math.atan(Math.hypot(gAlong, gCross)) * 180 / Math.PI;
  // Downhill is the negated gradient. Its components are (along, right-of-course),
  // so the angle off the course bearing is atan2(right, along) and the aspect is
  // that angle added to the course. `|| 0` keeps a negated zero out of atan2,
  // where -0 would flip the answer by 180°.
  const offCourseDeg = Math.atan2(-gCross || 0, -gAlong || 0) * 180 / Math.PI;
  return {
    slopeDeg,
    aspectDeg: slopeDeg > 0 ? wrapBearing(station.bearingDeg + offCourseDeg) : null,
    basis: cross == null ? 'along-track' : 'cross-track',
  };
}

/**
 * Slope and aspect at every station, in station order.
 *
 * @param {readonly TerrainStation[]} stations
 * @returns {TerrainGradient[]}
 */
export function gradients(stations) {
  return stations.map((_, i) => gradientAt(stations, i));
}

/**
 * How the ground sits either side of the course at this station: positive when
 * the station stands above the mean of its lateral samples (a crest), negative
 * when it sits below them (a trough), null when nothing was sampled beside it.
 *
 * @param {TerrainStation} station
 * @returns {number|null}
 */
function crossRelief(station) {
  if (!isNum(station.groundMslM)) return null;
  if (!isNum(station.lateralOffsetM) || station.lateralOffsetM <= 0) return null;
  const left = isNum(station.leftMslM) ? station.leftMslM : null;
  const right = isNum(station.rightMslM) ? station.rightMslM : null;
  if (left != null && right != null) return station.groundMslM - (left + right) / 2;
  if (left != null) return station.groundMslM - left;
  if (right != null) return station.groundMslM - right;
  return null;
}

/**
 * Every named shape along the corridor, in along-track order.
 *
 * Stations whose ground is unknown, and the steps either side of them, produce
 * nothing — not a guess, not a placeholder. A corridor that is half gaps
 * returns the features of the half that answered, and the caller learns the
 * rest from the missing-sample count on the field's provenance.
 *
 * @param {readonly TerrainStation[]} stations
 * @param {Partial<FeatureThresholds>} [thresholds]
 * @returns {TerrainFeature[]}
 */
export function detectFeatures(stations, thresholds = {}) {
  const limits = { ...DEFAULT_FEATURE_THRESHOLDS, ...thresholds };
  /** @type {TerrainFeature[]} */
  const features = [];

  for (let i = 0; i < stations.length; i++) {
    const here = stations[i];
    const ground = isNum(here.groundMslM) ? here.groundMslM : null;
    if (ground == null) continue;

    const prev = stations[i - 1];
    const next = stations[i + 1];
    const prevG = prev && isNum(prev.groundMslM) ? prev.groundMslM : null;
    const nextG = next && isNum(next.groundMslM) ? next.groundMslM : null;

    // An extremum needs both shoulders. One shoulder plus a gap is a station
    // that might be the top of anything.
    if (prevG != null && nextG != null) {
      const overPrev = ground - prevG;
      const overNext = ground - nextG;
      const cross = crossRelief(here);
      const crossHigh = cross != null && cross > limits.minReliefM;
      const crossLow = cross != null && cross < -limits.minReliefM;
      const decided = crossHigh || crossLow;
      /** @type {TerrainFeatureKind|null} */
      let kind = null;
      let reliefM = 0;

      if (overPrev > limits.minReliefM && overNext > limits.minReliefM) {
        kind = crossLow ? 'pass' : 'ridge';
        reliefM = Math.min(overPrev, overNext);
      } else if (overPrev < -limits.minReliefM && overNext < -limits.minReliefM) {
        kind = crossHigh ? 'saddle' : 'valley';
        reliefM = Math.max(overPrev, overNext);
      }

      if (kind) {
        features.push(Object.freeze({
          kind,
          sampleId: here.id,
          throughId: null,
          distanceKm: here.distanceKm,
          groundMslM: ground,
          reliefM,
          slopeDeg: gradientAt(stations, i).slopeDeg,
          basis: /** @type {'along-track'|'cross-track'} */ (decided ? 'cross-track' : 'along-track'),
        }));
      }
    }

    // The step from here to the next station. Reported on the near side, so a
    // cliff read in flight order is announced before it is reached.
    if (nextG != null) {
      const runM = (next.distanceKm - here.distanceKm) * 1000;
      const drop = nextG - ground;
      if (runM > 0 && Math.abs(drop) >= limits.cliffMinDropM) {
        const slopeDeg = Math.atan(Math.abs(drop) / runM) * 180 / Math.PI;
        if (slopeDeg >= limits.cliffMinSlopeDeg) {
          features.push(Object.freeze({
            kind: /** @type {TerrainFeatureKind} */ ('cliff'),
            sampleId: here.id,
            throughId: next.id,
            distanceKm: here.distanceKm,
            groundMslM: ground,
            reliefM: drop,
            slopeDeg,
            basis: /** @type {'along-track'|'cross-track'} */ ('along-track'),
          }));
        }
      }
    }
  }

  return features;
}
