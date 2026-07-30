import test from 'node:test';
import assert from 'node:assert/strict';

import { DRONES } from '../src/catalog/drones.js';
import { BATTERIES } from '../src/catalog/batteries.js';
import {
  allBatteries, allDrones, allManufacturers, compatible, compatibleBatteries, dronePower,
  loadCustomDrones, saveCustomDrone, deleteCustomDrone, loadCustomBatteries,
} from '../src/registry.js';
import { validate, DRONE_FIELDS } from '../src/schema.js';
import { planMission, U } from '../src/physics.js';
// The pilot-facing form's own mapping: what "pick a class, weigh the rig, type a
// name" turns into. Imported here so the record shape the UI writes is the record
// shape these tests plan with — no hand-built fixture drifting away from it.
import { recordFromForm } from '../src/render/droneform.js';

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

// One ordinary summer-afternoon mission, so a planMission test only varies the
// drone and the pack.
const baseInputs = {
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
  landFloorPct: 20,
  cruiseMode: 'real',
  realVMs: moz7.cruiseMs,
  overheadF: 1.05,
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

test('a battery imported with fits: null loads rather than vanishing', () => {
  // schema.validate() treats a `tags`-typed field of null as blank-optional
  // and lets it through, so an imported record can carry `fits: null` — the
  // load gate has to accept that the same way it accepts `undefined`.
  globalThis.localStorage = makeStorage({
    'fpv:v1:custom-batteries': [pack({ id: 'custom-null-fits', fits: null, custom: true })],
  });
  const loaded = loadCustomBatteries();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'custom-null-fits');
  assert.equal(loaded[0].fits, undefined);
});

test('a custom manufacturer overrides the built-in it shares an id with', () => {
  globalThis.localStorage = makeStorage({
    'fpv:v1:custom-manufacturers': [{ id: 'lumenier', name: 'Lumenier (mine)' }],
  });
  const hit = allManufacturers().filter(m => m.id === 'lumenier');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].name, 'Lumenier (mine)');
});

/* ---------- custom drones ---------- */

// What the drone form produces from the smallest possible answer: a name, a
// class, and the four things a pilot can measure with a scale and their eyes.
const templateDrone = (over = {}) => recordFromForm({
  name: 'My 5" freestyle', classId: 'freestyle5',
  dryMass: 420, propDia: 5, rotors: 4, s: 6, connector: 'XT60', ...over,
});

test('a custom drone overrides the built-in it shares an id with, in place', () => {
  globalThis.localStorage = makeStorage({
    'fpv:v1:custom-drones': [{ ...moz7, dryMassG: 1234 }],
  });
  const merged = allDrones();
  assert.equal(merged.length, DRONES.length);
  assert.equal(merged.find(d => d.id === 'moz7v2').dryMassG, 1234);
  assert.equal(merged.findIndex(d => d.id === 'moz7v2'), DRONES.findIndex(d => d.id === 'moz7v2'));
});

test('a pilot-added drone appends after the catalog and is flagged custom', () => {
  globalThis.localStorage = makeStorage();
  saveCustomDrone(templateDrone());
  const merged = allDrones();
  assert.equal(merged.length, DRONES.length + 1);
  assert.equal(merged.at(-1).id, 'custom-drone-my-5-freestyle');
  assert.equal(merged.at(-1).custom, true);
});

test('saving the same id twice updates rather than duplicates, and delete removes it', () => {
  globalThis.localStorage = makeStorage();
  saveCustomDrone(templateDrone());
  saveCustomDrone(templateDrone({ dryMass: 455 }));
  assert.equal(loadCustomDrones().length, 1);
  assert.equal(loadCustomDrones()[0].dryMassG, 455);
  deleteCustomDrone('custom-drone-my-5-freestyle');
  assert.deepEqual(loadCustomDrones(), []);
  assert.equal(allDrones().length, DRONES.length);
});

test('the per-record gate drops an incomplete airframe and keeps the rest', () => {
  // Every field the gate checks is one planMission reads without a fallback, so
  // anything that survives it can be planned — the whole point of the filter.
  globalThis.localStorage = makeStorage({
    'fpv:v1:custom-drones': [
      { ...templateDrone(), id: 'good' },
      { ...templateDrone(), id: 'no-mass', dryMassG: undefined },
      { ...templateDrone(), id: 'no-rotors', numRotors: 0 },
      { ...templateDrone(), id: 'no-connector', connector: '' },
      { ...templateDrone(), id: 'no-eta', etaProp: null },
      null,
      'not a record',
    ],
  });
  assert.deepEqual(loadCustomDrones().map(d => d.id), ['good']);
});

test('a corrupt custom-drones blob leaves the hangar at the catalog', () => {
  globalThis.localStorage = makeStorage({ 'fpv:v1:custom-drones': { nope: true } });
  assert.deepEqual(loadCustomDrones(), []);
  assert.equal(allDrones().length, DRONES.length);
});

test('a class-template drone is a complete record by the schema’s own rules', () => {
  globalThis.localStorage = makeStorage();
  const rec = templateDrone();
  const { ok, errors } = validate(rec, DRONE_FIELDS);
  assert.equal(ok, true, JSON.stringify(errors));
  // No propulsion block: the form never asks, because a pilot has no way to know
  // motor and ESC limits. liftEnvelope() answers that with `unknown`.
  assert.equal(rec.propulsion, undefined);
  assert.equal(rec.confidence, 'estimated');
});

test('a custom 6S XT60 rig picks up the catalog’s 6S XT60 packs by computed match', () => {
  // §7.2, the whole reason compatibility stopped being a hardcoded fits list:
  // those packs are pinned to moz7v2 and nothing else, and a rig the pilot added
  // five minutes ago still gets every one of them.
  globalThis.localStorage = makeStorage();
  const rec = templateDrone();
  const fits = compatibleBatteries(rec);
  const expected = BATTERIES.filter(b => b.s === 6 && b.connector === 'XT60').map(b => b.id);
  assert.deepEqual(fits.map(b => b.id), expected);
  assert.ok(expected.length > 1);
  for (const b of fits) assert.equal(b.fits.includes(rec.id), false, 'matched by pin, not by numbers');
});

test('planMission runs a class-template drone end to end without throwing', () => {
  globalThis.localStorage = makeStorage();
  const rec = templateDrone();
  const batt = compatibleBatteries(rec)[0];
  let r;
  assert.doesNotThrow(() => { r = planMission({ ...baseInputs, drone: rec, battery: batt }); });
  assert.ok(r.radiusKm > 0);
  assert.ok(r.timeMin > 0);
  // The energy half of the plan is real; the lift ceiling is simply unmodeled,
  // and says so rather than inventing a number.
  assert.equal(r.flight.code, 'unknown');
  assert.equal(r.flight.viable, true);
});

test('a custom rig nothing fits reaches the handled no_battery path', () => {
  globalThis.localStorage = makeStorage();
  // 12S on an XT90 — a real cinelifter shape, and no pack in the catalog is close.
  const rec = templateDrone({ name: 'Orphan lifter', classId: 'cinelifter10', s: 12, connector: 'XT90' });
  assert.deepEqual(compatibleBatteries(rec), []);
  assert.equal(planMission({ ...baseInputs, drone: rec, battery: undefined }).code, 'no_battery');
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
  const inp = baseInputs;
  assert.ok(planMission(inp).radiusKm > 0); // the fixture is a real plan

  let r;
  assert.doesNotThrow(() => { r = planMission({ ...inp, battery: undefined }); });
  assert.equal(r.code, 'no_battery');
  assert.deepEqual(r.warnings, []);
  assert.equal(planMission({ ...inp, battery: null }).code, 'no_battery');
});
