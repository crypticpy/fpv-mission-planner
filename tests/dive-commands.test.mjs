import test from 'node:test';
import assert from 'node:assert/strict';

import { createMission, validateMission } from '../src/domain/mission/mission-schema.js';
import { missionReduce } from '../src/domain/mission/mission-reducer.js';

/* The dive commands live under the reducer's same two promises — a rejected
 * command changes nothing, no command hands back an invalid document — plus
 * three of their own: kind is identity (moving a gate keeps its id), gates
 * store in flight order whatever order they were authored, and an emptied
 * plan collapses back to the one representation of "no dive plan": null. */

const AUSTIN = { latitude: 30.2672, longitude: -97.7431, elevationMslM: 168 };

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

function run(doc, commands, deps) {
  return commands.reduce((d, c) => missionReduce(d, c, deps), doc);
}

const gate = (kind, latitude, longitude, altitudeMslM, rest = {}) => ({
  type: 'setDiveGate', payload: { kind, latitude, longitude, altitudeMslM, ...rest },
});

/* ---------- authoring the plan ---------- */

test('a fresh mission has no dive plan, and one gate makes one', () => {
  const deps = harness();
  const doc = start(deps);
  assert.equal(doc.scene.dive, null);
  const next = missionReduce(doc, gate('recovery', 30.62, -98.12, 2560, { radiusM: 30 }), deps);
  // gat_2: createMission spent the harness's first id on the mission itself.
  assert.deepEqual(next.scene.dive, {
    gates: [{ id: 'gat_2', kind: 'recovery', latitude: 30.62, longitude: -98.12, altitudeMslM: 2560, radiusM: 30 }],
    bailout: null,
    rthAltitudeMslM: null,
    speedMs: null,
    pulloutLoadG: null,
  });
  assert.deepEqual(validateMission(next).errors, []);
  assert.equal(doc.scene.dive, null, 'the given document was not mutated');
});

test('gates land in flight order regardless of authoring order', () => {
  const deps = harness();
  const doc = run(start(deps), [
    gate('recovery', 30.62, -98.12, 2560),
    gate('approach', 30.60, -98.10, 3460),
    gate('dive', 30.61, -98.11, 2758),
  ], deps);
  assert.deepEqual(doc.scene.dive.gates.map((g) => g.kind), ['approach', 'dive', 'recovery']);
  assert.deepEqual(validateMission(doc).errors, []);
});

test('re-setting a kind moves that gate and keeps its id — kind is the identity', () => {
  const deps = harness();
  const doc = run(start(deps), [gate('dive', 30.61, -98.11, 2758)], deps);
  const moved = missionReduce(doc, gate('dive', 30.615, -98.115, 2740), deps);
  assert.equal(moved.scene.dive.gates.length, 1, 'still one dive gate, not two');
  const g = moved.scene.dive.gates[0];
  assert.equal(g.id, doc.scene.dive.gates[0].id, 'an anchor to "the dive gate" survives the drag');
  assert.equal(g.altitudeMslM, 2740);
  assert.equal(g.radiusM, null, 'radius omitted reads null, not carried over silently');
});

test('a rejected gate command changes nothing and says why', () => {
  const deps = harness();
  const doc = run(start(deps), [gate('approach', 30.60, -98.10, 3460)], deps);
  const bad = [
    gate('plunge', 30.6, -98.1, 3000),
    gate('dive', 95, -98.1, 3000),
    { type: 'setDiveGate', payload: { kind: 'dive', latitude: 30.6, longitude: -98.1 } },
    gate('dive', 30.6, -98.1, 3000, { radiusM: -5 }),
  ];
  for (const cmd of bad) {
    const before = deps.warnings.length;
    const next = missionReduce(doc, cmd, deps);
    assert.equal(next, doc, 'same reference back — nothing changed');
    assert.equal(deps.warnings.length, before + 1);
    assert.equal(deps.warnings.at(-1).code, 'W-CMD-REJECTED');
  }
});

test('removing a gate removes it; removing a gate that is not there rejects', () => {
  const deps = harness();
  const doc = run(start(deps), [
    gate('approach', 30.60, -98.10, 3460),
    gate('dive', 30.61, -98.11, 2758),
  ], deps);
  const next = missionReduce(doc, { type: 'removeDiveGate', payload: { kind: 'approach' } }, deps);
  assert.deepEqual(next.scene.dive.gates.map((g) => g.kind), ['dive']);
  const again = missionReduce(next, { type: 'removeDiveGate', payload: { kind: 'approach' } }, deps);
  assert.equal(again, next);
  assert.equal(deps.warnings.at(-1).code, 'W-CMD-REJECTED');
});

/* ---------- bailout and the RTH plane ---------- */

test('a bailout pin without a typed name gets the default, and null clears it', () => {
  const deps = harness();
  const doc = missionReduce(start(deps),
    { type: 'setDiveBailout', payload: { bailout: { latitude: 30.63, longitude: -98.13 } } }, deps);
  assert.deepEqual(doc.scene.dive.bailout,
    { name: 'Bailout landing', latitude: 30.63, longitude: -98.13, elevationMslM: null });
  assert.deepEqual(validateMission(doc).errors, []);
  const cleared = missionReduce(doc, { type: 'setDiveBailout', payload: { bailout: null } }, deps);
  assert.equal(cleared.scene.dive, null, 'clearing the only content collapses the plan itself');
});

test('the RTH altitude sets and clears', () => {
  const deps = harness();
  const doc = missionReduce(start(deps), { type: 'setDiveRthAltitude', payload: { altitudeMslM: 3780 } }, deps);
  assert.equal(doc.scene.dive.rthAltitudeMslM, 3780);
  assert.deepEqual(validateMission(doc).errors, []);
  const junk = missionReduce(doc, { type: 'setDiveRthAltitude', payload: { altitudeMslM: '12400 ft' } }, deps);
  assert.equal(junk, doc);
  assert.equal(deps.warnings.at(-1).code, 'W-CMD-REJECTED');
});

/* ---------- the authored profile: speed and pullout load ---------- */

const profile = (payload) => ({ type: 'setDiveProfile', payload });

test('the profile numbers set one at a time or together', () => {
  const deps = harness();
  const speedOnly = missionReduce(start(deps), profile({ speedMs: 28 }), deps);
  assert.equal(speedOnly.scene.dive.speedMs, 28);
  assert.equal(speedOnly.scene.dive.pulloutLoadG, null);
  assert.deepEqual(validateMission(speedOnly).errors, []);

  const loadOnly = missionReduce(start(deps), profile({ pulloutLoadG: 2.5 }), deps);
  assert.equal(loadOnly.scene.dive.pulloutLoadG, 2.5);
  assert.equal(loadOnly.scene.dive.speedMs, null);
  assert.deepEqual(validateMission(loadOnly).errors, []);

  const both = missionReduce(start(deps), profile({ speedMs: 31.5, pulloutLoadG: 3 }), deps);
  assert.equal(both.scene.dive.speedMs, 31.5);
  assert.equal(both.scene.dive.pulloutLoadG, 3);
  assert.deepEqual(validateMission(both).errors, []);
});

test('an omitted number stands, a null one clears — the two are addressed apart', () => {
  const deps = harness();
  const doc = run(start(deps), [profile({ speedMs: 28, pulloutLoadG: 2.5 })], deps);
  const faster = missionReduce(doc, profile({ speedMs: 34 }), deps);
  assert.equal(faster.scene.dive.speedMs, 34);
  assert.equal(faster.scene.dive.pulloutLoadG, 2.5, 'the load this command never named is untouched');
  const noLoad = missionReduce(faster, profile({ pulloutLoadG: null }), deps);
  assert.equal(noLoad.scene.dive.pulloutLoadG, null);
  assert.equal(noLoad.scene.dive.speedMs, 34, 'clearing one number does not clear the other');
  assert.deepEqual(validateMission(noLoad).errors, []);
});

test('a rejected profile command changes nothing and says why', () => {
  const deps = harness();
  const doc = run(start(deps), [profile({ speedMs: 28, pulloutLoadG: 2.5 })], deps);
  const bad = [
    profile({ speedMs: 0 }),
    profile({ speedMs: -12 }),
    profile({ speedMs: '35 mph' }),
    profile({ pulloutLoadG: 1 }),   // 1 g is level flight, not a pullout
    profile({ pulloutLoadG: 0.9 }),
    profile({ pulloutLoadG: '3 g' }),
    profile({}),                    // naming neither number writes nothing
  ];
  for (const cmd of bad) {
    const before = deps.warnings.length;
    const next = missionReduce(doc, cmd, deps);
    assert.equal(next, doc, 'same reference back — nothing changed');
    assert.equal(deps.warnings.length, before + 1);
    assert.equal(deps.warnings.at(-1).code, 'W-CMD-REJECTED');
  }
});

/* ---------- the collapse invariant ---------- */

test('emptying the plan piece by piece lands back on exactly null', () => {
  const deps = harness();
  const full = run(start(deps), [
    gate('approach', 30.60, -98.10, 3460),
    gate('recovery', 30.62, -98.12, 2560),
    { type: 'setDiveBailout', payload: { bailout: { latitude: 30.63, longitude: -98.13, name: 'Valley meadow' } } },
    { type: 'setDiveRthAltitude', payload: { altitudeMslM: 3780 } },
  ], deps);
  assert.equal(full.scene.dive.gates.length, 2);
  const emptied = run(full, [
    { type: 'removeDiveGate', payload: { kind: 'approach' } },
    { type: 'removeDiveGate', payload: { kind: 'recovery' } },
    { type: 'setDiveBailout', payload: { bailout: null } },
    { type: 'setDiveRthAltitude', payload: { altitudeMslM: null } },
  ], deps);
  assert.equal(emptied.scene.dive, null, 'one representation of "no dive plan", not an empty husk');
  assert.deepEqual(validateMission(emptied).errors, []);
});

test('a speed with no gates is a plan; clearing the profile too is what empties it', () => {
  const deps = harness();
  const speedOnly = missionReduce(start(deps), profile({ speedMs: 28 }), deps);
  assert.equal(typeof speedOnly.scene.dive, 'object');
  assert.notEqual(speedOnly.scene.dive, null, 'an authored speed is content, gates or no gates');

  const full = run(start(deps), [
    gate('dive', 30.61, -98.11, 2758),
    { type: 'setDiveBailout', payload: { bailout: { latitude: 30.63, longitude: -98.13 } } },
    { type: 'setDiveRthAltitude', payload: { altitudeMslM: 3780 } },
    profile({ speedMs: 28, pulloutLoadG: 2.5 }),
  ], deps);
  const held = run(full, [
    { type: 'removeDiveGate', payload: { kind: 'dive' } },
    { type: 'setDiveBailout', payload: { bailout: null } },
    { type: 'setDiveRthAltitude', payload: { altitudeMslM: null } },
  ], deps);
  assert.notEqual(held.scene.dive, null, 'the profile numbers hold the plan open on their own');
  const emptied = missionReduce(held, profile({ speedMs: null, pulloutLoadG: null }), deps);
  assert.equal(emptied.scene.dive, null);
  assert.deepEqual(validateMission(emptied).errors, []);
});
