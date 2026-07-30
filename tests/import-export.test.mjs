import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHARE_VERSION, applyPlan, buildPayload, describePlan, planImport, planIsEmpty, planSkips,
  readPayload,
} from '../js/share.js';
import {
  allDrones,
  loadCustomBatteries, loadCustomDrones, loadCustomManufacturers,
} from '../js/registry.js';
import { fitForDrone, loadFlightLogs, logsForDrone } from '../js/flightlog.js';
// The pilot-facing form's own mapping, for the same reason registry.test.mjs uses
// it: the record shape these tests share is the record shape the UI writes.
import { recordFromForm } from '../js/render/droneform.js';

// Same Map-backed localStorage stub the store and registry tests use — store.js
// resolves globalThis.localStorage lazily on every call, so swapping it in
// between tests is enough.
function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

/* ---------- fixtures ---------- */

const DRONE_ID = 'custom-drone-my-5-freestyle';
const PACK_ID = 'custom-manufacturer-mine-6s-4000';
const BRAND_ID = 'manufacturer-mine';

const droneRecord = (over = {}) => ({
  ...recordFromForm({
    name: 'My 5" freestyle', classId: 'freestyle5',
    dryMass: 420, propDia: 5, rotors: 4, s: 6, connector: 'XT60',
  }),
  ...over,
});

// What app.js's battery-form handler writes, verbatim in shape.
const packRecord = (over = {}) => ({
  id: PACK_ID,
  name: 'Mine 6S 4000', short: 'Mine 6S 4000',
  chem: 'lipo', s: 6, p: 1,
  capAh: 4, massG: 520, irPackMilliOhm: 25, maxContA: 60,
  connector: 'XT60',
  manufacturerId: BRAND_ID,
  cellMaker: 'EVE', cellModel: '50PL', config: '6S1P',
  // Provenance that has to survive the trip (§6.3).
  estimated: ['irPackMilliOhm'],
  priceUsd: 90,
  custom: true,
  ...over,
});

const brandRecord = (over = {}) => ({
  id: BRAND_ID, name: 'Mine', url: 'https://example.com', custom: true, kind: 'custom-builder', ...over,
});

const logRecord = (over = {}) => ({
  id: 'log-hover-1',
  droneId: DRONE_ID,
  batteryId: PACK_ID,
  kind: 'hover',
  minutes: 6.5,
  // A flight the model believes: 800 mAh back in after a 6.5-minute hover on this
  // pack solves to η ≈ 0.48, inside the 5" freestyle range — so the fit this
  // logbook adds up to is a real number to check on the far side of the trip.
  mahIn: 800,
  landedSocPct: null,
  payloadG: 0, payloadCdA: 0, extraG: 0,
  avgSpeedMs: null, distanceKm: null,
  windMs: 0, windRelation: 'mixed',
  tempC: 21, elevM: 250, rhPct: 45,
  at: '2026-07-01T18:30',
  notes: 'new props',
  solved: { field: 'etaProp', value: 0.478, ok: true, reason: null },
  ...over,
});

/** A hangar with one of everything the pilot could have authored. */
function seedFullHangar(extra = {}) {
  globalThis.localStorage = makeStorage({
    'fpv:v1:custom-manufacturers': [brandRecord()],
    'fpv:v1:custom-drones': [droneRecord()],
    'fpv:v1:custom-batteries': [packRecord()],
    'fpv:v1:flight-logs': [logRecord()],
    ...extra,
  });
}

/* ---------- export shape ---------- */

test('an export carries only the pilot’s own records, brands included', () => {
  seedFullHangar();
  const payload = buildPayload();
  assert.equal(payload.version, SHARE_VERSION);
  assert.deepEqual(payload.drones.map(d => d.id), [DRONE_ID]);
  assert.deepEqual(payload.batteries.map(b => b.id), [PACK_ID]);
  // The brand rides along or the shared pack arrives orphaned.
  assert.deepEqual(payload.manufacturers, [{ id: BRAND_ID, name: 'Mine', url: 'https://example.com' }]);
  assert.equal(payload.flightLogs.length, 1);
  // No catalog record is ever in the file: the receiving planner already has them.
  assert.equal(payload.drones.length, 1);
  assert.ok(allDrones().length > 1);
});

test('flight logs are optional in the payload', () => {
  seedFullHangar();
  assert.equal(buildPayload({ includeLogs: true }).flightLogs.length, 1);
  assert.deepEqual(buildPayload({ includeLogs: false }).flightLogs, []);
  // …and leaving them out changes nothing else.
  assert.deepEqual(buildPayload({ includeLogs: false }).drones, buildPayload().drones);
});

test('timestamps are stripped by default and opt back in by checkbox', () => {
  seedFullHangar();
  assert.equal(buildPayload().flightLogs[0].at, null);
  assert.equal(buildPayload({ includeTimestamps: true }).flightLogs[0].at, '2026-07-01T18:30');
  // Nothing adds an export date either — a file whose point is not carrying a
  // timestamp must not grow one.
  assert.equal('exportedAt' in buildPayload(), false);
  assert.equal('at' in buildPayload().drones[0], false);
});

test('coordinates never reach the file, at any depth', () => {
  seedFullHangar({
    'fpv:v1:custom-drones': [{ ...droneRecord(), lat: 30.27, lng: -97.74 }],
    'fpv:v1:flight-logs': [{ ...logRecord(), lat: 30.27, lng: -97.74 }],
  });
  const text = JSON.stringify(buildPayload({ includeTimestamps: true }));
  assert.equal(/"(lat|lng|lon|latitude|longitude|coords|coordinates)"/.test(text), false, text);
  assert.equal(text.includes('30.27'), false);
  // and the records themselves still arrived
  const payload = buildPayload();
  assert.equal(payload.drones.length, 1);
  assert.equal(payload.flightLogs.length, 1);
});

/* ---------- round trip ---------- */

test('export → import into an empty hangar gives the same records back', () => {
  seedFullHangar();
  const payload = buildPayload({ includeTimestamps: true });
  const before = {
    drones: loadCustomDrones(),
    batteries: loadCustomBatteries(),
    manufacturers: loadCustomManufacturers(),
    logs: loadFlightLogs(),
  };

  globalThis.localStorage = makeStorage(); // a stranger's planner: catalog only
  const plan = planImport(readPayload(JSON.stringify(payload)).payload);
  assert.equal(planIsEmpty(plan), false);
  assert.deepEqual(planSkips(plan), []);
  // Nothing is written until confirm.
  assert.deepEqual(loadCustomDrones(), []);
  assert.deepEqual(loadFlightLogs(), []);

  assert.deepEqual(applyPlan(plan), { manufacturers: 1, drones: 1, batteries: 1, logs: 1 });
  assert.deepEqual(loadCustomDrones(), before.drones);
  assert.deepEqual(loadCustomBatteries(), before.batteries);
  assert.deepEqual(loadCustomManufacturers(), before.manufacturers);
  assert.deepEqual(loadFlightLogs(), before.logs);
});

test('provenance survives: the imported rig’s own fit is the fit it was exported with', () => {
  seedFullHangar();
  const source = fitForDrone(loadCustomDrones()[0]);
  assert.equal(source.nLogs, 1);
  // A real accepted fit on the exporting side, or the comparison below would be
  // two nulls agreeing with each other.
  assert.equal(source.nFlights, 1);
  assert.ok(source.etaProp.value > 0.3 && source.etaProp.value < 0.9, JSON.stringify(source.etaProp));
  const payload = buildPayload({ includeTimestamps: true });

  globalThis.localStorage = makeStorage();
  applyPlan(planImport(payload));
  const imported = loadCustomDrones()[0];
  const fit = fitForDrone(imported);
  assert.equal(logsForDrone(imported.id).length, 1);
  assert.deepEqual(
    { etaProp: fit.etaProp, cdA: fit.cdA, nFlights: fit.nFlights, tier: fit.tier },
    { etaProp: source.etaProp, cdA: source.cdA, nFlights: source.nFlights, tier: source.tier },
  );
  // The estimated flags and the source link came through untouched.
  assert.deepEqual(loadCustomBatteries()[0].estimated, ['irPackMilliOhm']);
  assert.equal(loadCustomManufacturers()[0].url, 'https://example.com');
  assert.equal(imported.confidence, 'estimated');
});

/* ---------- never overwrite ---------- */

test('a colliding id is renamed and every reference in the payload follows it', () => {
  seedFullHangar();
  const payload = buildPayload({ includeTimestamps: true });
  // The battery pins the drone by hand and names the brand, and the log points at
  // both — so all four references have to move together.
  payload.batteries[0].fits = [DRONE_ID, 'moz7v2'];

  // Importing the same file back over the live hangar: every id collides.
  const plan = planImport(payload);
  assert.deepEqual(plan.drones.kept.map(e => [e.originalId, e.id]),
    [[DRONE_ID, `${DRONE_ID}-imported`]]);
  assert.deepEqual(plan.batteries.kept.map(e => [e.originalId, e.id]),
    [[PACK_ID, `${PACK_ID}-imported`]]);
  assert.deepEqual(plan.manufacturers.kept.map(e => [e.originalId, e.id]),
    [[BRAND_ID, `${BRAND_ID}-imported`]]);
  assert.deepEqual(plan.logs.kept.map(e => [e.originalId, e.id]),
    [['log-hover-1', 'log-hover-1-imported']]);

  const pack = plan.batteries.kept[0].record;
  assert.deepEqual(pack.fits, [`${DRONE_ID}-imported`, 'moz7v2'], 'a pin outside the payload is left alone');
  assert.equal(pack.manufacturerId, `${BRAND_ID}-imported`);
  const log = plan.logs.kept[0].record;
  assert.equal(log.droneId, `${DRONE_ID}-imported`);
  assert.equal(log.batteryId, `${PACK_ID}-imported`);

  applyPlan(plan);
  // Nothing was overwritten: the originals are still there, unchanged.
  assert.deepEqual(loadCustomDrones().map(d => d.id), [DRONE_ID, `${DRONE_ID}-imported`]);
  assert.equal(loadCustomDrones()[0].dryMassG, 420);
  assert.deepEqual(loadCustomBatteries().map(b => b.id), [PACK_ID, `${PACK_ID}-imported`]);
  assert.deepEqual(loadFlightLogs().map(l => l.id).sort(), ['log-hover-1', 'log-hover-1-imported']);
  // The imported rig's logbook is its own, not a copy of the original's.
  assert.equal(logsForDrone(DRONE_ID).length, 1);
  assert.equal(logsForDrone(`${DRONE_ID}-imported`).length, 1);
});

test('importing the same file a third time numbers the rename rather than colliding', () => {
  seedFullHangar();
  const payload = buildPayload();
  applyPlan(planImport(payload));
  const plan = planImport(payload);
  assert.equal(plan.drones.kept[0].id, `${DRONE_ID}-imported-2`);
  applyPlan(plan);
  assert.deepEqual(loadCustomDrones().map(d => d.id),
    [DRONE_ID, `${DRONE_ID}-imported`, `${DRONE_ID}-imported-2`]);
});

test('a collision with a built-in catalog record renames too', () => {
  globalThis.localStorage = makeStorage();
  const plan = planImport({
    version: 1,
    drones: [{ ...droneRecord(), id: 'moz7v2', name: 'A stranger’s MOZ7' }],
  });
  assert.equal(plan.drones.kept[0].id, 'moz7v2-imported');
  applyPlan(plan);
  assert.equal(allDrones().find(d => d.id === 'moz7v2').name.includes('stranger'), false);
});

/* ---------- refusals ---------- */

test('malformed JSON is refused with a reason and nothing is read', () => {
  globalThis.localStorage = makeStorage();
  const got = readPayload('{ "version": 1, drones: [oops');
  assert.equal(got.ok, false);
  assert.match(got.error, /isn’t valid JSON/);
  assert.equal(got.payload, undefined);
  assert.equal(readPayload('[1,2,3]').ok, false);
  assert.equal(readPayload('null').ok, false);
});

test('an unknown or missing schema version is refused, and named', () => {
  const future = readPayload(JSON.stringify({ version: 2, drones: [] }));
  assert.equal(future.ok, false);
  assert.match(future.error, /version 2/);
  assert.match(future.error, /version 1 only/);

  const none = readPayload(JSON.stringify({ drones: [] }));
  assert.equal(none.ok, false);
  assert.match(none.error, /no version at all/);

  const junk = readPayload(JSON.stringify({ version: 'one', drones: [] }));
  assert.equal(junk.ok, false);
  assert.match(junk.error, /"one"/);

  assert.equal(readPayload(JSON.stringify({ version: 1, drones: [] })).ok, true);
});

test('one invalid record is skipped with a reason and never blocks the rest', () => {
  globalThis.localStorage = makeStorage();
  const plan = planImport({
    version: 1,
    manufacturers: [brandRecord(), { name: 'no id here' }],
    drones: [
      droneRecord({ id: 'good-rig', name: 'Good rig' }),
      droneRecord({ id: 'no-mass', name: 'No mass', dryMassG: undefined }),
      droneRecord({ id: 'silly-eta', name: 'Silly eta', etaProp: 4 }),
      'not a record',
      null,
    ],
    batteries: [packRecord(), packRecord({ id: 'bad-chem', chem: 'nuclear' })],
    flightLogs: [logRecord({ droneId: 'good-rig' }), { id: 'log-empty' }],
  });

  assert.deepEqual(plan.drones.kept.map(e => e.id), ['good-rig']);
  assert.deepEqual(plan.drones.skipped.map(s => s.originalId),
    ['no-mass', 'silly-eta', 'record 4', 'record 5']);
  assert.match(plan.drones.skipped[0].reason, /Dry weight/);
  assert.match(plan.drones.skipped[1].reason, /at most 0\.9/);
  assert.match(plan.drones.skipped[2].reason, /not a drone record/);
  assert.deepEqual(plan.batteries.kept.map(e => e.id), [PACK_ID]);
  assert.match(plan.batteries.skipped[0].reason, /Chemistry/);
  assert.deepEqual(plan.manufacturers.skipped.map(s => s.reason), ['a brand needs an id and a name.']);
  assert.deepEqual(plan.logs.kept.map(e => e.id), ['log-hover-1']);
  assert.match(plan.logs.skipped[0].reason, /not a usable flight/);

  // The good records really do land, and the skipped ones really don't.
  applyPlan(plan);
  assert.deepEqual(loadCustomDrones().map(d => d.id), ['good-rig']);
  assert.deepEqual(loadCustomBatteries().map(b => b.id), [PACK_ID]);
  assert.deepEqual(loadFlightLogs().map(l => l.id), ['log-hover-1']);
});

test('a payload with nothing usable in it plans as empty rather than as an import', () => {
  globalThis.localStorage = makeStorage();
  const plan = planImport({ version: 1, drones: [{ id: 'junk' }] });
  assert.equal(planIsEmpty(plan), true);
  assert.equal(planIsEmpty(planImport({ version: 1 })), true);
  assert.equal(describePlan(planImport({ version: 1 })), 'Nothing in that file — no drones, packs or flights to add.');
});

test('unknown keys in a shared record never reach storage', () => {
  globalThis.localStorage = makeStorage();
  const plan = planImport({
    version: 1,
    drones: [{ ...droneRecord(), evil: '<script>', savedAt: 12345, calibration: { fields: ['etaProp'] } }],
  });
  const rec = plan.drones.kept[0].record;
  assert.equal('evil' in rec, false);
  assert.equal('savedAt' in rec, false);
  assert.equal('calibration' in rec, false);
  assert.equal(rec.custom, true);
});

/* ---------- the diff sentence ---------- */

test('the diff names each rename and counts each skip', () => {
  seedFullHangar();
  const payload = buildPayload();
  payload.drones.push(droneRecord({ id: 'brand-new', name: 'Brand new' }));
  payload.drones.push({ id: 'broken', name: 'Broken' });
  const plan = planImport(payload);
  const line = describePlan(plan);
  assert.match(line, /2 drones \(1 renamed: ‘custom-drone-my-5-freestyle’ → ‘custom-drone-my-5-freestyle-imported’; 1 skipped\)/);
  assert.match(line, /1 battery \(1 renamed/);
  assert.match(line, /1 flight log \(1 renamed/);
  assert.deepEqual(planSkips(plan).map(s => s.kind), ['drone']);
});
