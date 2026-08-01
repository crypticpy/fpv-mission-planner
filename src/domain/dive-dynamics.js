// dive-dynamics.js — the authored dive line read as a sequence of phases (M16).
//
// dive.js holds the mechanics: one leg's geometry, one arc's radius, one pack's
// sag. Each of those answers a question about a single thing, and until now
// nothing called them — the numbers existed and no surface could ask for them.
// This module is the asking: it walks the gates in flight order, hands each
// consecutive pair to `diveLeg`, and returns the run as phases on a common
// station and clock, plus the one block of system figures the pull demands.
//
// It re-derives nothing. Every number below comes back out of dive.js, and the
// only arithmetic performed here is bookkeeping: cumulative station, cumulative
// time, and the arc's own length. Where dive.js answers `null`, that null is
// carried through with a phrase in `missing` naming the input nobody stated —
// because the failure this whole milestone is guarding against is a plausible
// figure standing in for an absent one.
//
// Three things are deliberately absent, and their absence is the point:
//
//   No temperature, anywhere. Nothing in this tool measures or estimates motor,
//     ESC or pack temperature, so there is no thermal field to emit — not even
//     a null one, which would advertise a model that does not exist.
//
//   No link margin in decibels. src/rf.js produces metres and a clear fraction;
//     a dB figure here would be invented.
//
//   No default for an unstated input. A dive with no authored speed has no time
//     axis at all rather than a time axis computed at some house cruise.
//
// Two conventions this module inherits rather than invents:
//
//   A leg is named by the gate it *ends* at, and wears that gate's label — the
//     same rule the 2D dive layer draws by. A plan missing its middle gate still
//     produces a leg under the later gate's kind, which is a true picture of a
//     half-authored plan rather than a refusal to describe one.
//
//   The pullout happens at the *dive* gate. That is the bottom of the descent
//     and the point the shipped pullout chip already measures from; two surfaces
//     disagreeing about where the arc is would be worse than either alone.

import {
  diveLeg, diveVerticalSpeedMs, electricalMargins, pulloutArc, pulloutClearance,
  pulloutPowerW, pulloutSag, recoveryReserveFrac, rthEnergyWh,
} from './dive.js';
import { distanceKm } from './geo.js';

/**
 * @typedef {import('./mission/mission-schema.js').DivePlan} DivePlan
 * @typedef {import('./mission/mission-schema.js').DiveGate} DiveGate
 * @typedef {import('./physics.js').BatteryConfig} BatteryConfig
 * @typedef {import('./physics.js').DroneConfig} DroneConfig
 * @typedef {import('./dive.js').DivePoint} DivePoint
 */

/**
 * The gates that are flown, in flight order. The abort gate is not here on
 * purpose: it is an alternate the pilot breaks off to, not a station on the
 * line, and drawing it as a phase would put a leg on the timeline that the plan
 * as authored never flies.
 * @type {readonly ('approach'|'dive'|'recovery')[]}
 */
const FLOWN_KINDS = Object.freeze(['approach', 'dive', 'recovery']);

/**
 * The label each leg wears, keyed by the gate it ends at. Written out rather
 * than imported: the same strings live in the 2D layer's style table, and this
 * module stays domain-pure. The test that pins them is the contract.
 * @type {Readonly<Record<string, string>>}
 */
const LEG_LABEL = Object.freeze({
  approach: 'Launch → approach',
  dive: 'Approach → dive',
  recovery: 'Dive → recovery',
});

/**
 * One stretch of the run, on a station axis measured along the flown path.
 *
 * `startM`/`endM` are path distance, not ground distance, so the axis and the
 * clock stay proportional at a constant speed — a phase twice as long on this
 * axis takes twice as long to fly.
 *
 * The `'pullout'` phase overlaps the `'recovery'` phase that follows it, and
 * that is geometry rather than an oversight: the pull is flown over the first
 * stretch of the climb-out, so both describe the same ground. The recovery leg
 * keeps its authored endpoints — the straight line from gate to gate that every
 * other surface reads — and the pullout band sits across its beginning.
 *
 * @typedef {object} DivePhase
 * @property {'approach'|'dive'|'pullout'|'recovery'} kind
 * @property {string} label
 * @property {number} startM             metres along the flown line, 0 at the first point
 * @property {number} endM
 * @property {number|null} startS        elapsed seconds; null when no speed is stated
 * @property {number|null} endS
 * @property {number} startMslM
 * @property {number} endMslM
 * @property {number|null} pitchDeg      null on the pullout: an arc has no one angle
 * @property {number|null} verticalSpeedMs signed; negative descending
 * @property {number|null} startClearanceM AGL; null where terrain never answered
 * @property {number|null} endClearanceM
 */

/**
 * What the run asks of the machine, once. Every field is a reading of a dive.js
 * function at the stated inputs, and every null has a phrase beside it in
 * `missing` naming what was never stated.
 *
 * @typedef {object} DiveSystems
 * @property {number|null} peakVerticalSpeedMs
 * @property {number|null} pulloutLoadG
 * @property {number|null} pulloutRadiusM
 * @property {number|null} pulloutSinkM
 * @property {number|null} pulloutClearanceM
 * @property {number|null} pulloutLowestMslM
 * @property {number|null} pulloutPowerW
 * @property {number|null} packSagV
 * @property {boolean|null} sagDeliverable
 * @property {number|null} motorMarginFrac
 * @property {number|null} escMarginFrac
 * @property {number|null} rthWh
 * @property {number|null} recoveryReserveFrac
 * @property {readonly string[]} missing
 */

/**
 * @typedef {object} DiveDynamics
 * @property {DivePhase[]} phases
 * @property {DiveSystems} systems
 * @property {number} totalM
 * @property {number|null} totalS
 * @property {boolean} groundComplete  false when terrain left a hole under any point
 * @property {number|null} speedMs     echoed, as authored
 */

/**
 * Everything one reading of a dive plan runs on. Only `dive` is required; every
 * other absence degrades a figure to null and names itself in `missing`, and
 * none of them is ever replaced by a house default.
 *
 * @typedef {object} DiveDynamicsSpec
 * @property {DivePlan|null} [dive]
 * @property {{ latitude: number, longitude: number }|null} [launch] the pad
 * @property {number|null} [launchMslM] the pad's elevation
 * @property {((lat: number, lng: number) => number|null)|null} [groundAt] MSL ground
 * @property {DroneConfig|null} [drone]    for the rotor count and the current limits
 * @property {BatteryConfig|null} [battery]
 * @property {number|null} [tempC]         pack temperature, for the sag model
 * @property {number|null} [soc]           state of charge at the pullout, 0–100
 * @property {number|null} [packWh]        usable pack energy the plan flies on
 * @property {number|null} [spentWh]       energy committed before the recovery
 * @property {number|null} [hoverPowerW]
 * @property {number|null} [massKg]
 * @property {number|null} [etaProp]
 * @property {number|null} [levelPowerW]   cruise power on the flight home
 * @property {number|null} [rthSpeedMs]    closing speed on the flight home
 */

/** @param {unknown} v @returns {number|null} */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The dive plan as phases and system figures, or null when there is no plan to
 * model. Fewer than two gates is not a line — one point has no leg, and a leg
 * is the smallest thing this module can say anything about.
 *
 * @param {DiveDynamicsSpec} spec
 * @returns {DiveDynamics|null}
 */
export function diveDynamics(spec) {
  const dive = spec?.dive ?? null;
  if (!dive || !Array.isArray(dive.gates) || dive.gates.length < 2) return null;

  /** @type {string[]} */
  const missing = [];
  /** @param {string} phrase */
  const note = (phrase) => { if (!missing.includes(phrase)) missing.push(phrase); };

  /* ---- the ground, read once per point ---- */

  const sampler = typeof spec.groundAt === 'function' ? spec.groundAt : null;
  if (!sampler) note('no terrain source for the ground under the dive line');
  let groundComplete = sampler != null;
  /** @type {Map<string, number|null>} */
  const groundMemo = new Map();
  /** @param {DivePoint} p @returns {number|null} */
  const groundOf = (p) => {
    const key = `${p.latitude},${p.longitude}`;
    const seen = groundMemo.get(key);
    if (seen !== undefined) return seen;
    const g = sampler ? num(sampler(p.latitude, p.longitude)) : null;
    if (g == null) groundComplete = false;
    groundMemo.set(key, g);
    return g;
  };
  /** @param {DivePoint} p @returns {number|null} */
  const clearanceAt = (p) => {
    const g = groundOf(p);
    return g == null ? null : p.altitudeMslM - g;
  };

  /* ---- the chain: the pad, then every flown gate ---- */

  /** The flown gates paired with the kind they were found under, so the phase
   * built from each one is named by the same word the search used. */
  /** @type {{ gate: DiveGate, kind: 'approach'|'dive'|'recovery' }[]} */
  const flown = [];
  for (const kind of FLOWN_KINDS) {
    const gate = dive.gates.find((g) => g.kind === kind);
    if (gate) flown.push({ gate, kind });
  }
  const gates = flown.map((f) => f.gate);

  const pad = spec.launch ?? null;
  const padMslM = num(spec.launchMslM);
  if (!pad) note('no launch point stated');
  else if (padMslM == null) note('no launch elevation stated');

  /** @type {{ point: DivePoint, kind: 'approach'|'dive'|'recovery'|null }[]} */
  const chain = [];
  if (pad && padMslM != null) {
    chain.push({
      point: { latitude: pad.latitude, longitude: pad.longitude, altitudeMslM: padMslM },
      kind: null,
    });
  }
  for (const f of flown) chain.push({ point: f.gate, kind: f.kind });

  /* ---- the legs ---- */

  const authoredSpeedMs = num(dive.speedMs);
  const speedMs = authoredSpeedMs != null && authoredSpeedMs > 0 ? authoredSpeedMs : null;
  if (speedMs == null) note('no dive speed stated');

  /** @type {DivePhase[]} */
  const legPhases = [];
  /** Where each gate sits on the axis and the clock, and the pitch of the leg into it. */
  /** @type {Map<string, { stationM: number, clockS: number|null, pitchDeg: number }>} */
  const arrival = new Map();
  let stationM = 0;
  /** @type {number|null} */
  let clockS = speedMs == null ? null : 0;

  for (let i = 1; i < chain.length; i++) {
    const from = chain[i - 1];
    const to = chain[i];
    const kind = /** @type {'approach'|'dive'|'recovery'} */ (to.kind);
    const leg = diveLeg(from.point, to.point);
    const endM = stationM + leg.pathM;
    const endS = clockS == null || speedMs == null ? null : clockS + leg.pathM / speedMs;
    legPhases.push(Object.freeze({
      kind,
      label: LEG_LABEL[kind],
      startM: stationM,
      endM,
      startS: clockS,
      endS,
      startMslM: from.point.altitudeMslM,
      endMslM: to.point.altitudeMslM,
      pitchDeg: leg.pitchDeg,
      verticalSpeedMs: speedMs == null ? null : diveVerticalSpeedMs(speedMs, leg.pitchDeg),
      startClearanceM: clearanceAt(from.point),
      endClearanceM: clearanceAt(to.point),
    }));
    stationM = endM;
    clockS = endS;
    arrival.set(kind, { stationM: endM, clockS: endS, pitchDeg: leg.pitchDeg });
  }

  /* ---- the pullout, at the dive gate ---- */

  const loadG = num(dive.pulloutLoadG);
  if (loadG == null) note('no pullout load stated');
  const diveGate = gates.find((g) => g.kind === 'dive') ?? null;
  const intoDive = arrival.get('dive') ?? null;
  const arc = intoDive && speedMs != null && loadG != null
    ? pulloutArc({ speedMs, pitchDeg: intoDive.pitchDeg, loadG })
    : null;
  if (!intoDive) note('no leg of the line arrives at a dive gate to pull out of');
  if (intoDive && speedMs != null && loadG != null && !arc) {
    note('a pullout load of 1 g or less leaves no arc to fly');
  }

  /** @type {DivePhase|null} */
  let pulloutPhase = null;
  /** @type {{ lowestMslM: number, clearanceM: number|null }|null} */
  let pulloutFloor = null;

  if (arc && intoDive && diveGate && speedMs != null) {
    const groundUnderGate = groundOf(diveGate);
    /* `pulloutClearance` derives the low point from the gate and the sink alone,
     * so the 0 standing in for an unsampled ground never reaches a reported
     * figure — `clearanceM` below is read only when the ground answered. */
    const floor = pulloutClearance({
      gateMslM: diveGate.altitudeMslM,
      groundMslM: groundUnderGate ?? 0,
      sinkM: arc.sinkM,
    });
    pulloutFloor = {
      lowestMslM: floor.lowestMslM,
      clearanceM: groundUnderGate == null ? null : floor.clearanceM,
    };
    /* The same clamp `pulloutArc` applies to the entry angle, so the length and
     * the sink describe one arc: the aircraft sweeps θ radians of a circle of
     * radius r, which is r·θ of path (and r·sin θ of ground). Path, because the
     * station axis is path everywhere else and a horizontal run laid on it would
     * quote the pull at a speed no other phase is flown at. */
    const thetaRad = Math.min(Math.max(-intoDive.pitchDeg, 0), 90) * Math.PI / 180;
    const arcM = arc.radiusM * thetaRad;
    pulloutPhase = Object.freeze({
      kind: /** @type {'pullout'} */ ('pullout'),
      label: 'Pullout',
      startM: intoDive.stationM,
      endM: intoDive.stationM + arcM,
      startS: intoDive.clockS,
      endS: intoDive.clockS == null ? null : intoDive.clockS + arcM / speedMs,
      startMslM: diveGate.altitudeMslM,
      endMslM: floor.lowestMslM,
      /* An arc has no one flight-path angle — it sweeps from the dive's pitch to
       * level — and quoting the entry figure would read as a sustained one. */
      pitchDeg: null,
      verticalSpeedMs: null,
      startClearanceM: clearanceAt(diveGate),
      endClearanceM: pulloutFloor.clearanceM,
    });
  }
  if (arc && diveGate && groundOf(diveGate) == null) note('no ground under the dive gate');

  /** @type {DivePhase[]} */
  const phases = [];
  for (const phase of legPhases) {
    phases.push(phase);
    if (pulloutPhase && phase.kind === 'dive') phases.push(pulloutPhase);
  }

  /* The run is as long as the furthest any phase reaches. Written as a maximum
   * rather than as the last leg's end because a pull that runs past the recovery
   * gate is a real state, and truncating the axis would hide it. */
  const totalM = phases.reduce((m, p) => Math.max(m, p.endM), 0);
  const totalS = speedMs == null
    ? null
    : phases.reduce((/** @type {number} */ s, p) => Math.max(s, p.endS ?? 0), 0);

  return Object.freeze({
    phases,
    systems: systemsOf({ spec, dive, gates, legPhases, arc, pulloutFloor, loadG, pad, note, missing }),
    totalM,
    totalS,
    groundComplete,
    speedMs: authoredSpeedMs,
  });
}

/**
 * What the pull and the flight home ask of the pack and the propulsion.
 *
 * Split out because it is a different kind of statement from the geometry above
 * — the phases describe the authored line, these describe the machine flying it
 * — and because a hundred lines of `null`-guarding inside the walk would bury
 * the walk.
 *
 * @param {object} ctx
 * @param {DiveDynamicsSpec} ctx.spec
 * @param {DivePlan} ctx.dive
 * @param {readonly DiveGate[]} ctx.gates
 * @param {readonly DivePhase[]} ctx.legPhases
 * @param {{ radiusM: number, sinkM: number }|null} ctx.arc
 * @param {{ lowestMslM: number, clearanceM: number|null }|null} ctx.pulloutFloor
 * @param {number|null} ctx.loadG
 * @param {{ latitude: number, longitude: number }|null} ctx.pad
 * @param {(phrase: string) => void} ctx.note
 * @param {string[]} ctx.missing
 * @returns {DiveSystems}
 */
function systemsOf(ctx) {
  const { spec, dive, gates, legPhases, arc, pulloutFloor, loadG, pad, note, missing } = ctx;

  /* The steepest descent the authored line commits to. Taken across the flown
   * legs rather than off the dive leg by name, so a plan whose approach is
   * steeper than its dive reports the figure the pilot actually meets. */
  let peakVerticalSpeedMs = /** @type {number|null} */ (null);
  for (const phase of legPhases) {
    const v = phase.verticalSpeedMs;
    if (v == null) continue;
    if (peakVerticalSpeedMs == null || v < peakVerticalSpeedMs) peakVerticalSpeedMs = v;
  }

  /* ---- what the pull draws ---- */

  const hoverPowerW = num(spec.hoverPowerW);
  if (hoverPowerW == null) note('no hover power stated');
  const drawW = hoverPowerW != null && loadG != null && loadG > 0
    ? pulloutPowerW(hoverPowerW, loadG)
    : null;

  const batt = spec.battery ?? null;
  if (!batt) note('no battery selected');
  const tempC = num(spec.tempC);
  if (tempC == null) note('no pack temperature stated');
  const soc = num(spec.soc);
  if (soc == null) note('no state of charge at the pullout stated');
  const sag = batt && tempC != null && soc != null && drawW != null && drawW > 0
    ? pulloutSag({ batt, tempC, powerW: drawW, soc })
    : null;

  const drone = spec.drone ?? null;
  if (!drone) note('no airframe stated');
  const motorMaxA = num(drone?.propulsion?.motorMaxA);
  const escMaxA = num(drone?.propulsion?.escMaxA);
  if (drone && motorMaxA == null) note('no motor current limit on file for this airframe');
  if (drone && escMaxA == null) note('no ESC current limit on file for this airframe');
  const margins = sag && drone
    ? electricalMargins({ currentA: sag.I, numRotors: drone.numRotors, motorMaxA, escMaxA })
    : { motorMarginFrac: null, escMarginFrac: null };

  /* ---- the flight home ---- */

  const massKg = num(spec.massKg);
  if (massKg == null) note('no all-up mass stated');
  const etaProp = num(spec.etaProp);
  if (etaProp == null) note('no drivetrain efficiency stated');
  const rthAltitudeMslM = num(dive.rthAltitudeMslM);
  if (rthAltitudeMslM == null) note('no lost-link altitude stated');
  const levelPowerW = num(spec.levelPowerW);
  if (levelPowerW == null) note('no cruise power for the flight home stated');
  const rthSpeedMsRaw = num(spec.rthSpeedMs);
  const rthSpeedMs = rthSpeedMsRaw != null && rthSpeedMsRaw > 0 ? rthSpeedMsRaw : null;
  if (rthSpeedMs == null) note('no closing speed for the flight home stated');

  /* The recovery gate when there is one, and otherwise the last gate the line
   * reaches — the flight home starts wherever the dive stops, and calling a
   * half-authored plan's last gate "not the recovery gate" would silently drop
   * the only return figure it can have. */
  const endGate = gates.length > 0 ? gates[gates.length - 1] : null;
  const homeM = pad && endGate
    ? distanceKm(
      { lat: endGate.latitude, lng: endGate.longitude },
      { lat: pad.latitude, lng: pad.longitude },
    ) * 1000
    : null;
  const climbM = rthAltitudeMslM != null && endGate
    ? rthAltitudeMslM - endGate.altitudeMslM
    : null;

  /** @type {number|null} */
  let rthWh = null;
  if (massKg != null && etaProp != null && climbM != null && homeM != null
    && (!(homeM > 0) || (levelPowerW != null && rthSpeedMs != null))) {
    rthWh = rthEnergyWh({
      massKg,
      etaProp,
      climbM,
      distanceM: homeM,
      // Both are read only when there is distance to cover, and the guard above
      // admits distance only when both were stated.
      levelPowerW: levelPowerW ?? 0,
      speedMs: rthSpeedMs ?? 0,
    });
  }

  const packWh = num(spec.packWh);
  if (packWh == null) note('no usable pack energy stated');
  const spentWh = num(spec.spentWh);
  if (spentWh == null) note('no planned mission energy stated');
  const reserveFrac = packWh != null && spentWh != null && rthWh != null
    ? recoveryReserveFrac({ packWh, spentWh, rthWh })
    : null;

  return Object.freeze({
    peakVerticalSpeedMs,
    pulloutLoadG: loadG,
    pulloutRadiusM: arc ? arc.radiusM : null,
    pulloutSinkM: arc ? arc.sinkM : null,
    pulloutClearanceM: pulloutFloor ? pulloutFloor.clearanceM : null,
    pulloutLowestMslM: pulloutFloor ? pulloutFloor.lowestMslM : null,
    pulloutPowerW: drawW,
    // An undeliverable draw has no terminal voltage — `dischargeSim` answers NaN
    // and this reports the absence, never the NaN.
    packSagV: sag && Number.isFinite(sag.vLoad) ? sag.vLoad : null,
    sagDeliverable: sag ? sag.deliverable : null,
    motorMarginFrac: margins.motorMarginFrac,
    escMarginFrac: margins.escMarginFrac,
    rthWh,
    recoveryReserveFrac: reserveFrac,
    missing: Object.freeze(missing.slice()),
  });
}
