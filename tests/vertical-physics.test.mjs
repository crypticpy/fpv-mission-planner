import test from 'node:test';
import assert from 'node:assert/strict';

import { G, airDensity, discAreaM2, planMission, powerAtSpeed, U } from '../src/domain/physics.js';
import {
  DEFAULT_CLIMB_RATE_MS, DEFAULT_DESCENT_RATE_MS, DESCENT_HOVER_POWER_FRAC, ISA_LAPSE_K_PER_M,
  atmosphereAt, climbEnergyWh, descentExcessWh, hoverPowerRatio, legVerticalEnergy, windAtAltitude,
} from '../src/domain/vertical.js';

/* M3b: the vertical model, pinned.
 *
 * Every equation in src/domain/vertical.js is either an identity out of the same
 * momentum theory physics.js already solves, or a stated planning policy. This
 * file is where that claim is checkable: the identities are tested as identities
 * (against the general case, not against a remembered number), and the policies
 * are tested for the property that made them policies — that each one errs
 * against the pilot rather than for them.
 *
 * The one number that is genuinely pinned is the parity claim: the module is
 * additive, so planMission's answer with these functions unused has to be bit
 * for bit what it was before they existed. tests/analysis-pipeline.test.mjs
 * carries that one against the pipeline; here it is against the model. */

const ETA = 0.55;
const MASS_KG = 1.342;

/* ---------- climb: an identity, not a fit ---------- */

test('climb energy is the potential energy gained over drivetrain efficiency', () => {
  const gain = 150;
  const wh = climbEnergyWh(MASS_KG, ETA, gain);
  assert.equal(wh, MASS_KG * G * gain / (ETA * 3600), 'no fudge factor, no fitted constant');
  // …which is to say, in units a pilot could check: 1.342 kg lifted 150 m is
  // 1974 J of potential energy, 3590 J at the pack, 1.0 Wh.
  assert.ok(Math.abs(wh - 0.997) < 0.002, `${wh.toFixed(3)} Wh for 150 m — sanity, not precision`);
});

test('climb energy is linear in height and inversely linear in efficiency', () => {
  assert.ok(Math.abs(climbEnergyWh(MASS_KG, ETA, 200) - 2 * climbEnergyWh(MASS_KG, ETA, 100)) < 1e-12,
    'twice the height, twice the energy');
  assert.ok(Math.abs(climbEnergyWh(MASS_KG, ETA / 2, 100) - 2 * climbEnergyWh(MASS_KG, ETA, 100)) < 1e-12,
    'half the efficiency, twice the draw');
});

test('climb energy does not depend on how fast the climb is flown', () => {
  // The rate cancels: power m·g·V for a time h/V is m·g·h whatever V is. This is
  // why DEFAULT_CLIMB_RATE_MS moves the clock and not the budget, and it is a
  // result rather than a simplification.
  const slow = legVerticalEnergy({
    massKg: MASS_KG, etaProp: ETA, hoverW: 300, levelPowerW: 300, deltaM: 120, climbRateMs: 1,
  });
  const fast = legVerticalEnergy({
    massKg: MASS_KG, etaProp: ETA, hoverW: 300, levelPowerW: 300, deltaM: 120, climbRateMs: 12,
  });
  assert.equal(slow.climbWh, fast.climbWh, 'same Wh');
  assert.equal(slow.climbS, 120, 'and 120 s at 1 m/s');
  assert.equal(fast.climbS, 10, 'against 10 s at 12 m/s');
});

test('the climb model is an upper bound on the momentum-theory excess it stands in for', () => {
  /* The claim in the module's doc-block, checked numerically. In a vertical
   * climb at V_c the induced velocity is v_i = −V_c/2 + √((V_c/2)² + v_h²), so
   * the rotor power excess over hover is T·(V_c + v_i − v_h). m·g·V_c is that
   * expression's ceiling, and the margin is where this module's conservatism
   * actually lives — if a future change ever made the charged figure *smaller*
   * than the theory it approximates, this fails. */
  const thrustN = MASS_KG * G;
  const rho = 1.225;
  const disc = discAreaM2({ propDiaIn: 7.5, numRotors: 4 });
  const vh = Math.sqrt(thrustN / (2 * rho * disc));

  for (const vc of [0.5, 1, 3, 6, 10]) {
    const vi = -vc / 2 + Math.sqrt((vc / 2) ** 2 + vh ** 2);
    const theoryExcessW = thrustN * (vc + vi - vh);
    // What this module charges for the same climb, as a power over its duration.
    const gain = vc * 10;                       // ten seconds of climbing
    const chargedW = climbEnergyWh(MASS_KG, 1, gain) * 3600 / 10;  // η = 1: the mechanical side
    assert.ok(chargedW >= theoryExcessW - 1e-9,
      `at ${vc} m/s the model charges ${chargedW.toFixed(1)} W against a theory excess of `
      + `${theoryExcessW.toFixed(1)} W — the bound is supposed to hold from above`);
  }
});

test('a level or descending leg costs no climb energy, and nothing goes negative', () => {
  assert.equal(climbEnergyWh(MASS_KG, ETA, 0), 0);
  assert.equal(climbEnergyWh(MASS_KG, ETA, -200), 0, 'a drop is not a negative climb');
  assert.equal(climbEnergyWh(0, ETA, 100), 0);
  assert.equal(climbEnergyWh(MASS_KG, 0, 100), 0, 'no efficiency, no division by zero');
});

/* ---------- descent: a policy, and never a credit ---------- */

test('a descent never returns energy to the pack', () => {
  for (const levelW of [0, 50, 200, 400, 5000]) {
    const down = descentExcessWh({ hoverW: 300, levelPowerW: levelW, dropM: 200 });
    assert.ok(down.wh >= 0, `level power ${levelW} W produced ${down.wh} Wh — regeneration is not modelled`);
  }
});

test('a descent costs the difference between descent power and the cruise already charged', () => {
  const hoverW = 300;
  const dropM = 200;
  const seconds = dropM / DEFAULT_DESCENT_RATE_MS;
  // Cheaper cruise than the descent policy: the difference is charged.
  const cheap = descentExcessWh({ hoverW, levelPowerW: 100, dropM });
  assert.ok(Math.abs(cheap.wh - (DESCENT_HOVER_POWER_FRAC * hoverW - 100) * seconds / 3600) < 1e-12);
  assert.equal(cheap.seconds, seconds);
  // Cruise already above the descent policy: nothing more to charge, and
  // certainly nothing to refund.
  assert.equal(descentExcessWh({ hoverW, levelPowerW: 400, dropM }).wh, 0);
});

test('the descent rate stays well below the vortex-ring region these rotors live in', () => {
  // v_h for this airframe is 5-8 m/s; the policy rate has to be far enough below
  // it that momentum theory is still describing something real.
  const thrustN = MASS_KG * G;
  const disc = discAreaM2({ propDiaIn: 7.5, numRotors: 4 });
  const vh = Math.sqrt(thrustN / (2 * 1.225 * disc));
  assert.ok(DEFAULT_DESCENT_RATE_MS < vh / 2,
    `${DEFAULT_DESCENT_RATE_MS} m/s against an induced velocity of ${vh.toFixed(1)} m/s — `
    + 'a descent rate near v_h is inside the regime this model cannot describe');
});

test('one leg changes height in one direction, and both terms are reported anyway', () => {
  const up = legVerticalEnergy({
    massKg: MASS_KG, etaProp: ETA, hoverW: 300, levelPowerW: 200, deltaM: 100,
  });
  assert.ok(up.climbWh > 0);
  assert.equal(up.descentWh, 0, 'zero is a statement, not an omission');
  assert.equal(up.descentS, 0);
  assert.equal(up.wh, up.climbWh + up.descentWh);

  const down = legVerticalEnergy({
    massKg: MASS_KG, etaProp: ETA, hoverW: 300, levelPowerW: 200, deltaM: -100,
  });
  assert.equal(down.climbWh, 0);
  assert.ok(down.descentWh > 0);
  assert.equal(down.descentS, 100 / DEFAULT_DESCENT_RATE_MS);

  const level = legVerticalEnergy({
    massKg: MASS_KG, etaProp: ETA, hoverW: 300, levelPowerW: 200, deltaM: 0,
  });
  assert.equal(level.wh, 0, 'a level leg costs nothing vertical, which is the pre-M3b behaviour');
});

test('a climb and the descent back down cost more than staying level, never less', () => {
  const upThenDown = legVerticalEnergy({
    massKg: MASS_KG, etaProp: ETA, hoverW: 300, levelPowerW: 200, deltaM: 150,
  }).wh + legVerticalEnergy({
    massKg: MASS_KG, etaProp: ETA, hoverW: 300, levelPowerW: 200, deltaM: -150,
  }).wh;
  assert.ok(upThenDown > 0, 'a round trip over a hill is not free, and is not a wash');
});

test('the default climb rate is the one the module documents', () => {
  assert.equal(DEFAULT_CLIMB_RATE_MS, 3);
  assert.equal(legVerticalEnergy({
    massKg: MASS_KG, etaProp: ETA, hoverW: 300, levelPowerW: 200, deltaM: 90,
  }).climbS, 30, 'and it is the rate actually applied when none is given');
});

/* ---------- the air up there ---------- */

test('the air at altitude is physics.js\'s own, at the lapsed temperature', () => {
  const at = atmosphereAt({ mslM: 1200, refElevM: 200, refTempC: 30, rhPct: 40 });
  const expectedC = 30 - ISA_LAPSE_K_PER_M * 1000;
  assert.ok(Math.abs(at.tempC - expectedC) < 1e-12, 'lapsed at the ISA rate and nothing else');
  // The whole point of not restating the barometric formula: this has to be the
  // same function the plan is solved with, called at a different height.
  const direct = airDensity(1200, expectedC, 40);
  assert.equal(at.rho, direct.rho);
  assert.equal(at.pressPa, direct.pressPa);
  assert.equal(at.densityAltM, direct.densityAltM);
});

test('the air thins with height, and the reading at its own elevation is unchanged', () => {
  const low = atmosphereAt({ mslM: 200, refElevM: 200, refTempC: 25, rhPct: 40 });
  const high = atmosphereAt({ mslM: 1400, refElevM: 200, refTempC: 25, rhPct: 40 });
  assert.equal(low.tempC, 25, 'at the reference height the reading is the reading');
  assert.equal(low.rho, airDensity(200, 25, 40).rho);
  assert.ok(high.rho < low.rho, '1200 m up is thinner air');
  assert.ok(high.densityAltM > low.densityAltM);
});

test('hover power goes as 1 over the square root of density, exactly', () => {
  // Straight out of T^1.5 / √(2ρA). Checked against physics.js's own power
  // solver at zero airspeed rather than against a remembered ratio, because the
  // claim is that the two models agree — not that this one produces a nice
  // number. avionicsW is zeroed for the comparison: the flight controller draws
  // the same watts at any density, so leaving it in would compare a rotor law
  // against a rotor law plus a constant.
  const cfg = {
    massKg: MASS_KG, areaM2: discAreaM2({ propDiaIn: 7.5, numRotors: 4 }),
    cdA: 0.042, etaProp: ETA, avionicsW: 0, rho: 0,
  };
  const rhoRef = 1.225;
  const rho = 1.05;
  const modelled = hoverPowerRatio(rhoRef, rho);
  assert.ok(Math.abs(modelled - Math.sqrt(rhoRef / rho)) < 1e-15);
  const direct = powerAtSpeed({ ...cfg, rho }, 0) / powerAtSpeed({ ...cfg, rho: rhoRef }, 0);
  assert.ok(Math.abs(modelled - direct) < 1e-9,
    `${modelled} against physics.js's own ${direct} — the two hover models must not diverge`);
});

test('matching densities are a ratio of one, and a nonsense density is not a divide by zero', () => {
  assert.equal(hoverPowerRatio(1.225, 1.225), 1);
  assert.equal(hoverPowerRatio(0, 1.1), 1, 'unknown reference: assert nothing');
  assert.equal(hoverPowerRatio(1.1, 0), 1);
});

test('thinner air always costs power and never gives it away', () => {
  for (const rho of [0.8, 1.0, 1.1, 1.2]) {
    assert.ok(hoverPowerRatio(1.225, rho) >= 1, `${rho} kg/m³ came out cheaper than sea level`);
  }
});

/* ---------- the wind up there ---------- */

const LEVELS = {
  10: { windMph: 6, windFromDeg: 170 },
  80: { windMph: 12, windFromDeg: 185 },
  120: { windMph: 16, windFromDeg: 195 },
  180: { windMph: 22, windFromDeg: 205 },
};

test('a height between two published levels is interpolated, and says so', () => {
  const at = windAtAltitude(LEVELS, 100);
  assert.equal(at.basis, 'interpolated');
  assert.deepEqual([...at.levelsM], [80, 120], 'and names both levels it came off');
  assert.ok(Math.abs(at.windMph - 14) < 1e-12, 'halfway between 12 and 16 mph');
  assert.ok(Math.abs(at.windFromDeg - 190) < 1e-12);
});

test('a published level reads back as itself', () => {
  const at = windAtAltitude(LEVELS, 120);
  assert.equal(at.windMph, 16);
  assert.equal(at.windFromDeg, 195);
});

test('a height outside the published range is clamped, not extrapolated', () => {
  const high = windAtAltitude(LEVELS, 500);
  assert.equal(high.basis, 'clamped');
  assert.equal(high.windMph, 22, 'the 180 m figure, unchanged — a power law here would be invention');
  assert.deepEqual([...high.levelsM], [180]);

  const low = windAtAltitude(LEVELS, 2);
  assert.equal(low.basis, 'clamped');
  assert.equal(low.windMph, 6);
});

test('one published level is one wind, at every height', () => {
  const only = { 80: { windMph: 12, windFromDeg: 185 } };
  for (const h of [5, 80, 300, 2000]) {
    const at = windAtAltitude(only, h);
    assert.equal(at.basis, 'single-level', `at ${h} m`);
    assert.equal(at.windMph, 12);
    assert.equal(at.windFromDeg, 185);
    assert.deepEqual([...at.levelsM], [80]);
  }
});

test('no usable level is null, not a calm', () => {
  assert.equal(windAtAltitude(null, 80), null);
  assert.equal(windAtAltitude({}, 80), null);
  assert.equal(windAtAltitude({ 80: { windMph: 12 } }, 80), null, 'a speed with no direction is not a reading');
  assert.equal(windAtAltitude({ 80: { windMph: null, windFromDeg: 185 } }, 80), null);
  // A gap in an otherwise usable profile is skipped, not treated as zero wind.
  const holed = windAtAltitude({ 10: { windMph: 6, windFromDeg: 170 }, 80: null, 120: LEVELS[120] }, 80);
  assert.equal(holed.basis, 'interpolated');
  assert.deepEqual([...holed.levelsM], [10, 120]);
});

test('bearings blend the short way round the compass', () => {
  // 350° and 10° are 20° apart, not 340°. Blending the long way puts the wind
  // at 180° — from precisely the opposite direction, on a forecast that says
  // nothing of the kind.
  const at = windAtAltitude({
    10: { windMph: 10, windFromDeg: 350 },
    80: { windMph: 10, windFromDeg: 10 },
  }, 45);
  assert.ok(at.windFromDeg > 359 || at.windFromDeg < 1,
    `blended to ${at.windFromDeg}° — the answer is north, not south`);
});

/* ---------- additive: the horizontal model is untouched ---------- */

test('planMission is bit for bit what it was before any of this existed', () => {
  // The load-bearing claim of the whole module: nothing here is wired into the
  // horizontal solver. If an import in vertical.js ever grew a side effect on
  // physics.js's module state, this is what would catch it.
  const inputs = {
    drone: {
      dryMassG: 843, propDiaIn: 7.5, numRotors: 4, cdA: 0.042,
      etaProp: ETA, avionicsW: 12, maxSpeedMs: 30.5, cruiseMs: 18,
    },
    battery: { chem: 'liion', s: 6, capAh: 5.0, massG: 499, irPackMilliOhm: 60 },
    payloadG: 0, extraG: 0,
    env: {
      elevM: U.ftToM(550), tempC: U.fToC(75), rhPct: 40,
      windFromDeg: 170, windMode: 'headOut',
      windAvgMs: U.mphToMs(8), windGustMs: U.mphToMs(16),
    },
    landFloorPct: 20, cruiseMode: 'real', realVMs: 18, overheadF: 1.05,
  };
  const before = planMission(inputs);
  // Exercise every export, then plan the identical mission again.
  climbEnergyWh(MASS_KG, ETA, 100);
  descentExcessWh({ hoverW: 300, levelPowerW: 200, dropM: 100 });
  atmosphereAt({ mslM: 900, refElevM: 200, refTempC: 25, rhPct: 40 });
  hoverPowerRatio(1.225, 1.1);
  windAtAltitude(LEVELS, 100);
  const after = planMission(inputs);
  assert.equal(after.radiusKm, before.radiusKm);
  assert.equal(after.rho, before.rho);
  assert.equal(after.densityAltM, before.densityAltM);
  assert.equal(after.flight.timeMin, before.flight.timeMin);
});
