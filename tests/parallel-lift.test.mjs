import test from 'node:test';
import assert from 'node:assert/strict';

import { DRONES, BATTERIES } from '../js/data.js';
import { airDensity, discAreaM2, liftEnvelope, parallelBattery, planMission, U } from '../js/physics.js';

const moz7 = DRONES.find(d => d.id === 'moz7v2');
const cinelog = DRONES.find(d => d.id === 'cinelog30v3');
const nav5000 = BATTERIES.find(b => b.id === 'nav5000');
const gnb850lr = BATTERIES.find(b => b.id === 'gnb850lr');

function calmInputs(drone, battery, overrides = {}) {
  return {
    drone,
    battery,
    payloadG: 0,
    payloadCdA: 0,
    extraG: 0,
    env: {
      elevM: U.ftToM(800),
      tempC: U.fToC(75),
      rhPct: 40,
      windAvgMs: U.mphToMs(3),
      windGustMs: U.mphToMs(5),
      windMode: 'headOut',
      windFromDeg: 170,
    },
    landFloorPct: 20,
    cruiseMode: 'real',
    realVMs: drone.cruiseMs,
    overheadF: 1.05,
    ...overrides,
  };
}

test('parallelBattery preserves voltage while combining identical packs', () => {
  const dual = parallelBattery(nav5000, 2, {
    harnessMassG: moz7.parallelHarnessMassG,
    extraCdA: moz7.parallelPackCdA,
  });
  assert.equal(dual.s, nav5000.s);
  assert.equal(dual.p, nav5000.p * 2);
  assert.equal(dual.capAh, nav5000.capAh * 2);
  assert.equal(dual.massG, nav5000.massG * 2 + moz7.parallelHarnessMassG);
  assert.equal(dual.irPackMilliOhm, nav5000.irPackMilliOhm / 2);
  assert.equal(dual.maxContA, nav5000.maxContA * 2);
  assert.equal(dual.priceUsd, nav5000.priceUsd * 2);
  assert.equal(dual.packCount, 2);
  assert.equal(dual.config, '6S2P');
});

test('parallelizing an internally parallel pack multiplies its effective P count', () => {
  const nav10000 = BATTERIES.find(b => b.id === 'nav10000');
  assert.equal(parallelBattery(nav10000, 2).config, '6S4P');
});

test('a second pack increases AUW, disc loading, energy, and lift capability', () => {
  const single = planMission(calmInputs(moz7, nav5000));
  const dualPack = parallelBattery(nav5000, 2, {
    harnessMassG: moz7.parallelHarnessMassG,
    extraCdA: moz7.parallelPackCdA,
  });
  const dual = planMission(calmInputs(moz7, dualPack));
  assert.ok(dual.massKg > single.massKg);
  assert.ok(dual.discLoadingGcm2 > single.discLoadingGcm2);
  assert.ok(dual.energy.packWh > single.energy.packWh);
  assert.ok(dual.flight.maxHoverMassG > single.flight.maxHoverMassG);
  assert.ok(dual.radiusKm > single.radiusKm);
});

test('lift envelope reports its limiting component and finite thrust margin', () => {
  const { rho } = airDensity(U.ftToM(800), U.fToC(75), 40);
  const massKg = (moz7.dryMassG + nav5000.massG) / 1000;
  const lift = liftEnvelope({
    drone: moz7,
    battery: nav5000,
    rho,
    areaM2: discAreaM2(moz7),
    tempC: U.fToC(75),
    massKg,
  });
  assert.equal(lift.limitingComponent, 'battery');
  assert.ok(Number.isFinite(lift.maxHoverMassG));
  assert.ok(lift.thrustToWeight > 1);
  assert.equal(lift.estimated, true);
});

test('a cold, high-IR pack is classified as pack-sag limited, not motor', () => {
  const { rho } = airDensity(U.ftToM(800), U.fToC(-20), 40);
  const coldBatt = { ...nav5000, irPackMilliOhm: 400 };
  const massKg = (moz7.dryMassG + coldBatt.massG) / 1000;
  const lift = liftEnvelope({
    drone: moz7,
    battery: coldBatt,
    rho,
    areaM2: discAreaM2(moz7),
    tempC: U.fToC(-20),
    massKg,
  });
  assert.equal(lift.limitingComponent, 'pack sag');
});

test('a warm pack where sag does not bind keeps the battery-limited label', () => {
  const { rho } = airDensity(U.ftToM(800), U.fToC(75), 40);
  const massKg = (moz7.dryMassG + nav5000.massG) / 1000;
  const lift = liftEnvelope({
    drone: moz7,
    battery: nav5000,
    rho,
    areaM2: discAreaM2(moz7),
    tempC: U.fToC(75),
    massKg,
  });
  assert.equal(lift.limitingComponent, 'battery');
});

test('an over-limit load is marked WILL NOT FLY and produces no mission', () => {
  const mountainEnv = {
    elevM: U.ftToM(10_000),
    tempC: U.fToC(45),
    rhPct: 30,
    windAvgMs: U.mphToMs(15),
    windGustMs: U.mphToMs(25),
    windMode: 'headOut',
    windFromDeg: 260,
  };
  const result = planMission(calmInputs(cinelog, gnb850lr, {
    payloadG: 207,
    payloadCdA: 0.010,
    extraG: 500,
    env: mountainEnv,
  }));
  assert.equal(result.flight.code, 'no_lift');
  assert.equal(result.flight.viable, false);
  assert.ok(result.flight.thrustToWeight < 1);
  assert.equal(result.radiusKm, 0);
  assert.equal(result.timeMin, 0);
  assert.equal(result.timeline.length, 0);
  assert.ok(result.warnings.some(w => w.text.startsWith('WILL NOT FLY:')));
});
