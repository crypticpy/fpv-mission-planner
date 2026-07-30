// vertical.js — what changes when the aircraft changes height.
//
// Everything in physics.js is horizontal: one air density for the whole flight,
// one wind, and legs that cost the same whether they end 200 m higher or 200 m
// lower than they started. That was honest while the analysis said so out loud
// (M2 raised W-ALT-VERTICAL-UNMODELLED and charged nothing), and it stops being
// good enough the moment the route crosses a ridge.
//
// This module is additive. It does not touch a single validated horizontal
// equation — `powerAtSpeed`, `legSolverFrom` and `planMission` are untouched and
// their parity tests still pin them — it answers three narrower questions the
// pipeline asks *beside* those numbers:
//
//   what does gaining height cost?
//   what does losing it cost? (never: what does it give back)
//   what is the air, and the wind, doing up there rather than down here?
//
// The whole module is written to err against the pilot. Where a choice was
// available between a figure that flatters the plan and one that does not, the
// one that does not is here, and the reason is written next to it. Nothing below
// is a measurement of this airframe; every constant is either a rotor-theory
// identity or a stated planning policy, marked as such, and the constraint
// explanations that carry these numbers say so in their `limitations`.

import { G, airDensity } from './physics.js';

/* ---------- stated policy, not measured physics ---------- */

/**
 * The climb rate the planner costs a height gain at, m/s.
 *
 * It does not change the energy — see `climbEnergyWh`, where the rate cancels —
 * so it exists only to say how long the climb takes. 3 m/s is a normal
 * cinematic-cruise climb for the airframes this tool plans; a racer pulling
 * 15 m/s pays the same Wh and arrives sooner.
 */
export const DEFAULT_CLIMB_RATE_MS = 3;

/**
 * The descent rate, m/s. Deliberately below the induced velocity of these
 * rotors (v_h is roughly 5-8 m/s at their disc loading), because a multirotor
 * descending vertically at anything close to its own downwash speed is inside
 * the vortex-ring region, where momentum theory is not merely inaccurate but
 * invalid. Planning a descent this tool cannot model would be worse than
 * planning a slow one.
 */
export const DEFAULT_DESCENT_RATE_MS = 2;

/**
 * What a controlled descent costs, as a fraction of hover power.
 *
 * There is no defensible closed form here: the descent regime this fraction
 * covers is exactly the one momentum theory cannot describe, and the empirical
 * literature on it is helicopter data at helicopter disc loadings. So this is a
 * planning policy, chosen close to hover on purpose. The failure that matters is
 * under-charging a descent and telling a pilot they have energy they do not; a
 * descent that turns out cheaper than 0.9 hover costs them nothing but a
 * pleasant surprise.
 */
export const DESCENT_HOVER_POWER_FRAC = 0.9;

/** The ISA temperature lapse rate, K per metre of altitude. */
export const ISA_LAPSE_K_PER_M = 0.0065;

/* ---------- the energy of changing height ---------- */

/**
 * Electrical energy to gain `gainM` metres, in Wh. Zero for a level or
 * descending leg — a drop is `descentExcessWh`'s business.
 *
 * The model is the potential energy gained, divided by the same `etaProp` that
 * every other electrical figure in this tool is divided by:
 *
 *   E_climb = m·g·Δh / η
 *
 * Two things are worth knowing about that expression.
 *
 * *It is rate-independent, and that is a result rather than a simplification.*
 * Charging the climb at a power of m·g·V_c for a time Δh/V_c gives m·g·Δh
 * whatever V_c is. So `DEFAULT_CLIMB_RATE_MS` moves the clock and not the Wh.
 *
 * *It is a strict upper bound on the momentum-theory excess.* In a vertical
 * climb at V_c the induced velocity solves v_i = −V_c/2 + √((V_c/2)² + v_h²),
 * and the rotor power is T·(V_c + v_i) against T·v_h in hover, so the excess is
 *
 *   T·(V_c/2 + √((V_c/2)² + v_h²) − v_h)  ≤  T·V_c
 *
 * — the inequality reduces to 0 ≤ v_h·V_c, which holds for every thrust, every
 * density and every climb rate. At a realistic V_c = 3 m/s over v_h ≈ 6 m/s the
 * bound is loose by nearly a factor of two, which is the direction this module
 * is supposed to be wrong in.
 *
 * What it leaves out is the parasite drag of the vertical component itself,
 * ½·ρ·cdA·V_c³ — under a watt at these rates and frontal areas against the tens
 * of watts of the climb term. It is an omission, it is stated in the constraint
 * that carries this number, and it is far smaller than the margin above.
 *
 * @param {number} massKg   all-up mass
 * @param {number} etaProp  electrical to ideal efficiency, as planMission uses it
 * @param {number} gainM    height gained; <= 0 returns 0
 * @returns {number} Wh
 */
export function climbEnergyWh(massKg, etaProp, gainM) {
  if (!(gainM > 0) || !(massKg > 0) || !(etaProp > 0)) return 0;
  return massKg * G * gainM / (etaProp * 3600);
}

/**
 * The energy a descent costs *on top of* flying that stretch level, in Wh.
 *
 * Never negative, by construction. A descending multirotor can in principle
 * windmill energy back into the pack, and no plan of this tool's will ever be
 * built on it: recovery depends on the ESC's regeneration behaviour, the pack's
 * charge acceptance and a descent profile nobody has flown yet, and a plan that
 * banked on it would hand the pilot Wh that may not exist.
 *
 * So the descent is charged at `descentPowerFrac` of hover for as long as it
 * takes, the level cruise power for that same stretch has already been charged
 * by the route integrator, and only the difference — when there is one — is
 * added here.
 *
 * @param {object} spec
 * @param {number} spec.hoverW           the plan's own hover power
 * @param {number} spec.levelPowerW      what this leg already costs per second
 * @param {number} spec.dropM            height lost; <= 0 returns 0
 * @param {number} [spec.descentRateMs]
 * @param {number} [spec.descentPowerFrac]
 * @returns {{ wh: number, seconds: number }}
 */
export function descentExcessWh({
  hoverW, levelPowerW, dropM,
  descentRateMs = DEFAULT_DESCENT_RATE_MS,
  descentPowerFrac = DESCENT_HOVER_POWER_FRAC,
}) {
  if (!(dropM > 0) || !(hoverW > 0) || !(descentRateMs > 0)) return { wh: 0, seconds: 0 };
  const seconds = dropM / descentRateMs;
  const excessW = Math.max(0, descentPowerFrac * hoverW - Math.max(0, levelPowerW || 0));
  return { wh: excessW * seconds / 3600, seconds };
}

/**
 * @typedef {object} LegVerticalEnergy
 * @property {number} climbWh    energy to gain height on this leg
 * @property {number} descentWh  energy charged over and above level flight to lose it
 * @property {number} wh         climbWh + descentWh
 * @property {number} climbS     seconds spent climbing
 * @property {number} descentS   seconds spent descending
 */

/**
 * One leg's vertical energy, from its own height change.
 *
 * A leg changes height once, in one direction, so exactly one of the two terms
 * is ever non-zero. Both are reported anyway: a caller summing a route wants the
 * climb total and the descent total separately, and "0" is a statement.
 *
 * The seconds are reported and *not* added to the leg's time. The route
 * integrator sized this leg from its ground speed, and stretching it here would
 * make the analysis and `planRoute` disagree about how long the flight is. Where
 * the vertical time exceeds the leg's own, the aircraft cannot in fact make the
 * height change on that leg — a statement this module supplies the numbers for
 * and the pipeline makes.
 *
 * @param {object} spec
 * @param {number} spec.massKg
 * @param {number} spec.etaProp
 * @param {number} spec.hoverW
 * @param {number} spec.levelPowerW  this leg's own cruise power
 * @param {number} spec.deltaM       positive up, negative down
 * @param {number} [spec.climbRateMs]
 * @param {number} [spec.descentRateMs]
 * @param {number} [spec.descentPowerFrac]
 * @returns {LegVerticalEnergy}
 */
export function legVerticalEnergy({
  massKg, etaProp, hoverW, levelPowerW, deltaM,
  climbRateMs = DEFAULT_CLIMB_RATE_MS,
  descentRateMs = DEFAULT_DESCENT_RATE_MS,
  descentPowerFrac = DESCENT_HOVER_POWER_FRAC,
}) {
  const delta = Number.isFinite(deltaM) ? deltaM : 0;
  const climbWh = climbEnergyWh(massKg, etaProp, delta);
  const climbS = delta > 0 && climbRateMs > 0 ? delta / climbRateMs : 0;
  const down = descentExcessWh({
    hoverW, levelPowerW, dropM: -delta, descentRateMs, descentPowerFrac,
  });
  return {
    climbWh,
    descentWh: down.wh,
    wh: climbWh + down.wh,
    climbS,
    descentS: down.seconds,
  };
}

/* ---------- the air up there ---------- */

/**
 * @typedef {object} AltitudeAir
 * @property {number} mslM         the height this describes
 * @property {number} tempC        the lapsed temperature there
 * @property {number} rho          kg/m³
 * @property {number} pressPa
 * @property {number} densityAltM
 */

/**
 * The air at one height, from a reading taken at another.
 *
 * `airDensity` is physics.js's, called with this sample's own elevation rather
 * than the launch point's — the barometric and humid-air formulas are not
 * restated here, because two copies of an atmosphere is how the two stop
 * agreeing. What this adds is the one input `airDensity` cannot infer: the
 * temperature at the new height, lapsed from the reported one at the standard
 * rate.
 *
 * Relative humidity is carried up unchanged. That is not what a real atmosphere
 * does, and it is the conservative direction: holding RH constant as the air
 * cools keeps more water vapour in the mix than reality would, and water vapour
 * is lighter than air, so the density that comes out is if anything a little low
 * — which costs the plan power rather than giving it away.
 *
 * @param {object} spec
 * @param {number} spec.mslM       the height wanted, metres MSL
 * @param {number} spec.refElevM   where the reading was taken, metres MSL
 * @param {number} spec.refTempC   the reading
 * @param {number} spec.rhPct
 * @returns {AltitudeAir}
 */
export function atmosphereAt({ mslM, refElevM, refTempC, rhPct }) {
  const tempC = refTempC - ISA_LAPSE_K_PER_M * (mslM - refElevM);
  const air = airDensity(mslM, tempC, rhPct);
  return { mslM, tempC, rho: air.rho, pressPa: air.pressPa, densityAltM: air.densityAltM };
}

/**
 * How much more power the rotors need in air of density `rho` than in air of
 * density `rhoRef`, as a ratio.
 *
 * Straight out of the same momentum theory `powerAtSpeed` solves: hover power is
 * T^1.5 / √(2·ρ·A), so at fixed thrust and disc area it goes as 1/√ρ. Thinner
 * air, more power, by exactly this factor. Nothing empirical in it.
 *
 * @param {number} rhoRef the density the plan was solved at
 * @param {number} rho    the density up where the leg actually flies
 * @returns {number} 1 when they match, >1 when the flight air is thinner
 */
export function hoverPowerRatio(rhoRef, rho) {
  if (!(rhoRef > 0) || !(rho > 0)) return 1;
  return Math.sqrt(rhoRef / rho);
}

/* ---------- the wind up there ---------- */

/**
 * What a wind figure at some height is based on.
 *
 * `interpolated` means the forecast published levels either side of the height
 * asked about. `clamped` means the height is outside the published range and the
 * nearest level is being quoted unchanged. `single-level` means the forecast has
 * exactly one usable level, so there is no gradient to read — and inventing one
 * (a power law, a log profile, a roughness guess) would be this tool asserting a
 * wind shear nobody measured.
 * @typedef {'interpolated'|'clamped'|'single-level'} WindBasis
 */

/**
 * @typedef {object} AltitudeWind
 * @property {number} windMph
 * @property {number} windFromDeg
 * @property {WindBasis} basis
 * @property {readonly number[]} levelsM the published levels this came off
 */

/** @typedef {Record<string, { windMph?: unknown, windFromDeg?: unknown }>} WindLevels */

/**
 * Every level in a levels shape that carries a usable reading, low to high.
 * @param {unknown} levels
 * @returns {{ altM: number, windMph: number, windFromDeg: number }[]}
 */
function usableLevels(levels) {
  if (!levels || typeof levels !== 'object') return [];
  const bag = /** @type {Record<string, unknown>} */ (levels);
  /** @type {{ altM: number, windMph: number, windFromDeg: number }[]} */
  const out = [];
  for (const key of Object.keys(bag)) {
    const altM = Number(key);
    if (!Number.isFinite(altM)) continue;
    const level = /** @type {{ windMph?: unknown, windFromDeg?: unknown }} */ (bag[key]);
    if (!level || typeof level !== 'object') continue;
    const windMph = level.windMph;
    const windFromDeg = level.windFromDeg;
    if (typeof windMph !== 'number' || !Number.isFinite(windMph)) continue;
    if (typeof windFromDeg !== 'number' || !Number.isFinite(windFromDeg)) continue;
    out.push({ altM, windMph, windFromDeg });
  }
  return out.sort((a, b) => a.altM - b.altM);
}

/**
 * Shortest-way angular blend between two bearings. Blending 350° and 10° the
 * long way round produces 180°, which is the exact opposite of both.
 * @param {number} a
 * @param {number} b
 * @param {number} t 0 gives a, 1 gives b
 * @returns {number}
 */
function blendBearing(a, b, t) {
  const diff = ((((b - a) % 360) + 540) % 360) - 180;
  return ((((a + diff * t) % 360) + 360) % 360);
}

/**
 * The wind at one height above the launch point, out of the forecast's published
 * levels — or null when the forecast published none.
 *
 * The whole point of the `basis` field is that this function is not allowed to
 * make anything up. With one level it says `single-level` and returns that level
 * unchanged; above or below the published range it says `clamped` and returns
 * the nearest level unchanged; only between two published levels does it
 * interpolate, and then it says so and names both. A caller that wants to know
 * whether the wind really varies with height on this forecast reads `basis`, not
 * the numbers.
 *
 * @param {unknown} levels the shape windprofile.js latches from a forecast
 * @param {number} altM    height above the launch point, metres
 * @returns {AltitudeWind|null}
 */
export function windAtAltitude(levels, altM) {
  const rungs = usableLevels(levels);
  if (rungs.length === 0) return null;
  const at = Number.isFinite(altM) ? Number(altM) : 0;
  if (rungs.length === 1) {
    const only = rungs[0];
    return Object.freeze({
      windMph: only.windMph,
      windFromDeg: only.windFromDeg,
      basis: /** @type {WindBasis} */ ('single-level'),
      levelsM: Object.freeze([only.altM]),
    });
  }
  const low = rungs[0];
  const high = rungs[rungs.length - 1];
  if (at <= low.altM || at >= high.altM) {
    const edge = at <= low.altM ? low : high;
    return Object.freeze({
      windMph: edge.windMph,
      windFromDeg: edge.windFromDeg,
      basis: /** @type {WindBasis} */ ('clamped'),
      levelsM: Object.freeze([edge.altM]),
    });
  }
  let below = low;
  let above = high;
  for (let i = 0; i < rungs.length - 1; i++) {
    if (at >= rungs[i].altM && at <= rungs[i + 1].altM) {
      below = rungs[i];
      above = rungs[i + 1];
      break;
    }
  }
  const span = above.altM - below.altM;
  const t = span > 0 ? (at - below.altM) / span : 0;
  return Object.freeze({
    windMph: below.windMph + (above.windMph - below.windMph) * t,
    windFromDeg: blendBearing(below.windFromDeg, above.windFromDeg, t),
    basis: /** @type {WindBasis} */ ('interpolated'),
    levelsM: Object.freeze([below.altM, above.altM]),
  });
}
