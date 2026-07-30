import test from 'node:test';
import assert from 'node:assert/strict';

import { DRONES } from '../js/catalog/drones.js';
import { BATTERIES } from '../js/catalog/batteries.js';
import { planMission, U } from '../js/physics.js';
import {
  normalizeInstance, loadPackInstances, instancesForBattery, savePackInstance,
  deletePackInstance, deletePackInstancesFor, selectedInstanceId, setSelectedInstance,
  selectedInstance, instanceBattery, highCycleCount,
} from '../js/packinstances.js';

// Same Map-backed localStorage stub the store, registry and logbook tests use:
// store.js resolves globalThis.localStorage lazily on every call, so swapping
// this in between tests is enough.
function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

const moz7 = DRONES.find(d => d.id === 'moz7v2');
const pack = BATTERIES.find(b => b.id === 'nav5000');

const inst = (over = {}) => ({
  id: 'pack-1', batteryId: pack.id, label: 'Pack #2',
  cycleCount: 180, irPackMilliOhm: null, irTempC: null, ...over,
});

/* ---------- the record gate ---------- */

test('normalizeInstance keeps a whole record and drops a broken one', () => {
  assert.deepEqual(normalizeInstance(inst({ irPackMilliOhm: 34, irTempC: 21 })), {
    id: 'pack-1', batteryId: pack.id, label: 'Pack #2',
    cycleCount: 180, irPackMilliOhm: 34, irTempC: 21,
  });
  // The three identity fields are the record; without any one of them there is
  // nothing to point at or to name.
  assert.equal(normalizeInstance(inst({ id: '' })), null);
  assert.equal(normalizeInstance(inst({ batteryId: '   ' })), null);
  assert.equal(normalizeInstance(inst({ label: '' })), null);
  assert.equal(normalizeInstance(null), null);
  assert.equal(normalizeInstance('pack'), null);
});

test('out-of-range measurements come back as "not stated", not as a refusal', () => {
  // A pack tracked by cycles alone is a legitimate instance: plenty of pilots
  // have no charger that reports resistance.
  const bookkeeping = normalizeInstance(inst());
  assert.equal(bookkeeping.irPackMilliOhm, null);
  assert.equal(bookkeeping.cycleCount, 180);
  for (const bad of [0, -4, 900, 'lots', NaN, null]) {
    assert.equal(normalizeInstance(inst({ irPackMilliOhm: bad })).irPackMilliOhm, null, String(bad));
  }
  for (const bad of [-99, 6000, 'many', NaN, null, undefined]) {
    assert.equal(normalizeInstance(inst({ cycleCount: bad })).cycleCount, null, String(bad));
  }
  assert.equal(normalizeInstance(inst({ cycleCount: 84.6 })).cycleCount, 85);
  assert.equal(normalizeInstance(inst({ irTempC: 300 })).irTempC, null);
});

/* ---------- persistence ---------- */

test('instances round-trip through storage, junk entries dropped', () => {
  globalThis.localStorage = makeStorage();
  savePackInstance(inst({ id: 'a', label: 'Fresh', irPackMilliOhm: 22 }));
  savePackInstance(inst({ id: 'b', label: 'Tired', irPackMilliOhm: 34, cycleCount: 210 }));
  savePackInstance(inst({ id: 'c', batteryId: 'other-pack', label: 'Someone else’s' }));
  assert.equal(savePackInstance({ id: 'd', batteryId: pack.id }), null, 'a nameless pack saved');

  const mine = instancesForBattery(pack.id);
  assert.deepEqual(mine.map(i => i.label), ['Fresh', 'Tired']);
  assert.equal(mine[1].irPackMilliOhm, 34);
  assert.equal(loadPackInstances().length, 3);

  // Upsert, not append: bumping a cycle count is the common edit.
  savePackInstance({ ...mine[1], cycleCount: 240 });
  assert.equal(instancesForBattery(pack.id).length, 2);
  assert.equal(instancesForBattery(pack.id).find(i => i.id === 'b').cycleCount, 240);

  // One corrupt entry loses its own row and nothing else.
  globalThis.localStorage = makeStorage({
    'fpv:v1:pack-instances': [inst({ id: 'a', label: 'Good' }), { id: 'x' }, 'nonsense'],
  });
  assert.deepEqual(loadPackInstances().map(i => i.label), ['Good']);
  globalThis.localStorage = makeStorage({ 'fpv:v1:pack-instances': { not: 'a list' } });
  assert.deepEqual(loadPackInstances(), []);
});

test('the selection is per battery id and survives a switch away and back', () => {
  globalThis.localStorage = makeStorage();
  savePackInstance(inst({ id: 'a', label: 'Pack #1' }));
  savePackInstance(inst({ id: 'z', batteryId: 'gnb1100', label: 'The other one' }));
  setSelectedInstance(pack.id, 'a');
  setSelectedInstance('gnb1100', 'z');
  assert.equal(selectedInstanceId(pack.id), 'a');
  assert.equal(selectedInstance(pack.id).label, 'Pack #1');
  assert.equal(selectedInstance('gnb1100').label, 'The other one');
  setSelectedInstance(pack.id, null);
  assert.equal(selectedInstanceId(pack.id), null);
  assert.equal(selectedInstanceId('gnb1100'), 'z', 'clearing one pack cleared another');

  // A selection pointing at an instance that no longer exists is "catalog spec",
  // not a dangling read.
  setSelectedInstance(pack.id, 'gone');
  assert.equal(selectedInstance(pack.id), null);
});

test('deleting a pack takes its selection with it', () => {
  globalThis.localStorage = makeStorage();
  savePackInstance(inst({ id: 'a', label: 'Pack #1' }));
  savePackInstance(inst({ id: 'b', label: 'Pack #2' }));
  setSelectedInstance(pack.id, 'b');
  deletePackInstance('b');
  assert.deepEqual(instancesForBattery(pack.id).map(i => i.id), ['a']);
  assert.equal(selectedInstanceId(pack.id), null, 'the plan is still pointing at a binned pack');

  // Deleting the pack model the pilot authored takes every copy of it.
  savePackInstance(inst({ id: 'c', label: 'Pack #3' }));
  setSelectedInstance(pack.id, 'c');
  deletePackInstancesFor(pack.id);
  assert.deepEqual(instancesForBattery(pack.id), []);
  assert.equal(selectedInstanceId(pack.id), null);
});

/* ---------- the overlay ---------- */

test('no instance selected leaves the catalog record exactly as written', () => {
  globalThis.localStorage = makeStorage();
  assert.equal(instanceBattery(pack), pack, 'the record was copied for nothing');
  // …and an instance with no measured resistance is bookkeeping only: the plan
  // is unchanged, but the UI still knows which pack is on the rig.
  savePackInstance(inst({ id: 'a', label: 'Pack #2' }));
  setSelectedInstance(pack.id, 'a');
  const carried = instanceBattery(pack);
  assert.equal(carried.irPackMilliOhm, pack.irPackMilliOhm);
  assert.equal(carried.packInstance.label, 'Pack #2');
  assert.equal(carried.packInstance.measured, false);
  assert.equal(carried.packInstance.specIrPackMilliOhm, pack.irPackMilliOhm);
});

test('a measured instance overrides the record without mutating the catalog literal', () => {
  globalThis.localStorage = makeStorage();
  const before = { ...pack };
  savePackInstance(inst({ id: 'a', label: 'Pack #2', irPackMilliOhm: 34, irTempC: 19 }));
  setSelectedInstance(pack.id, 'a');
  const overlaid = instanceBattery(pack);
  assert.equal(overlaid.irPackMilliOhm, 34);
  assert.equal(overlaid.packInstance.measured, true);
  assert.equal(overlaid.packInstance.irTempC, 19);
  assert.equal(overlaid.packInstance.specIrPackMilliOhm, before.irPackMilliOhm);
  assert.deepEqual(pack, before, 'the catalog record was mutated');
  // Idempotent: loadoutBattery() runs it over a record that may already have
  // been through battery().
  assert.equal(instanceBattery(overlaid), overlaid);
});

test('the overlaid resistance reaches the plan', () => {
  globalThis.localStorage = makeStorage();
  const inputs = (battery) => ({
    drone: moz7,
    battery: { ...battery, packCount: 1, extraCdA: 0 },
    payloadG: 0, payloadCdA: 0, extraG: 0,
    env: {
      elevM: 250, tempC: 22, rhPct: 45,
      windAvgMs: U.mphToMs(3), windGustMs: U.mphToMs(5),
      windMode: 'headOut', windFromDeg: 170,
    },
    landFloorPct: 20, cruiseMode: 'real', realVMs: moz7.cruiseMs, overheadF: 1.05, lite: true,
  });
  const spec = planMission(inputs(pack)).radiusKm;

  // A pack that reads 50% above its own spec: the sag model sees the aged
  // resistance, so the plan comes back shorter. This is the whole point of the
  // feature — the number physics.js reads has to be the physical pack's.
  savePackInstance(inst({
    id: 'a', label: 'Pack #2', cycleCount: 210,
    irPackMilliOhm: Math.round(pack.irPackMilliOhm * 1.5),
  }));
  setSelectedInstance(pack.id, 'a');
  const aged = planMission(inputs(instanceBattery(pack))).radiusKm;
  assert.ok(aged < spec, `the aged pack planned no shorter: ${aged} vs ${spec}`);

  // Binning it falls back to the catalog spec, exactly.
  deletePackInstance('a');
  assert.equal(planMission(inputs(instanceBattery(pack))).radiusKm, spec);
});

/* ---------- the cycle-count note ---------- */

test('high cycle counts are chemistry-shaped, and never a number the model uses', () => {
  assert.equal(highCycleCount('lipo', 200), true);
  assert.equal(highCycleCount('lihv', 149), false);
  assert.equal(highCycleCount('liion', 200), false, 'a 21700 pack is not tired at 200 cycles');
  assert.equal(highCycleCount('liion', 320), true);
  assert.equal(highCycleCount('lipo', null), false);
  assert.equal(highCycleCount('unobtainium', 9000), false);

  // §5 asks for the bookkeeping, not a derating model: cycles must not move the
  // plan on their own.
  globalThis.localStorage = makeStorage();
  savePackInstance(inst({ id: 'a', label: 'Ancient', cycleCount: 900 }));
  setSelectedInstance(pack.id, 'a');
  assert.equal(instanceBattery(pack).irPackMilliOhm, pack.irPackMilliOhm);
  assert.equal(instanceBattery(pack).capAh, pack.capAh);
});
