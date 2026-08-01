// dive.js — the physics of pointing a multirotor down a mountain (M16).
//
// vertical.js models the slow, controlled height changes an ordinary route
// makes, and stops on purpose at descent rates a rotor's own downwash can
// swallow. A mountain dive is the other regime: the aircraft descends far
// faster than its induced velocity, the airflow is clean and from ahead, and
// the questions change — how steep, how fast at the bottom, how hard the
// pullout, how low the arc sinks, and what the pack and motors are asked for
// while it happens.
//
// Everything here is closed-form mechanics over stated inputs. Like
// vertical.js, where a choice existed between a figure that flatters the plan
// and one that does not, the one that does not is here, with the reason next
// to it. Nothing is a measurement of this airframe. There is deliberately no
// thermal model in this module: nothing in this tool measures or estimates
// motor or ESC temperature, and a number invented for it would be worse than
// its absence.

import { G, dischargeSim } from './physics.js';
import { climbEnergyWh } from './vertical.js';
import { distanceKm } from './geo.js';

/* ---------- the line itself ---------- */

/** A gate-shaped point: where, and how high. */
/** @typedef {{ latitude: number, longitude: number, altitudeMslM: number }} DivePoint */

/**
 * @typedef {object} DiveLeg
 * @property {number} dropM       height lost entry→exit; negative if it climbs
 * @property {number} horizontalM great-circle ground distance
 * @property {number} pathM       straight-line length of the leg
 * @property {number} pitchDeg    flight-path angle, negative down (a dive reads −52, not 52)
 */

/**
 * The geometry of one dive leg, from two gates. Pure trigonometry over the
 * same spherical distance every other leg in this tool uses — the leg is
 * treated as a straight line in the vertical plane through its endpoints,
 * which over the sub-kilometre lengths a dive line runs is the line the pilot
 * actually flies.
 *
 * @param {DivePoint} entry
 * @param {DivePoint} exit
 * @returns {DiveLeg}
 */
export function diveLeg(entry, exit) {
  const horizontalM = distanceKm(
    { lat: entry.latitude, lng: entry.longitude },
    { lat: exit.latitude, lng: exit.longitude },
  ) * 1000;
  const dropM = entry.altitudeMslM - exit.altitudeMslM;
  const pathM = Math.hypot(dropM, horizontalM);
  const pitchDeg = pathM > 0 ? -Math.atan2(dropM, horizontalM) * 180 / Math.PI : 0;
  return { dropM, horizontalM, pathM, pitchDeg };
}

/**
 * The vertical component of flying `speedMs` along a path at `pitchDeg`,
 * signed like the pitch: negative going down. The "peak vertical speed" the
 * dive readout quotes is this at the dive leg's own pitch and speed — a
 * statement about the authored line, not a prediction of what the pilot's
 * thumb does.
 *
 * @param {number} speedMs
 * @param {number} pitchDeg
 * @returns {number}
 */
export function diveVerticalSpeedMs(speedMs, pitchDeg) {
  if (!(speedMs > 0) || !Number.isFinite(pitchDeg)) return 0;
  return speedMs * Math.sin(pitchDeg * Math.PI / 180);
}

/**
 * The throttle-idle equilibrium speed on a slope: the speed at which drag
 * along the path balances the gravity component along it,
 *
 *   ½·ρ·v²·cdA = m·g·sin|θ|   →   v = √(2·m·g·sin|θ| / (ρ·cdA))
 *
 * This is a reference point, not a cap — under power the aircraft goes
 * faster, braking (flat to the wind) it goes slower. Its use is honesty about
 * the authored dive speed: a leg authored well above this figure is a claim
 * about throttle held in, and a leg near it costs no pack at all on the way
 * down. `null`, not a number, when the leg does not descend or an input is
 * unusable — a terminal speed on a climb is not zero, it does not exist.
 *
 * @param {object} spec
 * @param {number} spec.massKg  all-up mass
 * @param {number} spec.rho     air density on the slope, kg/m³
 * @param {number} spec.cdA     the airframe's drag area
 * @param {number} spec.pitchDeg flight-path angle, negative down
 * @returns {number|null}
 */
export function terminalDiveSpeedMs({ massKg, rho, cdA, pitchDeg }) {
  if (!(massKg > 0) || !(rho > 0) || !(cdA > 0) || !Number.isFinite(pitchDeg) || pitchDeg >= 0) return null;
  const sinTheta = Math.sin(-pitchDeg * Math.PI / 180);
  return Math.sqrt(2 * massKg * G * sinTheta / (rho * cdA));
}

/* ---------- the pullout ---------- */

/**
 * @typedef {object} PulloutArc
 * @property {number} radiusM the tightest arc the load limit allows at this speed
 * @property {number} sinkM   height lost between starting the pull and flying level
 */

/**
 * The pullout, as a circular arc flown at constant speed from the dive's
 * pitch to level. The load factor on such an arc is worst at the bottom,
 * where the rotors carry both the turn and the weight:
 *
 *   n = v²/(g·r) + 1   →   r = v² / (g·(n − 1))
 *
 * and the height lost from pull to level is r·(1 − cos|θ|).
 *
 * Constant speed is the conservative reading: a real pullout bleeds speed
 * into drag and the climbing gravity component, which tightens the arc as it
 * goes, so the real sink is at or under this figure. Erring the other way —
 * quoting a sink the aircraft might beat — is the failure that puts a dive
 * line into a ridge.
 *
 * `null` when no arc exists: at a load allowance of 1 g or less the rotors
 * can hold the weight or turn the path, not both, and there is no pullout to
 * describe.
 *
 * @param {object} spec
 * @param {number} spec.speedMs  speed at pullout entry
 * @param {number} spec.pitchDeg the dive's flight-path angle, negative down
 * @param {number} spec.loadG    the load factor the pull is flown at
 * @returns {PulloutArc|null}
 */
export function pulloutArc({ speedMs, pitchDeg, loadG }) {
  if (!(speedMs > 0) || !(loadG > 1) || !Number.isFinite(pitchDeg)) return null;
  const radiusM = speedMs * speedMs / (G * (loadG - 1));
  const theta = Math.min(Math.max(-pitchDeg, 0), 90) * Math.PI / 180;
  return { radiusM, sinkM: radiusM * (1 - Math.cos(theta)) };
}

/**
 * The inverse reading: the load factor an arc of `radiusM` demands at
 * `speedMs`, worst-point (bottom of the arc). What a "tune pullout" control
 * reads back as the pilot trades radius against g.
 *
 * @param {object} spec
 * @param {number} spec.speedMs
 * @param {number} spec.radiusM
 * @returns {number|null}
 */
export function pulloutLoadG({ speedMs, radiusM }) {
  if (!(speedMs > 0) || !(radiusM > 0)) return null;
  return speedMs * speedMs / (G * radiusM) + 1;
}

/**
 * Where the pullout bottoms out against the ground, if the pull starts at the
 * recovery gate itself — the latest defensible start, and therefore the
 * clearance figure that errs against the pilot. A pull begun before the gate
 * only clears by more.
 *
 * @param {object} spec
 * @param {number} spec.gateMslM   the recovery gate's altitude
 * @param {number} spec.groundMslM the terrain under the arc's low point
 * @param {number} spec.sinkM      `pulloutArc().sinkM`
 * @returns {{ lowestMslM: number, clearanceM: number }}
 */
export function pulloutClearance({ gateMslM, groundMslM, sinkM }) {
  const lowestMslM = gateMslM - Math.max(0, sinkM || 0);
  return { lowestMslM, clearanceM: lowestMslM - groundMslM };
}

/* ---------- what the pull asks of the machine ---------- */

/**
 * Electrical power during the pullout, scaled from hover by momentum theory:
 * induced power goes as thrust^1.5 at fixed disc area and density, and the
 * pull carries `loadG` times the weight, so
 *
 *   P_pull = P_hover · n^1.5
 *
 * This overstates the demand — at pullout speeds the rotors are in clean
 * forward flow, well past translational lift, where induced power is a
 * fraction of its hover figure. Overstating the draw overstates the sag and
 * the current, which is the direction a margin should be wrong in. What it is
 * *not* is a measurement; the constraint that carries this number says so.
 *
 * @param {number} hoverW the plan's own hover power
 * @param {number} loadG
 * @returns {number}
 */
export function pulloutPowerW(hoverW, loadG) {
  if (!(hoverW > 0) || !(loadG > 0)) return 0;
  return hoverW * Math.pow(loadG, 1.5);
}

/**
 * @typedef {object} PulloutSag
 * @property {number} vOcv
 * @property {number} I     pack amps at this power, NaN when undeliverable
 * @property {number} vLoad the sagged terminal voltage, NaN when undeliverable
 * @property {boolean} deliverable
 */

/**
 * What the pack's terminals read while delivering the pullout power — the
 * same IR model (`dischargeSim`) every other sag figure in this tool comes
 * from, sampled at the state of charge the dive reaches the pullout with.
 * Two sag models would eventually disagree; this is a reading of the one.
 *
 * @param {object} spec
 * @param {import('./physics.js').BatteryConfig} spec.batt
 * @param {number} spec.tempC  pack temperature
 * @param {number} spec.powerW electrical draw during the pull
 * @param {number} spec.soc    state of charge at pullout, 0–100
 * @returns {PulloutSag}
 */
export function pulloutSag({ batt, tempC, powerW, soc }) {
  const state = dischargeSim(batt, tempC, powerW).stateAt(soc);
  return { ...state, deliverable: Number.isFinite(state.vLoad) };
}

/**
 * @typedef {object} ElectricalMargins
 * @property {number|null} motorMarginFrac 0.18 reads "18% of the motors' ceiling unused"
 * @property {number|null} escMarginFrac
 */

/**
 * How much of the propulsion's current ceiling the pullout draw leaves
 * unused, per limit. The catalog's `motorMaxA`/`escMaxA` are per-motor
 * figures (the same convention `liftEnvelope` multiplies out), the draw is a
 * whole-pack figure, so each margin compares against limit × rotors. Negative
 * is a statement, not an error: the pull as authored exceeds that ceiling.
 * `null` where the catalog carries no limit — a margin against a number
 * nobody stated would be an invention.
 *
 * @param {object} spec
 * @param {number} spec.currentA  pack amps during the pull (`pulloutSag().I`)
 * @param {number} spec.numRotors
 * @param {number|null|undefined} spec.motorMaxA per-motor, from the catalog
 * @param {number|null|undefined} spec.escMaxA   per-motor, from the catalog
 * @returns {ElectricalMargins}
 */
export function electricalMargins({ currentA, numRotors, motorMaxA, escMaxA }) {
  /** @param {number|null|undefined} perMotorA @returns {number|null} */
  const marginOf = (perMotorA) => {
    if (!(currentA >= 0) || !(numRotors > 0) || !(typeof perMotorA === 'number' && perMotorA > 0)) return null;
    const totalA = perMotorA * numRotors;
    return (totalA - currentA) / totalA;
  };
  return { motorMarginFrac: marginOf(motorMaxA), escMarginFrac: marginOf(escMaxA) };
}

/* ---------- getting home afterward ---------- */

/**
 * The energy the recovery costs: climb from the recovery gate to the
 * lost-link/RTH altitude, then cruise home at that height. The climb term is
 * vertical.js's own `climbEnergyWh` — one climb model in this tool, not two —
 * and the cruise term is the caller's level power over the distance at the
 * stated speed. `null` when there is distance to cover and no usable speed to
 * cover it at; a time nobody can compute is not zero Wh.
 *
 * @param {object} spec
 * @param {number} spec.massKg
 * @param {number} spec.etaProp
 * @param {number} spec.climbM      recovery gate up to the RTH plane; <= 0 costs nothing
 * @param {number} spec.distanceM   ground distance home
 * @param {number} spec.levelPowerW cruise power at the RTH height
 * @param {number} spec.speedMs     cruise speed home
 * @returns {number|null} Wh
 */
export function rthEnergyWh({ massKg, etaProp, climbM, distanceM, levelPowerW, speedMs }) {
  const climbWh = climbEnergyWh(massKg, etaProp, climbM);
  const dist = distanceM > 0 ? distanceM : 0;
  if (dist === 0) return climbWh;
  if (!(speedMs > 0) || !(levelPowerW >= 0)) return null;
  return climbWh + levelPowerW * (dist / speedMs) / 3600;
}

/**
 * The share of the pack still unspoken-for once the dive is flown and the
 * ride home is paid: (pack − spent − home) / pack. Negative is the honest
 * reading of a plan that does not close — the caller words it, this reports
 * it. `null` without a usable pack size; a fraction of nothing is not 100%.
 *
 * @param {object} spec
 * @param {number} spec.packWh  usable pack energy the plan flies on
 * @param {number} spec.spentWh energy the mission has used by the recovery gate
 * @param {number} spec.rthWh   `rthEnergyWh()`
 * @returns {number|null}
 */
export function recoveryReserveFrac({ packWh, spentWh, rthWh }) {
  if (!(packWh > 0) || !(spentWh >= 0) || !(rthWh >= 0)) return null;
  return (packWh - spentWh - rthWh) / packWh;
}
