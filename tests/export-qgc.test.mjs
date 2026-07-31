import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileMission } from '../src/domain/mission/compile.js';
import { ID_PREFIXES, createMission, validateMission } from '../src/domain/mission/mission-schema.js';
import {
  FORMAT, SUPPORT, exportMission, importMission,
} from '../src/infrastructure/export/qgc-plan.js';

/* The property under test is the one a pilot cannot check by eye: that the
 * numbers in a `.plan` mean what QGroundControl will read them to mean. A plan
 * that loads without complaint but datums its altitudes to a fabricated home,
 * or writes a heading where a hold time goes, is worse than one that refuses —
 * so the tests that matter here are the refusals, the frame mapping, and the
 * round trip that proves nothing drifted on the way out and back.
 *
 * The fixtures under tests/fixtures/interop are real files with their sources
 * recorded beside them; the assertions about them are assertions about the
 * format, not about this adapter. */

const FIXTURES = new URL('./fixtures/interop/', import.meta.url);
const fixture = (name) => readFileSync(new URL(name, FIXTURES), 'utf8');

/**
 * Deterministic ids and clock, so a failure is about the adapter. The tag
 * separates the ids a test authors from the ids an import mints, which would
 * otherwise collide by counting from the same place.
 */
function harness(tag = '') {
  let ids = 0;
  let tick = 0;
  return {
    idgen: (prefix) => `${prefix}_${tag}${++ids}`,
    now: () => new Date(Date.UTC(2026, 6, 31, 12, 0, tick++)).toISOString(),
  };
}

/** Flat ground at 150 m, for the AGL cases. */
const GROUND = () => 150;

/** A full snapshot, because the validator insists on every number in one. */
const AIRCRAFT = {
  sourceId: 'ac_test', name: 'Test quad', dryMassG: 650, propDiaIn: 5, numRotors: 4, ducted: false,
  etaProp: 0.7, cdA: 0.012, avionicsW: 6, maxSpeedMs: 25, cruiseMs: 11,
  maxThrustGPerRotor: 900, propulsion: null, parallelHarnessMassG: 0,
};

const LAUNCH = { latitude: 30.2672, longitude: -97.7431, elevationMslM: 149.5 };

/**
 * A mission document, built the way the app builds one.
 * @param {object} spec
 */
function mission({ stops, returnPolicy, launch = LAUNCH, aircraft = null, scene = [] }, deps) {
  const doc = createMission({
    launch, aircraft, returnPolicy, title: 'Pedernales ridge run',
  }, deps);
  for (const subject of scene) doc.scene.subjects.push(subject);
  let previous = 'launch';
  for (const stop of stops) {
    const waypoint = {
      id: deps.idgen(ID_PREFIXES.waypoint), latitude: stop.latitude, longitude: stop.longitude,
    };
    doc.route.waypoints.push(waypoint);
    doc.route.segments.push({
      id: deps.idgen(ID_PREFIXES.segment),
      from: previous,
      to: waypoint.id,
      altitude: {
        authored: stop.altitude, reference: stop.reference ?? 'launchRelative', resolvedMslM: null,
      },
      speedPolicy: stop.speed ?? { mode: 'fixed', targetMs: 12.5 },
      intent: stop.intent ?? 'transit',
      holdS: stop.holdS ?? null,
      subjectRef: stop.subjectRef ?? null,
      camera: stop.camera ?? null,
    });
    previous = waypoint.id;
  }
  return doc;
}

const RIDGE = [
  { latitude: 30.2681234, longitude: -97.7442117, altitude: 80 },
  { latitude: 30.2694821, longitude: -97.7455903, altitude: 95, holdS: 12, intent: 'hold' },
  { latitude: 30.2703399, longitude: -97.7461288, altitude: 62.5 },
];

/** The plain case, compiled and exported. */
function planOf(spec = {}, deps = harness()) {
  const doc = mission({ stops: RIDGE, ...spec }, deps);
  const compiled = compileMission(doc, { terrainSampler: spec.terrainSampler ?? null });
  const result = exportMission(compiled, { filenameBase: spec.filenameBase });
  return { doc, compiled, result };
}

/** The waypoint items, without the speed changes and the return interleaved. */
const waypointsOf = (result) => JSON.parse(result.payload.text).mission.items
  .filter((item) => item.command === 16);

const near = (actual, expected, tolerance, what) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `${what}: ${actual} is further than ${tolerance} from ${expected}`,
);

const conceptsOf = (result) => result.semanticLosses.map((loss) => loss.concept);

/* ---------- 1. the envelope QGroundControl requires ---------- */

test('the plan carries every key QGC checks for before it reads a single item', () => {
  const { result } = planOf();
  const plan = JSON.parse(result.payload.text);

  assert.deepEqual(Object.keys(plan).sort(),
    ['fileType', 'geoFence', 'groundStation', 'mission', 'rallyPoints', 'version']);
  assert.equal(plan.fileType, 'Plan');
  assert.equal(plan.version, 1);
  assert.equal(typeof plan.groundStation, 'string');
  // Present and empty, not absent: a plan without these two objects is rejected
  // before its mission is looked at.
  assert.deepEqual(plan.geoFence, { circles: [], polygons: [], version: 2 });
  assert.deepEqual(plan.rallyPoints, { points: [], version: 2 });
});

test('the mission object carries its three required fields, home altitude included', () => {
  const { result } = planOf();
  const { mission: m } = JSON.parse(result.payload.text);

  assert.deepEqual(m.plannedHomePosition, [30.2672, -97.7431, 149.5]);
  assert.ok(Array.isArray(m.items));
  assert.equal(m.firmwareType, 0, 'MAV_AUTOPILOT_GENERIC: this app does not know the firmware');
  assert.equal(m.vehicleType, 2, 'MAV_TYPE_QUADROTOR');
  assert.equal(m.version, 2);
  assert.equal('cruiseSpeed' in m, false, 'cruiseSpeed describes forward flight this app does not plan');
});

test('every item is a SimpleItem with seven params and a sequential doJumpId', () => {
  const { result } = planOf();
  const { mission: m } = JSON.parse(result.payload.text);

  m.items.forEach((item, i) => {
    assert.equal(item.type, 'SimpleItem');
    assert.equal(typeof item.command, 'number');
    assert.equal(typeof item.frame, 'number');
    assert.equal(item.autoContinue, true);
    assert.equal(item.params.length, 7, 'a simple item carries exactly seven parameters');
    assert.equal(item.doJumpId, i + 1, 'doJumpId is the 1-based sequence number');
  });
});

test('the altitude trio is written together or not at all', () => {
  const { result } = planOf();
  const { mission: m } = JSON.parse(result.payload.text);
  const trio = ['AMSLAltAboveTerrain', 'Altitude', 'AltitudeMode'];

  for (const item of m.items) {
    const present = trio.filter((key) => key in item);
    assert.ok(present.length === 0 || present.length === 3,
      `naming one of ${trio.join('/')} makes QGC require all three; found ${present.join(', ')}`);
    if (present.length === 3) assert.equal(item.command, 16, 'only waypoints carry an altitude');
  }
});

/* ---------- 2. the field mapping, frame by frame ---------- */

test('the authored frame picks the MAV_FRAME, and the AltitudeMode that agrees with it', () => {
  const cases = [
    { reference: 'launchRelative', frame: 3, mode: 1 },
    { reference: 'msl', frame: 0, mode: 2 },
    { reference: 'agl', frame: 10, mode: 4 },
  ];
  for (const { reference, frame, mode } of cases) {
    const { result } = planOf({ stops: [{ ...RIDGE[0], reference }], terrainSampler: GROUND });
    const [item] = waypointsOf(result);
    assert.equal(item.frame, frame, `${reference} is MAV_FRAME ${frame}`);
    assert.equal(item.AltitudeMode, mode, `${reference} is AltitudeMode ${mode}`);
    assert.equal(item.Altitude, 80, 'the height written is the height authored, in its own frame');
    assert.equal(item.params[6], 80, 'params[6] is the altitude the vehicle flies');
  }
});

test('a terrain-framed plan carries its AMSL figure and warns about the data it needs', () => {
  const { result } = planOf({ stops: [{ ...RIDGE[0], reference: 'agl' }], terrainSampler: GROUND });
  const [item] = waypointsOf(result);

  assert.equal(item.AMSLAltAboveTerrain, 230, '150 m of ground under 80 m of air');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /terrain data/i);
  assert.equal(planOf().result.warnings.length, 0, 'a launch-relative plan has nothing to warn about');
});

test('an AGL altitude with no terrain under it is refused, not written as a bare number', () => {
  // The compiler routes every frame conversion through sea level, so an AGL
  // altitude with no terrain sample resolves to nothing at all — not even back
  // to the figure it was authored as. Writing 80 into a terrain-framed item
  // here would be inventing agreement with a datum nobody has checked.
  const { result } = planOf({ stops: [{ ...RIDGE[0], reference: 'agl' }] });
  assert.equal(result.status, 'failed');
  assert.equal(result.errors[0].code, 'E-QGC-ALTITUDE-UNRESOLVED');
  assert.match(result.errors[0].message, /agl/);
});

test('a waypoint puts hold in params[0], the position in params[4..6], and null yaw in params[3]', () => {
  const { result } = planOf();
  const waypoints = JSON.parse(result.payload.text).mission.items.filter((i) => i.command === 16);

  assert.deepEqual(waypoints.map((i) => i.params[0]), [0, 12, 0], 'param1 is hold seconds');
  assert.deepEqual(waypoints[1].params.slice(4), [30.2694821, -97.7455903, 95]);
  for (const item of waypoints) {
    assert.equal(item.params[3], null, 'a null yaw is "keep the current heading mode"');
    assert.deepEqual(item.params.slice(1, 3), [0, 0], 'accept and pass radius are left to the vehicle');
  }
});

test('a speed change is written once, when the speed changes', () => {
  const stops = [
    { ...RIDGE[0], speed: { mode: 'fixed', targetMs: 9 } },
    { ...RIDGE[1], speed: { mode: 'fixed', targetMs: 9 } },
    { ...RIDGE[2], speed: { mode: 'fixed', targetMs: 14.5 } },
  ];
  const { result } = planOf({ stops });
  const changes = JSON.parse(result.payload.text).mission.items.filter((i) => i.command === 178);

  assert.equal(changes.length, 2, 'two speeds, two DO_CHANGE_SPEED items');
  assert.deepEqual(changes.map((i) => i.params[1]), [9, 14.5]);
  for (const change of changes) {
    assert.equal(change.frame, 2, 'a command with no location is MAV_FRAME_MISSION');
    assert.equal(change.params[0], 1, 'SPEED_TYPE_GROUNDSPEED');
    assert.equal(change.params[2], -1, '-1 is "do not touch the throttle"');
    assert.equal('Altitude' in change, false);
  }
});

test('a cruise speed the compiler resolved becomes hoverSpeed, and an unresolved one becomes a loss', () => {
  const cruise = { mode: 'cruise', targetMs: null };
  const withAircraft = planOf({
    aircraft: AIRCRAFT, stops: RIDGE.map((s) => ({ ...s, speed: cruise })),
  }).result;
  assert.equal(JSON.parse(withAircraft.payload.text).mission.hoverSpeed, 11);

  const without = planOf({ stops: RIDGE.map((s) => ({ ...s, speed: cruise })) }).result;
  const plan = JSON.parse(without.payload.text);
  assert.equal('hoverSpeed' in plan.mission, false, 'no aircraft, no speed, no invented number');
  assert.equal(plan.mission.items.some((i) => i.command === 178), false);
  assert.ok(without.semanticLosses.some((l) => l.concept === 'speed' && /will not invent/.test(l.detail)));
});

test('a direct return is an RTL item last; a retraced one is a named loss', () => {
  const direct = planOf({ returnPolicy: { mode: 'direct', altitude: null } }).result;
  const items = JSON.parse(direct.payload.text).mission.items;
  assert.equal(items[items.length - 1].command, 20, 'MAV_CMD_NAV_RETURN_TO_LAUNCH');
  assert.equal(items[items.length - 1].frame, 2);

  const retrace = planOf({ returnPolicy: { mode: 'retrace', altitude: null } }).result;
  assert.equal(JSON.parse(retrace.payload.text).mission.items.some((i) => i.command === 20), false);
  assert.ok(retrace.semanticLosses.some((l) => l.concept === 'return-policy' && /retraced/.test(l.detail)));
});

test('the payload names itself, and the envelope says where it came from', () => {
  const { result } = planOf({ filenameBase: 'Pedernales ridge/run #2' });
  assert.equal(result.payload.filename, 'Pedernales-ridge-run-2.plan');
  assert.equal(result.payload.mime, 'application/json');
  assert.equal(result.sourceFormat, 'mission-document-v1');
  assert.equal(result.targetFormat, FORMAT.id);
  assert.equal(result.adapterVersion, '1.0.0');
  assert.match(result.payload.text, /\n$/, 'a text file ends in a newline');
});

/* ---------- 3. the round trip ---------- */

test('a mission survives export and import inside ADR 0010\'s tolerances', () => {
  const { doc, result } = planOf({ returnPolicy: { mode: 'direct', altitude: null } });
  const back = importMission(result.payload.text, harness());

  assert.equal(back.payload.route.waypoints.length, doc.route.waypoints.length);
  doc.route.waypoints.forEach((original, i) => {
    const arrived = back.payload.route.waypoints[i];
    near(arrived.latitude, original.latitude, 1e-6, `waypoint ${i} latitude`);
    near(arrived.longitude, original.longitude, 1e-6, `waypoint ${i} longitude`);
  });
  doc.route.segments.forEach((original, i) => {
    const arrived = back.payload.route.segments[i];
    near(arrived.altitude.authored, original.altitude.authored, 0.1, `segment ${i} altitude`);
    assert.equal(arrived.altitude.reference, original.altitude.reference);
    near(arrived.speedPolicy.targetMs, 12.5, 0.1, `segment ${i} speed`);
    if (original.holdS !== null) near(arrived.holdS, original.holdS, 1, `segment ${i} hold`);
    else assert.equal(arrived.holdS, null);
  });
  assert.equal(back.payload.route.returnPolicy.mode, 'direct');
  assert.deepEqual(
    { lat: back.payload.launch.latitude, lon: back.payload.launch.longitude, elev: back.payload.launch.elevationMslM },
    { lat: LAUNCH.latitude, lon: LAUNCH.longitude, elev: LAUNCH.elevationMslM },
  );
});

test('ids do not survive the trip, and the import says so rather than pretending', () => {
  const { doc, result } = planOf();
  const back = importMission(result.payload.text, harness('in'));
  const originalIds = new Set(doc.route.waypoints.map((w) => w.id));
  const arrivedIds = back.payload.route.waypoints.map((w) => w.id);

  // A `.plan` has nowhere to carry an id, so the test is that every id in the
  // imported document came from the injected generator and none from the file.
  for (const id of arrivedIds) {
    assert.match(id, /^wpt_in\d+$/, 'ids come from the caller\'s generator');
    assert.equal(originalIds.has(id), false);
  }
  assert.equal(new Set(arrivedIds).size, arrivedIds.length, 'fresh ids are still unique');
  assert.ok(back.semanticLosses.some((l) => /minted fresh ids/.test(l.detail)));
});

test('an imported document is one the schema accepts, and says it was imported', () => {
  const { result } = planOf();
  const back = importMission(result.payload.text, harness());

  assert.equal(validateMission(back.payload).ok, true);
  assert.deepEqual(validateMission(back.payload).errors, []);
  assert.equal(back.payload.provenance.origin, 'imported');
  assert.equal(back.payload.provenance.sourceFormat, FORMAT.id);
  assert.equal(back.sourceFormat, FORMAT.id);
  assert.equal(back.targetFormat, 'mission-document-v1');
  assert.equal(back.status, 'degraded', 'an import that mints ids has lost something');
});

test('altitudes arrive unresolved: resolving them is the domain\'s job, not the adapter\'s', () => {
  const { result } = planOf();
  const back = importMission(result.payload.text, harness());
  for (const segment of back.payload.route.segments) {
    assert.equal(segment.altitude.resolvedMslM, null);
  }
});

test('speed arrives as a fixed target, and the loss says the policy behind it is gone', () => {
  const { result } = planOf({ aircraft: AIRCRAFT, stops: RIDGE.map((s) => ({ ...s, speed: { mode: 'cruise', targetMs: null } })) });
  const back = importMission(result.payload.text, harness());

  assert.deepEqual([...new Set(back.payload.route.segments.map((s) => s.speedPolicy.mode))], ['fixed']);
  near(back.payload.route.segments[0].speedPolicy.targetMs, 11, 0.1, 'cruise speed');
  assert.ok(back.semanticLosses.some((l) => l.concept === 'speed' && /cruise, max-range/.test(l.detail)));
});

/* ---------- 4. what the format cannot hold ---------- */

test('a rich mission names every concept this format drops, and none that it keeps', () => {
  const scene = [{
    id: 'sub_1', name: 'Ridge cabin', latitude: 30.2694, longitude: -97.7455,
    elevationMslM: 160, radiusM: 25,
  }];
  const stops = [
    { ...RIDGE[0] },
    { ...RIDGE[1], subjectRef: 'sub_1', camera: { tilt: -15 } },
    { ...RIDGE[2], intent: 'reveal' },
  ];
  const { result } = planOf({ stops, scene, returnPolicy: { mode: 'direct', altitude: null } });

  assert.equal(result.status, 'degraded');
  assert.deepEqual(conceptsOf(result), ['camera-intent', 'reserve'],
    'geometry, altitude, speed, hold and the return are all native here');
  for (const loss of result.semanticLosses) {
    assert.equal(loss.disposition, 'dropped');
    assert.ok(loss.detail.length > 0, 'a loss names the thing that was lost');
  }
});

test('the support table says what it means, and the reserve is always lost', () => {
  assert.deepEqual(Object.keys(SUPPORT).sort(), [
    'altitude-reference', 'camera-intent', 'geometry', 'hold', 'reserve', 'return-policy', 'speed',
  ]);
  assert.equal(SUPPORT.reserve, 'unsupported');
  assert.equal(SUPPORT['camera-intent'], 'unsupported');
  assert.ok(conceptsOf(planOf().result).includes('reserve'),
    'no flight controller holds a landing reserve, so every export says so');
});

test('a return altitude is named as the vehicle parameter it really is', () => {
  const { result } = planOf({
    returnPolicy: { mode: 'direct', altitude: { authored: 60, reference: 'launchRelative', resolvedMslM: null } },
  });
  assert.ok(result.semanticLosses.some((l) => l.concept === 'return-policy' && /RTL_RETURN_ALT/.test(l.detail)));
});

/* ---------- 5. refusals ---------- */

test('an export refuses rather than fabricating the two numbers it cannot know', () => {
  const noElevation = planOf({ launch: { ...LAUNCH, elevationMslM: null } }).result;
  assert.equal(noElevation.status, 'failed');
  assert.equal(noElevation.payload, null);
  assert.equal(noElevation.errors[0].code, 'E-QGC-HOME-ELEVATION');
  assert.match(noElevation.errors[0].message, /re-datums/);

  const empty = planOf({ stops: [] }).result;
  assert.equal(empty.status, 'failed');
  assert.equal(empty.errors[0].code, 'E-QGC-EMPTY');
});

test('an import refuses anything that is not a current plan file', () => {
  const cases = [
    ['not json at all', 'E-QGC-PARSE'],
    ['[1, 2, 3]', 'E-QGC-ROOT'],
    ['{"fileType": "Fence", "version": 1}', 'E-QGC-FILETYPE'],
    ['{"fileType": "Plan", "version": 2}', 'E-QGC-VERSION'],
    ['{"fileType": "Plan", "version": 1}', 'E-QGC-MISSION'],
    ['{"fileType": "Plan", "version": 1, "mission": {"items": []}}', 'E-QGC-HOME'],
  ];
  for (const [text, code] of cases) {
    const result = importMission(text, harness());
    assert.equal(result.status, 'failed', text);
    assert.equal(result.errors[0].code, code, text);
    assert.equal(result.payload, null);
  }
});

test('a hostile __proto__ key lands in the file and dies at the boundary', () => {
  const { result } = planOf();
  // Written into the text rather than through an object literal, because a
  // literal's `__proto__` sets a prototype instead of a key — the file is the
  // only place this attack can come from.
  const hostile = result.payload.text
    .replace('{\n', '{\n    "__proto__": { "polluted": true },\n')
    .replace('"type": "SimpleItem"', '"__proto__": { "polluted": true }, "type": "SimpleItem"');
  const parsed = JSON.parse(hostile);
  assert.equal(Object.hasOwn(parsed, '__proto__'), true, 'the attack is really in the file');

  const back = importMission(hostile, harness());
  assert.equal(back.status, 'degraded', 'the plan is still a plan');
  assert.equal(({}).polluted, undefined, 'nothing reached Object.prototype');
  assert.equal(Object.hasOwn(back.payload, '__proto__'), false);
  assert.equal(Object.getPrototypeOf(back.payload), Object.prototype);
  assert.equal(JSON.stringify(back.payload).includes('polluted'), false);
  for (const waypoint of back.payload.route.waypoints) {
    assert.equal(Object.hasOwn(waypoint, '__proto__'), false);
  }
});

test('a file too large to trust is refused before it is parsed', () => {
  const oversized = `{"fileType":"Plan","version":1,"pad":"${'a'.repeat(5 * 1024 * 1024)}"}`;
  const result = importMission(oversized, harness());
  assert.equal(result.status, 'failed');
  assert.equal(result.errors[0].code, 'E-IMPORT-TOO-LARGE');
});

test('a number that is not a number fails the import rather than propagating', () => {
  const plan = (params) => JSON.stringify({
    fileType: 'Plan',
    version: 1,
    mission: {
      plannedHomePosition: [30.2672, -97.7431, 149.5],
      items: [{ type: 'SimpleItem', command: 16, frame: 3, autoContinue: true, params }],
    },
  });
  const cases = [
    [[0, 0, 0, null, 'thirty', -97.7, 80], 'E-QGC-GEO-RANGE'],
    [[0, 0, 0, null, 91.5, -97.7, 80], 'E-QGC-GEO-RANGE'],
    [[0, 0, 0, null, 30.2, -181, 80], 'E-QGC-GEO-RANGE'],
    [[0, 0, 0, null, 30.2, -97.7, null], 'E-QGC-ALTITUDE'],
    [['soon', 0, 0, null, 30.2, -97.7, 80], 'E-QGC-HOLD'],
    [[0, 0, 0, null, 30.2, -97.7], 'E-QGC-PARAMS'],
  ];
  for (const [params, code] of cases) {
    const result = importMission(plan(params), harness());
    assert.equal(result.status, 'failed', JSON.stringify(params));
    assert.equal(result.errors[0].code, code, JSON.stringify(params));
  }
});

test('a plan with nothing this app can fly is refused, not read as an empty mission', () => {
  const text = JSON.stringify({
    fileType: 'Plan',
    version: 1,
    mission: {
      plannedHomePosition: [30.2672, -97.7431, 149.5],
      items: [{
        type: 'ComplexItem', complexItemType: 'StructureScan', command: 0, frame: 2, params: [0, 0, 0, 0, 0, 0, 0],
      }],
    },
  });
  const result = importMission(text, harness());
  assert.equal(result.errors[0].code, 'E-QGC-NO-WAYPOINTS');
  assert.match(result.errors[0].message, /StructureScan/);
});

test('a waypoint in a frame this app does not model is dropped and named, not guessed at', () => {
  const text = JSON.stringify({
    fileType: 'Plan',
    version: 1,
    mission: {
      plannedHomePosition: [30.2672, -97.7431, 149.5],
      items: [
        { type: 'SimpleItem', command: 16, frame: 6, autoContinue: true, params: [0, 0, 0, null, 30.2, -97.7, 80] },
        { type: 'SimpleItem', command: 16, frame: 3, autoContinue: true, params: [0, 0, 0, null, 30.3, -97.8, 80] },
      ],
    },
  });
  const result = importMission(text, harness());
  assert.equal(result.payload.route.waypoints.length, 1);
  assert.ok(result.semanticLosses.some((l) => /MAV_FRAME 6/.test(l.detail)));
});

/* ---------- 6. the fixtures ---------- */

test('the documented example plan is shaped the way this adapter writes one', () => {
  const plan = JSON.parse(fixture('qgroundcontrol-plan-example.plan'));
  const written = JSON.parse(planOf().result.payload.text);

  assert.deepEqual(Object.keys(plan).sort(), Object.keys(written).sort());
  for (const key of ['plannedHomePosition', 'items', 'firmwareType', 'vehicleType', 'version']) {
    assert.ok(key in plan.mission, `the documented mission carries ${key}`);
    assert.ok(key in written.mission, `so does this adapter's`);
  }
  const [item] = plan.mission.items;
  assert.equal(item.params.length, 7);
  assert.equal(item.params[3], null, 'the documented yaw is null');
  for (const key of ['AMSLAltAboveTerrain', 'Altitude', 'AltitudeMode']) assert.ok(key in item);
});

test('the documented example disagrees with itself about altitude, which is why frame wins', () => {
  const plan = JSON.parse(fixture('qgroundcontrol-plan-example.plan'));
  const [item] = plan.mission.items;
  // frame 3 is MAV_FRAME_GLOBAL_RELATIVE_ALT; AltitudeMode 0 is QGC's Mixed,
  // and the mission's own globalPlanAltitudeMode says 1 (Relative).
  assert.equal(item.frame, 3);
  assert.equal(item.AltitudeMode, 0);
  assert.equal(plan.mission.globalPlanAltitudeMode, 1);

  // The same item with a command this app models: the frame is what is read.
  const asWaypoint = JSON.parse(fixture('qgroundcontrol-plan-example.plan'));
  asWaypoint.mission.items[0].command = 16;
  const result = importMission(JSON.stringify(asWaypoint), harness());
  assert.equal(result.payload.route.segments[0].altitude.reference, 'launchRelative');
  assert.equal(result.payload.route.segments[0].altitude.authored, 50);
});

test('the documented example holds only a takeoff, so importing it is refused by name', () => {
  const result = importMission(fixture('qgroundcontrol-plan-example.plan'), harness());
  assert.equal(result.status, 'failed');
  assert.equal(result.errors[0].code, 'E-QGC-NO-WAYPOINTS');
  assert.match(result.errors[0].message, /MAV_CMD 22/);
});

test('a plan in the older item schema is refused rather than half-read', () => {
  const result = importMission(fixture('qgroundcontrol-sectiontest.plan'), harness());
  assert.equal(result.status, 'failed');
  assert.equal(result.errors[0].code, 'E-QGC-PARAMS');
  // The envelope passed every top-level check: nothing above the items said
  // this file was of another generation.
  const plan = JSON.parse(fixture('qgroundcontrol-sectiontest.plan'));
  assert.equal(plan.fileType, 'Plan');
  assert.equal(plan.version, 1);
  assert.equal(plan.mission.items[0].params.length, 4);
});
