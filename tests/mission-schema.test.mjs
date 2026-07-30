import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MISSION_SCHEMA_VERSION, ID_PREFIXES, LAUNCH_NODE,
  createMission, validateMission,
  aircraftSnapshot, batterySnapshot, payloadSnapshot,
  defaultAltitude, defaultSpeedPolicy,
} from '../src/domain/mission/mission-schema.js';
import { migrateMission } from '../src/domain/mission/mission-migrations.js';

/* MissionDocumentV1 (ADR 0002) is a frozen contract, so these tests are written
 * against the contract rather than the implementation: what a fresh mission is,
 * what the validator refuses to call a mission at all, what it merely flags as
 * incomplete, and what happens at the one door an untrusted record comes
 * through. The load-bearing distinction throughout is errors vs warnings — a
 * document with an unresolved altitude still loads; a document whose segments
 * point at waypoints that are not there does not. */

const AUSTIN = { latitude: 30.2672, longitude: -97.7431, elevationMslM: 168 };

/** Deterministic identity and clock: `msn_1`, `wpt_2`, … and a ticking instant. */
function harness() {
  let ids = 0;
  let ticks = 0;
  return {
    idgen: (prefix) => `${prefix}_${++ids}`,
    now: () => new Date(Date.UTC(2026, 6, 30, 12, 0, ticks++)).toISOString(),
  };
}

const freshMission = (opts = {}, deps = harness()) =>
  createMission({ launch: AUSTIN, title: 'Pedernales ridge run', ...opts }, deps);

/** Codes only — the messages are prose and tests should not pin prose. */
const codes = (issues) => issues.map((i) => i.code);

/* ---------- 1. what a fresh mission is ---------- */

test('createMission mints a complete, valid v1 document', () => {
  const doc = freshMission();
  assert.equal(doc.schemaVersion, MISSION_SCHEMA_VERSION);
  assert.equal(doc.id, 'msn_1');
  assert.equal(doc.title, 'Pedernales ridge run');
  assert.equal(doc.createdAt, doc.updatedAt);
  assert.deepEqual(doc.launch, AUSTIN);
  assert.deepEqual(doc.route, {
    waypoints: [], segments: [], returnPolicy: { mode: 'direct', altitude: null },
  });
  assert.deepEqual(doc.planningPolicy, {
    reserve: { landFloorPct: 20 }, gustFactor: 0.35, windLevel: 80, radioBand: '5g8',
  });
  assert.deepEqual(doc.scene, { subjects: [], cameraProfile: null });
  assert.equal(doc.provenance.origin, 'authored');
  assert.equal(validateMission(doc).ok, true);
});

test('createMission takes its identity and its clock from deps', () => {
  const a = freshMission();
  const b = freshMission();
  assert.equal(a.id, b.id, 'a fresh harness restarts the sequence — ids are the injected ones');
  const shared = harness();
  assert.equal(freshMission({}, shared).id, 'msn_1');
  assert.equal(freshMission({}, shared).id, 'msn_2');
});

test('createMission refuses to invent a launch point', () => {
  assert.throws(() => createMission({}, harness()), TypeError);
  assert.throws(() => createMission({ launch: { latitude: 30 } }, harness()), TypeError);
  assert.throws(
    () => createMission({ launch: { latitude: 30, longitude: Number.NaN } }, harness()), TypeError);
});

test('an unknown launch elevation stays null rather than becoming sea level', () => {
  const doc = createMission({ launch: { latitude: 30.2, longitude: -97.7 } }, harness());
  assert.equal(doc.launch.elevationMslM, null);
  const verdict = validateMission(doc);
  assert.equal(verdict.ok, true);
  assert.ok(codes(verdict.warnings).includes('W-LAUNCH-ELEV-UNKNOWN'));
});

test('an empty mission is flagged as incomplete without being invalid', () => {
  const verdict = validateMission(freshMission());
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.errors, []);
  assert.deepEqual(
    codes(verdict.warnings).filter((c) => c === 'W-LOADOUT-MISSING').length, 3,
    'aircraft, battery and payload are each reported missing');
  assert.ok(codes(verdict.warnings).includes('W-ENV-UNRESOLVED'));
});

/* ---------- 2. what the validator refuses to call a mission ---------- */

/** A minimal one-waypoint route, built by hand so a test can break one field of it. */
function routedMission() {
  const doc = freshMission();
  return {
    ...doc,
    route: {
      waypoints: [{ id: 'wpt_1', latitude: 30.3, longitude: -97.8 }],
      segments: [{
        id: 'seg_1', from: LAUNCH_NODE, to: 'wpt_1',
        altitude: { authored: 80, reference: 'launchRelative', resolvedMslM: 248 },
        speedPolicy: defaultSpeedPolicy(), intent: 'transit',
        holdS: null, subjectRef: null, camera: null, overrides: null,
      }],
      returnPolicy: { mode: 'direct', altitude: null },
    },
  };
}

test('a routed mission validates, chain and all', () => {
  const verdict = validateMission(routedMission());
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
});

const brokenIdentity = [
  ['not an object', () => 'a mission', 'E-DOC-NOT-OBJECT'],
  ['null', () => null, 'E-DOC-NOT-OBJECT'],
  ['an array', () => [], 'E-DOC-NOT-OBJECT'],
  ['a foreign schema version', () => ({ ...routedMission(), schemaVersion: 4 }), 'E-DOC-VERSION'],
  ['no id', () => ({ ...routedMission(), id: '' }), 'E-ID-MISSING'],
  ['a non-string title', () => ({ ...routedMission(), title: 7 }), 'E-TITLE-TYPE'],
  ['an unparseable createdAt', () => ({ ...routedMission(), createdAt: 'yesterday' }), 'E-TIME-INVALID'],
  ['no launch point', () => ({ ...routedMission(), launch: null }), 'E-LAUNCH-MISSING'],
  ['a latitude off the globe', () => {
    const d = routedMission();
    return { ...d, launch: { ...d.launch, latitude: 130 } };
  }, 'E-GEO-RANGE'],
  ['a launch elevation that is not a number', () => {
    const d = routedMission();
    return { ...d, launch: { ...d.launch, elevationMslM: 'high' } };
  }, 'E-LAUNCH-ELEV-TYPE'],
  ['no route', () => ({ ...routedMission(), route: null }), 'E-ROUTE-MISSING'],
  ['no planning policy', () => ({ ...routedMission(), planningPolicy: undefined }), 'E-POLICY-MISSING'],
  ['a reserve outside 0–100', () => {
    const d = routedMission();
    return { ...d, planningPolicy: { ...d.planningPolicy, reserve: { landFloorPct: 140 } } };
  }, 'E-POLICY-RESERVE'],
  ['a gust factor expressed as a percentage', () => {
    const d = routedMission();
    return { ...d, planningPolicy: { ...d.planningPolicy, gustFactor: 35 } };
  }, 'E-POLICY-GUST'],
  ['no provenance', () => ({ ...routedMission(), provenance: null }), 'E-PROV-MISSING'],
  ['no environment reference', () => ({ ...routedMission(), environmentReference: null }), 'E-ENV-MISSING'],
  ['an environment source outside the enum', () => ({
    ...routedMission(), environmentReference: { source: 'guess', presetId: null, capturedAt: null, values: null, provenance: null },
  }), 'E-ENV-SOURCE'],
  ['a preset environment that names no preset', () => ({
    ...routedMission(), environmentReference: { source: 'preset', presetId: null, capturedAt: null, values: null, provenance: null },
  }), 'E-ENV-PRESET'],
  ['a snapshot that is a reference rather than a copy', () => ({
    ...routedMission(), aircraftSnapshot: 'moz7v2',
  }), 'E-SNAPSHOT-TYPE'],
  ['a snapshot missing a number the physics reads', () => ({
    ...routedMission(), payloadSnapshot: { sourceId: 'naked', name: 'Naked GoPro', cdA: 0.0015 },
  }), 'E-SNAPSHOT-FIELD'],
];

for (const [label, build, code] of brokenIdentity) {
  test(`validateMission rejects ${label}`, () => {
    const verdict = validateMission(build());
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict.errors).includes(code),
      `expected ${code}, got ${JSON.stringify(codes(verdict.errors))}`);
  });
}

const brokenRoute = [
  ['a waypoint using the reserved launch id', (r) => {
    r.waypoints[0].id = LAUNCH_NODE;
    r.segments[0].to = LAUNCH_NODE;
  }, 'E-ID-RESERVED'],
  ['two waypoints with the same id', (r) => {
    r.waypoints.push({ id: 'wpt_1', latitude: 30.4, longitude: -97.9 });
    r.segments.push({ ...r.segments[0], id: 'seg_2', from: 'wpt_1', to: 'wpt_1' });
  }, 'E-ID-DUPLICATE'],
  ['two segments with the same id', (r) => {
    r.waypoints.push({ id: 'wpt_2', latitude: 30.4, longitude: -97.9 });
    r.segments.push({ ...r.segments[0], from: 'wpt_1', to: 'wpt_2' });
  }, 'E-ID-DUPLICATE'],
  ['a segment ending at a waypoint that is not there', (r) => { r.segments[0].to = 'wpt_9'; }, 'E-SEG-REF'],
  ['a segment starting from a node that is not there', (r) => { r.segments[0].from = 'wpt_9'; }, 'E-SEG-REF'],
  ['a first segment that does not start at the launch', (r) => {
    r.waypoints.push({ id: 'wpt_2', latitude: 30.4, longitude: -97.9 });
    r.segments.push({ ...r.segments[0], id: 'seg_2', from: 'wpt_1', to: 'wpt_2' });
    r.segments[0].from = 'wpt_2';
  }, 'E-SEG-CHAIN'],
  ['more waypoints than segments', (r) => {
    r.waypoints.push({ id: 'wpt_2', latitude: 30.4, longitude: -97.9 });
  }, 'E-SEG-CHAIN'],
  ['an intent outside the enum', (r) => { r.segments[0].intent = 'swoop'; }, 'E-SEG-INTENT'],
  ['a dwell time on a transit leg', (r) => { r.segments[0].holdS = 30; }, 'E-SEG-HOLD'],
  ['a negative dwell time on a hold', (r) => {
    r.segments[0].intent = 'hold';
    r.segments[0].holdS = -5;
  }, 'E-SEG-HOLD'],
  ['an altitude frame nobody defined', (r) => { r.segments[0].altitude.reference = 'aboveTheTrees'; }, 'E-ALT-REFERENCE'],
  ['an authored altitude that is not a number', (r) => { r.segments[0].altitude.authored = 'high'; }, 'E-ALT-AUTHORED'],
  ['a resolved altitude that is not a number', (r) => { r.segments[0].altitude.resolvedMslM = 'high'; }, 'E-ALT-RESOLVED'],
  ['a fixed-speed leg with no target speed', (r) => { r.segments[0].speedPolicy = { mode: 'fixed', targetMs: null }; }, 'E-SPEED-TARGET'],
  ['a speed mode outside the enum', (r) => { r.segments[0].speedPolicy = { mode: 'fast', targetMs: null }; }, 'E-SPEED-MODE'],
  ['a segment pointing at a subject that is not in the scene', (r) => { r.segments[0].subjectRef = 'sub_9'; }, 'E-SEG-SUBJECT'],
  ['a camera block that is not an object', (r) => { r.segments[0].camera = 'wide'; }, 'E-SEG-BAG'],
  ['a return mode outside the enum', (r) => { r.returnPolicy.mode = 'walk'; }, 'E-RETURN-MODE'],
];

for (const [label, mutate, code] of brokenRoute) {
  test(`validateMission rejects ${label}`, () => {
    const doc = routedMission();
    mutate(doc.route);
    const verdict = validateMission(doc);
    assert.equal(verdict.ok, false);
    assert.ok(codes(verdict.errors).includes(code),
      `expected ${code}, got ${JSON.stringify(codes(verdict.errors))}`);
  });
}

test('errors carry the path of the field that earned them', () => {
  const doc = routedMission();
  doc.route.segments[0].intent = 'swoop';
  const [error] = validateMission(doc).errors;
  assert.equal(error.path, 'route.segments[0].intent');
});

/* ---------- 3. incompleteness is flagged, not fatal ---------- */

test('an unresolved altitude is a warning, so the mission still opens', () => {
  const doc = routedMission();
  doc.route.segments[0].altitude.resolvedMslM = null;
  const verdict = validateMission(doc);
  assert.equal(verdict.ok, true);
  assert.ok(codes(verdict.warnings).includes('W-ALT-UNRESOLVED'));
});

test('a hold with no dwell time yet is a warning, not a zero', () => {
  const doc = routedMission();
  doc.route.segments[0].intent = 'hold';
  doc.route.segments[0].holdS = null;
  const verdict = validateMission(doc);
  assert.equal(verdict.ok, true);
  assert.ok(codes(verdict.warnings).includes('W-SEG-HOLD-UNKNOWN'));
});

test('a foreign id is carried, not rewritten', () => {
  const doc = { ...routedMission(), id: 'imported-from-elsewhere' };
  const verdict = validateMission(doc);
  assert.equal(verdict.ok, true, 'a mission from another tool is still a mission');
  assert.ok(codes(verdict.warnings).includes('W-ID-PREFIX'));
});

/* ---------- 4. snapshots are copies ---------- */

const MOZ7 = {
  id: 'moz7v2', name: 'GEPRC MOZ7 V2 O4 Pro', dryMassG: 843, propDiaIn: 7.5, numRotors: 4,
  ducted: false, s: 6, connector: 'XT60', etaProp: 0.55, cdA: 0.042, avionicsW: 10,
  maxSpeedMs: 30.5, cruiseMs: 18, confidence: 'estimated',
  propulsion: { motorMaxW: 1148.9, motorMaxA: 49.35, escMaxA: 65 },
  parallelHarnessMassG: 20, parallelPackCdA: 0.003, wheelbaseMm: 336,
};

test('aircraftSnapshot keeps what the physics reads and drops the rest', () => {
  const snap = aircraftSnapshot(MOZ7, { calibrated: true });
  assert.equal(snap.sourceId, 'moz7v2');
  assert.equal(snap.dryMassG, 843);
  assert.equal(snap.etaProp, 0.55);
  assert.equal(snap.calibrated, true);
  assert.equal(snap.maxThrustGPerRotor, null, 'an absent bench figure is null, not a guess');
  assert.equal('wheelbaseMm' in snap, false, 'the model never reads it');
});

test('a snapshot does not move when the catalog record does', () => {
  const record = structuredClone(MOZ7);
  const snap = aircraftSnapshot(record);
  record.propulsion.escMaxA = 999;
  record.etaProp = 0.9;
  assert.equal(snap.propulsion.escMaxA, 65);
  assert.equal(snap.etaProp, 0.55);
});

test('batterySnapshot keeps the pack as flown, overlay and parallel maths included', () => {
  const snap = batterySnapshot({
    id: 'nav5000--2x-parallel', name: '2× Lumenier NAV 5000 6S Li-Ion', chem: 'liion',
    s: 6, p: 2, capAh: 10, massG: 1018, irPackMilliOhm: 59, maxContA: 70,
    packCount: 2, extraCdA: 0.003, packInstance: { id: 'pk_1', label: 'Pack #2' },
  });
  assert.equal(snap.packCount, 2);
  assert.equal(snap.capAh, 10);
  assert.equal(snap.packInstance.label, 'Pack #2');
  assert.equal(snap.irTempC, null);
});

test('payloadSnapshot carries the rail ballast beside the camera', () => {
  const snap = payloadSnapshot({ id: 'naked', name: 'Naked GoPro · ~32 g', massG: 32, cdA: 0.0015 }, { extraG: 40 });
  assert.deepEqual(snap, { sourceId: 'naked', name: 'Naked GoPro · ~32 g', massG: 32, cdA: 0.0015, extraG: 40 });
});

test('a mission carrying all three snapshots stops warning about the loadout', () => {
  const doc = {
    ...routedMission(),
    aircraftSnapshot: aircraftSnapshot(MOZ7),
    batterySnapshot: batterySnapshot({
      id: 'nav5000', name: 'NAV 5000', chem: 'liion', s: 6, p: 1, capAh: 5,
      massG: 499, irPackMilliOhm: 118, maxContA: 35, packCount: 1, extraCdA: 0,
    }),
    payloadSnapshot: payloadSnapshot({ id: 'naked', name: 'Naked GoPro', massG: 32, cdA: 0.0015 }),
  };
  const verdict = validateMission(doc);
  assert.deepEqual(verdict.errors, []);
  assert.equal(codes(verdict.warnings).includes('W-LOADOUT-MISSING'), false);
});

test('defaultAltitude arrives unresolved, at the level this app has always flown', () => {
  assert.deepEqual(defaultAltitude(), { authored: 80, reference: 'launchRelative', resolvedMslM: null });
});

/* ---------- 5. the door: migrateMission ---------- */

test('a current-version document passes straight through, with its warnings', () => {
  const doc = freshMission();
  const result = migrateMission(structuredClone(doc));
  assert.equal(result.ok, true);
  assert.equal(result.fromVersion, 1);
  assert.deepEqual(result.doc, doc);
  assert.ok(codes(result.warnings).includes('W-LOADOUT-MISSING'));
});

test('a mission from a newer app is refused by version, not partially read', () => {
  const future = { ...freshMission(), schemaVersion: 2 };
  const result = migrateMission(future);
  assert.equal(result.ok, false);
  assert.equal(result.doc, undefined);
  assert.deepEqual(codes(result.errors), ['E-DOC-VERSION-FUTURE']);
  assert.match(result.errors[0].message, /v2/);
  assert.match(result.errors[0].message, /v1/);
});

for (const [label, blob] of [
  ['a JSON string', '{"schemaVersion":1}'],
  ['a number', 42],
  ['null', null],
  ['undefined', undefined],
  ['an array of missions', [{ schemaVersion: 1 }]],
]) {
  test(`migrateMission refuses ${label} without reading a field of it`, () => {
    const result = migrateMission(blob);
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result.errors), ['E-DOC-NOT-OBJECT']);
  });
}

for (const [label, version] of [
  ['no version at all', undefined],
  ['a version of zero', 0],
  ['a decimal version', 1.5],
  ['a version as text', '1'],
]) {
  test(`migrateMission refuses a record with ${label}`, () => {
    const result = migrateMission({ ...freshMission(), schemaVersion: version });
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result.errors), ['E-DOC-VERSION-MISSING']);
  });
}

test('a half-written document fails safely to "not loaded"', () => {
  const half = freshMission();
  delete half.route;
  delete half.planningPolicy;
  const result = migrateMission(half);
  assert.equal(result.ok, false);
  assert.equal(result.doc, undefined);
  assert.equal(result.fromVersion, 1, 'we know what it claimed to be, we just cannot use it');
  assert.ok(codes(result.errors).includes('E-ROUTE-MISSING'));
  assert.ok(codes(result.errors).includes('E-POLICY-MISSING'));
});

test('migrateMission does not write back into the record it was handed', () => {
  const raw = structuredClone(freshMission());
  const before = structuredClone(raw);
  migrateMission(raw);
  assert.deepEqual(raw, before);
});

test('the id prefixes are the ones ADR 0002 names', () => {
  assert.deepEqual(ID_PREFIXES, {
    mission: 'msn', waypoint: 'wpt', segment: 'seg', constraint: 'con', subject: 'sub',
  });
});
