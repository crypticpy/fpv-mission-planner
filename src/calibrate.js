// calibrate.js — turn "flew 7:20 on the GEPRC 720, charger put 580 mAh back"
// into the two numbers nobody can type: etaProp and cdA (§6.2). Pure functions
// over physics.js's own model — no DOM, no storage, and nothing here ever
// writes to a drone record: §6.2's first trust rule is that a fit is shown,
// never silently applied.
//
// Every solve is the same three steps:
//   1. landed state of charge  ← mAh back in (preferred) or the OSD's guess
//   2. average electrical power ← bisect dischargeToSoc against that SoC
//   3. the airframe number      ← invert powerAtSpeed at the airspeed flown
//
// Step 3 is closed form for a hover test, because etaProp appears exactly once
// in powerAtSpeed and as a pure divisor; a cruise leg needs a bisection,
// because cdA sits inside the drag term that feeds the thrust that feeds the
// induced-velocity fixed point. Two flights, two unknowns, in that order:
// hover pins efficiency with drag out of the picture, cruise then pins drag.
//
// powerAtSpeed's speed-dependent profile-power term does not disturb either
// solve, by design: both the µ² excess and the disc tilt are identically zero at
// v = 0, so the hover closure below is the same one division it always was, and
// what it recovers is the same etaProp it always recovered. A cruise solve does
// see the new terms — that is the point of them — and still bisects, because
// power is still strictly increasing in cdA at a fixed airspeed.

import {
  airDensity, discAreaM2, powerAtSpeed, dischargeSim, dischargeToSoc,
} from './domain/physics.js';

// Bisection budget. 80 halvings shrink any bracket this code builds to well
// below floating-point relevance — and far below the 0.5%-of-charge grid the
// discharge walk integrates on, which is the real accuracy limit.
const BISECT_STEPS = 80;
const P_LO_W = 1e-3;      // a draw small enough to count as "not flying"
const CDA_HI_START = 0.01; // m², doubled outward until it brackets the answer

/* ---------------- landed state of charge ---------------- */

/**
 * SoC fraction left when the charger put `mahIn` back into the pack — §6.2's
 * preferred input, because a charger measures what the OSD estimates. Clamped
 * to 0–1: more mAh in than the pack's rating means the rating is wrong (or the
 * pack is tired), not that the flight ended below empty.
 *
 * Deliberately measured against the pack's nameplate capacity, not the
 * temperature-derated one: the charger refilled a cold pack that never held
 * its rating to begin with, so on a freezing day this reads a little low. That
 * bias is smaller than the OSD's.
 */
export function landedSocFromMahIn({ battery, mahIn }) {
  const capMah = (battery?.capAh || 0) * 1000;
  if (!(capMah > 0) || !Number.isFinite(mahIn)) return null;
  return Math.min(1, Math.max(0, 1 - mahIn / capMah));
}

// `mahIn` wins over `landedSocPct` when both are supplied — see above.
function resolveLandedSoc({ battery, landedSocPct, mahIn }) {
  if (Number.isFinite(mahIn)) return landedSocFromMahIn({ battery, mahIn });
  if (Number.isFinite(landedSocPct)) return Math.min(1, Math.max(0, landedSocPct / 100));
  return null;
}

/* ---------------- average power from a flight ---------------- */

// Whole-pack endurance (minutes) at a constant draw. Monotone decreasing in
// power, which is what makes the bracket below findable.
function enduranceMin(battery, tempC, pW) {
  return dischargeSim(battery, tempC, pW).deliveredWh / pW * 60;
}

/**
 * Average electrical power (W) for a flight described as "flew `minutes`,
 * landed at `landedSocPct`" (or `mahIn`).
 *
 * The bracket needs care, because dischargeToSoc is only monotone decreasing
 * in power while the pack can still hold the flight up. Past that point higher
 * power cuts the flight short and the reported terminal SoC climbs again, so a
 * naive bracket can straddle both branches and converge on nonsense. Hence:
 *
 *   lower bound  P_LO_W — a milliwatt, effectively a pack still full
 *   upper bound  pMax   — the draw whose whole-pack endurance is exactly
 *                         `minutes`, found by its own bisection on
 *                         enduranceMin (monotone, so this one is safe)
 *
 * On [P_LO_W, pMax] the SoC curve is smooth and strictly decreasing, and 80
 * halvings resolve it to far finer than the model's own 0.5% charge grid.
 *
 * Returns null rather than a number whenever the description cannot be
 * reproduced: a landed SoC lower than the pack can reach in that time, a
 * flight longer than the pack can fly at any power, a missing input. A
 * fabricated watt figure here would poison the airframe silently, which is
 * exactly what §6.2 says not to allow.
 */
export function avgPowerFromFlight({ battery, tempC, minutes, landedSocPct, mahIn }) {
  const target = resolveLandedSoc({ battery, landedSocPct, mahIn });
  if (!battery || target === null || !(minutes > 0) || !Number.isFinite(tempC)) return null;
  // No power at all flies this long → the flight time or the capacity is wrong.
  if (enduranceMin(battery, tempC, P_LO_W) < minutes) return null;

  let hi = 1;
  for (let i = 0; i < 60 && enduranceMin(battery, tempC, hi) > minutes; i++) hi *= 2;
  if (enduranceMin(battery, tempC, hi) > minutes) return null;
  let lo = P_LO_W;
  for (let i = 0; i < BISECT_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (enduranceMin(battery, tempC, mid) > minutes) lo = mid; else hi = mid;
  }
  const pMax = lo;

  // The least charge the pack can possibly have left after this long in the
  // air. Anything lower is a landed % the flight cannot explain.
  if (dischargeToSoc(battery, tempC, pMax, minutes) > target) return null;

  let a = P_LO_W;
  let b = pMax;
  for (let i = 0; i < BISECT_STEPS; i++) {
    const mid = (a + b) / 2;
    if (dischargeToSoc(battery, tempC, mid, minutes) > target) a = mid; else b = mid;
  }
  return (a + b) / 2;
}

/* ---------------- the two solves ---------------- */

function massKgOf(drone, battery, payloadG, extraG) {
  return (drone.dryMassG + battery.massG + (payloadG || 0) + (extraG || 0)) / 1000;
}

/**
 * Hover test → etaProp. At v = 0 the drag term vanishes, so cdA drops out
 * entirely (which is the whole point of flying the hover test first) and
 * powerAtSpeed collapses to a closed form:
 *
 *   T   = m·g                        (hypot(W, 0), no drag)
 *   v_i = √(T / (2·ρ·A))             (the fixed point closes at v = 0)
 *   P   = T·v_i / η + avionicsW
 *   →   η = m·g·√(m·g / (2·ρ·A)) / (P − avionicsW)
 *
 * One division, no search. The numerator is read out of powerAtSpeed itself
 * with η = 1 and avionicsW = 0 — which returns exactly that ideal power —
 * rather than re-typing the algebra, so this solve cannot drift away from the
 * model it inverts.
 *
 * Returns `{ etaProp, pAvgW, pIdealW }`, with etaProp null when the flight
 * cannot be inverted (see avgPowerFromFlight) or when the average draw does
 * not even cover the avionics, which means the flight time or the pack
 * capacity is wrong. Feed the result to clampToClass before showing it.
 */
export function solveEtaProp({
  drone, battery, payloadG = 0, extraG = 0, env, minutes, landedSocPct, mahIn,
}) {
  const pAvgW = avgPowerFromFlight({ battery, tempC: env.tempC, minutes, landedSocPct, mahIn });
  if (pAvgW === null) return { etaProp: null, pAvgW: null, pIdealW: null };
  const { rho } = airDensity(env.elevM, env.tempC, env.rhPct);
  const cfg = {
    massKg: massKgOf(drone, battery, payloadG, extraG),
    rho,
    areaM2: discAreaM2(drone),
    cdA: 0,
    etaProp: 1,
    avionicsW: 0,
  };
  const pIdealW = powerAtSpeed(cfg, 0);
  const rotorW = pAvgW - drone.avionicsW;
  return { etaProp: rotorW > 0 ? pIdealW / rotorW : null, pAvgW, pIdealW };
}

/**
 * Cruise leg → effective cdA, with etaProp already pinned (from a hover test,
 * or held at the class default and labeled as such — §6.2). powerAtSpeed is
 * strictly increasing in cdA at a fixed airspeed but has no closed inverse, so
 * this bisects: bracket [0, CDA_HI_START] doubled outward until it contains
 * the answer, then 80 halvings.
 *
 * Airspeed is what the model wants. Pass `airspeedMs` if you have it;
 * otherwise pass the leg's ground speed as `speedMs` with the along-track
 * `headwindMs` (signed — negative for a tailwind) and `crosswindMs`. That
 * conversion is exact rather than approximate: planMission's groundSpeedVec
 * solves vg = √(v² − c²) − h, so v = hypot(vg + h, c).
 *
 * What comes back is the airframe's own drag area: the solve sees the whole
 * configuration's drag, so anything the plan adds on top (a payload's cdA, a
 * second pack's frontal area) is subtracted via `otherCdA`. `cdATotalM2`
 * carries the unsubtracted figure.
 *
 * Returns cdA null when the flight cannot be inverted, when no airspeed can be
 * worked out, or when even a drag-free airframe would have burned more than
 * the flight did — that last case means the mass, the pinned etaProp, or the
 * pack capacity is wrong, and there is no non-negative drag area to blame.
 */
export function solveCdA({
  drone, battery, payloadG = 0, extraG = 0, env, minutes, landedSocPct, mahIn,
  airspeedMs, speedMs, headwindMs = 0, crosswindMs = 0, otherCdA = 0,
}) {
  const vAir = Number.isFinite(airspeedMs)
    ? airspeedMs
    : Math.hypot((speedMs || 0) + headwindMs, crosswindMs);
  const pAvgW = avgPowerFromFlight({ battery, tempC: env.tempC, minutes, landedSocPct, mahIn });
  if (pAvgW === null || !(vAir > 0)) {
    return { cdA: null, cdATotalM2: null, pAvgW, airspeedMs: vAir };
  }
  const { rho } = airDensity(env.elevM, env.tempC, env.rhPct);
  const base = {
    massKg: massKgOf(drone, battery, payloadG, extraG),
    rho,
    areaM2: discAreaM2(drone),
    etaProp: drone.etaProp,
    avionicsW: drone.avionicsW,
  };
  const pAt = (cdA) => powerAtSpeed({ ...base, cdA }, vAir);
  const fail = { cdA: null, cdATotalM2: null, pAvgW, airspeedMs: vAir };
  if (pAt(0) >= pAvgW) return fail;

  let lo = 0;
  let hi = CDA_HI_START;
  for (let i = 0; i < 40 && pAt(hi) < pAvgW; i++) { lo = hi; hi *= 2; }
  if (pAt(hi) < pAvgW) return fail;
  for (let i = 0; i < BISECT_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (pAt(mid) < pAvgW) lo = mid; else hi = mid;
  }
  const total = (lo + hi) / 2;
  return { cdA: total - otherCdA, cdATotalM2: total, pAvgW, airspeedMs: vAir };
}

/* ---------------- trust gates ---------------- */

const SOLVED_FIELDS = ['etaProp', 'cdA'];

function refusalReason(field, value, lo, hi, cls) {
  const high = value > hi;
  const edge = high ? hi : lo;
  const side = high ? 'above' : 'below';
  const bound = high ? 'ceiling' : 'floor';
  if (field === 'etaProp') {
    return `this implies η = ${value.toFixed(2)}, ${side} the ${edge.toFixed(2)} ${bound} for a ${cls.label} — `
      + (high
        ? 'check the pack’s real capacity and the landed %; a tired pack or an optimistic mAh figure reads as a suspiciously efficient airframe.'
        : 'check the flight time and the dry weight; a flight cut short, or a weight typed without the battery subtracted, reads as a hopeless airframe.');
  }
  if (field === 'cdA') {
    return `this implies a ${value.toFixed(3)} m² drag area, ${side} the ${edge.toFixed(3)} m² ${bound} for a ${cls.label} — `
      + 'check the cruise speed and the wind you flew in; a ground speed mistaken for an airspeed lands here first.';
  }
  return `${field} = ${value} is outside the ${lo}–${hi} range expected of a ${cls.label}.`;
}

/**
 * Judge a solved value against its class's sanity range (§6.2: "clamp to class
 * ranges and refuse absurd solutions with a physical reason"). Nothing is
 * actually clamped to the edge — a value silently pulled to 0.70 is a lie with
 * a plausible face, and a worn pack or a wrong mass would poison the airframe
 * without ever raising its voice. In range passes through untouched; out of
 * range comes back refused, with a sentence naming what to go re-check.
 *
 * `solution` is either an explicit `{ field, value }` or a solver result — the
 * single solved key of `{ etaProp, … }` / `{ cdA, … }` is found for you.
 * Returns `{ ok: true, field, value }` or `{ ok: false, field, value, reason }`.
 */
export function clampToClass(solution, classTemplate) {
  const src = solution && typeof solution === 'object' ? solution : {};
  const field = src.field ?? SOLVED_FIELDS.find(k => k in src);
  const value = src.field ? src.value : src[field];
  const range = field ? classTemplate?.ranges?.[field] : null;
  if (!range) {
    return {
      ok: false, field: field ?? null, value: value ?? null,
      reason: 'this class carries no sanity range for that field, so the fit cannot be checked — pick the class the airframe actually belongs to.',
    };
  }
  if (!Number.isFinite(value)) {
    return {
      ok: false, field, value: null,
      reason: 'these numbers do not describe a flight the model can invert — check the flight time, the pack’s real capacity, and the landed %.',
    };
  }
  const [lo, hi] = range;
  if (value < lo || value > hi) {
    return { ok: false, field, value, reason: refusalReason(field, value, lo, hi, classTemplate) };
  }
  return { ok: true, field, value };
}

/**
 * How much weight a fit has earned, per §6.2's gating:
 *   'none'    — no flights logged
 *   'show'    — 1–2 flights: display the number, do not use it
 *   'offer'   — 3+ flights: offer it behind a toggle, off by default
 *   'default' — 5+ flights across two distinct speeds: on by default, with
 *               the band shown
 * Five flights all flown at one speed stay at 'offer': without a speed spread
 * the fit cannot separate drag from efficiency, so the right next move is to
 * go fly a different speed, not to trust the number harder.
 */
export function confidence(nFlights, speedSpreadOk = false) {
  const n = Number.isFinite(nFlights) ? Math.floor(nFlights) : 0;
  if (n <= 0) return 'none';
  if (n >= 5 && speedSpreadOk) return 'default';
  if (n >= 3) return 'offer';
  return 'show';
}
