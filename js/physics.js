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

// Induced velocity in forward flight (momentum theory, fixed-point iteration).
function inducedVelocity(thrustN, rho, areaM2, vMs) {
  const vh2 = thrustN / (2 * rho * areaM2);
  let vi = Math.sqrt(vh2);
  for (let i = 0; i < 30; i++) {
    vi = vh2 / Math.hypot(vMs, vi);
  }
  return vi;
}

// Electrical power (W) to fly at airspeed vMs.
// etaProp is overall electrical→ideal-induced efficiency (folds figure of merit,
// motor/ESC losses, and profile drag at hover); calibrated per airframe against
// real-world flight logs. cdA in m².
export function powerAtSpeed({ massKg, rho, areaM2, cdA, etaProp, avionicsW }, vMs) {
  const W = massKg * G;
  const D = 0.5 * rho * cdA * vMs * vMs;
  const T = Math.hypot(W, D);
  const vi = inducedVelocity(T, rho, areaM2, vMs);
  const pIdeal = T * vi + D * vMs;
  return pIdeal / etaProp + avionicsW;
}

export function powerCurve(cfg, vMaxMs, step = 0.25) {
  const pts = [];
  for (let v = 0; v <= vMaxMs + 1e-9; v += step) {
    pts.push({ v, p: powerAtSpeed(cfg, v) });
  }
  return pts;
}

/* ---------------- Battery chemistry ---------------- */

// OCV per cell vs state-of-charge (%), capacity & internal-resistance factors vs °C.
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

// Discharge the pack at constant electrical power. Returns delivered energy (Wh),
// whether the cutoff was sag-limited, and a soc→(vLoad, I) sampler for timelines.
export function dischargeSim(batt, tempC, pW) {
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
    wh += (effAh * socStep / 100) * (vOcv - I * rOhm);
    stopSoc = soc - socStep;
  }
  return {
    deliveredWh: wh,
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

/* ---------------- Mission planning ---------------- */

const WIND_MODES = ['headOut', 'tailOut', 'cross'];

function groundSpeed(vAir, windMs, legWind) {
  if (legWind === 'head') return vAir - windMs;
  if (legWind === 'tail') return vAir + windMs;
  const cross = vAir * vAir - windMs * windMs; // crab into a pure crosswind
  return cross > 0 ? Math.sqrt(cross) : 0;
}

function legWinds(mode) {
  if (mode === 'headOut') return ['head', 'tail'];
  if (mode === 'tailOut') return ['tail', 'head'];
  return ['cross', 'cross'];
}

// Airspeed minimizing Wh per ground-km for one leg; scan is robust vs the flat
// U-shape of the power curve.
function bestRangeSpeed(cfg, windMs, legWind, vMax) {
  let best = null;
  for (let v = 1; v <= vMax; v += 0.25) {
    const vg = groundSpeed(v, windMs, legWind);
    if (vg <= 0.5) continue;
    const whPerKm = powerAtSpeed(cfg, v) / (3.6 * vg);
    if (!best || whPerKm < best.whPerKm) best = { v, vg, whPerKm };
  }
  return best; // null → wind unbeatable at any speed
}

function bestEnduranceSpeed(cfg, vMax) {
  let best = { v: 0, p: Infinity };
  for (let v = 0; v <= vMax; v += 0.25) {
    const p = powerAtSpeed(cfg, v);
    if (p < best.p) best = { v, p };
  }
  return best;
}

/**
 * Plan an out-and-back mission.
 * inputs: {
 *   drone, battery, payloadG, extraG,
 *   env: { elevM, tempC, rhPct, windAvgMs, windGustMs, windMode },
 *   reservePct, gustFactor,
 *   cruiseMode: 'real'|'range'|'manual', realVMs, manualVMs,
 *   overheadF   // scenario maneuvering burn, ×steady cruise power (≥1)
 * }
 */
export function planMission(inp) {
  const { drone, battery, env } = inp;
  const warnings = [];
  const { rho, densityAltM } = airDensity(env.elevM, env.tempC, env.rhPct);

  const massKg = (drone.dryMassG + battery.massG + inp.payloadG + (inp.extraG || 0)) / 1000;
  const areaM2 = discAreaM2(drone);
  const cdA = drone.cdA + (inp.payloadCdA || 0);
  const cfg = { massKg, rho, areaM2, cdA, etaProp: drone.etaProp, avionicsW: drone.avionicsW };
  const vMax = drone.maxSpeedMs;

  // Planning wind: average plus a slice of the gust spread (conservatism knob).
  const gustFactor = inp.gustFactor ?? 0.35;
  const windMs = env.windAvgMs + gustFactor * Math.max(0, env.windGustMs - env.windAvgMs);
  const [outWind, backWind] = legWinds(WIND_MODES.includes(env.windMode) ? env.windMode : 'headOut');

  // Hover point.
  const pHover = powerAtSpeed(cfg, 0);
  const vNomPack = battery.s > 0 ? battery.s * CHEMISTRY[battery.chem].vNom : 1;
  const iHover = pHover / vNomPack;
  const discLoadingGcm2 = (massKg * 1000) / (areaM2 * 1e4);

  // Cruise speeds per leg. 'real' flies the airframe's calibrated hands-on
  // cruise speed both ways (like a pilot would); 'range' is the theoretical
  // per-leg optimum; 'manual' is a user-set airspeed.
  const endur = bestEnduranceSpeed(cfg, vMax);
  const overheadF = Math.max(inp.overheadF ?? 1, 1);
  const fixedV = inp.cruiseMode === 'manual' ? (inp.manualVMs || 0)
    : inp.cruiseMode === 'real' ? Math.min(inp.realVMs || 0, 0.95 * vMax)
    : 0;
  let legOut, legBack;
  if (fixedV > 0) {
    const mk = (legWind) => {
      const vg = groundSpeed(fixedV, windMs, legWind);
      return vg > 0.5
        ? { v: fixedV, vg, whPerKm: powerAtSpeed(cfg, fixedV) / (3.6 * vg) }
        : null;
    };
    legOut = mk(outWind);
    legBack = mk(backWind);
  } else {
    legOut = bestRangeSpeed(cfg, windMs, outWind, vMax);
    legBack = bestRangeSpeed(cfg, windMs, backWind, vMax);
  }
  // Scenario maneuvering burn scales the whole cruise leg (it cancels out of
  // the best-range argmin, so it's applied after speed selection). legs.pOut /
  // legs.pBack stay steady-flight so power-curve markers sit on the curve;
  // whPerKm and the discharge sim carry the overhead.
  if (legOut) legOut.whPerKm *= overheadF;
  if (legBack) legBack.whPerKm *= overheadF;

  // Usable energy at the mission's average power draw.
  const pOutSteady = legOut ? powerAtSpeed(cfg, legOut.v) : pHover;
  const pBackSteady = legBack ? powerAtSpeed(cfg, legBack.v) : pHover;
  const pOut = legOut ? pOutSteady * overheadF : pHover;
  const pBack = legBack ? pBackSteady * overheadF : pHover;
  const pAvg = (pOut + pBack) / 2;
  const sim = dischargeSim(battery, env.tempC, pAvg);
  const reserve = Math.min(Math.max(inp.reservePct ?? 20, 0), 60) / 100;
  const usableWh = sim.deliveredWh * (1 - reserve);

  // Mission radius & time.
  let radiusKm = 0, timeMin = 0, totalKm = 0;
  if (legOut && legBack) {
    radiusKm = usableWh / (legOut.whPerKm + legBack.whPerKm);
    totalKm = radiusKm * 2;
    timeMin = (radiusKm / (legOut.vg * 3.6) + radiusKm / (legBack.vg * 3.6)) * 60;
  }
  const hoverSim = dischargeSim(battery, env.tempC, pHover);
  const hoverTimeMin = hoverSim.deliveredWh * (1 - reserve) / pHover * 60;
  const cruiseTimeMin = usableWh / pAvg * 60; // loiter at cruise power

  // Timeline for the mission-profile chart.
  const timeline = [];
  if (legOut && legBack && radiusKm > 0) {
    const outMin = radiusKm / (legOut.vg * 3.6) * 60;
    const backMin = radiusKm / (legBack.vg * 3.6) * 60;
    const whPerPct = sim.deliveredWh > 0 ? sim.deliveredWh / (100 - sim.stopSoc) : 1;
    const simOut = dischargeSim(battery, env.tempC, pOut);
    const simBack = dischargeSim(battery, env.tempC, pBack);
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
  if (!legOut || !legBack) {
    warnings.push({ level: 'critical', text: 'Wind exceeds what this aircraft can penetrate — no safe out-and-back exists at these settings.' });
  }
  if (battery.maxContA) {
    const iRatio = iHover / battery.maxContA;
    if (iRatio > 1) warnings.push({ level: 'critical', text: `Hover draw ~${iHover.toFixed(0)}A exceeds the pack's ${battery.maxContA}A continuous rating.` });
    else if (iRatio > 0.6) warnings.push({ level: 'serious', text: `Hover draw is ${(iRatio * 100).toFixed(0)}% of the pack's continuous rating — punch-outs will sag hard.` });
  }
  if (sim.sagLimited) warnings.push({ level: 'serious', text: 'Voltage sag cuts the flight before the capacity is used — the pack is the limiter, not the energy.' });
  if (env.windGustMs > 0.45 * vMax) warnings.push({ level: 'serious', text: 'Gusts are a large fraction of this craft\'s top speed — expect control-authority margins to shrink.' });
  if (env.tempC <= 5 && battery.chem !== 'liion') warnings.push({ level: 'warning', text: 'Cold LiPo/LiHV: expect reduced capacity and heavy early sag. Keep packs warm until launch.' });
  if (env.tempC <= 0 && battery.chem === 'liion') warnings.push({ level: 'warning', text: 'Sub-freezing Li-Ion: capacity and current capability drop. Warm packs before flight.' });
  if (densityAltM > 2500) warnings.push({ level: 'warning', text: `Density altitude ${(densityAltM * 3.28084).toFixed(0)} ft — thrust margin and efficiency are both reduced up here.` });

  return {
    rho, densityAltM, massKg, discLoadingGcm2, areaM2,
    hover: { pW: pHover, iA: iHover, gPerW: (massKg * 1000) / pHover },
    endurance: { vMs: endur.v, pW: endur.p },
    wind: { planningMs: windMs, outWind, backWind },
    legs: { out: legOut, back: legBack, pOut: pOutSteady, pBack: pBackSteady },
    overheadF,
    energy: { packWh: battery.capAh * battery.s * CHEMISTRY[battery.chem].vNom,
              deliveredWh: sim.deliveredWh, usableWh, reservePct: reserve * 100,
              capF: sim.capF, sagLimited: sim.sagLimited },
    radiusKm, totalKm, timeMin, hoverTimeMin, cruiseTimeMin,
    curve: powerCurve(cfg, vMax),
    cfg, timeline, warnings,
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
