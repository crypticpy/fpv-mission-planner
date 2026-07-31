// regime.js — baseline B2: does the air go over the barrier, or around it? (M5)
//
// B1 (terrain-forcing.js) asks what a wind does where it touches the ground. It
// cannot ask the prior question: whether the air is stratified enough that the
// barrier deflects it at all. That is what a Froude-like number is for —
// `Fr = U / (N h)`, the ratio of the flow's kinetic energy to the work of
// lifting stratified air over a barrier of height `h`.
//
// The artifact is precise about how far that number may be pushed: "Low values
// suggest blocking/flow-around; values near one indicate a sensitive transition;
// higher values favor flow-over. Thresholds must be calibrated and shown as
// regimes because real stratification is not uniform." And in the limitations:
// "A Froude number summarizes a regime; it does not uniquely locate wave
// breaking, rotors, or vortices."
//
// So this module returns a regime *and the band it was read from*, never a bare
// verdict, and it applies one rule that makes that structural rather than
// advisory: **if the perturbed ensemble spans more than one regime, the answer
// is 'transition'.** A regime label that a ±30% forecast error would overturn is
// not a blocked/flow-over finding, it is a sensitive one, and saying so is the
// whole point of carrying a band.
//
// That rule has an arithmetic consequence worth stating in daylight, because it
// looks like dead code otherwise. With U and N each perturbed by ±30%, the band
// spans `Fr × [0.7/1.3, 1.3/0.7] = Fr × [0.538, 1.857]`, so:
//
//   - 'blocked'   needs a central Fr below 0.5 / 1.857 ≈ 0.27;
//   - 'flow-over' needs a central Fr above 2.0 / 0.538 ≈ 3.72;
//   - everything between is 'transition'.
//
// Both ends are reachable on ordinary mountain soundings (a nocturnal inversion
// in light wind reaches the first; a weakly stratified gale reaches the second),
// and the wide middle is deliberate.
//
// Everything inside is SI. The inputs are not — the app speaks mph and °C — so
// the conversions happen once, on the way in.

import { G, U as UNITS } from '../physics.js';

/**
 * A pressure-level sounding, lowest level first. `heightM` is geopotential
 * height above mean sea level, which is what makes the levels stackable against
 * a DEM; the artifact is explicit that "pressure levels must never be treated as
 * fixed AGL heights".
 *
 * @typedef {{ hPa: number, windMph: number, windFromDeg: number,
 *             tempC: number, heightM: number }} SoundingLevel
 * @typedef {readonly SoundingLevel[]} Sounding
 */

/** @typedef {import('./terrain-forcing.js').WindVector} WindVector */

/**
 * `blocked`   — stratification wins; air is deflected around rather than over.
 * `transition`— near unity, or a band that straddles a threshold. The sensitive
 *               case, and the one the artifact wants rendered as a widened
 *               yellow zone rather than a sharper prediction.
 * `flow-over` — the flow surmounts the barrier; mountain-wave conditions become
 *               plausible downstream, which is a statement about *conditions*
 *               and never about where a rotor is.
 * `unknown`   — the inputs could not support any of the three. Never a guess.
 *
 * @typedef {'blocked'|'transition'|'flow-over'|'unknown'} FlowRegime
 */

/**
 * Why an answer is 'unknown', or 'ok' when it is not. Carried so a UI can say
 * which input is missing instead of showing a shrug.
 *
 * @typedef {'ok'|'no-relief'|'insufficient-levels'|'unstable-or-neutral-layer'
 *           |'no-wind'} RegimeReason
 */

/**
 * The split, and why it is where it is.
 *
 * Unity is the physical scale — `Fr = 1` is where the flow's energy and the
 * barrier's work balance — and the artifact forbids resting a verdict on a
 * single crisp threshold. So the two edges sit a factor of two either side of
 * unity: geometrically symmetric, deliberately wide, and honest that the
 * literature's "blocked below one, over above one" is a summary of a range of
 * calibrations rather than a measured boundary. A tighter split would be a
 * precision this module has not earned, and a wider one would make the outer
 * classes unreachable under the perturbation envelope above.
 *
 * @typedef {{ blockedBelow: number, flowOverAbove: number }} RegimeThresholds
 */

/** @type {RegimeThresholds} */
export const REGIME_THRESHOLDS = Object.freeze({
  blockedBelow: 0.5,
  flowOverAbove: 2.0,
});

/**
 * The sensitivity band's envelope.
 *
 * `speedFrac` is the artifact's own "speed by about ±30%". `stabilityFrac`
 * reuses the same figure rather than inventing a second one: the artifact asks
 * for stability to be perturbed but names no number, and N enters `Fr = U/(N h)`
 * with exactly the same power as U, so the two perturbations are commensurate by
 * construction. N is in any case the shakier of the two — a two-level potential
 * temperature difference across a coarse pressure layer — so if the figures
 * differed this one would be the larger.
 *
 * Barrier height is deliberately *not* perturbed here: `h` comes from the DEM
 * the pilot is flying, not from a forecast, and DEM-resolution sensitivity is a
 * property of the sampled grid rather than of this calculation.
 *
 * @typedef {{ speedFrac: number, stabilityFrac: number }} RegimePerturbations
 */

/** @type {RegimePerturbations} */
export const REGIME_PERTURBATIONS = Object.freeze({
  speedFrac: 0.3,
  stabilityFrac: 0.3,
});

/** Reference pressure for potential temperature, hPa. */
const P0_HPA = 1000;

/** R_d / c_p for dry air: 287.05 / 1004.7. */
const KAPPA = 0.2857;

/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const RAD = Math.PI / 180;

/**
 * The band the regime was read from. `regimes` is every distinct regime the
 * ensemble produced, sorted; when it holds more than one entry the reported
 * regime is 'transition' whatever the central value said.
 *
 * @typedef {object} RegimeBand
 * @property {number|null} froudeMin
 * @property {number|null} froudeMax
 * @property {readonly FlowRegime[]} regimes
 * @property {number|null} agreement 0–1, the share of ensemble members whose
 *                         regime matches the central Fr's regime
 * @property {number} members
 * @property {RegimePerturbations} perturbations
 */

/**
 * What the answer was built from. Diagnostics, not verdicts — a UI that wants to
 * explain a regime (ADR 0008 requires it: inputs, model baseline, sensitivity,
 * limitations) reads this rather than re-deriving it.
 *
 * @typedef {object} RegimeBasis
 * @property {'B2-stability-regime'} baseline
 * @property {RegimeReason} reason
 * @property {number|null} n2PerS2      Brunt–Väisälä frequency squared, 1/s²
 * @property {number|null} uMs          the cross-barrier speed actually used
 * @property {number|null} hM           the barrier height actually used
 * @property {'sounding'|'fallback'|null} windSource
 * @property {number} levelsUsed        sounding levels inside the barrier layer
 * @property {number|null} layerDepthM  the depth the stability gradient spans,
 *                         which is the sounding's resolution and not ours to
 *                         improve — it can exceed `hM` when levels are sparse
 * @property {RegimeThresholds} thresholds
 */

/**
 * @typedef {object} RegimeResult
 * @property {number|null} froude  the central Fr = U / (N h)
 * @property {number|null} brunt   N in 1/s; present whenever the sounding
 *                        supported it, even when the regime is 'unknown' for
 *                        want of a wind
 * @property {FlowRegime} regime
 * @property {RegimeBand} band
 * @property {RegimeBasis} basis
 */

/**
 * Potential temperature in kelvin: the temperature a parcel would have if
 * brought dry-adiabatically to 1000 hPa. Its vertical gradient is what stability
 * actually is — a raw temperature gradient conflates stratification with the
 * adiabatic lapse every parcel follows for free.
 *
 * @param {number} tempC
 * @param {number} hPa
 * @returns {number|null}
 */
function thetaK(tempC, hPa) {
  if (!isNum(tempC) || !isNum(hPa) || hPa <= 0) return null;
  return (tempC + 273.15) * Math.pow(P0_HPA / hPa, KAPPA);
}

/**
 * The levels usable for stability, lowest first. A level needs a pressure, a
 * temperature and a height; wind is optional here because a sounding can be
 * usable for N and not for U, and the two failures deserve different reasons.
 *
 * @param {unknown} sounding
 * @returns {SoundingLevel[]}
 */
function usableLevels(sounding) {
  if (!Array.isArray(sounding)) return [];
  /** @type {SoundingLevel[]} */
  const out = [];
  for (const raw of sounding) {
    if (!raw || typeof raw !== 'object') continue;
    const level = /** @type {Partial<SoundingLevel>} */ (raw);
    if (!isNum(level.hPa) || level.hPa <= 0) continue;
    if (!isNum(level.tempC) || !isNum(level.heightM)) continue;
    out.push({
      hPa: level.hPa,
      tempC: level.tempC,
      heightM: level.heightM,
      windMph: isNum(level.windMph) ? level.windMph : NaN,
      windFromDeg: isNum(level.windFromDeg) ? level.windFromDeg : NaN,
    });
  }
  // The contract says lowest first; sorting anyway costs nothing and means a
  // provider that hands levels back pressure-first cannot silently invert the
  // stability gradient.
  return out.sort((a, b) => a.heightM - b.heightM);
}

/**
 * The levels that span the barrier: everything from the lowest up to
 * `base + h`, extended by one level when that leaves fewer than two.
 *
 * The extension matters more than it looks. Pressure levels are coarse — often
 * a kilometre apart — and a 300 m barrier can sit entirely inside one layer. The
 * honest response is to measure the gradient over the layer the sounding
 * actually resolves and report that depth (`layerDepthM`), not to interpolate a
 * gradient the data never had.
 *
 * @param {readonly SoundingLevel[]} levels lowest first
 * @param {number} reliefM
 * @returns {SoundingLevel[]}
 */
function barrierLayer(levels, reliefM) {
  if (levels.length === 0) return [];
  const base = levels[0].heightM;
  const within = levels.filter((l) => l.heightM <= base + reliefM);
  if (within.length >= 2) return within;
  const next = levels[within.length];
  return next ? [...within, next] : within;
}

/**
 * The bulk cross-barrier speed over a layer, as the magnitude of the vector
 * mean.
 *
 * A vector mean rather than a mean of speeds, because a wind that veers through
 * the layer is not pushing air over the barrier as hard as its speeds suggest,
 * and averaging the magnitudes would launder directional shear into a stronger
 * bulk flow. Two known honesty debts ride here, both in the same direction and
 * both covered in part by the band: this is the full wind rather than the
 * component normal to the ridge (the artifact's B2 inputs name "effective
 * barrier height" and a ridge-normal component, which needs a ridge orientation
 * this function is not given), and the normal component is always the smaller of
 * the two — so `Fr` is biased high, toward 'flow-over'.
 *
 * @param {readonly SoundingLevel[]} levels
 * @returns {number|null}
 */
function layerMeanSpeedMs(levels) {
  let east = 0;
  let north = 0;
  let n = 0;
  for (const level of levels) {
    if (!isNum(level.windMph) || !isNum(level.windFromDeg)) continue;
    const speed = Math.max(0, UNITS.mphToMs(level.windMph));
    const toDeg = level.windFromDeg + 180;
    east += speed * Math.sin(toDeg * RAD);
    north += speed * Math.cos(toDeg * RAD);
    n += 1;
  }
  if (n === 0) return null;
  return Math.hypot(east / n, north / n);
}

/**
 * @param {number} froude
 * @param {RegimeThresholds} limits
 * @returns {FlowRegime}
 */
function regimeOf(froude, limits) {
  if (froude < limits.blockedBelow) return 'blocked';
  if (froude > limits.flowOverAbove) return 'flow-over';
  return 'transition';
}

/**
 * @param {RegimeReason} reason
 * @param {Partial<RegimeBasis>} [basis]
 * @returns {RegimeResult}
 */
function unknownResult(reason, basis = {}) {
  return Object.freeze({
    froude: null,
    brunt: isNum(basis.n2PerS2) && basis.n2PerS2 > 0 ? Math.sqrt(basis.n2PerS2) : null,
    regime: /** @type {FlowRegime} */ ('unknown'),
    band: Object.freeze({
      froudeMin: null,
      froudeMax: null,
      regimes: Object.freeze(/** @type {FlowRegime[]} */ ([])),
      agreement: null,
      members: 0,
      perturbations: REGIME_PERTURBATIONS,
    }),
    basis: Object.freeze({
      baseline: /** @type {'B2-stability-regime'} */ ('B2-stability-regime'),
      reason,
      n2PerS2: basis.n2PerS2 ?? null,
      uMs: basis.uMs ?? null,
      hM: basis.hM ?? null,
      windSource: basis.windSource ?? null,
      levelsUsed: basis.levelsUsed ?? 0,
      layerDepthM: basis.layerDepthM ?? null,
      thresholds: REGIME_THRESHOLDS,
    }),
  });
}

/**
 * Estimate the flow regime over a barrier from a pressure-level sounding.
 *
 * `reliefM` is the barrier height — for an advisory grid, its max elevation
 * minus its min. `wind` is a fallback used only for U, and only when the
 * sounding carries no usable winds; there is no fallback for stability, because
 * N cannot be guessed from a surface observation and a guessed N is the one
 * input that would turn this from an estimate into a fiction.
 *
 * Returns 'unknown' — with a reason — rather than a verdict whenever the inputs
 * cannot support one.
 *
 * @param {object} args
 * @param {unknown} args.sounding pressure levels, lowest first
 * @param {WindVector} [args.wind] fallback background wind
 * @param {number} args.reliefM barrier height, metres
 * @returns {RegimeResult}
 */
export function computeRegime({ sounding, wind, reliefM }) {
  if (!isNum(reliefM) || reliefM <= 0) return unknownResult('no-relief');

  const levels = usableLevels(sounding);
  const layer = barrierLayer(levels, reliefM);
  if (layer.length < 2) {
    return unknownResult('insufficient-levels', { hM: reliefM, levelsUsed: layer.length });
  }

  const bottom = layer[0];
  const top = layer[layer.length - 1];
  const layerDepthM = top.heightM - bottom.heightM;
  const thetaBottom = thetaK(bottom.tempC, bottom.hPa);
  const thetaTop = thetaK(top.tempC, top.hPa);
  if (thetaBottom == null || thetaTop == null || !(layerDepthM > 0)) {
    return unknownResult('insufficient-levels', {
      hM: reliefM, levelsUsed: layer.length, layerDepthM: layerDepthM || null,
    });
  }

  // N² = (g / θ̄) · dθ/dz, the bulk gradient across the barrier layer.
  const thetaMean = (thetaBottom + thetaTop) / 2;
  const n2PerS2 = (G / thetaMean) * ((thetaTop - thetaBottom) / layerDepthM);
  const partial = {
    n2PerS2, hM: reliefM, levelsUsed: layer.length, layerDepthM,
  };
  if (!(n2PerS2 > 0)) {
    // A neutral or unstable layer has no stable stratification to be lifted
    // over, so `Fr = U/(N h)` is undefined rather than large. The layer may well
    // be convective, which is its own hazard and not one a Froude number
    // describes — so this is 'unknown' with the reason attached, not a quiet
    // promotion to 'flow-over'.
    return unknownResult('unstable-or-neutral-layer', partial);
  }
  const brunt = Math.sqrt(n2PerS2);

  const soundingU = layerMeanSpeedMs(layer);
  const fallbackU = wind && isNum(wind.windMph)
    ? Math.max(0, UNITS.mphToMs(wind.windMph))
    : null;
  const uMs = soundingU ?? fallbackU;
  /** @type {'sounding'|'fallback'|null} */
  const windSource = soundingU != null ? 'sounding' : (fallbackU != null ? 'fallback' : null);
  if (uMs == null) return unknownResult('no-wind', partial);

  const froude = uMs / (brunt * reliefM);

  /** @type {FlowRegime[]} */
  const memberRegimes = [];
  let froudeMin = Infinity;
  let froudeMax = -Infinity;
  const { speedFrac, stabilityFrac } = REGIME_PERTURBATIONS;
  for (const du of [-speedFrac, 0, speedFrac]) {
    for (const dn of [-stabilityFrac, 0, stabilityFrac]) {
      const memberFr = (uMs * (1 + du)) / (brunt * (1 + dn) * reliefM);
      froudeMin = Math.min(froudeMin, memberFr);
      froudeMax = Math.max(froudeMax, memberFr);
      memberRegimes.push(regimeOf(memberFr, REGIME_THRESHOLDS));
    }
  }

  const central = regimeOf(froude, REGIME_THRESHOLDS);
  const spanned = [...new Set(memberRegimes)].sort();
  const agreement = memberRegimes.filter((r) => r === central).length / memberRegimes.length;
  // The rule this module exists to enforce: a label the perturbation envelope
  // overturns is a sensitivity finding, not a regime finding.
  const regime = spanned.length > 1 ? /** @type {FlowRegime} */ ('transition') : central;

  return Object.freeze({
    froude,
    brunt,
    regime,
    band: Object.freeze({
      froudeMin,
      froudeMax,
      regimes: Object.freeze(spanned),
      agreement,
      members: memberRegimes.length,
      perturbations: REGIME_PERTURBATIONS,
    }),
    basis: Object.freeze({
      baseline: /** @type {'B2-stability-regime'} */ ('B2-stability-regime'),
      reason: /** @type {RegimeReason} */ ('ok'),
      n2PerS2,
      uMs,
      hM: reliefM,
      windSource,
      levelsUsed: layer.length,
      layerDepthM,
      thresholds: REGIME_THRESHOLDS,
    }),
  });
}

/**
 * The barrier height an advisory grid implies: its highest known elevation minus
 * its lowest. Null when fewer than two cells carry a reading, because a single
 * elevation is a point, not a barrier.
 *
 * Kept here rather than in terrain-forcing.js because `reliefM` is a B2 input
 * and B1 has no use for it.
 *
 * @param {{ cells: readonly { elevM: number|null }[] }} grid
 * @returns {number|null}
 */
export function gridReliefM(grid) {
  let min = Infinity;
  let max = -Infinity;
  let n = 0;
  for (const cell of grid?.cells ?? []) {
    if (!cell || !isNum(cell.elevM)) continue;
    min = Math.min(min, cell.elevM);
    max = Math.max(max, cell.elevM);
    n += 1;
  }
  if (n < 2) return null;
  return max - min;
}
