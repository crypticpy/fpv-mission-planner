import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileMission } from '../src/domain/mission/compile.js';
import { ID_PREFIXES, createMission, validateMission } from '../src/domain/mission/mission-schema.js';
import {
  FORMAT, SUPPORT, exportMission, importMission,
} from '../src/infrastructure/export/ardupilot-wpl.js';

/* `QGC WPL 110` is twelve tab-separated columns with no names on them, so every
 * mistake this adapter could make is a silent one: a hold time read as a yaw, a
 * relative altitude read as MSL, a home row counted as a waypoint. The tests
 * that matter are therefore column-position tests, frame tests, and the refusals
 * — a file this format cannot express must not be written as a plausible one.
 *
 * The two fixtures are real files (see the .provenance.md beside each): what
 * they assert is the format, not this adapter. */

const FIXTURES = new URL('./fixtures/interop/', import.meta.url);
const fixture = (name) => readFileSync(new URL(name, FIXTURES), 'utf8');

/** Deterministic ids and clock; the tag keeps authored ids apart from minted ones. */
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

const AIRCRAFT = {
  sourceId: 'ac_test', name: 'Test quad', dryMassG: 650, propDiaIn: 5, numRotors: 4, ducted: false,
  etaProp: 0.7, cdA: 0.012, avionicsW: 6, maxSpeedMs: 25, cruiseMs: 11,
  maxThrustGPerRotor: 900, propulsion: null, parallelHarnessMassG: 0,
};

const LAUNCH = { latitude: -35.3632621, longitude: 149.1652374, elevationMslM: 584.08 };

/** @param {object} spec */
function mission({ stops, returnPolicy, launch = LAUNCH, aircraft = null, scene = [] }, deps) {
  const doc = createMission({
    launch, aircraft, returnPolicy, title: 'CMAC circuit',
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

const CIRCUIT = [
  { latitude: -35.3625131, longitude: 149.1651034, altitude: 20 },
  { latitude: -35.3625334, longitude: 149.1642461, altitude: 20, holdS: 8, intent: 'hold' },
  { latitude: -35.3639812, longitude: 149.1644172, altitude: 32.5 },
];

function wplOf(spec = {}, deps = harness()) {
  const doc = mission({ stops: CIRCUIT, ...spec }, deps);
  const compiled = compileMission(doc, { terrainSampler: spec.terrainSampler ?? null });
  const result = exportMission(compiled, { filenameBase: spec.filenameBase });
  return { doc, compiled, result };
}

/** Data rows, split the way a reader splits them. */
const rowsOf = (result) => result.payload.text
  .split('\n').slice(1).filter((line) => line.trim() !== '')
  .map((line) => line.split('\t'));

const cell = {
  seq: 0, current: 1, frame: 2, command: 3, p1: 4, p2: 5, p3: 6, p4: 7,
  latitude: 8, longitude: 9, altitude: 10, autocontinue: 11,
};

const near = (actual, expected, tolerance, what) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `${what}: ${actual} is further than ${tolerance} from ${expected}`,
);

const conceptsOf = (result) => result.semanticLosses.map((loss) => loss.concept);

/* ---------- 1. the shape of the file ---------- */

test('the file is a version line, then tab-separated rows of twelve columns', () => {
  const { result } = wplOf();
  const lines = result.payload.text.split('\n');

  assert.equal(lines[0], 'QGC WPL 110', 'the trailing 110 is the format version, not a row count');
  assert.equal(lines[lines.length - 1], '', 'the file ends in a newline');
  for (const row of rowsOf(result)) {
    assert.equal(row.length, 12);
    assert.equal(row[cell.autocontinue], '1', 'every row continues to the next');
  }
  assert.equal(result.payload.text.includes('\r'), false, 'unix line endings');
});

test('the rows are numbered from zero, in file order', () => {
  const { result } = wplOf({ returnPolicy: { mode: 'direct', altitude: null } });
  const rows = rowsOf(result);
  rows.forEach((row, i) => assert.equal(row[cell.seq], String(i)));
});

test('row zero is home: current, in MSL, at the launch elevation', () => {
  const { result } = wplOf();
  const [home] = rowsOf(result);

  assert.equal(home[cell.seq], '0');
  assert.equal(home[cell.current], '1', 'the CURRENT flag marks the home row');
  assert.equal(home[cell.frame], '0', 'MAV_FRAME_GLOBAL: home altitude is above sea level');
  assert.equal(home[cell.command], '16');
  assert.equal(home[cell.latitude], '-35.3632621');
  assert.equal(home[cell.longitude], '149.1652374');
  assert.equal(home[cell.altitude], '584.080000');
  for (const row of rowsOf(result).slice(1)) assert.equal(row[cell.current], '0');
});

test('coordinates carry seven decimals, everything else six', () => {
  const { result } = wplOf();
  for (const row of rowsOf(result)) {
    // MISSION_ITEM_INT stores degrees scaled by 1e7, so seven decimals is the
    // format's own resolution; six would quantise a position to ~11 cm and eat
    // most of the 1e-6 degree round-trip budget.
    assert.match(row[cell.latitude], /^-?\d+\.\d{7}$/);
    assert.match(row[cell.longitude], /^-?\d+\.\d{7}$/);
    assert.match(row[cell.altitude], /^-?\d+\.\d{6}$/);
    for (const key of ['p1', 'p2', 'p3', 'p4']) assert.match(row[cell[key]], /^-?\d+\.\d{6}$/);
  }
});

/* ---------- 2. the field mapping ---------- */

test('the authored frame becomes the MAV_FRAME of its row', () => {
  const cases = [
    { reference: 'launchRelative', frame: '3' },
    { reference: 'msl', frame: '0' },
    { reference: 'agl', frame: '10' },
  ];
  for (const { reference, frame } of cases) {
    const { result } = wplOf({ stops: [{ ...CIRCUIT[0], reference }], terrainSampler: GROUND });
    const waypoint = rowsOf(result).find((row) => row[cell.seq] !== '0' && row[cell.command] === '16');
    assert.equal(waypoint[cell.frame], frame, `${reference} is MAV_FRAME ${frame}`);
    assert.equal(waypoint[cell.altitude], '20.000000', 'the height written is the height authored');
  }
});

test('a terrain-framed file warns about the parameter that has to be on', () => {
  const { result } = wplOf({ stops: [{ ...CIRCUIT[0], reference: 'agl' }], terrainSampler: GROUND });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /TERRAIN_ENABLE/);
  assert.equal(wplOf().result.warnings.length, 0);
});

test('hold time is param1 of the waypoint row, and nothing else moves', () => {
  const { result } = wplOf();
  const waypoints = rowsOf(result).filter((row) => row[cell.command] === '16' && row[cell.seq] !== '0');

  assert.deepEqual(waypoints.map((r) => r[cell.p1]), ['0.000000', '8.000000', '0.000000']);
  for (const row of waypoints) {
    assert.deepEqual(row.slice(cell.p2, cell.p4 + 1), ['0.000000', '0.000000', '0.000000'],
      'accept radius, pass radius and yaw are left to the vehicle');
  }
});

test('a speed change is its own row, written when the speed changes', () => {
  const stops = [
    { ...CIRCUIT[0], speed: { mode: 'fixed', targetMs: 9 } },
    { ...CIRCUIT[1], speed: { mode: 'fixed', targetMs: 9 } },
    { ...CIRCUIT[2], speed: { mode: 'fixed', targetMs: 14.5 } },
  ];
  const changes = rowsOf(wplOf({ stops }).result).filter((row) => row[cell.command] === '178');

  assert.equal(changes.length, 2);
  assert.deepEqual(changes.map((r) => r[cell.p2]), ['9.000000', '14.500000']);
  for (const row of changes) {
    assert.equal(row[cell.p1], '1.000000', 'SPEED_TYPE_GROUNDSPEED');
    assert.equal(row[cell.p3], '-1.000000', 'throttle unchanged');
    assert.deepEqual(row.slice(cell.latitude, cell.altitude + 1), ['0.0000000', '0.0000000', '0.000000'],
      'a command with no location sits at zero');
  }
});

test('a direct return is an RTL row last; a retraced one is a named loss', () => {
  const direct = wplOf({ returnPolicy: { mode: 'direct', altitude: null } }).result;
  const rows = rowsOf(direct);
  assert.equal(rows[rows.length - 1][cell.command], '20', 'MAV_CMD_NAV_RETURN_TO_LAUNCH');

  const retrace = wplOf({ returnPolicy: { mode: 'retrace', altitude: null } }).result;
  assert.equal(rowsOf(retrace).some((r) => r[cell.command] === '20'), false);
  assert.ok(retrace.semanticLosses.some((l) => l.concept === 'return-policy' && /retraced/.test(l.detail)));
});

test('a return altitude is named as the vehicle parameter it really is', () => {
  const { result } = wplOf({
    returnPolicy: { mode: 'direct', altitude: { authored: 60, reference: 'launchRelative', resolvedMslM: null } },
  });
  assert.ok(result.semanticLosses.some((l) => l.concept === 'return-policy' && /RTL_ALT/.test(l.detail)));
});

test('the payload names itself, and the envelope says where it came from', () => {
  const { result } = wplOf({ filenameBase: 'CMAC circuit/lap 3' });
  assert.equal(result.payload.filename, 'CMAC-circuit-lap-3.waypoints');
  assert.equal(result.payload.mime, 'text/plain');
  assert.equal(result.sourceFormat, 'mission-document-v1');
  assert.equal(result.targetFormat, FORMAT.id);
  assert.equal(result.adapterVersion, '1.0.0');
  assert.deepEqual([...FORMAT.extensions], ['.waypoints', '.txt']);
});

/* ---------- 3. the round trip ---------- */

test('a mission survives export and import inside ADR 0010\'s tolerances', () => {
  const { doc, result } = wplOf({ returnPolicy: { mode: 'direct', altitude: null } });
  const back = importMission(result.payload.text, harness('in'));

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
  near(back.payload.launch.latitude, LAUNCH.latitude, 1e-6, 'launch latitude');
  near(back.payload.launch.longitude, LAUNCH.longitude, 1e-6, 'launch longitude');
  near(back.payload.launch.elevationMslM, LAUNCH.elevationMslM, 0.1, 'launch elevation');
});

test('a hold becomes a holding segment again, and a transit stays a transit', () => {
  const { result } = wplOf();
  const back = importMission(result.payload.text, harness('in'));
  assert.deepEqual(back.payload.route.segments.map((s) => s.intent), ['transit', 'hold', 'transit']);
  assert.deepEqual(back.payload.route.segments.map((s) => s.holdS), [null, 8, null]);
});

test('ids do not survive the trip, and the import says so rather than pretending', () => {
  const { doc, result } = wplOf();
  const back = importMission(result.payload.text, harness('in'));
  const originalIds = new Set(doc.route.waypoints.map((w) => w.id));

  for (const waypoint of back.payload.route.waypoints) {
    assert.match(waypoint.id, /^wpt_in\d+$/, 'ids come from the caller\'s generator');
    assert.equal(originalIds.has(waypoint.id), false);
  }
  assert.ok(back.semanticLosses.some((l) => /minted fresh ids/.test(l.detail)));
});

test('an imported document is one the schema accepts, and says it was imported', () => {
  const { result } = wplOf();
  const back = importMission(result.payload.text, harness('in'));

  assert.equal(validateMission(back.payload).ok, true);
  assert.deepEqual(validateMission(back.payload).errors, []);
  assert.equal(back.payload.provenance.origin, 'imported');
  assert.equal(back.payload.provenance.sourceFormat, FORMAT.id);
  assert.equal(back.sourceFormat, FORMAT.id);
  assert.equal(back.targetFormat, 'mission-document-v1');
  assert.equal(back.status, 'degraded');
  for (const segment of back.payload.route.segments) {
    assert.equal(segment.altitude.resolvedMslM, null, 'resolving altitudes is the domain\'s job');
  }
});

test('a file with no RTL row imports as a mission with no return, not a guessed one', () => {
  const { result } = wplOf({ returnPolicy: { mode: 'none', altitude: null } });
  const back = importMission(result.payload.text, harness('in'));
  assert.deepEqual(back.payload.route.returnPolicy, { mode: 'none', altitude: null });
});

/* ---------- 4. what the format cannot hold ---------- */

test('a rich mission names every concept this format drops, and none that it keeps', () => {
  const scene = [{
    id: 'sub_1', name: 'Tower', latitude: -35.3625, longitude: 149.1642,
    elevationMslM: 600, radiusM: 30,
  }];
  const stops = [
    { ...CIRCUIT[0] },
    { ...CIRCUIT[1], subjectRef: 'sub_1', camera: { tilt: -20 } },
    { ...CIRCUIT[2], intent: 'orbit' },
  ];
  const { result } = wplOf({ stops, scene, returnPolicy: { mode: 'direct', altitude: null } });

  assert.equal(result.status, 'degraded');
  assert.deepEqual(conceptsOf(result), ['camera-intent', 'reserve']);
  for (const loss of result.semanticLosses) {
    assert.equal(loss.disposition, 'dropped');
    assert.ok(loss.detail.length > 0);
  }
});

test('the support table is the one this format can honour', () => {
  assert.deepEqual(SUPPORT, {
    geometry: 'native',
    'altitude-reference': 'native',
    speed: 'native',
    hold: 'native',
    'camera-intent': 'unsupported',
    'return-policy': 'native',
    reserve: 'unsupported',
  });
  assert.equal(Object.isFrozen(SUPPORT), true);
  assert.ok(conceptsOf(wplOf().result).includes('reserve'), 'no waypoint file holds a landing reserve');
});

test('a speed the compiler could not resolve is a loss, not an invented number', () => {
  const { result } = wplOf({ stops: CIRCUIT.map((s) => ({ ...s, speed: { mode: 'cruise', targetMs: null } })) });
  assert.equal(rowsOf(result).some((row) => row[cell.command] === '178'), false);
  assert.ok(result.semanticLosses.some((l) => l.concept === 'speed' && /will not invent/.test(l.detail)));

  const resolved = wplOf({
    aircraft: AIRCRAFT, stops: CIRCUIT.map((s) => ({ ...s, speed: { mode: 'cruise', targetMs: null } })),
  }).result;
  const changes = rowsOf(resolved).filter((row) => row[cell.command] === '178');
  assert.equal(changes.length, 1);
  assert.equal(changes[0][cell.p2], '11.000000', 'the aircraft\'s own cruise speed');
});

test('the cruise policy behind an imported speed is gone, and the import says so', () => {
  const { result } = wplOf();
  const back = importMission(result.payload.text, harness('in'));
  assert.deepEqual([...new Set(back.payload.route.segments.map((s) => s.speedPolicy.mode))], ['fixed']);
  assert.ok(back.semanticLosses.some((l) => l.concept === 'speed' && /cruise, max-range/.test(l.detail)));
});

/* ---------- 5. refusals ---------- */

test('an export refuses rather than fabricating the two numbers it cannot know', () => {
  const noElevation = wplOf({ launch: { ...LAUNCH, elevationMslM: null } }).result;
  assert.equal(noElevation.status, 'failed');
  assert.equal(noElevation.payload, null);
  assert.equal(noElevation.errors[0].code, 'E-WPL-HOME-ELEVATION');

  const empty = wplOf({ stops: [] }).result;
  assert.equal(empty.status, 'failed');
  assert.equal(empty.errors[0].code, 'E-WPL-EMPTY');

  const noTerrain = wplOf({ stops: [{ ...CIRCUIT[0], reference: 'agl' }] }).result;
  assert.equal(noTerrain.errors[0].code, 'E-WPL-ALTITUDE-UNRESOLVED');
});

test('a file without the magic first line is refused', () => {
  for (const text of ['', 'QGC WPL 120\n', '0\t1\t0\t16\t0\t0\t0\t0\t1\t2\t3\t1\n']) {
    const result = importMission(text, harness());
    assert.equal(result.status, 'failed', JSON.stringify(text));
    assert.equal(result.errors[0].code, 'E-WPL-HEADER');
  }
});

test('a row that is not twelve numbers is refused, and the line is named', () => {
  const good = '0\t1\t0\t16\t0\t0\t0\t0\t47.6\t-122.1\t5\t1';
  const cases = [
    [`QGC WPL 110\n${good}\n0\t1\t0\t16\t0\t0\t0\t0\t47.6\t-122.1\t5\n`, 'E-WPL-COLUMNS'],
    [`QGC WPL 110\n${good}\t9\n`, 'E-WPL-COLUMNS'],
    ['QGC WPL 110\n', 'E-WPL-EMPTY'],
    ['QGC WPL 110\n\n   \n', 'E-WPL-EMPTY'],
  ];
  for (const [text, code] of cases) {
    const result = importMission(text, harness());
    assert.equal(result.status, 'failed', text);
    assert.equal(result.errors[0].code, code, text);
    assert.equal(result.payload, null);
  }
});

test('a cell that is not a number fails the import rather than propagating a NaN', () => {
  const rows = [
    '0\t1\t0\t16\t0\t0\t0\t0\t47.660459\t-122.103167\t5.21\t1',
    '1\t0\t3\t16\t0\t0\t0\t0\tNaN\t-122.103274\t100\t1',
  ];
  const result = importMission(`QGC WPL 110\n${rows.join('\n')}\n`, harness());

  assert.equal(result.status, 'failed');
  assert.equal(result.payload, null, 'a NaN never reaches a coordinate');
  assert.equal(result.errors[0].code, 'E-WPL-NOT-A-NUMBER');
  assert.match(result.errors[0].message, /Line 3/, 'the line number counts the header');
  assert.match(result.errors[0].message, /NaN/);

  // The same for the values that merely look numeric.
  for (const bad of ['12abc', 'Infinity', '', '1e', '0x1g', '__proto__']) {
    const text = `QGC WPL 110\n${rows[0]}\n1\t0\t3\t16\t0\t0\t0\t0\t${bad}\t-122.1\t100\t1\n`;
    const attempt = importMission(text, harness());
    assert.equal(attempt.status, 'failed', bad);
    // An empty cell collapses under the whitespace split, so it is short rather
    // than non-numeric; either way the file is refused.
    assert.ok(['E-WPL-NOT-A-NUMBER', 'E-WPL-COLUMNS'].includes(attempt.errors[0].code), bad);
  }
});

test('a coordinate outside the earth is refused, wherever it sits', () => {
  const home = (lat, lon) => `0\t1\t0\t16\t0\t0\t0\t0\t${lat}\t${lon}\t5\t1`;
  const homeOk = home(47.660459, -122.103167);

  const badHome = importMission(`QGC WPL 110\n${home(147.6, -122.1)}\n`, harness());
  assert.equal(badHome.errors[0].code, 'E-WPL-HOME');

  const badRow = importMission(
    `QGC WPL 110\n${homeOk}\n1\t0\t3\t16\t0\t0\t0\t0\t47.6\t-190.2\t100\t1\n`, harness(),
  );
  assert.equal(badRow.errors[0].code, 'E-WPL-GEO-RANGE');
  assert.match(badRow.errors[0].message, /Line 3/);
});

test('a file too large to trust is refused before it is parsed', () => {
  const result = importMission(`QGC WPL 110\n${'0\t'.repeat(3 * 1024 * 1024)}\n`, harness());
  assert.equal(result.status, 'failed');
  assert.equal(result.errors[0].code, 'E-IMPORT-TOO-LARGE');
});

test('a file with a home row and nothing flyable is refused by name', () => {
  const text = 'QGC WPL 110\n'
    + '0\t1\t0\t16\t0\t0\t0\t0\t47.660459\t-122.103167\t5.21\t1\n'
    + '1\t0\t3\t22\t0\t0\t0\t0\t47.661298\t-122.103274\t20\t1\n';
  const result = importMission(text, harness());
  assert.equal(result.status, 'failed');
  assert.equal(result.errors[0].code, 'E-WPL-NO-WAYPOINTS');
});

test('a home row in a relative frame gives up its elevation, not its position', () => {
  const text = 'QGC WPL 110\n'
    + '0\t1\t3\t16\t0\t0\t0\t0\t47.660459\t-122.103167\t0\t1\n'
    + '1\t0\t3\t16\t0\t0\t0\t0\t47.661298\t-122.103274\t100\t1\n';
  const result = importMission(text, harness());

  assert.equal(result.payload.launch.elevationMslM, null, 'a height above itself is no elevation');
  near(result.payload.launch.latitude, 47.660459, 1e-6, 'launch latitude');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /MAV_FRAME 3/);
});

/* ---------- 6. the fixtures ---------- */

test('ArduPilot\'s own CMAC circuit imports, with its non-waypoint rows named', () => {
  const result = importMission(fixture('ardupilot-cmac-circuit.waypoints'), harness('in'));

  assert.equal(result.status, 'degraded');
  assert.equal(validateMission(result.payload).ok, true);
  near(result.payload.launch.latitude, -35.363262, 1e-6, 'launch latitude');
  near(result.payload.launch.longitude, 149.165237, 1e-6, 'launch longitude');
  near(result.payload.launch.elevationMslM, 584.080017, 0.1, 'launch elevation');

  // Seven rows: home, a takeoff, four waypoints and a DO_JUMP.
  assert.equal(result.payload.route.waypoints.length, 4);
  const dropped = result.semanticLosses.find((l) => /dropped 2 row/.test(l.detail));
  assert.ok(dropped, 'the takeoff and the DO_JUMP are both named');
  assert.match(dropped.detail, /takeoff/);
  assert.match(dropped.detail, /MAV_CMD 177/);
  assert.equal(result.payload.route.returnPolicy.mode, 'none', 'this file has no RTL row');
  for (const segment of result.payload.route.segments) {
    assert.equal(segment.altitude.reference, 'launchRelative', 'MAV_FRAME 3 throughout');
    assert.equal(segment.altitude.authored, 20);
  }
});

test('the trailing blank line of a real file is not read as a row', () => {
  const text = fixture('ardupilot-cmac-circuit.waypoints');
  assert.match(text, /\n$/);
  assert.equal(importMission(text, harness()).status, 'degraded');
});

test('a Mission Planner file with unpadded integer cells reads the same as a padded one', () => {
  const text = fixture('qgroundcontrol-missionplanner.waypoints');
  // Its home row writes `0` where ArduPilot writes `0.000000`: the columns are
  // numbers, not fixed-width fields, which is why the reader splits on
  // whitespace runs and converts rather than slicing.
  assert.match(text.split('\n')[1], /\t0\t0\t0\t0\t/);

  const result = importMission(text, harness('in'));
  assert.equal(validateMission(result.payload).ok, true);
  assert.equal(result.payload.route.waypoints.length, 5);
  near(result.payload.launch.elevationMslM, 5.21, 0.1, 'launch elevation');
  near(result.payload.route.waypoints[0].latitude, 47.661298, 1e-6, 'first waypoint');
  assert.equal(result.payload.route.segments[0].altitude.authored, 100);
  assert.deepEqual([...new Set(result.payload.route.segments.map((s) => s.speedPolicy.mode))], ['cruise'],
    'no DO_CHANGE_SPEED row, so no speed to claim');
});

test('a fixture round-trips through this adapter without moving', () => {
  const imported = importMission(fixture('qgroundcontrol-missionplanner.waypoints'), harness('in'));
  const compiled = compileMission(imported.payload);
  const again = importMission(exportMission(compiled).payload.text, harness('re'));

  imported.payload.route.waypoints.forEach((original, i) => {
    const arrived = again.payload.route.waypoints[i];
    near(arrived.latitude, original.latitude, 1e-6, `waypoint ${i} latitude`);
    near(arrived.longitude, original.longitude, 1e-6, `waypoint ${i} longitude`);
  });
  imported.payload.route.segments.forEach((original, i) => {
    near(again.payload.route.segments[i].altitude.authored, original.altitude.authored, 0.1, `segment ${i}`);
  });
});
