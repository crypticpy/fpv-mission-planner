import test from 'node:test';
import assert from 'node:assert/strict';

import { createMission, validateMission, LAUNCH_NODE } from '../src/domain/mission/mission-schema.js';
import { missionReduce } from '../src/domain/mission/mission-reducer.js';
import { CONCEPTS, compileMission } from '../src/domain/mission/compile.js';
import { deriveLosses } from '../src/infrastructure/export/adapter-contracts.js';
import { EXPORTABLE } from '../src/infrastructure/export/import-router.js';

/* The compiler's promise is that every adapter reads the same numbers and that
 * a number it could not work out is absent rather than invented (ADR 0010 §1,
 * ADR 0003). So these tests are about three things: what the frames come out as
 * against a known launch elevation and a known ground, what happens to each
 * frame when an input for it is missing, and which concepts a given mission is
 * recorded as using — because that last one is what turns into a named loss in
 * every adapter without an adapter author writing it. */

const AUSTIN = { latitude: 30.2672, longitude: -97.7431, elevationMslM: 168 };
const RIDGE = { latitude: 30.3, longitude: -97.8 };
const SADDLE = { latitude: 30.4, longitude: -97.9 };

/* Snapshots carry every number the validator insists on, so a fixture with a
 * loadout is still a document that loads. `cruiseMs` is the one the compiler
 * reads. */
const AIRCRAFT = {
  sourceId: 'moz7v2', name: 'GEPRC MOZ7 V2', dryMassG: 843, propDiaIn: 7.5, numRotors: 4,
  etaProp: 0.55, cdA: 0.042, avionicsW: 10, maxSpeedMs: 30.5, cruiseMs: 18,
};

/** Deterministic identity and a clock that ticks one second per command. */
function harness() {
  let ids = 0;
  let ticks = 0;
  return {
    idgen: (prefix) => `${prefix}_${++ids}`,
    now: () => new Date(Date.UTC(2026, 6, 31, 12, 0, ticks++)).toISOString(),
  };
}

/** Ground truth under the two waypoints these fixtures use; null anywhere else. */
const terrain = (latitude) => (latitude === RIDGE.latitude ? 200
  : latitude === SADDLE.latitude ? 260 : null);

const run = (doc, commands, deps) => commands.reduce((d, c) => missionReduce(d, c, deps), doc);

const wp = (at, rest = {}) => ({ type: 'addWaypoint', payload: { ...at, ...rest } });

/* The lens M7 added as its own concept. 36 x 24 mm at 24 mm is the ADR's own
 * analytic case, and the compiler only ever reads its name and focal length. */
const FULL_FRAME = {
  name: 'Full-frame mirrorless camera',
  sensorWidthMm: 36, sensorHeightMm: 24, focalLengthMm: 24, stabilized: false,
};
const setProfile = (profile) => ({ type: 'setCameraProfile', payload: { profile } });

/**
 * A mission at Austin with an aircraft attached and whatever route the caller
 * asks for. Every fixture goes through the reducer, so nothing here is a shape
 * the app could not actually author.
 */
function mission({ launch = AUSTIN, commands = [], aircraft = AIRCRAFT } = {}) {
  const deps = harness();
  const start = createMission({ launch, title: 'Pedernales ridge run' }, deps);
  const loaded = aircraft
    ? missionReduce(start, { type: 'snapshotLoadout', payload: { aircraft } }, deps)
    : start;
  const doc = run(loaded, commands, deps);
  assert.deepEqual(validateMission(doc).errors, [], 'fixture must be a valid document');
  return doc;
}

/** A two-waypoint transit route at the default 80 m above launch. */
const routed = (opts = {}) => mission({ commands: [wp(RIDGE), wp(SADDLE)], ...opts });

const concepts = (compiled) => compiled.inventory.map((entry) => entry.concept);
const detailOf = (compiled, concept) => compiled.inventory.find((e) => e.concept === concept)?.detail;
const codes = (compiled) => compiled.issues.map((i) => i.code);
const paths = (compiled) => compiled.issues.map((i) => i.path);

/* ---------- 1. the frames, against known ground ---------- */

test('every frame is precomputed from the launch elevation and the terrain sample', () => {
  const compiled = compileMission(routed(), { terrainSampler: terrain });

  assert.deepEqual(compiled.points[0].altitude, {
    authored: 80, reference: 'launchRelative',
    amslM: 248,      // 168 launch + 80 above it
    launchRelM: 80,  // as authored
    aglM: 48,        // 248 MSL over 200 m of ridge
  });
  assert.deepEqual(compiled.points[1].altitude, {
    authored: 80, reference: 'launchRelative', amslM: 248, launchRelM: 80, aglM: -12,
  });
  assert.deepEqual(compiled.issues, [], 'nothing was missing, so nothing is reported');
});

test('an MSL-authored altitude keeps its own frame and loses only what it cannot reach', () => {
  const doc = mission({
    launch: { ...AUSTIN, elevationMslM: null },
    commands: [wp(RIDGE), { type: 'setSegmentAltitude', payload: { segmentId: 'seg_3', authored: 300, reference: 'msl' } }],
  });
  const compiled = compileMission(doc, { terrainSampler: terrain });

  assert.equal(compiled.points[0].altitude.amslM, 300);
  assert.equal(compiled.points[0].altitude.aglM, 100, '300 MSL over 200 m of ridge');
  assert.equal(compiled.points[0].altitude.launchRelM, null, 'no launch elevation to be relative to');
  assert.deepEqual(codes(compiled), ['C-ALT-UNRESOLVED']);
  assert.deepEqual(paths(compiled), ['route.segments[0].altitude.launchRelM']);
});

test('no launch elevation leaves a launch-relative altitude with no frame at all', () => {
  const doc = mission({ launch: { ...AUSTIN, elevationMslM: null }, commands: [wp(RIDGE)] });
  const compiled = compileMission(doc, { terrainSampler: terrain });

  assert.deepEqual(compiled.points[0].altitude, {
    authored: 80, reference: 'launchRelative', amslM: null, launchRelM: null, aglM: null,
  });
  assert.deepEqual(codes(compiled), ['C-ALT-UNRESOLVED', 'C-ALT-UNRESOLVED', 'C-ALT-UNRESOLVED']);
  assert.deepEqual(paths(compiled), [
    'route.segments[0].altitude.amslM',
    'route.segments[0].altitude.launchRelM',
    'route.segments[0].altitude.aglM',
  ]);
  assert.match(compiled.issues[0].message, /launch elevation/);
});

test('no terrain sampler leaves the AGL frame empty and the other two intact', () => {
  const compiled = compileMission(routed());

  assert.equal(compiled.points[0].altitude.amslM, 248);
  assert.equal(compiled.points[0].altitude.launchRelM, 80);
  assert.equal(compiled.points[0].altitude.aglM, null);
  assert.deepEqual(paths(compiled), [
    'route.segments[0].altitude.aglM',
    'route.segments[1].altitude.aglM',
  ]);
});

test('a sampler that throws is a sampler with no answer, not a failed compile', () => {
  const compiled = compileMission(routed(), {
    terrainSampler: () => { throw new Error('DEM provider is down'); },
  });
  assert.equal(compiled.points[0].altitude.aglM, null);
  assert.equal(compiled.points[0].altitude.amslM, 248);
});

test('an AGL-authored altitude resolves from the terrain sample', () => {
  const doc = mission({
    commands: [wp(RIDGE), { type: 'setSegmentAltitude', payload: { segmentId: 'seg_3', authored: 50, reference: 'agl' } }],
  });
  const compiled = compileMission(doc, { terrainSampler: terrain });
  assert.deepEqual(compiled.points[0].altitude, {
    authored: 50, reference: 'agl', amslM: 250, launchRelM: 82, aglM: 50,
  });
});

/* ---------- 2. speed ---------- */

test('speed resolves per mode, and maxRange waits for the physics sweep', () => {
  const doc = mission({
    commands: [
      wp(RIDGE), wp(SADDLE), wp({ latitude: 30.5, longitude: -98.0 }),
      { type: 'setSegmentSpeed', payload: { segmentId: 'seg_5', speedPolicy: { mode: 'fixed', targetMs: 14 } } },
      { type: 'setSegmentSpeed', payload: { segmentId: 'seg_7', speedPolicy: { mode: 'maxRange', targetMs: null } } },
    ],
  });
  const compiled = compileMission(doc, { terrainSampler: terrain });

  assert.deepEqual(compiled.legs.map((l) => l.speed), [
    { mode: 'cruise', ms: 18 },    // the aircraft snapshot's figure
    { mode: 'fixed', ms: 14 },     // the pilot's own
    { mode: 'maxRange', ms: null },
  ]);
  assert.deepEqual(codes(compiled).filter((c) => c === 'C-SPEED-UNRESOLVED'), ['C-SPEED-UNRESOLVED']);
  const issue = compiled.issues.find((i) => i.code === 'C-SPEED-UNRESOLVED');
  assert.equal(issue.path, 'route.segments[2].speedPolicy');
  assert.match(issue.message, /sweep/);
});

test('a cruise leg with no aircraft snapshot has no speed and says so', () => {
  const compiled = compileMission(routed({ aircraft: null }), { terrainSampler: terrain });
  assert.deepEqual(compiled.legs.map((l) => l.speed.ms), [null, null]);
  assert.deepEqual(codes(compiled), ['C-SPEED-UNRESOLVED', 'C-SPEED-UNRESOLVED']);
  assert.match(compiled.issues[0].message, /aircraft snapshot/);
});

/* ---------- 3. shape: points, legs, the return that is never a leg ---------- */

test('points and legs follow the route, and the return policy stays declarative', () => {
  const doc = mission({
    commands: [
      wp(RIDGE), wp(SADDLE),
      { type: 'setReturnPolicy', payload: { mode: 'direct', altitude: { authored: 120, reference: 'launchRelative' } } },
    ],
  });
  const compiled = compileMission(doc, { terrainSampler: terrain });

  assert.deepEqual(compiled.points.map((p) => p.id), ['wpt_2', 'wpt_4']);
  assert.deepEqual(compiled.legs.map((l) => [l.fromId, l.toId]), [
    [LAUNCH_NODE, 'wpt_2'], ['wpt_2', 'wpt_4'],
  ]);
  assert.equal(compiled.legs.length, doc.route.segments.length, 'no return leg is materialised');
  assert.equal(compiled.returnPolicy.mode, 'direct');
  assert.equal(compiled.returnPolicy.altitude.amslM, 288, '168 launch + 120 above it');
  assert.equal(compiled.home.elevationMslM, 168);
  assert.deepEqual(compiled.reserve, { landFloorPct: 20 });
  assert.equal(compiled.missionId, doc.id);
  assert.equal(compiled.title, doc.title);
});

test('scene subjects are carried through field by field', () => {
  const compiled = compileMission(framed(routed()), { terrainSampler: terrain });
  assert.deepEqual(compiled.scene.subjects, [{
    id: 'sub_9', name: 'Water tower', latitude: 30.31, longitude: -97.81,
    elevationMslM: 210, radiusM: 40,
  }]);
  assert.equal(compiled.legs[0].subjectRef, 'sub_9');
  assert.deepEqual(compiled.legs[0].camera, { pitchDeg: -15 });
});

/** A subject in the scene and the first leg pointed at it, with a camera bag. */
function framed(doc) {
  const subject = {
    id: 'sub_9', name: 'Water tower', latitude: 30.31, longitude: -97.81,
    elevationMslM: 210, radiusM: 40,
  };
  const segments = doc.route.segments.map((s, i) => (i === 0
    ? { ...s, subjectRef: subject.id, camera: { pitchDeg: -15 } }
    : s));
  const next = { ...doc, scene: { ...doc.scene, subjects: [subject] }, route: { ...doc.route, segments } };
  assert.deepEqual(validateMission(next).errors, [], 'fixture must be a valid document');
  return next;
}

/* ---------- 4. the concept inventory ---------- */

test('a bare transit route uses geometry, altitude, speed, return and reserve', () => {
  const compiled = compileMission(routed(), { terrainSampler: terrain });
  assert.deepEqual(concepts(compiled), [
    'geometry', 'altitude-reference', 'speed', 'return-policy', 'reserve',
  ]);
  assert.match(detailOf(compiled, 'geometry'), /2 waypoints/);
  assert.match(detailOf(compiled, 'altitude-reference'), /launch-relative/);
  assert.match(detailOf(compiled, 'speed'), /cruise/);
  assert.match(detailOf(compiled, 'reserve'), /20%/);
});

test('a hold is inventoried by count, and a transit route has none', () => {
  const held = compileMission(mission({
    commands: [wp(RIDGE, { intent: 'hold', holdS: 45 }), wp(SADDLE, { intent: 'hold', holdS: 20 })],
  }), { terrainSampler: terrain });

  assert.ok(concepts(held).includes('hold'));
  assert.equal(detailOf(held, 'hold'), '2 hold segments');
  assert.equal(concepts(compileMission(routed())).includes('hold'), false);
});

test('camera intent is inventoried from a framing intent, a subject, or a camera bag', () => {
  const reveal = compileMission(mission({ commands: [wp(RIDGE, { intent: 'reveal' })] }));
  assert.ok(concepts(reveal).includes('camera-intent'), 'a reveal frames something');

  const subject = compileMission(framed(routed()));
  assert.ok(concepts(subject).includes('camera-intent'), 'a transit leg pointed at a subject frames it too');
  assert.match(detailOf(subject, 'camera-intent'), /1 camera-directed segment/);

  assert.equal(concepts(compileMission(routed())).includes('camera-intent'), false);
});

test('an approach is a camera-directed segment and is counted as one (M7)', () => {
  const approach = compileMission(mission({ commands: [wp(RIDGE, { intent: 'approach' })] }));
  assert.ok(concepts(approach).includes('camera-intent'), 'an approach frames what it approaches');
  assert.equal(detailOf(approach, 'camera-intent'), '1 camera-directed segment');

  const mixed = compileMission(mission({
    commands: [wp(RIDGE, { intent: 'approach' }), wp(SADDLE, { intent: 'reveal' })],
  }));
  assert.equal(detailOf(mixed, 'camera-intent'), '2 camera-directed segments');
});

test('a camera profile is its own concept, named by the lens it is (M7)', () => {
  const profiled = compileMission(mission({
    commands: [wp(RIDGE), wp(SADDLE), setProfile(FULL_FRAME)],
  }), { terrainSampler: terrain });

  assert.ok(concepts(profiled).includes('camera-profile'));
  assert.equal(detailOf(profiled, 'camera-profile'), 'Full-frame mirrorless camera at 24 mm');
  // It is the profile that puts it there, not the shot: a framed route with no
  // lens attached says camera-intent and nothing about a camera.
  assert.equal(concepts(compileMission(framed(routed()))).includes('camera-profile'), false);
  assert.equal(concepts(compileMission(routed())).includes('camera-profile'), false);
});

test('a camera profile is a named loss in every format we can write (ADR 0010 §2)', () => {
  // No adapter's SUPPORT table mentions camera-profile, so an undeclared concept
  // degrades every existing format honestly with no adapter author involved.
  // That this is free is the point (ADR 0011 §6).
  const profiled = compileMission(mission({
    commands: [wp(RIDGE), wp(SADDLE), setProfile(FULL_FRAME)],
  }), { terrainSampler: terrain });

  assert.ok(EXPORTABLE.length >= 5, 'every writable format is in this check');
  for (const adapter of EXPORTABLE) {
    assert.equal(Object.hasOwn(adapter.support, 'camera-profile'), false,
      `${adapter.format.id} declares nothing about camera-profile, and does not have to`);
    const loss = deriveLosses(profiled.inventory, adapter.support)
      .find((l) => l.concept === 'camera-profile');
    assert.ok(loss, `${adapter.format.id} must name the profile as a loss`);
    assert.equal(loss.disposition, 'dropped');
    assert.equal(loss.detail, 'Full-frame mirrorless camera at 24 mm');
  }
});

test("a return mode of 'none' is not a return policy the mission uses", () => {
  const compiled = compileMission(mission({
    commands: [wp(RIDGE), { type: 'setReturnPolicy', payload: { mode: 'none', altitude: null } }],
  }));
  assert.equal(concepts(compiled).includes('return-policy'), false);
  assert.ok(concepts(compiled).includes('reserve'), 'reserve is always in play');
});

test('an empty route still reports the reserve, and nothing that needs a route', () => {
  const compiled = compileMission(mission());
  assert.deepEqual(concepts(compiled), ['return-policy', 'reserve']);
  assert.deepEqual(compiled.points, []);
  assert.deepEqual(compiled.legs, []);
});

test('the inventory is drawn from the frozen vocabulary, in its order', () => {
  const compiled = compileMission(framed(mission({
    commands: [wp(RIDGE, { intent: 'orbit', holdS: 30 }), wp(SADDLE)],
  })), { terrainSampler: terrain });

  const used = concepts(compiled);
  assert.deepEqual(used, CONCEPTS.filter((c) => used.includes(c)), 'reported in CONCEPTS order');
  for (const entry of compiled.inventory) {
    assert.ok(CONCEPTS.includes(entry.concept), `${entry.concept} is a known concept`);
    assert.equal(typeof entry.detail, 'string');
    assert.notEqual(entry.detail, '');
  }
  assert.throws(() => CONCEPTS.push('nope'), TypeError, 'the vocabulary is frozen');
});

test('the detail names the references and modes actually used', () => {
  const doc = mission({
    commands: [
      wp(RIDGE), wp(SADDLE),
      { type: 'setSegmentAltitude', payload: { segmentId: 'seg_5', authored: 400, reference: 'msl' } },
      { type: 'setSegmentSpeed', payload: { segmentId: 'seg_5', speedPolicy: { mode: 'fixed', targetMs: 12 } } },
    ],
  });
  const compiled = compileMission(doc, { terrainSampler: terrain });
  assert.equal(detailOf(compiled, 'altitude-reference'), 'altitudes authored launch-relative, MSL');
  assert.equal(detailOf(compiled, 'speed'), 'cruise, fixed speed policies');
});

/* ---------- 5. purity ---------- */

test('compiling a mission does not touch the document it was given', () => {
  const doc = framed(mission({
    commands: [
      wp(RIDGE, { intent: 'orbit', holdS: 30 }), wp(SADDLE),
      { type: 'setReturnPolicy', payload: { mode: 'retrace', altitude: { authored: 150, reference: 'agl' } } },
    ],
  }));
  const before = structuredClone(doc);

  const first = compileMission(doc, { terrainSampler: terrain });
  const second = compileMission(doc, { terrainSampler: terrain });

  assert.deepEqual(doc, before, 'the input document is untouched');
  assert.deepEqual(first, second, 'the same inputs compile to the same output');
});

test('the sampler is asked once per distinct point', () => {
  const asked = [];
  compileMission(routed(), {
    terrainSampler: (latitude, longitude) => { asked.push([latitude, longitude]); return terrain(latitude); },
  });
  assert.deepEqual(asked, [[RIDGE.latitude, RIDGE.longitude], [SADDLE.latitude, SADDLE.longitude]]);
});
