import test from 'node:test';
import assert from 'node:assert/strict';

import { DRONES } from '../js/catalog/drones.js';
import { BATTERIES } from '../js/catalog/batteries.js';
import {
  allBatteries, allManufacturers, compatible, compatibleBatteries, dronePower,
} from '../js/registry.js';
import { planMission, U } from '../js/physics.js';

// Same Map-backed localStorage stub the store tests use. registry.js reads
// through store.js, which resolves globalThis.localStorage lazily on every
// call, so swapping this in between tests is enough — no fresh imports needed.
function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

const moz7 = DRONES.find(d => d.id === 'moz7v2');
const cinelog = DRONES.find(d => d.id === 'cinelog30v3');
const nav5000 = BATTERIES.find(b => b.id === 'nav5000');

// A pack shaped like a catalog record, so the predicate is the only variable.
const pack = (over = {}) => ({
  id: 'testpack', name: 'Test pack', chem: 'lipo', s: 6, p: 1,
  capAh: 3, massG: 400, irPackMilliOhm: 30, maxContA: 60,
  connector: 'XT60', manufacturerId: 'custom', ...over,
});

// A rig that accepts a 4S–6S XT60 pack of any weight.
const rig = {
  id: 'testrig', name: 'Test rig', connector: 'XT60', s: 6,
  power: { connectors: ['XT60'], sMin: 4, sMax: 6, maxPackMassG: null },
};

/* ---------- merge precedence ---------- */

test('a custom record overrides the built-in it shares an id with, in place', () => {
  globalThis.localStorage = makeStorage({
    'fpv:v1:custom-batteries': [{
      ...nav5000, massG: 512, custom: true, // the pilot weighed their own
    }],
  });
  const merged = allBatteries();
  assert.equal(merged.length, BATTERIES.length, 'override must not add a duplicate row');
  const hit = merged.filter(b => b.id === 'nav5000');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].massG, 512);
  assert.equal(hit[0].custom, true);
  // and it keeps the catalog's position rather than jumping to the end
  assert.equal(merged.findIndex(b => b.id === 'nav5000'),
               BATTERIES.findIndex(b => b.id === 'nav5000'));
});

test('a genuinely new custom record appends after the catalog', () => {
  globalThis.localStorage = makeStorage({
    'fpv:v1:custom-batteries': [pack({ id: 'custom-mine', fits: ['moz7v2'], custom: true })],
  });
  const merged = allBatteries();
  assert.equal(merged.length, BATTERIES.length + 1);
  assert.equal(merged.at(-1).id, 'custom-mine');
});

test('a custom manufacturer overrides the built-in it shares an id with', () => {
  globalThis.localStorage = makeStorage({
    'fpv:v1:custom-manufacturers': [{ id: 'lumenier', name: 'Lumenier (mine)' }],
  });
  const hit = allManufacturers().filter(m => m.id === 'lumenier');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].name, 'Lumenier (mine)');
});

/* ---------- compatibility truth table ---------- */

test('an explicit fits pin wins outright, whatever the numbers say', () => {
  // Wrong connector, wrong cell count, and still compatible: the pin is the
  // record author saying they verified this pairing by hand.
  assert.equal(compatible(rig, pack({ connector: 'XT30', s: 3, fits: ['testrig'] })), true);
});

test('no pin: matching connector and an in-range cell count is compatible', () => {
  assert.equal(compatible(rig, pack({ s: 4 })), true);
  assert.equal(compatible(rig, pack({ s: 6 })), true);
});

test('no pin: a connector the rig does not accept is not compatible', () => {
  assert.equal(compatible(rig, pack({ connector: 'XT30' })), false);
  // a pin for some *other* drone does not help
  assert.equal(compatible(rig, pack({ connector: 'XT30', fits: ['moz7v2'] })), false);
});

test('no pin: a cell count outside the rig’s range is not compatible', () => {
  assert.equal(compatible(rig, pack({ s: 3 })), false);
  assert.equal(compatible(rig, pack({ s: 7 })), false);
});

test('a pack heavier than a finite maxPackMassG is not compatible', () => {
  const strapped = { ...rig, power: { ...rig.power, maxPackMassG: 350 } };
  assert.equal(compatible(strapped, pack({ massG: 350 })), true);
  assert.equal(compatible(strapped, pack({ massG: 351 })), false);
});

test('maxPackMassG null never hides a pack, however absurd its weight', () => {
  // The lift pin (§7.2): compatibility must not encode thrust. A pack this rig
  // cannot possibly lift still belongs in the list, wearing liftEnvelope's
  // WILL NOT FLY label — a pack that silently vanishes teaches the pilot
  // nothing, and they already own it.
  assert.equal(rig.power.maxPackMassG, null);
  assert.equal(compatible(rig, pack({ massG: 25_000 })), true);
});

test('a drone with no power block falls back to its own connector and cell count', () => {
  const legacy = { id: 'legacyrig', connector: 'XT30', s: 4 };
  assert.deepEqual(dronePower(legacy),
    { connectors: ['XT30'], sMin: 4, sMax: 4, maxPackMassG: null });
  assert.equal(compatible(legacy, pack({ connector: 'XT30', s: 4 })), true);
  assert.equal(compatible(legacy, pack({ connector: 'XT30', s: 6 })), false);
  assert.equal(compatible(legacy, pack({ connector: 'XT60', s: 4 })), false);
});

test('compatible() is false rather than throwing when either side is missing', () => {
  assert.equal(compatible(null, pack()), false);
  assert.equal(compatible(rig, undefined), false);
});

/* ---------- no regression in the shipped pairings ---------- */

test('every built-in drone gets exactly the packs the old fits filter gave it', () => {
  globalThis.localStorage = makeStorage(); // catalog only
  for (const d of DRONES) {
    const oldWay = BATTERIES.filter(b => b.fits.includes(d.id)).map(b => b.id);
    const newWay = compatibleBatteries(d).map(b => b.id);
    assert.deepEqual(newWay, oldWay, `${d.id} pairings changed`);
    assert.ok(oldWay.length > 0, `${d.id} has no packs — the fixture is wrong`);
  }
});

test('the two built-in rigs still do not share a single pack', () => {
  globalThis.localStorage = makeStorage();
  const a = new Set(compatibleBatteries(moz7).map(b => b.id));
  const b = compatibleBatteries(cinelog).map(x => x.id);
  assert.ok(b.every(id => !a.has(id)));
});

/* ---------- the handled missing-battery path ---------- */

test('planMission returns a handled no_battery code instead of throwing', () => {
  const inp = {
    drone: moz7,
    battery: nav5000,
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
    reservePct: 20,
    cruiseMode: 'real',
    realVMs: moz7.cruiseMs,
    overheadF: 1.05,
  };
  assert.ok(planMission(inp).radiusKm > 0); // the fixture is a real plan

  let r;
  assert.doesNotThrow(() => { r = planMission({ ...inp, battery: undefined }); });
  assert.equal(r.code, 'no_battery');
  assert.deepEqual(r.warnings, []);
  assert.equal(planMission({ ...inp, battery: null }).code, 'no_battery');
});
