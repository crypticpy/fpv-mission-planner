import test from 'node:test';
import assert from 'node:assert/strict';

import { createMission, validateMission, LAUNCH_NODE } from '../src/domain/mission/mission-schema.js';
import { MISSION_COMMANDS, missionReduce } from '../src/domain/mission/mission-reducer.js';

/* The reducer's two promises are what these tests are for: a rejected command
 * changes nothing (and says why), and no command ever hands back a document the
 * validator would refuse. Everything else — chain repair, which resolved
 * altitudes survive a launch move — is a consequence of those two plus the
 * segment invariant, so each test names the behaviour rather than the branch. */

const AUSTIN = { latitude: 30.2672, longitude: -97.7431, elevationMslM: 168 };

/* Snapshots carry every number the physics reads — the validator insists, so a
 * half-filled loadout is a rejected command rather than a saved mission. */
const AIRCRAFT = {
  sourceId: 'moz7v2', name: 'GEPRC MOZ7 V2', dryMassG: 843, propDiaIn: 7.5, numRotors: 4,
  etaProp: 0.55, cdA: 0.042, avionicsW: 10, maxSpeedMs: 30.5, cruiseMs: 18,
};
const BATTERY = {
  sourceId: 'nav5000', name: 'Lumenier NAV 5000', chem: 'liion',
  s: 6, capAh: 5, massG: 499, irPackMilliOhm: 118, packCount: 1,
};
const PAYLOAD = { sourceId: 'naked', name: 'Naked GoPro', massG: 32, cdA: 0.0015 };

/** Deterministic identity and a clock that ticks one second per command. */
function harness() {
  let ids = 0;
  let ticks = 0;
  /** @type {{code: string, command: string, path: string|null, message: string}[]} */
  const warnings = [];
  return {
    warnings,
    idgen: (prefix) => `${prefix}_${++ids}`,
    now: () => new Date(Date.UTC(2026, 6, 30, 12, 0, ticks++)).toISOString(),
    onWarning: (w) => warnings.push(w),
  };
}

const start = (deps) => createMission({ launch: AUSTIN, title: 'Ridge run' }, deps);

/** Apply a list of commands in order. */
function run(doc, commands, deps) {
  return commands.reduce((d, c) => missionReduce(d, c, deps), doc);
}

const wp = (latitude, longitude, rest = {}) => ({ type: 'addWaypoint', payload: { latitude, longitude, ...rest } });

/** A three-waypoint route: wpt_2/wpt_4/wpt_6 reached by seg_3/seg_5/seg_7. */
function routed(deps) {
  return run(start(deps), [wp(30.3, -97.8), wp(30.4, -97.9), wp(30.5, -98.0)], deps);
}

/** The invariant every handler preserves: segment i is the leg arriving at waypoint i. */
function assertChain(doc) {
  const { waypoints, segments } = doc.route;
  assert.equal(segments.length, waypoints.length, 'one segment per waypoint');
  segments.forEach((seg, i) => {
    assert.equal(seg.to, waypoints[i].id, `segment ${i} arrives at waypoint ${i}`);
    assert.equal(seg.from, i === 0 ? LAUNCH_NODE : waypoints[i - 1].id, `segment ${i} departs the previous node`);
  });
  assert.deepEqual(validateMission(doc).errors, []);
}

/* ---------- immutability, the property that has to hold everywhere ---------- */

test('no command mutates the document it was given', () => {
  const deps = harness();
  const doc = routed(deps);
  const before = structuredClone(doc);
  const commands = [
    { type: 'setTitle', payload: { title: 'Renamed' } },
    { type: 'setLaunch', payload: { latitude: 30.1, longitude: -97.6, elevationMslM: 200 } },
    wp(30.6, -98.1),
    { type: 'moveWaypoint', payload: { id: 'wpt_2', latitude: 30.31, longitude: -97.81 } },
    { type: 'removeWaypoint', payload: { id: 'wpt_4' } },
    { type: 'setSegmentAltitude', payload: { segmentId: 'seg_3', authored: 120, reference: 'agl' } },
    { type: 'setSegmentSpeed', payload: { segmentId: 'seg_3', speedPolicy: { mode: 'fixed', targetMs: 14 } } },
    { type: 'setSegmentIntent', payload: { segmentId: 'seg_5', intent: 'orbit', holdS: 45 } },
    { type: 'setReturnPolicy', payload: { mode: 'retrace', altitude: { authored: 100, reference: 'msl' } } },
    { type: 'setPlanningPolicy', payload: { gustFactor: 0.5 } },
    { type: 'snapshotLoadout', payload: { aircraft: AIRCRAFT } },
    { type: 'setEnvironmentReference', payload: { source: 'preset', presetId: 'hot-day' } },
  ];
  for (const command of commands) missionReduce(doc, command, deps);
  assert.deepEqual(doc, before, 'the original is byte-for-byte what it was');
});

test('unchanged branches are shared, not copied', () => {
  const deps = harness();
  const doc = routed(deps);
  const next = missionReduce(doc, { type: 'setTitle', payload: { title: 'Renamed' } }, deps);
  assert.notEqual(next, doc);
  assert.equal(next.route, doc.route, 'retitling does not clone the route');
  assert.equal(next.provenance, doc.provenance);
});

test('every state-changing command re-stamps updatedAt and leaves createdAt alone', () => {
  const deps = harness();
  const doc = routed(deps);
  for (const command of [
    { type: 'setTitle', payload: { title: 'x' } },
    wp(30.9, -98.4),
    { type: 'setPlanningPolicy', payload: { windLevel: 40 } },
    { type: 'setReturnPolicy', payload: { mode: 'none' } },
  ]) {
    const next = missionReduce(doc, command, deps);
    assert.notEqual(next.updatedAt, doc.updatedAt, `${command.type} stamps the clock`);
    assert.equal(next.createdAt, doc.createdAt, `${command.type} leaves createdAt alone`);
  }
});

/* ---------- a rejected command changes nothing ---------- */

test('an unknown command returns the very same document, with a warning naming the ones that exist', () => {
  const deps = harness();
  const doc = routed(deps);
  const next = missionReduce(doc, { type: 'setVibes', payload: { vibes: 'cinematic' } }, deps);
  assert.equal(next, doc, 'the same object, so `next === doc` means nothing happened');
  const [warning] = deps.warnings;
  assert.deepEqual(
    { code: warning.code, command: warning.command, path: warning.path },
    { code: 'W-CMD-UNKNOWN', command: 'setVibes', path: null });
  assert.match(warning.message, /setSegmentIntent/, 'the warning lists the real commands');
});

for (const [label, command] of [
  ['a bare string', 'setTitle'],
  ['null', null],
  ['an object with no type', { payload: { title: 'x' } }],
  ['a non-string type', { type: 7 }],
]) {
  test(`a malformed command (${label}) is refused without touching the document`, () => {
    const deps = harness();
    const doc = routed(deps);
    assert.equal(missionReduce(doc, command, deps), doc);
    assert.equal(deps.warnings[0].code, 'W-CMD-MALFORMED');
  });
}

const rejections = [
  ['a title that is not text', { type: 'setTitle', payload: { title: 42 } }, 'title'],
  ['a launch off the globe', { type: 'setLaunch', payload: { latitude: 91, longitude: 0 } }, 'launch'],
  ['a launch elevation that is not a number', { type: 'setLaunch', payload: { latitude: 30, longitude: -97, elevationMslM: 'high' } }, 'launch.elevationMslM'],
  ['a waypoint with no coordinates', { type: 'addWaypoint', payload: {} }, 'latitude/longitude'],
  ['a waypoint with an intent nobody defined', wp(30.6, -98.1, { intent: 'swoop' }), 'intent'],
  ['a dwell time on a transit waypoint', wp(30.6, -98.1, { holdS: 30 }), 'holdS'],
  ['a negative dwell time', wp(30.6, -98.1, { intent: 'hold', holdS: -1 }), 'holdS'],
  ['moving a waypoint that is not on this route', { type: 'moveWaypoint', payload: { id: 'wpt_99', latitude: 30, longitude: -97 } }, 'id'],
  ['removing a waypoint that is not on this route', { type: 'removeWaypoint', payload: { id: 'wpt_99' } }, 'id'],
  ['an altitude on a segment that is not on this route', { type: 'setSegmentAltitude', payload: { segmentId: 'seg_99', authored: 90, reference: 'msl' } }, 'segmentId'],
  ['an altitude frame nobody defined', { type: 'setSegmentAltitude', payload: { segmentId: 'seg_3', authored: 90, reference: 'aboveTheTrees' } }, 'altitude.reference'],
  ['an authored altitude that is not a number', { type: 'setSegmentAltitude', payload: { segmentId: 'seg_3', authored: '90', reference: 'msl' } }, 'altitude.authored'],
  ['a fixed speed with no target', { type: 'setSegmentSpeed', payload: { segmentId: 'seg_3', speedPolicy: { mode: 'fixed' } } }, 'speedPolicy.targetMs'],
  ['a speed mode nobody defined', { type: 'setSegmentSpeed', payload: { segmentId: 'seg_3', speedPolicy: { mode: 'ludicrous' } } }, 'speedPolicy.mode'],
  ['an intent nobody defined', { type: 'setSegmentIntent', payload: { segmentId: 'seg_3', intent: 'swoop' } }, 'intent'],
  ['a dwell time on a transit leg', { type: 'setSegmentIntent', payload: { segmentId: 'seg_3', intent: 'transit', holdS: 20 } }, 'holdS'],
  ['a return mode nobody defined', { type: 'setReturnPolicy', payload: { mode: 'walk' } }, 'mode'],
  ['a reserve that is not an object', { type: 'setPlanningPolicy', payload: { reserve: 25 } }, 'reserve'],
  ['a snapshot that is a bare id', { type: 'snapshotLoadout', payload: { aircraft: 'moz7v2' } }, 'aircraft'],
  ['an environment source nobody defined', { type: 'setEnvironmentReference', payload: { source: 'vibes' } }, 'source'],
];

for (const [label, command, path] of rejections) {
  test(`rejects ${label}`, () => {
    const deps = harness();
    const doc = routed(deps);
    assert.equal(missionReduce(doc, command, deps), doc, 'nothing happened');
    assert.equal(deps.warnings.length, 1);
    assert.equal(deps.warnings[0].code, 'W-CMD-REJECTED');
    assert.equal(deps.warnings[0].command, command.type);
    assert.equal(deps.warnings[0].path, path);
    assert.ok(deps.warnings[0].message.length > 0);
  });
}

test('a command that would introduce a structural error is rejected with that error', () => {
  const deps = harness();
  const doc = routed(deps);
  // A gust factor typed as a percentage rather than a fraction: the handler has
  // nothing to say about it, the contract does.
  const next = missionReduce(doc, { type: 'setPlanningPolicy', payload: { gustFactor: 35 } }, deps);
  assert.equal(next, doc);
  assert.equal(deps.warnings[0].code, 'W-CMD-REJECTED');
  assert.equal(deps.warnings[0].path, 'planningPolicy.gustFactor');
});

test('a document that arrived broken can still be edited back into shape', () => {
  const deps = harness();
  const broken = { ...routed(deps), aircraftSnapshot: 'moz7v2' };
  assert.equal(validateMission(broken).ok, false);
  const next = missionReduce(broken, { type: 'setTitle', payload: { title: 'Still editable' } }, deps);
  assert.equal(next.title, 'Still editable', 'the pre-existing error is not held against this command');
  assert.deepEqual(deps.warnings, []);
});

test('a successful command reports nothing', () => {
  const deps = harness();
  missionReduce(routed(deps), { type: 'setTitle', payload: { title: 'Quiet' } }, deps);
  assert.deepEqual(deps.warnings, []);
});

/* ---------- route editing ---------- */

test('addWaypoint appends the waypoint and the leg that reaches it', () => {
  const deps = harness();
  const doc = routed(deps);
  assertChain(doc);
  assert.deepEqual(doc.route.waypoints.map((w) => w.id), ['wpt_2', 'wpt_4', 'wpt_6']);
  assert.deepEqual(doc.route.segments.map((s) => s.id), ['seg_3', 'seg_5', 'seg_7']);
  assert.equal(doc.route.segments[0].from, LAUNCH_NODE, 'the first leg is the climb-out from the launch');
  assert.deepEqual(doc.route.segments[0].altitude, { authored: 80, reference: 'launchRelative', resolvedMslM: null });
  assert.deepEqual(doc.route.segments[0].speedPolicy, { mode: 'cruise', targetMs: null });
  assert.equal(doc.route.segments[0].intent, 'transit');
});

test('addWaypoint takes an altitude, a speed and a dwell when it is offered one', () => {
  const deps = harness();
  const doc = missionReduce(start(deps), wp(30.3, -97.8, {
    altitude: { authored: 45, reference: 'agl' },
    speedPolicy: { mode: 'fixed', targetMs: 9 },
    intent: 'orbit',
    holdS: 30,
  }), deps);
  const [seg] = doc.route.segments;
  assert.deepEqual(seg.altitude, { authored: 45, reference: 'agl', resolvedMslM: null });
  assert.deepEqual(seg.speedPolicy, { mode: 'fixed', targetMs: 9 });
  assert.equal(seg.intent, 'orbit');
  assert.equal(seg.holdS, 30);
});

test('ids come from deps and are never handed out twice', () => {
  const deps = harness();
  const doc = routed(deps);
  const ids = [doc.id, ...doc.route.waypoints.map((w) => w.id), ...doc.route.segments.map((s) => s.id)];
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ['msn_1', 'wpt_2', 'wpt_4', 'wpt_6', 'seg_3', 'seg_5', 'seg_7']);
});

test('an edit never re-mints an id', () => {
  const deps = harness();
  const doc = routed(deps);
  const next = run(doc, [
    { type: 'moveWaypoint', payload: { id: 'wpt_4', latitude: 30.45, longitude: -97.95 } },
    { type: 'setSegmentIntent', payload: { segmentId: 'seg_5', intent: 'reveal' } },
    { type: 'setTitle', payload: { title: 'Same route, new name' } },
  ], deps);
  assert.deepEqual(next.route.waypoints.map((w) => w.id), doc.route.waypoints.map((w) => w.id));
  assert.deepEqual(next.route.segments.map((s) => s.id), doc.route.segments.map((s) => s.id));
  assert.equal(next.id, doc.id);
});

test('moveWaypoint moves one point and nothing else', () => {
  const deps = harness();
  const doc = routed(deps);
  const next = missionReduce(doc, { type: 'moveWaypoint', payload: { id: 'wpt_4', latitude: 30.44, longitude: -97.94 } }, deps);
  assert.deepEqual(next.route.waypoints[1], { id: 'wpt_4', latitude: 30.44, longitude: -97.94 });
  assert.deepEqual(next.route.waypoints[0], doc.route.waypoints[0]);
  assert.deepEqual(next.route.waypoints[2], doc.route.waypoints[2]);
  assertChain(next);
});

test('removeWaypoint drops the leg that arrived there and re-anchors the next one', () => {
  const deps = harness();
  const doc = routed(deps);
  const next = missionReduce(doc, { type: 'removeWaypoint', payload: { id: 'wpt_4' } }, deps);
  assert.deepEqual(next.route.waypoints.map((w) => w.id), ['wpt_2', 'wpt_6']);
  assert.deepEqual(next.route.segments.map((s) => s.id), ['seg_3', 'seg_7'],
    'the survivors keep their own ids');
  assert.equal(next.route.segments[1].from, 'wpt_2', 'the leg to wpt_6 now departs wpt_2');
  assertChain(next);
});

test('removing the first waypoint re-anchors the route to the launch', () => {
  const deps = harness();
  const next = missionReduce(routed(deps), { type: 'removeWaypoint', payload: { id: 'wpt_2' } }, deps);
  assert.deepEqual(next.route.segments.map((s) => s.id), ['seg_5', 'seg_7']);
  assert.equal(next.route.segments[0].from, LAUNCH_NODE);
  assertChain(next);
});

test('removing the last waypoint leaves the rest of the chain untouched', () => {
  const deps = harness();
  const doc = routed(deps);
  const next = missionReduce(doc, { type: 'removeWaypoint', payload: { id: 'wpt_6' } }, deps);
  assert.deepEqual(next.route.segments.map((s) => s.id), ['seg_3', 'seg_5']);
  assert.equal(next.route.segments[0], doc.route.segments[0], 'untouched legs are the same objects');
  assertChain(next);
});

test('removing the only waypoint leaves an empty, valid route', () => {
  const deps = harness();
  const doc = missionReduce(start(deps), wp(30.3, -97.8), deps);
  const next = missionReduce(doc, { type: 'removeWaypoint', payload: { id: 'wpt_2' } }, deps);
  assert.deepEqual(next.route.waypoints, []);
  assert.deepEqual(next.route.segments, []);
  assertChain(next);
});

/* ---------- moving the launch keeps the route (ADR 0002) ---------- */

/** Pretend altitude.js has been past: every altitude carries a resolved figure. */
function resolveAll(doc) {
  const segments = doc.route.segments.map((s) => ({
    ...s, altitude: { ...s.altitude, resolvedMslM: 168 + s.altitude.authored },
  }));
  return { ...doc, route: { ...doc.route, segments } };
}

test('moving the launch keeps every waypoint exactly where it was', () => {
  const deps = harness();
  const doc = routed(deps);
  const next = missionReduce(doc, { type: 'setLaunch', payload: { latitude: 30.2, longitude: -97.7, elevationMslM: 190 } }, deps);
  assert.deepEqual(next.route.waypoints, doc.route.waypoints,
    'the old "moving launch clears the route" behaviour is dead');
  assert.deepEqual(next.route.segments.map((s) => s.id), doc.route.segments.map((s) => s.id));
  assert.deepEqual(next.launch, { latitude: 30.2, longitude: -97.7, elevationMslM: 190 });
  assertChain(next);
});

test('moving the launch drops the resolved MSL of everything that depended on it', () => {
  const deps = harness();
  const doc = resolveAll(run(start(deps), [
    wp(30.3, -97.8, { altitude: { authored: 80, reference: 'launchRelative' } }),
    wp(30.4, -97.9, { altitude: { authored: 45, reference: 'agl' } }),
    wp(30.5, -98.0, { altitude: { authored: 400, reference: 'msl' } }),
  ], deps));
  const next = missionReduce(doc, { type: 'setLaunch', payload: { latitude: 30.2, longitude: -97.7 } }, deps);
  assert.equal(next.route.segments[0].altitude.resolvedMslM, null, 'launch-relative is anchored to a launch that moved');
  assert.equal(next.route.segments[1].altitude.resolvedMslM, null, 'AGL was sampled against the old terrain snapshot');
  assert.equal(next.route.segments[2].altitude.resolvedMslM, 568, 'MSL does not care where the launch is');
  assert.equal(next.launch.elevationMslM, null, 'an elevation nobody supplied is unknown, not the old one');
});

test('moving the launch drops a launch-relative return altitude too', () => {
  const deps = harness();
  const doc = missionReduce(start(deps), {
    type: 'setReturnPolicy', payload: { mode: 'direct', altitude: { authored: 120, reference: 'launchRelative' } },
  }, deps);
  const resolved = {
    ...doc,
    route: { ...doc.route, returnPolicy: { ...doc.route.returnPolicy, altitude: { authored: 120, reference: 'launchRelative', resolvedMslM: 288 } } },
  };
  const next = missionReduce(resolved, { type: 'setLaunch', payload: { latitude: 30.2, longitude: -97.7 } }, deps);
  assert.equal(next.route.returnPolicy.altitude.resolvedMslM, null);
  assert.equal(next.route.returnPolicy.altitude.authored, 120, 'the authored height is the pilot\'s and stays');
});

test('moving a waypoint drops only that leg\'s AGL resolution', () => {
  const deps = harness();
  const doc = resolveAll(run(start(deps), [
    wp(30.3, -97.8, { altitude: { authored: 80, reference: 'launchRelative' } }),
    wp(30.4, -97.9, { altitude: { authored: 45, reference: 'agl' } }),
  ], deps));
  const next = missionReduce(doc, { type: 'moveWaypoint', payload: { id: 'wpt_4', latitude: 30.41, longitude: -97.91 } }, deps);
  assert.equal(next.route.segments[1].altitude.resolvedMslM, null, 'different ground under the arrival point');
  assert.equal(next.route.segments[0].altitude.resolvedMslM, 248, 'the untouched leg keeps its figure');
});

/* ---------- segment editing ---------- */

test('setSegmentAltitude replaces the authored height and always leaves it unresolved', () => {
  const deps = harness();
  const doc = resolveAll(routed(deps));
  const next = missionReduce(doc, { type: 'setSegmentAltitude', payload: { segmentId: 'seg_5', authored: 130, reference: 'msl' } }, deps);
  assert.deepEqual(next.route.segments[1].altitude, { authored: 130, reference: 'msl', resolvedMslM: null },
    'altitude.js is the only writer of resolvedMslM');
  assert.equal(next.route.segments[0], doc.route.segments[0]);
});

test('setSegmentAltitude will not let a caller assert its own MSL figure', () => {
  const deps = harness();
  const doc = routed(deps);
  const next = missionReduce(doc, {
    type: 'setSegmentAltitude',
    payload: { segmentId: 'seg_3', authored: 80, reference: 'launchRelative', resolvedMslM: 9999 },
  }, deps);
  assert.equal(next.route.segments[0].altitude.resolvedMslM, null);
});

test('setSegmentSpeed swaps the policy for that one leg', () => {
  const deps = harness();
  const doc = routed(deps);
  const next = missionReduce(doc, { type: 'setSegmentSpeed', payload: { segmentId: 'seg_7', speedPolicy: { mode: 'maxRange' } } }, deps);
  assert.deepEqual(next.route.segments[2].speedPolicy, { mode: 'maxRange', targetMs: null });
  assert.deepEqual(next.route.segments[0].speedPolicy, { mode: 'cruise', targetMs: null });
});

test('setSegmentIntent keeps a dwell time when the new intent still holds station', () => {
  const deps = harness();
  const doc = run(routed(deps), [
    { type: 'setSegmentIntent', payload: { segmentId: 'seg_3', intent: 'hold', holdS: 60 } },
  ], deps);
  assert.equal(doc.route.segments[0].holdS, 60);
  const orbited = missionReduce(doc, { type: 'setSegmentIntent', payload: { segmentId: 'seg_3', intent: 'orbit' } }, deps);
  assert.equal(orbited.route.segments[0].holdS, 60, 're-typing the duration after a mis-click is not a thing');
});

test('setSegmentIntent drops a dwell time that no longer means anything', () => {
  const deps = harness();
  const doc = missionReduce(routed(deps), { type: 'setSegmentIntent', payload: { segmentId: 'seg_3', intent: 'hold', holdS: 60 } }, deps);
  const transit = missionReduce(doc, { type: 'setSegmentIntent', payload: { segmentId: 'seg_3', intent: 'transit' } }, deps);
  assert.equal(transit.route.segments[0].holdS, null, 'no orphan number left for an exporter to believe');
  assert.deepEqual(validateMission(transit).errors, []);
});

test('every command in MISSION_COMMANDS actually changes something', () => {
  const deps = harness();
  const doc = routed(deps);
  const exercised = {
    setTitle: { title: 'x' },
    setLaunch: { latitude: 30.2, longitude: -97.7 },
    addWaypoint: { latitude: 30.9, longitude: -98.4 },
    moveWaypoint: { id: 'wpt_2', latitude: 30.31, longitude: -97.81 },
    removeWaypoint: { id: 'wpt_2' },
    setSegmentAltitude: { segmentId: 'seg_3', authored: 60, reference: 'msl' },
    setSegmentSpeed: { segmentId: 'seg_3', speedPolicy: { mode: 'maxRange' } },
    setSegmentIntent: { segmentId: 'seg_3', intent: 'reveal' },
    setReturnPolicy: { mode: 'retrace' },
    setPlanningPolicy: { windLevel: 40 },
    snapshotLoadout: { aircraft: AIRCRAFT },
    setEnvironmentReference: { source: 'live' },
  };
  assert.deepEqual(Object.keys(exercised).sort(), [...MISSION_COMMANDS].sort(),
    'the exported command list and this test agree on what exists');
  for (const [type, payload] of Object.entries(exercised)) {
    const next = missionReduce(doc, { type, payload }, deps);
    assert.notEqual(next, doc, `${type} produced a new document`);
    assert.deepEqual(validateMission(next).errors, [], `${type} produced a valid document`);
  }
  assert.deepEqual(deps.warnings, []);
});

/* ---------- policy, loadout, environment ---------- */

test('setPlanningPolicy patches one knob and leaves the others alone', () => {
  const deps = harness();
  const doc = routed(deps);
  const next = missionReduce(doc, { type: 'setPlanningPolicy', payload: { gustFactor: 0.5 } }, deps);
  assert.deepEqual(next.planningPolicy, {
    reserve: { landFloorPct: 20 }, gustFactor: 0.5, windLevel: 80, radioBand: '5g8',
  });
});

test('a reserve patch merges into the reserve rather than replacing it', () => {
  const deps = harness();
  const next = missionReduce(routed(deps), { type: 'setPlanningPolicy', payload: { reserve: { landFloorPct: 25 } } }, deps);
  assert.deepEqual(next.planningPolicy.reserve, { landFloorPct: 25 });
});

test('snapshotLoadout embeds a copy the catalog can no longer reach', () => {
  const deps = harness();
  const record = { ...BATTERY, packInstance: { id: 'pk_1', label: 'Pack #2' } };
  const next = missionReduce(routed(deps), { type: 'snapshotLoadout', payload: { battery: record } }, deps);
  record.capAh = 99;
  record.packInstance.label = 'Pack #9';
  assert.equal(next.batterySnapshot.capAh, 5);
  assert.equal(next.batterySnapshot.packInstance.label, 'Pack #2', 'deep, not one level down');
});

test('snapshotLoadout leaves the slots it was not given', () => {
  const deps = harness();
  const doc = missionReduce(routed(deps), {
    type: 'snapshotLoadout', payload: { aircraft: AIRCRAFT, battery: BATTERY },
  }, deps);
  const next = missionReduce(doc, { type: 'snapshotLoadout', payload: { payload: PAYLOAD } }, deps);
  assert.equal(next.aircraftSnapshot.sourceId, 'moz7v2');
  assert.equal(next.batterySnapshot.sourceId, 'nav5000');
  assert.equal(next.payloadSnapshot.sourceId, 'naked');
});

test('snapshotLoadout clears a slot when it is handed null', () => {
  const deps = harness();
  const doc = missionReduce(routed(deps), { type: 'snapshotLoadout', payload: { aircraft: AIRCRAFT } }, deps);
  const next = missionReduce(doc, { type: 'snapshotLoadout', payload: { aircraft: null } }, deps);
  assert.equal(next.aircraftSnapshot, null);
});

test('a half-filled loadout is refused rather than saved as a mission with a hole in it', () => {
  const deps = harness();
  const doc = routed(deps);
  const next = missionReduce(doc, { type: 'snapshotLoadout', payload: { aircraft: { sourceId: 'moz7v2', name: 'MOZ7' } } }, deps);
  assert.equal(next, doc);
  assert.equal(deps.warnings[0].code, 'W-CMD-REJECTED');
  assert.match(deps.warnings[0].path, /^aircraftSnapshot\./);
});

test('setEnvironmentReference replaces the whole reference rather than blending two', () => {
  const deps = harness();
  const doc = missionReduce(routed(deps), {
    type: 'setEnvironmentReference',
    payload: { source: 'preset', presetId: 'hot-day', capturedAt: '2026-07-30T12:00:00.000Z' },
  }, deps);
  assert.equal(doc.environmentReference.presetId, 'hot-day');

  const next = missionReduce(doc, { type: 'setEnvironmentReference', payload: { source: 'live' } }, deps);
  assert.deepEqual(next.environmentReference, {
    source: 'live', presetId: null, capturedAt: null, values: null, provenance: null,
  }, 'no leftover preset id claiming this mission is both');
});

test('setReturnPolicy takes an altitude and leaves it for altitude.js to resolve', () => {
  const deps = harness();
  const next = missionReduce(routed(deps), {
    type: 'setReturnPolicy', payload: { mode: 'retrace', altitude: { authored: 120, reference: 'launchRelative' } },
  }, deps);
  assert.deepEqual(next.route.returnPolicy, {
    mode: 'retrace', altitude: { authored: 120, reference: 'launchRelative', resolvedMslM: null },
  });
});

test('the reducer works without any deps at all', () => {
  const doc = createMission({ launch: AUSTIN });
  const next = missionReduce(doc, { type: 'addWaypoint', payload: { latitude: 30.3, longitude: -97.8 } });
  assert.equal(next.route.waypoints.length, 1);
  assert.match(next.route.waypoints[0].id, /^wpt_/);
  assert.deepEqual(validateMission(next).errors, []);
});
