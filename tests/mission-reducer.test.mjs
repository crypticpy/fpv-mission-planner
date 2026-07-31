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

test('a command type inherited from Object.prototype is unknown, not a handler', () => {
  const deps = harness();
  const doc = routed(deps);
  for (const type of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(missionReduce(doc, { type, payload: {} }, deps), doc, `'${type}' changes nothing`);
  }
  assert.deepEqual(deps.warnings.map((w) => w.code),
    ['W-CMD-UNKNOWN', 'W-CMD-UNKNOWN', 'W-CMD-UNKNOWN', 'W-CMD-UNKNOWN']);
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
  // ADR 0011 §2 (M7 wave B) — the cinematic bags' own commands.
  ['adding a subject with no coordinates', { type: 'addSubject', payload: { name: 'X' } }, 'latitude/longitude'],
  ['moving a subject that is not in this scene', { type: 'moveSubject', payload: { id: 'sub_99', latitude: 30, longitude: -97 } }, 'id'],
  ['removing a subject that is not in this scene', { type: 'removeSubject', payload: { id: 'sub_99' } }, 'id'],
  ['a segment camera with orbit settings on a non-orbit intent', {
    type: 'setSegmentCamera', payload: { segmentId: 'seg_3', camera: { orbit: { radiusM: 10, clockwise: true } } },
  }, 'camera.orbit'],
  ['a segment subject pointing at a subject that does not exist', {
    type: 'setSegmentSubject', payload: { segmentId: 'seg_3', subjectRef: 'sub_99' },
  }, 'subjectRef'],
  ['a dwell time on a segment hold command for a transit leg', { type: 'setSegmentHold', payload: { segmentId: 'seg_3', holdS: 20 } }, 'holdS'],
  ['a camera profile with an unknown key', {
    type: 'setCameraProfile',
    payload: { profile: { name: 'X', sensorWidthMm: 6, sensorHeightMm: 4, focalLengthMm: 3, stabilized: true, extra: 1 } },
  }, 'profile.extra'],
  ['a scene template with no name', { type: 'saveSceneTemplate', payload: { name: '', intent: 'transit' } }, 'name'],
  ['applying a template that does not exist', { type: 'applySceneTemplate', payload: { templateId: 'tpl_99', segmentId: 'seg_3' } }, 'templateId'],
  ['removing a scene template that does not exist', { type: 'removeSceneTemplate', payload: { id: 'tpl_99' } }, 'id'],
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

test('setSegmentIntent drops an orbit radius the same way it drops a dwell', () => {
  const deps = harness();
  const doc = run(routed(deps), [
    { type: 'setSegmentIntent', payload: { segmentId: 'seg_3', intent: 'orbit', holdS: 30 } },
    { type: 'setSegmentCamera', payload: { segmentId: 'seg_3', camera: { pitchDeg: -15, orbit: { radiusM: 25, clockwise: true } } } },
  ], deps);
  // Leaving 'orbit' must not be blocked by the orbit bag it makes meaningless
  // (E-SEG-CAMERA-ORBIT would reject this very command otherwise), and must
  // not orphan the radius for a later exporter to believe.
  const passed = missionReduce(doc, { type: 'setSegmentIntent', payload: { segmentId: 'seg_3', intent: 'pass' } }, deps);
  assert.deepEqual(passed.route.segments[0].camera, { pitchDeg: -15, yawOffsetDeg: null, orbit: null },
    'the orbit goes; the pitch means the same thing on every camera intent and stays');
  assert.deepEqual(validateMission(passed).errors, []);
  // Staying on 'orbit' (a holdS-only re-issue) keeps the radius untouched.
  const still = missionReduce(doc, { type: 'setSegmentIntent', payload: { segmentId: 'seg_3', intent: 'orbit', holdS: 45 } }, deps);
  assert.deepEqual(still.route.segments[0].camera.orbit, { radiusM: 25, clockwise: true });
});

test('every command in MISSION_COMMANDS actually changes something', () => {
  const deps = harness();
  // A subject, a template and a holding leg, seeded so the subject/template
  // -referencing commands below have something real to point at — addSubject
  // and saveSceneTemplate get their own dedicated happy-path tests; this
  // fixture only needs their result, not their behaviour re-checked here.
  const doc = run(routed(deps), [
    { type: 'addSubject', payload: { latitude: 30.35, longitude: -97.85, name: 'Windmill' } },
    { type: 'saveSceneTemplate', payload: { name: 'Flyby', intent: 'transit' } },
    wp(30.7, -98.2, { intent: 'hold', holdS: 15 }),
  ], deps);
  const [subject] = doc.scene.subjects;
  const [template] = doc.scene.templates;
  const holdSegment = doc.route.segments.find((s) => s.intent === 'hold');

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
    addSubject: { latitude: 30.37, longitude: -97.87, name: 'Silo' },
    moveSubject: { id: subject.id, latitude: 30.36, longitude: -97.86 },
    removeSubject: { id: subject.id },
    setSegmentCamera: { segmentId: 'seg_3', camera: { pitchDeg: -10 } },
    setSegmentSubject: { segmentId: 'seg_3', subjectRef: subject.id },
    setSegmentHold: { segmentId: holdSegment.id, holdS: 45 },
    setCameraProfile: {
      profile: { name: 'GoPro', sensorWidthMm: 6.17, sensorHeightMm: 4.63, focalLengthMm: 3, stabilized: true },
    },
    saveSceneTemplate: { name: 'Orbit', intent: 'orbit', holdS: 20 },
    applySceneTemplate: { templateId: template.id, segmentId: 'seg_3' },
    removeSceneTemplate: { id: template.id },
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

/* ---------- ADR 0011 §2 (M7 wave B): the cinematic bags' own commands ---------- */

test('addSubject mints a subject and defaults an omitted name', () => {
  const deps = harness();
  const next = missionReduce(routed(deps), { type: 'addSubject', payload: { latitude: 30.35, longitude: -97.85 } }, deps);
  assert.equal(next.scene.subjects.length, 1);
  assert.equal(next.scene.subjects[0].name, 'Untitled subject');
  assert.match(next.scene.subjects[0].id, /^sub_/);
  assert.deepEqual(validateMission(next).errors, []);
});

test('addSubject takes an elevation and a radius when offered one', () => {
  const deps = harness();
  const next = missionReduce(routed(deps), {
    type: 'addSubject', payload: { latitude: 30.35, longitude: -97.85, name: 'Windmill', elevationMslM: 320, radiusM: 15 },
  }, deps);
  assert.deepEqual(next.scene.subjects[0], {
    id: next.scene.subjects[0].id, name: 'Windmill', latitude: 30.35, longitude: -97.85, elevationMslM: 320, radiusM: 15,
  });
});

test('moveSubject moves one subject and nothing else', () => {
  const deps = harness();
  const doc = missionReduce(routed(deps), {
    type: 'addSubject', payload: { latitude: 30.35, longitude: -97.85, name: 'Windmill' },
  }, deps);
  const [subject] = doc.scene.subjects;
  const next = missionReduce(doc, { type: 'moveSubject', payload: { id: subject.id, latitude: 30.36, longitude: -97.86 } }, deps);
  assert.deepEqual(next.scene.subjects[0], { ...subject, latitude: 30.36, longitude: -97.86 });
  assert.deepEqual(validateMission(next).errors, []);
});

test("removeSubject nulls every segment's dangling subjectRef in the same reduction", () => {
  const deps = harness();
  const withSubject = missionReduce(routed(deps), {
    type: 'addSubject', payload: { latitude: 30.35, longitude: -97.85, name: 'Windmill' },
  }, deps);
  const [subject] = withSubject.scene.subjects;
  const referenced = run(withSubject, [
    { type: 'setSegmentSubject', payload: { segmentId: 'seg_3', subjectRef: subject.id } },
    { type: 'setSegmentSubject', payload: { segmentId: 'seg_7', subjectRef: subject.id } },
  ], deps);
  assert.equal(referenced.route.segments[0].subjectRef, subject.id);
  assert.equal(referenced.route.segments[2].subjectRef, subject.id);

  const next = missionReduce(referenced, { type: 'removeSubject', payload: { id: subject.id } }, deps);
  assert.deepEqual(next.scene.subjects, []);
  assert.equal(next.route.segments[0].subjectRef, null, 'the leg that pointed at it is not left dangling');
  assert.equal(next.route.segments[2].subjectRef, null, 'neither is the other one');
  assert.equal(next.route.segments[1].subjectRef, null, 'an unrelated leg was never pointing at it');
  assert.deepEqual(validateMission(next).errors, [], 'the document is never invalid between commands');
});

test('setSegmentCamera replaces the whole shot geometry, not a merge', () => {
  const deps = harness();
  const doc = missionReduce(routed(deps), {
    type: 'setSegmentCamera', payload: { segmentId: 'seg_3', camera: { pitchDeg: -20, yawOffsetDeg: 10 } },
  }, deps);
  const next = missionReduce(doc, { type: 'setSegmentCamera', payload: { segmentId: 'seg_3', camera: { pitchDeg: -5 } } }, deps);
  assert.deepEqual(next.route.segments[0].camera, { pitchDeg: -5, yawOffsetDeg: null, orbit: null },
    'the old yawOffsetDeg is gone, not carried over');
});

test('setSegmentCamera clears the shot geometry with null', () => {
  const deps = harness();
  const doc = missionReduce(routed(deps), {
    type: 'setSegmentCamera', payload: { segmentId: 'seg_3', camera: { pitchDeg: -20 } },
  }, deps);
  const next = missionReduce(doc, { type: 'setSegmentCamera', payload: { segmentId: 'seg_3', camera: null } }, deps);
  assert.equal(next.route.segments[0].camera, null);
  assert.deepEqual(validateMission(next).errors, []);
});

test('setSegmentSubject sets, then clears with null', () => {
  const deps = harness();
  const withSubject = missionReduce(routed(deps), {
    type: 'addSubject', payload: { latitude: 30.35, longitude: -97.85, name: 'Windmill' },
  }, deps);
  const [subject] = withSubject.scene.subjects;
  const linked = missionReduce(withSubject, { type: 'setSegmentSubject', payload: { segmentId: 'seg_3', subjectRef: subject.id } }, deps);
  assert.equal(linked.route.segments[0].subjectRef, subject.id);
  const cleared = missionReduce(linked, { type: 'setSegmentSubject', payload: { segmentId: 'seg_3', subjectRef: null } }, deps);
  assert.equal(cleared.route.segments[0].subjectRef, null);
  assert.deepEqual(validateMission(cleared).errors, []);
});

test('setSegmentHold changes only the dwell time', () => {
  const deps = harness();
  const doc = missionReduce(routed(deps), {
    type: 'setSegmentIntent', payload: { segmentId: 'seg_3', intent: 'hold', holdS: 10 },
  }, deps);
  const next = missionReduce(doc, { type: 'setSegmentHold', payload: { segmentId: 'seg_3', holdS: 45 } }, deps);
  assert.equal(next.route.segments[0].holdS, 45);
  assert.equal(next.route.segments[0].intent, 'hold');
  assert.deepEqual(validateMission(next).errors, []);
});

test("setCameraProfile swaps the mission's one active preset, or clears it with null", () => {
  const deps = harness();
  const profile = { name: 'GoPro HERO-class', sensorWidthMm: 6.17, sensorHeightMm: 4.63, focalLengthMm: 3, stabilized: true };
  const doc = missionReduce(routed(deps), { type: 'setCameraProfile', payload: { profile } }, deps);
  assert.deepEqual(doc.scene.cameraProfile, profile);
  const next = missionReduce(doc, { type: 'setCameraProfile', payload: { profile: null } }, deps);
  assert.equal(next.scene.cameraProfile, null);
});

test('saveSceneTemplate mints a reusable preset', () => {
  const deps = harness();
  const next = missionReduce(routed(deps), {
    type: 'saveSceneTemplate',
    payload: { name: 'Orbit reveal', intent: 'orbit', holdS: 20, camera: { orbit: { radiusM: 15, clockwise: true } } },
  }, deps);
  assert.equal(next.scene.templates.length, 1);
  assert.match(next.scene.templates[0].id, /^tpl_/);
  assert.equal(next.scene.templates[0].holdS, 20);
  assert.deepEqual(validateMission(next).errors, []);
});

test('applySceneTemplate copies intent/holdS/camera onto a segment, never a live reference', () => {
  const deps = harness();
  const doc = missionReduce(routed(deps), {
    type: 'saveSceneTemplate',
    payload: { name: 'Orbit reveal', intent: 'orbit', holdS: 20, camera: { orbit: { radiusM: 15, clockwise: true } } },
  }, deps);
  const [template] = doc.scene.templates;
  const next = missionReduce(doc, { type: 'applySceneTemplate', payload: { templateId: template.id, segmentId: 'seg_3' } }, deps);
  assert.equal(next.route.segments[0].intent, 'orbit');
  assert.equal(next.route.segments[0].holdS, 20);
  assert.deepEqual(next.route.segments[0].camera, { pitchDeg: null, yawOffsetDeg: null, orbit: { radiusM: 15, clockwise: true } });
  assert.deepEqual(validateMission(next).errors, []);

  // Removing the template afterward must not reach back into the segment that
  // already applied it — the copy is a snapshot, not a reference (ADR 0011 §2).
  const removed = missionReduce(next, { type: 'removeSceneTemplate', payload: { id: template.id } }, deps);
  assert.equal(removed.route.segments[0].intent, 'orbit', 'seg_3 keeps its copy after the template is gone');
  assert.deepEqual(removed.route.segments[0].camera, { pitchDeg: null, yawOffsetDeg: null, orbit: { radiusM: 15, clockwise: true } });
});

test("applySceneTemplate deep-copies the camera — mutating the template's own object does not reach the segment", () => {
  const deps = harness();
  const doc = missionReduce(routed(deps), {
    type: 'saveSceneTemplate',
    payload: { name: 'Orbit reveal', intent: 'orbit', holdS: 20, camera: { orbit: { radiusM: 15, clockwise: true } } },
  }, deps);
  const [template] = doc.scene.templates;
  const next = missionReduce(doc, { type: 'applySceneTemplate', payload: { templateId: template.id, segmentId: 'seg_3' } }, deps);
  // A direct, low-level mutation of the stored template's own camera object —
  // this is the "no live reference" contract at the object-identity level,
  // not merely "the values happened to differ afterward".
  template.camera.orbit.radiusM = 999;
  assert.equal(next.route.segments[0].camera.orbit.radiusM, 15, "the segment holds its own copy, not the template's object");
});

test('applySceneTemplate drops holdS when the template intent does not hold station', () => {
  const deps = harness();
  const doc = run(routed(deps), [
    { type: 'setSegmentIntent', payload: { segmentId: 'seg_3', intent: 'hold', holdS: 60 } },
    { type: 'saveSceneTemplate', payload: { name: 'Flyby', intent: 'transit' } },
  ], deps);
  const [template] = doc.scene.templates;
  const next = missionReduce(doc, { type: 'applySceneTemplate', payload: { templateId: template.id, segmentId: 'seg_3' } }, deps);
  assert.equal(next.route.segments[0].intent, 'transit');
  assert.equal(next.route.segments[0].holdS, null, 'no orphan dwell time left behind, the same as setSegmentIntent');
});

test('removeSceneTemplate drops the preset without touching any segment that already applied it', () => {
  const deps = harness();
  const doc = missionReduce(routed(deps), {
    type: 'saveSceneTemplate', payload: { name: 'Orbit reveal', intent: 'orbit', holdS: 20 },
  }, deps);
  const [template] = doc.scene.templates;
  const applied = missionReduce(doc, { type: 'applySceneTemplate', payload: { templateId: template.id, segmentId: 'seg_3' } }, deps);
  const next = missionReduce(applied, { type: 'removeSceneTemplate', payload: { id: template.id } }, deps);
  assert.deepEqual(next.scene.templates, []);
  assert.equal(next.route.segments[0].intent, 'orbit', 'already-applied segments are untouched');
});

/* A gap this wave leaves rather than papering over: setSegmentIntent never
 * touches segment.camera, so switching a segment off 'orbit' while it still
 * carries camera.orbit settings leaves an orbit-shaped camera on what is now a
 * non-orbit segment — which the validator catches (E-SEG-CAMERA-ORBIT). The
 * document is never left invalid: missionReduce's own safety net sees that
 * error as newly introduced by this command and rejects the command outright,
 * so the segment keeps its old intent rather than a broken new one. It is a
 * usability gap (the pilot has to clear the camera first), not a soundness one. */
test('setSegmentIntent off orbit drops the orbit bag rather than rejecting the escape', () => {
  const deps = harness();
  const withOrbitCamera = missionReduce(
    missionReduce(routed(deps), { type: 'setSegmentIntent', payload: { segmentId: 'seg_3', intent: 'orbit', holdS: 20 } }, deps),
    { type: 'setSegmentCamera', payload: { segmentId: 'seg_3', camera: { orbit: { radiusM: 15, clockwise: true } } } },
    deps,
  );
  assert.equal(withOrbitCamera.route.segments[0].camera.orbit.radiusM, 15);
  assert.deepEqual(deps.warnings, [], 'both setup commands succeed cleanly');

  // The radius is meaningful only while the intent is 'orbit', so it leaves
  // with the intent — the same treatment holdS gets, and for the same reason.
  // Rejecting here would make "clear the radius first" a rule the pilot has to
  // remember to change a dropdown.
  const next = missionReduce(withOrbitCamera, { type: 'setSegmentIntent', payload: { segmentId: 'seg_3', intent: 'transit' } }, deps);
  assert.notEqual(next, withOrbitCamera, 'the command lands');
  assert.deepEqual(deps.warnings, [], 'nothing to warn about: no orphan survived to reject');
  assert.equal(next.route.segments[0].camera.orbit, null);
  assert.deepEqual(validateMission(next).errors, []);
});
