// physics.js — atmosphere, rotor power, battery, and mission models.
// Units are SI internally (kg, m, s, W, Wh); UI layers convert for display.

export const G = 9.80665;

/* ---------------- Atmosphere ---------------- */

// Barometric pressure (ISA troposphere) + Magnus vapor pressure → humid-air density.
export function airDensity(elevM, tempC, rhPct) {
  const T = tempC + 273.15;
  const p = 101325 * Math.pow(1 - 2.25577e-5 * elevM, 5.25588);
  const es = 610.94 * Math.exp((17.625 * tempC) / (tempC + 243.04));
  const e = Math.min(Math.max(rhPct, 0), 100) / 100 * es;
  const rho = (p - e) / (287.058 * T) + e / (461.495 * T);
  const densityAltM = 44330 * (1 - Math.pow(rho / 1.225, 0.234969));
  return { rho, pressPa: p, densityAltM };
}

/* ---------------- Rotor / airframe power ---------------- */

export function discAreaM2(drone) {
  const r = (drone.propDiaIn * 0.0254) / 2;
  return drone.numRotors * Math.PI * r * r;
}

/**
 * Blade-profile power growth with speed, as the lumped constant of
 * `P0·(1 + k·µ²)` — the classical rotor profile-power law, with µ the advance
 * ratio (edgewise flow over blade tip speed) and k ≈ 4.65.
 *
 * Why one number and not two new fields: the constant term `P0` is already in
 * the model. `etaProp` has always folded hover profile drag in with figure of
 * merit and the motor/ESC chain, and because it divides the whole ideal power it
 * carries `P0` as a *fraction* of induced power — which is how blade drag
 * actually scales with thrust. So the only thing missing was the µ² excess:
 *
 *   ΔP_profile = P0·k·µ²  with  P0 = f·T·v_h  and  µ = v·cosθ / v_tip
 *
 * Blade-element theory closes both unknowns without any per-airframe data. For a
 * rotor of solidity σ, profile drag coefficient Cd0 and mean blade lift
 * coefficient C̄l:
 *
 *   v_tip / v_h = √(12 / (σ·C̄l)) ≡ C     (independent of size, thrust and ρ)
 *   f = P0 / (T·v_h) = σ·Cd0·C³ / 16
 *   ⇒  ΔP_profile = (f·k/C²) · T · (v·cosθ)² / v_h
 *
 * `PROFILE_MU2` is that single lumped `f·k/C²`. With σ = 0.18 (a three-blade FPV
 * prop), Cd0 = 0.04 (blade Reynolds number ~5×10⁴ — far draggier than a
 * helicopter blade), C̄l = 0.55 and k = 4.65: C ≈ 11.0, f ≈ 0.60, and
 * f·k/C² ≈ 0.023. Every term is a rotor-design constant, none of them scales
 * with diameter or disc loading, which is why this is a model constant rather
 * than a class template field — nobody can type it and nothing in the catalog
 * would distinguish it.
 *
 * The f ≈ 0.60 that falls out is a useful cross-check on the whole
 * decomposition: it implies a hover figure of merit of 1/(1+f) ≈ 0.62 and hence
 * a drive-chain efficiency of etaProp·(1+f) — 0.88 for the MOZ7, 0.59 for the
 * ducted Cinelog30. Both land where a motor/ESC chain plus (for the Cinelog)
 * duct losses should.
 */
export const PROFILE_MU2 = 0.023;

/**
 * Induced velocity in forward flight (momentum theory, fixed-point iteration),
 * with the disc tilt the thrust vector needs to overcome drag.
 *
 * The freestream meets a disc tilted forward by θ = atan(D/W) as two
 * components: `vEdgeMs` in the plane of the disc (v·cosθ) and `vPerpMs` through
 * it (v·sinθ), the latter adding to the induced flow the same way a climb rate
 * would. So the inflow the momentum balance sees is hypot(v·cosθ, v·sinθ + vi)
 * rather than hypot(v, vi) — larger, so less induced velocity is needed, so
 * induced power in fast forward flight is lower than the untilted form claims.
 * The untilted form is exactly the θ = 0 case of this one, and at v = 0 both
 * reduce to vi = v_h with the fixed point closing on the first pass (hypot(0, x)
 * is |x| exactly, so hover stays bit-identical — calibrate.js's closed-form
 * hover solve depends on it).
 *
 * Returns `{ vi, vHover }`; `vHover` (√(T/2ρA)) is the profile term's velocity
 * scale, handed back rather than recomputed.
 */
function inducedVelocity(thrustN, rho, areaM2, vEdgeMs, vPerpMs) {
  const vh2 = thrustN / (2 * rho * areaM2);
  const vHover = Math.sqrt(vh2);
  let vi = vHover;
  for (let i = 0; i < 30; i++) {
    vi = vh2 / Math.hypot(vEdgeMs, vPerpMs + vi);
  }
  return { vi, vHover };
}

/**
 * Electrical power (W) to fly at airspeed vMs. cdA in m².
 *
 * etaProp is overall electrical→ideal efficiency (folds figure of merit,
 * motor/ESC losses, and blade profile drag at hover); calibrated per airframe
 * against real-world flight logs, and unchanged in meaning by the profile term
 * above — at vMs = 0 this function is bit-identical to the flat-η form it
 * replaces, because the tilt is zero and the µ² excess is zero.
 *
 * Three ideal-power terms, then one efficiency divisor and the avionics draw:
 *   induced  T·vi          the momentum-theory cost of holding the tilted thrust
 *   parasite D·v           which is also T·v·sinθ — the propulsive half
 *   profile  PROFILE_MU2 · T·(v·cosθ)²/v_h    blade drag's growth with speed
 */
export function powerAtSpeed({ massKg, rho, areaM2, cdA, etaProp, avionicsW }, vMs) {
  const W = massKg * G;
  const D = 0.5 * rho * cdA * vMs * vMs;
  const T = Math.hypot(W, D);
  // Disc tilt: cosθ = W/T, sinθ = D/T. Every record the schema accepts has mass,
  // so T > 0.
  const vEdge = vMs * (W / T);
  const { vi, vHover } = inducedVelocity(T, rho, areaM2, vEdge, vMs * (D / T));
  const pProfile = PROFILE_MU2 * T * vEdge * vEdge / vHover;
  const pIdeal = T * vi + D * vMs + pProfile;
  return pIdeal / etaProp + avionicsW;
}

export function powerCurve(cfg, vMaxMs, step = 0.25) {
  const pts = [];
  for (let v = 0; v <= vMaxMs + 1e-9; v += step) {
    pts.push({ v, p: powerAtSpeed(cfg, v) });
  }
  return pts;
}

// Create the electrically equivalent pack for identical batteries connected in
// parallel. Voltage/series count stay unchanged; capacity and current capability
// add, while identical pack resistances divide by the pack count.
export function parallelBattery(batt, count = 2, {
  harnessMassG = 0,
  extraCdA = 0,
} = {}) {
  const n = Math.max(1, Math.round(count));
  if (n === 1) return { ...batt, packCount: 1, extraCdA: 0 };
  return {
    ...batt,
    id: `${batt.id}--${n}x-parallel`,
    name: `${n}× ${batt.name}`,
    short: `${n}× ${batt.short || batt.name}`,
    p: (batt.p || 1) * n,
    config: `${batt.s}S${(batt.p || 1) * n}P`,
    capAh: batt.capAh * n,
    massG: batt.massG * n + harnessMassG,
    irPackMilliOhm: batt.irPackMilliOhm / n,
    maxContA: batt.maxContA ? batt.maxContA * n : null,
    priceUsd: batt.priceUsd ? batt.priceUsd * n : null,
    packCount: n,
    harnessMassG,
    extraCdA,
    baseBatteryId: batt.id,
  };
}

// What a pasted bench table says the rig can pull, in newtons — total, from the
// per-motor peak the pilot pasted (thrust.js parses it; §6.1 calls it the escape
// hatch for the model's shakiest inversion).
//
// Deliberately not capped by the continuous electrical ceiling: a published
// thrust table is a bench figure at a fixed voltage, and clamping it to our
// current chain would re-import the guess it exists to replace. It is the
// pilot's own number, and it wins.
function benchThrustN(drone) {
  const perRotor = drone.maxThrustGPerRotor;
  if (!(perRotor > 0)) return null;
  return (perRotor * drone.numRotors / 1000) * G;
}

// A thrust figure → the go/no-go verdict, whatever the figure came from. 1.3:1
// is the margin below which there is nothing left to steer with, and 2:1 is the
// line under which a gust is a problem.
function thrustVerdict(maxThrustN, massKg) {
  const maxThrustG = maxThrustN / G * 1000;
  const auwG = massKg * 1000;
  const thrustToWeight = auwG > 0 ? maxThrustG / auwG : 0;
  let code = 'viable';
  if (thrustToWeight <= 1) code = 'no_lift';
  else if (thrustToWeight < 1.3) code = 'no_control_margin';
  else if (thrustToWeight < 2) code = 'marginal';
  return {
    code,
    viable: code !== 'no_lift',
    maxThrustN,
    maxThrustG,
    maxHoverMassG: maxThrustG,
    payloadMarginG: maxThrustG - auwG,
    thrustToWeight,
  };
}

// Continuous static lift ceiling from the lowest electrical limit in the
// battery → ESC → motor chain. No exact motor/prop thrust curves are published
// for these aircraft, so ideal hover momentum theory is inverted through the
// same calibrated etaProp used by the mission model. The result is deliberately
// exposed as an estimate with its limiting component — unless the pilot pasted a
// bench table, which replaces the inversion with a measurement.
//
// Two temperatures reach this function and they are not the same one: `rho` was
// computed from the air, while `tempC` is the *pack's* temperature and is only
// read by the chemistry's internal-resistance factor below (Phase 4 item 3).
export function liftEnvelope({ drone, battery, rho, areaM2, tempC, massKg }) {
  const prop = drone.propulsion;
  const bench = benchThrustN(drone);
  if (!prop) {
    // A pilot-authored rig has no motor or ESC limits on record, so there is no
    // electrical ceiling to invert — but a pasted table still answers the
    // question outright, which is exactly the audience it is for.
    if (bench !== null) {
      return {
        ...thrustVerdict(bench, massKg),
        estimated: false,
        confidence: 'measured',
        maxElectricalW: Infinity,
        limitingComponent: 'thrust table',
      };
    }
    return {
      code: 'unknown', viable: true, estimated: true, thrustToWeight: Infinity,
      maxThrustN: Infinity, maxThrustG: Infinity, maxHoverMassG: Infinity,
      payloadMarginG: Infinity, maxElectricalW: Infinity,
      limitingComponent: 'unknown', confidence: 'unknown',
    };
  }

  const chem = CHEMISTRY[battery.chem];
  const rOhm = (battery.irPackMilliOhm / 1000) * interp(chem.irTemp, tempC);
  const vOcv = chem.vNom * battery.s;
  const cutoffV = chem.cutoffLoad * battery.s;
  const sagCurrentA = rOhm > 0 ? Math.max(0, (vOcv - cutoffV) / rOhm) : Infinity;
  const batteryA = battery.maxContA || sagCurrentA;
  const motorA = prop.motorMaxA * drone.numRotors;
  const escA = prop.escMaxA * drone.numRotors;
  const maxCurrentA = Math.max(0, Math.min(batteryA, motorA, escA, sagCurrentA));
  const vLoad = Math.max(cutoffV, vOcv - maxCurrentA * rOhm);
  const currentLimitedW = maxCurrentA * vLoad;
  const motorLimitedW = prop.motorMaxW * drone.numRotors;
  const maxElectricalW = Math.max(0, Math.min(currentLimitedW, motorLimitedW));
  const rotorElectricalW = Math.max(0, maxElectricalW - drone.avionicsW);

  const idealW = rotorElectricalW * drone.etaProp;
  const modelThrustN = idealW > 0
    ? Math.pow(idealW * Math.sqrt(2 * rho * areaM2), 2 / 3)
    : 0;

  let limitingComponent = 'motor';
  if (currentLimitedW <= motorLimitedW) {
    if (sagCurrentA <= batteryA && sagCurrentA <= motorA && sagCurrentA <= escA) limitingComponent = 'pack sag';
    else if (batteryA <= motorA && batteryA <= escA) limitingComponent = 'battery';
    else if (escA <= motorA) limitingComponent = 'ESC';
  }

  // The electrical ceiling still governs how fast this thing can go — that is a
  // power question, and maxElectricalW is left alone. Only the lift figure is
  // replaced.
  return {
    ...thrustVerdict(bench ?? modelThrustN, massKg),
    estimated: bench === null,
    confidence: bench !== null ? 'measured' : (prop.confidence || 'estimated'),
    maxCurrentA,
    vLoad,
    maxElectricalW,
    limitingComponent: bench !== null ? 'thrust table' : limitingComponent,
    sourceLabel: prop.sourceLabel,
    sourceUrl: prop.sourceUrl,
  };
}

/* ---------------- Battery chemistry ---------------- */

/**
 * OCV per cell vs state-of-charge (%), capacity & internal-resistance factors vs
 * temperature — the *pack's* temperature, not the air's, which is why
 * planMission takes the two apart (Phase 4 item 3).
 *
 * What the cold rows are, and what they are not. Both temperature tables come
 * off low-rate bench discharges of a cell held at the stated temperature for the
 * whole sweep. A pack bolted to an airframe does neither: it gets pulled hard in
 * bursts, and it heats itself while it works — the I²R the cold `irTemp` factor
 * describes is a loss that lands inside the cells. So the tables err in two
 * opposite directions, and it matters which is which:
 *
 *   the first pull is worse than this says. A cold pack meets the climb-out at
 *     its full cold resistance, and that sag is deeper than any steady-state
 *     curve at the same temperature predicts.
 *   the rest of the flight is better than this says. Minutes in, the pack has
 *     warmed itself and is really living on a milder row of the table than the
 *     one we hold it at, so the whole-flight penalty here reads pessimistic.
 *
 * Fixing that properly needs a thermal mass and a heat-transfer coefficient per
 * pack — numbers nobody can type. So the tables stay as they are, the pack/air
 * split lets a pilot say the pack started warm, and the cold warning and the
 * README both say out loud which way each error runs.
 */
export const CHEMISTRY = {
  liion: {
    label: 'Li-Ion',
    vFull: 4.2, vNom: 3.6, cutoffLoad: 2.8,
    ocv: [[0, 3.00], [5, 3.25], [10, 3.40], [20, 3.55], [30, 3.62], [40, 3.68],
          [50, 3.73], [60, 3.80], [70, 3.87], [80, 3.95], [90, 4.05], [100, 4.20]],
    // capacity & IR vs temp: Lumenier INR21700-50SE factory test report
    capTemp: [[-20, 0.87], [-10, 0.89], [0, 0.92], [10, 0.97], [20, 1], [50, 1]],
    irTemp: [[-20, 3.9], [-10, 2.8], [0, 2.0], [10, 1.4], [25, 1], [50, 0.9]],
  },
  lihv: {
    label: 'LiHV',
    vFull: 4.35, vNom: 3.85, cutoffLoad: 3.30,
    ocv: [[0, 3.30], [5, 3.50], [10, 3.60], [20, 3.70], [30, 3.77], [40, 3.82],
          [50, 3.88], [60, 3.95], [70, 4.02], [80, 4.10], [90, 4.20], [100, 4.35]],
    capTemp: [[-10, 0.65], [0, 0.80], [10, 0.92], [20, 1], [50, 1]],
    irTemp: [[-10, 3.0], [0, 2.0], [10, 1.4], [25, 1], [50, 0.9]],
  },
  lipo: {
    label: 'LiPo',
    vFull: 4.2, vNom: 3.7, cutoffLoad: 3.30,
    ocv: [[0, 3.30], [5, 3.48], [10, 3.58], [20, 3.68], [30, 3.74], [40, 3.79],
          [50, 3.84], [60, 3.90], [70, 3.97], [80, 4.03], [90, 4.11], [100, 4.20]],
    capTemp: [[-10, 0.65], [0, 0.80], [10, 0.92], [20, 1], [50, 1]],
    irTemp: [[-10, 3.0], [0, 2.0], [10, 1.4], [25, 1], [50, 0.9]],
  },
};

/**
 * Is the pack cold enough to say something about? Li-Ion holds together down to
 * freezing where LiPo/LiHV are already giving up capacity and punch by 5 °C —
 * the two thresholds the mission warnings and the verdict card have always used,
 * in one place now that both of them read the pack's temperature instead of the
 * air's.
 */
export function isColdPack(chem, packTempC) {
  return packTempC <= (chem === 'liion' ? 0 : 5);
}

export function interp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return last[1];
}

// Solve pack current for a constant-power draw against OCV and internal resistance.
// P = I * (Vocv - I*R)  →  I = (Vocv - sqrt(Vocv² - 4RP)) / (2R)
function currentForPower(pW, vOcv, rOhm) {
  const disc = vOcv * vOcv - 4 * rOhm * pW;
  if (disc <= 0) return null; // pack cannot deliver this power
  return (vOcv - Math.sqrt(disc)) / (2 * rOhm);
}

// The one discharge integration: walk state of charge down in 0.5% steps at
// constant electrical power, stopping at the load cutoff (sag-limited) or at
// empty. `onStep(stepWh, socAfter, socBefore)` sees every accepted step and may
// return true to stop the walk early. dischargeSim and dischargeToSoc are two
// readings of this same walk — energy out, and where the charge sits after a
// given number of minutes.
function walkDischarge(batt, tempC, pW, onStep) {
  const chem = CHEMISTRY[batt.chem];
  const capF = interp(chem.capTemp, tempC);
  const rOhm = (batt.irPackMilliOhm / 1000) * interp(chem.irTemp, tempC);
  const effAh = batt.capAh * capF;
  const cutoffV = chem.cutoffLoad * batt.s;
  let wh = 0;
  let sagLimited = false;
  const socStep = 0.5;
  let stopSoc = 0;
  for (let soc = 100; soc > 0; soc -= socStep) {
    const vOcv = interp(chem.ocv, soc - socStep / 2) * batt.s;
    const I = currentForPower(pW, vOcv, rOhm);
    if (I === null || vOcv - I * rOhm < cutoffV) { sagLimited = soc > 3; stopSoc = soc; break; }
    const stepWh = (effAh * socStep / 100) * (vOcv - I * rOhm);
    wh += stepWh;
    stopSoc = soc - socStep;
    if (onStep && onStep(stepWh, stopSoc, soc)) break;
  }
  return { chem, capF, rOhm, deliveredWh: wh, sagLimited, stopSoc };
}

// Discharge the pack at constant electrical power. Returns delivered energy (Wh),
// whether the cutoff was sag-limited, and a soc→(vLoad, I) sampler for timelines.
export function dischargeSim(batt, tempC, pW) {
  const { chem, capF, rOhm, deliveredWh, sagLimited, stopSoc } = walkDischarge(batt, tempC, pW);
  return {
    deliveredWh,
    sagLimited,
    stopSoc,
    capF,
    rOhm,
    stateAt(soc) {
      const vOcv = interp(chem.ocv, soc) * batt.s;
      const I = currentForPower(pW, vOcv, rOhm);
      return { vOcv, I: I ?? NaN, vLoad: I === null ? NaN : vOcv - I * rOhm };
    },
  };
}

/**
 * State of charge left (fraction, 0–1) after flying `minutes` at constant
 * electrical power `pW`. The inverse reading of dischargeSim's walk, and the
 * bridge between how a pilot describes a flight ("7:20, landed at 22%") and the
 * average watts calibrate.js needs. Each 0.5% step of charge is worth
 * `stepWh / pW` hours; the step the clock runs out inside is interpolated
 * linearly, so the result is continuous in both `minutes` and `pW`.
 *
 * If the pack reaches its load cutoff before `minutes` are up, the flight did
 * not happen as described — the walk's terminal SoC comes back instead (0 when
 * the energy simply ran out, the sag-limited SoC when voltage bound first,
 * i.e. exactly dischargeSim's `stopSoc`). Note that this makes the function
 * non-monotone in power past that point: a solver must bracket below it (see
 * calibrate.js's avgPowerFromFlight).
 */
export function dischargeToSoc(batt, tempC, pW, minutes) {
  if (!(pW > 0) || !(minutes > 0)) return 1;
  let elapsed = 0;
  let soc = 100;
  const walk = walkDischarge(batt, tempC, pW, (stepWh, socAfter, socBefore) => {
    const dtMin = stepWh / pW * 60;
    if (elapsed + dtMin >= minutes) {
      soc = socBefore - (socBefore - socAfter) * ((minutes - elapsed) / dtMin);
      elapsed = minutes;
      return true;
    }
    elapsed += dtMin;
    soc = socAfter;
    return false;
  });
  return (elapsed >= minutes ? soc : walk.stopSoc) / 100;
}

/* ---------------- Mission planning ---------------- */

const WIND_MODES = ['headOut', 'tailOut', 'cross'];

/**
 * Share of the gust spread the planning wind carries: the planning wind is
 * `avg + GUST_FACTOR·(gust − avg)`. Exported because the control rail now owns
 * this number (Phase 4 item 4) and both sides have to agree on the default.
 *
 * Note what the blend is actually mixing: Open-Meteo publishes gusts at 10 m
 * and sustained wind at 80 m, which is the altitude band this tool plans in. So
 * the spread is a 10 m spread laid over an 80 m mean — it reads harsher than
 * the air the aircraft is in, and the honest thing to do is say so next to the
 * knob rather than bury a 0.35 in the model.
 */
export const GUST_FACTOR_DEFAULT = 0.35;

/**
 * The get-home reserve's hunt-and-land allowance, in minutes of hover power
 * (Phase 4 item 2). Hover is the right power scale: finding the landing spot,
 * an aborted approach and a controlled descent are all low-speed station
 * keeping, not cruise. 90 seconds buys about 30 s of looking, 30 s of approach
 * and 30 s of margin.
 *
 * Deliberately a time, not an energy or a percentage: `min × pHover` scales with
 * the aircraft rather than with the pack, which is the whole complaint against
 * the percent reserve it replaces. On the MOZ7 + 6S 5000 Li-Ion it comes out at
 * 4.5 Wh of a 108 Wh pack (4.2%); on the Cinelog30 + 4S 850 it is 0.95 Wh of
 * 12.6 Wh (7.5%) — the small pack gets the bigger share of itself, which is the
 * way round it should have been all along.
 */
export const HUNT_LAND_HOVER_MIN = 1.5;

// Ground speed holding a course line against a signed along-track headwind and
// a crosswind component. The crab that cancels the cross component spends
// airspeed; a cross component at or beyond airspeed makes the course unholdable
// (being blown downwind is not progress toward the waypoint — return 0, never
// the drift speed).
function groundSpeedVec(vAir, headMs, crossMs) {
  if (Math.abs(crossMs) >= vAir) return 0;
  const along = crossMs === 0 ? vAir : Math.sqrt(vAir * vAir - crossMs * crossMs);
  return Math.max(0, along - headMs);
}

// Per-leg wind components — [out, back] — from a discrete relative mode…
function legVecsFromMode(mode, windMs) {
  if (mode === 'tailOut') return [{ head: -windMs, cross: 0 }, { head: windMs, cross: 0 }];
  if (mode === 'cross') return [{ head: 0, cross: windMs }, { head: 0, cross: windMs }];
  return [{ head: windMs, cross: 0 }, { head: -windMs, cross: 0 }]; // headOut
}

// …or from an absolute out-leg ground course and the bearing the wind blows
// FROM (meteorological): courseDeg === windFromDeg is straight into the wind.
// Snapping sub-nanoscale components keeps the cardinal cases bit-identical to
// the discrete modes.
//
// Exported for src/domain/route.js (Phase 4 item 7), which decomposes the wind onto each
// leg of a pilot-drawn polyline and must do it exactly the way the footprint
// sweep does — a route that traces the out-and-back has to reproduce the ring's
// own numbers, and it only can if both read the same decomposition.
export function legVecsFromCourse(courseDeg, windFromDeg, windMs) {
  const d = (courseDeg - windFromDeg) * Math.PI / 180;
  const snap = (x) => Math.abs(x) < 1e-9 ? 0 : x;
  const head = snap(windMs * Math.cos(d));
  const cross = snap(windMs * Math.abs(Math.sin(d)));
  return [{ head, cross }, { head: -head, cross }];
}

// Airspeed minimizing Wh per ground-km for one leg; scan is robust vs the flat
// U-shape of the power curve.
function bestRangeSpeed(vec, vMax, pAt) {
  let best = null;
  for (let v = 1; v <= vMax; v += 0.25) {
    const vg = groundSpeedVec(v, vec.head, vec.cross);
    if (vg <= 0.5) continue;
    const whPerKm = pAt(v) / (3.6 * vg);
    if (!best || whPerKm < best.whPerKm) best = { v, vg, whPerKm };
  }
  return best; // null → wind unbeatable at any speed
}

/**
 * One leg of a mission against a given wind vector, as a closure over the cruise
 * policy and the loaded speed envelope: `{ head, cross }` in m/s → `{ v, vg,
 * whPerKm }`, or null when no airspeed holds that course.
 *
 * 'real' flies the airframe's calibrated hands-on cruise speed (like a pilot
 * would), 'range' is the theoretical per-leg optimum, 'manual' a user-set
 * airspeed. The scenario maneuvering burn scales the whole leg — it cancels out
 * of the best-range argmin, so it is applied after speed selection, which is why
 * planMission's `legs.pOut`/`pBack` stay steady-flight (power-curve markers have
 * to sit on the curve) while `whPerKm` carries the overhead.
 *
 * A factory rather than a block inside planMission because src/domain/route.js (Phase 4
 * item 7) integrates a pilot-drawn polyline leg by leg and has to do it with the
 * *same* solve: a route that traces the planned out-and-back reproduces that
 * plan's numbers by identity, not by a second implementation agreeing with the
 * first. `legSolverFrom()` below is that door in.
 */
function makeLegSolver({ flight, vMax, pAt, overheadF, cruiseMode, realVMs, manualVMs }) {
  const fixedV = cruiseMode === 'manual' ? (manualVMs || 0)
    : cruiseMode === 'real' ? Math.min(realVMs || 0, 0.95 * vMax)
    : 0;
  return (vec) => {
    if (!flight.viable) return null;
    let leg;
    if (fixedV > 0) {
      if (fixedV > vMax + 1e-9) return null;
      const vg = groundSpeedVec(fixedV, vec.head, vec.cross);
      leg = vg > 0.5 ? { v: fixedV, vg, whPerKm: pAt(fixedV) / (3.6 * vg) } : null;
    } else {
      leg = bestRangeSpeed(vec, vMax, pAt);
    }
    if (leg) leg.whPerKm *= overheadF;
    return leg;
  };
}

/**
 * The leg solver a finished plan ran on, rebuilt from the plan and the inputs
 * that produced it. Everything it needs is already on the result — the loaded
 * speed ceiling, the lift verdict, the air/mass/drag config and the maneuvering
 * burn — so this reconstructs the identical closure rather than a lookalike.
 *
 * Deliberately not a field on the plan: the result object is compared whole in
 * several pinning tests, and a function on it is not data.
 */
export function legSolverFrom(plan, inp) {
  return makeLegSolver({
    flight: plan.flight,
    vMax: plan.speedLimitMs,
    pAt: (v) => powerAtSpeed(plan.cfg, v),
    overheadF: plan.overheadF,
    cruiseMode: inp.cruiseMode,
    realVMs: inp.realVMs,
    manualVMs: inp.manualVMs,
  });
}

function bestEnduranceSpeed(vMax, pAt) {
  let best = { v: 0, p: Infinity };
  for (let v = 0; v <= vMax; v += 0.25) {
    const p = pAt(v);
    if (p < best.p) best = { v, p };
  }
  return best;
}

/**
 * The strongest pure headwind the aircraft could still fly `radiusKm` home
 * against on `budgetWh` — the headline the Wh reserve exists to produce
 * ("reserve holds to an 18 mph headwind").
 *
 * Wh per ground-km rises monotonically with headwind (the power is the same or
 * higher, the ground speed strictly lower), so the feasible set is an interval
 * from zero and bisection is exact to within the last step. Returns the wind in
 * m/s, capped at `vMaxMs` — a headwind at the aircraft's own top speed is the
 * end of the scale, not a number worth resolving past.
 */
function headwindLimitMs(radiusKm, budgetWh, solveLeg, vMaxMs) {
  const fits = (w) => {
    const leg = solveLeg({ head: w, cross: 0 });
    return !!leg && radiusKm * leg.whPerKm <= budgetWh;
  };
  if (!(vMaxMs > 0) || !fits(0)) return 0;
  if (fits(vMaxMs)) return vMaxMs;
  let lo = 0, hi = vMaxMs;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * Plan an out-and-back mission.
 * inputs: {
 *   drone, battery, payloadG, extraG,
 *   env: { elevM, tempC, rhPct, windAvgMs, windGustMs, windMode, windFromDeg },
 *   packTempC,    // the pack's own temperature at takeoff; defaults to env.tempC
 *                 // (a pack that cold-soaked in the bag). Air temp keeps the air
 *                 // density; this drives every chemistry curve — see below
 *   landFloorPct, // pack-care floor: charge (% of delivered Wh) not to land below
 *   gustFactor,   // share of the gust spread the planning wind carries
 *   getHome,      // get-home reserve policy: false to size the mission with no
 *                 // reserve at all (a measurement, not a plan), or
 *                 // { windMs, huntLandMin } to override either half — windMs
 *                 // rescales the adverse return wind, huntLandMin its allowance
 *   cruiseMode: 'real'|'range'|'manual', realVMs, manualVMs,
 *   overheadF,  // scenario maneuvering burn, ×steady cruise power (≥1)
 *   courseDeg,  // optional absolute out-leg course; with env.windFromDeg it
 *               // overrides the relative windMode (map footprint sweeps)
 *   lite,       // skip timeline/power-curve/endurance extras (sweep callers)
 *   _pCache,    // optional Map memoizing powerAtSpeed across calls; only
 *               // valid while mass/air/drag config is unchanged (caller owns)
 * }
 */
export function planMission(inp) {
  const { drone, battery, env } = inp;
  // No pack selected at all — a rig nothing in the registry fits. A handled
  // code, because the caller can say so in a sentence; the alternative was a
  // raw TypeError three lines down.
  if (!battery) return { code: 'no_battery', warnings: [] };
  const warnings = [];
  const { rho, densityAltM } = airDensity(env.elevM, env.tempC, env.rhPct);

  /* ---- Pack temperature, apart from air temperature (Phase 4 item 3) ----
   *
   * Preheating packs is the single biggest thing a pilot does about cold, and
   * until now the model could not express it: one temperature fed both the air
   * density and the cell chemistry, so warming a pack meant lying about the air.
   * They are split here — air density still reads `env.tempC`, while capacity,
   * internal resistance and the sag ceiling in liftEnvelope() read the pack.
   *
   * The default is that they are the same number, because that is usually true:
   * a pack that rode to the field in a backpack is at air temperature. An
   * override is the pilot saying otherwise, in either direction (off the car
   * dash and warm, or still cold-soaked from a car left out overnight), so
   * `packOverride` is derived by comparison rather than from the field being
   * present — passing a pack temperature equal to the air claims nothing, and
   * changes nothing.
   */
  const packTempC = inp.packTempC ?? env.tempC;
  const packOverride = packTempC !== env.tempC;

  const massKg = (drone.dryMassG + battery.massG + inp.payloadG + (inp.extraG || 0)) / 1000;
  const areaM2 = discAreaM2(drone);
  const cdA = drone.cdA + (inp.payloadCdA || 0) + (battery.extraCdA || 0);
  const cfg = { massKg, rho, areaM2, cdA, etaProp: drone.etaProp, avionicsW: drone.avionicsW };
  const modelVMax = drone.maxSpeedMs;

  // Planning wind: average plus a slice of the gust spread (conservatism knob,
  // exposed on the rail since Phase 4 item 4 — see GUST_FACTOR_DEFAULT).
  const gustFactor = inp.gustFactor ?? GUST_FACTOR_DEFAULT;
  const windMs = env.windAvgMs + gustFactor * Math.max(0, env.windGustMs - env.windAvgMs);
  // Leg wind components: an absolute course (map footprint) wins over the
  // relative windMode (dashboard); both see the same gust-blended wind.
  const [vecOut, vecBack] = inp.courseDeg != null && isFinite(env.windFromDeg)
    ? legVecsFromCourse(inp.courseDeg, env.windFromDeg, windMs)
    : legVecsFromMode(WIND_MODES.includes(env.windMode) ? env.windMode : 'headOut', windMs);

  const pCache = inp._pCache;
  const pAt = pCache
    ? (v) => {
        let p = pCache.get(v);
        if (p === undefined) { p = powerAtSpeed(cfg, v); pCache.set(v, p); }
        return p;
      }
    : (v) => powerAtSpeed(cfg, v);

  // Hover point.
  const pHover = pAt(0);
  const vNomPack = battery.s > 0 ? battery.s * CHEMISTRY[battery.chem].vNom : 1;
  const iHover = pHover / vNomPack;
  const discLoadingGcm2 = (massKg * 1000) / (areaM2 * 1e4);
  const flight = liftEnvelope({ drone, battery, rho, areaM2, tempC: packTempC, massKg });

  // The published top speed is only usable while the loaded aircraft remains
  // inside both its continuous power and thrust envelopes.
  let vMax = 0;
  if (flight.viable) {
    for (let v = 0; v <= modelVMax + 1e-9; v += 0.25) {
      const dragN = 0.5 * rho * cdA * v * v;
      const thrustN = Math.hypot(massKg * G, dragN);
      if (thrustN > flight.maxThrustN || pAt(v) > flight.maxElectricalW) break;
      vMax = v;
    }
  }

  // Cruise speeds per leg — see makeLegSolver() for what each mode means and why
  // the maneuvering burn lands where it does.
  const endur = inp.lite ? null : bestEnduranceSpeed(vMax, pAt);
  const overheadF = Math.max(inp.overheadF ?? 1, 1);
  const solveLeg = makeLegSolver({
    flight, vMax, pAt, overheadF,
    cruiseMode: inp.cruiseMode, realVMs: inp.realVMs, manualVMs: inp.manualVMs,
  });
  const legOut = solveLeg(vecOut);
  const legBack = solveLeg(vecBack);

  // Usable energy at the mission's average power draw.
  const pOutSteady = legOut ? pAt(legOut.v) : pHover;
  const pBackSteady = legBack ? pAt(legBack.v) : pHover;
  const pOut = legOut ? pOutSteady * overheadF : pHover;
  const pBack = legBack ? pBackSteady * overheadF : pHover;
  const pAvg = (pOut + pBack) / 2;
  const sim = dischargeSim(battery, packTempC, pAvg);

  /* ---- The get-home reserve (Phase 4 item 2) ----
   *
   * Two separate things used to share one percent slider, and percent was the
   * wrong unit for both of them:
   *
   *   the pack-care floor — the charge you don't want to land below, because
   *     that is what wears cells. A percent, correctly: cell state of charge is
   *     the thing being protected. Stays the pilot's knob (`landFloorPct`).
   *   the get-home margin — the energy it takes to actually reach the launch
   *     point from the turnaround if the wind is against you. An amount of
   *     work, in Wh, and 20% of a 6S2P Li-Ion (43 Wh) versus 20% of an 850
   *     (2.5 Wh) held the margin back-to-front: the small pack, with the least
   *     absolute energy and the shortest legs, got the least.
   *
   * The margin is solved, not set. Two constraints on the turnaround radius R:
   *
   *   floor:    R·(whOut + whBack) ≤ delivered·(1 − floor)
   *   get-home: R·whOut + R·whHome + huntLand ≤ delivered
   *
   * where `whHome` is the same aircraft, at the same cruise policy, flying the
   * return leg it might actually get instead of the one it planned: the planned
   * return with the along-wind component turned adverse. The second constraint
   * rearranges to a closed form, so the whole thing costs no iteration and — at
   * the default wind — not even an extra leg solve. The mission takes whichever
   * radius binds first, and `reserveWh` is what the pack is holding when it lands
   * from that mission.
   *
   * What "worst case" is and isn't. It is the *blended* planning wind, not the
   * raw gust peak: a whole leg flown at the peak is a wind that doesn't exist for
   * the minutes the leg takes, and the gust factor above is already the knob for
   * how much of the peak to believe (so turning that knob up widens the reserve
   * too). And it is the forecast wind with its *sign* made adverse, not a wind
   * from a new direction: the free tailwind home is the assumption that strands
   * people, but a 90° shift on top of the forecast is double-counting, and
   * demanding headwind-home capability on a crosswind route would collapse the
   * whole map footprint the moment the rig couldn't out-fly the wind head-on.
   *
   * Because |head| and cross are shared between the two legs, the adverse return
   * IS one of the two legs already solved — whichever of them faces the wind. So
   * `legHome` closes exactly when the mission's own legs close: the reserve
   * shortens missions, and never invents a new collapse. (An explicit
   * `getHome.windMs` override rescales the vector and does cost a solve.)
   */
  const gh = inp.getHome === false ? null : {
    windMs: inp.getHome?.windMs ?? windMs,
    huntLandMin: inp.getHome?.huntLandMin ?? HUNT_LAND_HOVER_MIN,
  };
  // With no reserve policy at all the planned return leg stands in, which
  // collapses the get-home constraint into the floor one and leaves the mission
  // an unreserved measurement.
  const homeScale = gh ? (windMs > 0 ? gh.windMs / windMs : 0) : 0;
  const vecHome = !gh ? null
    : windMs > 0 ? { head: Math.abs(vecBack.head) * homeScale, cross: vecBack.cross * homeScale }
    : { head: gh.windMs, cross: 0 }; // dead calm, overridden: a pure headwind is all there is to scale
  const sameVec = (a, b) => Math.abs(a.head - b.head) < 1e-12 && Math.abs(a.cross - b.cross) < 1e-12;
  const legHome = !gh ? legBack
    : sameVec(vecHome, vecOut) ? legOut
    : sameVec(vecHome, vecBack) ? legBack
    : solveLeg(vecHome);
  const huntLandWh = gh ? gh.huntLandMin * pHover / 60 : 0;

  const floorFrac = Math.min(Math.max(inp.landFloorPct ?? 20, 0), 60) / 100;
  const floorUsableWh = sim.deliveredWh * (1 - floorFrac);

  // Mission radius & time.
  let radiusKm = 0, timeMin = 0, totalKm = 0;
  let usableWh = floorUsableWh; // no mission closes → the tile still reads the floor
  let reserveBinds = null;
  if (legOut && legBack && legHome) {
    const whPerKmRound = legOut.whPerKm + legBack.whPerKm;
    const rFloor = floorUsableWh / whPerKmRound;
    const rHome = Math.max(0, sim.deliveredWh - huntLandWh) / (legOut.whPerKm + legHome.whPerKm);
    reserveBinds = rHome < rFloor ? 'getHome' : 'floor';
    radiusKm = Math.min(rFloor, rHome);
    usableWh = radiusKm * whPerKmRound;
    totalKm = radiusKm * 2;
    timeMin = (radiusKm / (legOut.vg * 3.6) + radiusKm / (legBack.vg * 3.6)) * 60;
  }
  const reserveWh = sim.deliveredWh - usableWh;
  // The get-home reserve as the doc defines it: the energy the worst-case return
  // from this turnaround actually costs, hunt-and-land included. Distinct from
  // `reserveWh`, which is what the pack lands on after the *planned* return —
  // downwind-home missions land on far less than the upwind return would need,
  // and the plan is safe precisely because the radius was capped so the expensive
  // return still fits from the turnaround.
  const getHomeWh = gh && legHome && radiusKm > 0 ? radiusKm * legHome.whPerKm + huntLandWh : 0;
  // Hovering over your own feet has no leg to fly home, so only the pack-care
  // floor applies to this one.
  const hoverTimeMin = inp.lite ? 0
    : dischargeSim(battery, packTempC, pHover).deliveredWh * (1 - floorFrac) / pHover * 60;
  const cruiseTimeMin = usableWh / pAvg * 60; // loiter at cruise power
  // The headline: what the retained energy is actually worth, read back out of
  // the plan rather than asserted. Equal to gh.windMs to bisection precision
  // whenever the get-home constraint is the binding one, and higher when the
  // pack-care floor held more back than getting home needs. Display only, so
  // the sweep callers skip it.
  const holdsHeadwindMs = inp.lite || !(radiusKm > 0) ? null
    : headwindLimitMs(radiusKm, sim.deliveredWh - radiusKm * legOut.whPerKm - huntLandWh,
                      solveLeg, vMax);

  // Timeline for the mission-profile chart.
  const timeline = [];
  if (!inp.lite && legOut && legBack && radiusKm > 0) {
    const outMin = radiusKm / (legOut.vg * 3.6) * 60;
    const backMin = radiusKm / (legBack.vg * 3.6) * 60;
    const whPerPct = sim.deliveredWh > 0 ? sim.deliveredWh / (100 - sim.stopSoc) : 1;
    const simOut = dischargeSim(battery, packTempC, pOut);
    const simBack = dischargeSim(battery, packTempC, pBack);
    let soc = 100;
    const steps = 120;
    for (let i = 0; i <= steps; i++) {
      const t = (outMin + backMin) * i / steps;
      const out = t <= outMin;
      const p = out ? pOut : pBack;
      const dt = (outMin + backMin) / steps;
      if (i > 0) soc -= (p * dt / 60) / whPerPct;
      const dist = out ? (legOut.vg * 3.6) * t / 60 : radiusKm - (legBack.vg * 3.6) * (t - outMin) / 60;
      const st = (out ? simOut : simBack).stateAt(Math.max(soc, 0));
      timeline.push({ tMin: t, distKm: Math.max(dist, 0), soc: Math.max(soc, 0),
                      vLoad: st.vLoad, iA: st.I, phase: out ? 'out' : 'back' });
    }
  }

  /* Warnings */
  if (flight.code === 'no_lift') {
    warnings.push({
      level: 'critical',
      text: `WILL NOT FLY: ${massKg * 1000 > 0 ? (massKg * 1000).toFixed(0) : '—'} g all-up weight exceeds the ${flight.estimated === false ? 'measured' : 'estimated'} ${flight.maxHoverMassG.toFixed(0)} g continuous lift ceiling (${flight.thrustToWeight.toFixed(2)}:1 thrust-to-weight).`,
    });
  } else if (flight.code === 'no_control_margin') {
    warnings.push({
      level: 'serious',
      text: `Only ${flight.thrustToWeight.toFixed(2)}:1 estimated thrust-to-weight — it may lift, but has almost no climb or control margin.`,
    });
  } else if (flight.code === 'marginal') {
    warnings.push({
      level: 'warning',
      text: `${flight.thrustToWeight.toFixed(2)}:1 estimated thrust-to-weight is marginal for gusts, climb, and recovery.`,
    });
  }
  if (battery.packCount > 1) {
    warnings.push({
      level: 'warning',
      text: `Parallel mode assumes ${battery.packCount} identical, equally charged packs and includes ${battery.harnessMassG || 0} g of harness/restraint allowance.`,
    });
  }
  // `legHome` joins the other two: a mission whose worst-case return leg cannot
  // be flown at all has no safe turnaround point, which is the same dead end.
  // One text for all three, because render/dashboard.js's zeroRadiusNote()
  // replaces this line with the version that names the lever to move.
  if (!legOut || !legBack || !legHome) {
    if (flight.viable) warnings.push({ level: 'critical', text: 'Wind or loaded propulsion limits prevent a safe out-and-back at these settings.' });
  }
  if (battery.maxContA) {
    const iRatio = iHover / battery.maxContA;
    if (iRatio > 1) warnings.push({ level: 'critical', text: `Hover draw ~${iHover.toFixed(0)}A exceeds the pack's ${battery.maxContA}A continuous rating.` });
    else if (iRatio > 0.6) warnings.push({ level: 'serious', text: `Hover draw is ${(iRatio * 100).toFixed(0)}% of the pack's continuous rating — punch-outs will sag hard.` });
  }
  if (sim.sagLimited) warnings.push({ level: 'serious', text: 'Voltage sag cuts the flight before the capacity is used — the pack is the limiter, not the energy.' });
  if (env.windGustMs > 0.45 * vMax) warnings.push({ level: 'serious', text: 'Gusts are a large fraction of this craft\'s top speed — expect control-authority margins to shrink.' });
  // Cold is a property of the pack, so this reads the pack: preheating one is a
  // real mitigation and the warning has to clear when the pilot has done it.
  // Both halves of the honesty go in the text — what cold costs, and which way
  // the table behind the figure is wrong (see CHEMISTRY).
  if (isColdPack(battery.chem, packTempC)) {
    warnings.push({
      level: 'warning',
      text: `Cold ${CHEMISTRY[battery.chem].label} pack: less capacity than the plan would like and heavy sag on the first pull. `
        + (packOverride
          ? 'This is the temperature you set for the pack, not the air — warm it further before launch. '
          : 'Keep the packs somewhere warm until launch, and say so above if you preheat them. ')
        + 'The cold numbers behind this come off a gentle bench discharge, so they under-state that first-pull sag '
        + 'and over-state the penalty later on, once the pack has warmed itself up under load.',
    });
  }
  // A warm pack in cold air does not stay warm, and nothing in this model cools
  // it down. Say that where the pilot claimed the head start.
  if (packOverride && packTempC > env.tempC && isColdPack(battery.chem, env.tempC)) {
    warnings.push({
      level: 'warning',
      text: 'Preheated pack in cold air: the chemistry here reads the pack, not the air, and nothing models it cooling '
        + 'down in the airstream. Insulate it, launch soon after it comes off the warmer, and treat these figures as '
        + 'the optimistic end.',
    });
  }
  if (densityAltM > 2500) warnings.push({ level: 'warning', text: `Density altitude ${(densityAltM * 3.28084).toFixed(0)} ft — thrust margin and efficiency are both reduced up here.` });

  return {
    rho, densityAltM, massKg, discLoadingGcm2, areaM2,
    // The two temperatures the plan ran on, and whether they differ. `airC` is
    // what set the density; `packC` is what every chemistry curve read. The UI
    // says the split out loud whenever `packOverride` is true, because it moves
    // the answer without appearing in any other figure on screen.
    temps: { airC: env.tempC, packC: packTempC, packOverride, cold: isColdPack(battery.chem, packTempC) },
    hover: { pW: pHover, iA: iHover, gPerW: (massKg * 1000) / pHover },
    endurance: endur ? { vMs: endur.v, pW: endur.p } : null,
    wind: { planningMs: windMs, out: vecOut, back: vecBack, gustFactor },
    legs: { out: legOut, back: legBack, home: legHome, pOut: pOutSteady, pBack: pBackSteady },
    overheadF,
    energy: {
      packWh: battery.capAh * battery.s * CHEMISTRY[battery.chem].vNom,
      deliveredWh: sim.deliveredWh, usableWh,
      // The reserve as an amount of work, and the same amount as the share of
      // the pack the mission lands on (what the profile chart's marker line and
      // the hero sentence read). Derived now, not set.
      reserveWh,
      reservePct: sim.deliveredWh > 0 ? reserveWh / sim.deliveredWh * 100 : 0,
      landFloorPct: floorFrac * 100,
      getHomeWh, huntLandWh,
      getHomeWindMs: gh ? gh.windMs : null,
      holdsHeadwindMs,
      reserveBinds,
      capF: sim.capF, sagLimited: sim.sagLimited,
    },
    radiusKm, totalKm, timeMin, hoverTimeMin, cruiseTimeMin,
    curve: inp.lite ? [] : powerCurve(cfg, modelVMax),
    cfg, flight, speedLimitMs: vMax, timeline, warnings,
  };
}

/* ---------------- Unit helpers ---------------- */

export const U = {
  ftToM: (ft) => ft * 0.3048,
  mToFt: (m) => m / 0.3048,
  mphToMs: (mph) => mph * 0.44704,
  msToMph: (ms) => ms / 0.44704,
  fToC: (f) => (f - 32) * 5 / 9,
  cToF: (c) => c * 9 / 5 + 32,
  kmToMi: (km) => km * 0.621371,
};
