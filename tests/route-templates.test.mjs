import test from 'node:test';
import assert from 'node:assert/strict';

import { createMission, validateMission } from '../src/domain/mission/mission-schema.js';
import { missionReduce } from '../src/domain/mission/mission-reducer.js';
import { ROUTE_TEMPLATES, templateCommands } from '../src/domain/mission/route-templates.js';

/* A template's whole promise is that it is nothing but reducer commands — so
 * these tests never inspect the commands as data beyond their count. Each plan
 * is judged by reducing it and reading the document that comes out: canonical
 * gate order, validator-clean, idempotent where the template claims to be. */

const RIDGE = { latitude: 30.61, longitude: -98.11, elevationMslM: 3298 }; // the sheet's 10,820 ft launch

function harness() {
  let ids = 0;
  let ticks = 0;
  /** @type {{code: string}[]} */
  const warnings = [];
  return {
    warnings,
    idgen: (prefix) => `${prefix}_${++ids}`,
    now: () => new Date(Date.UTC(2026, 6, 30, 12, 0, ticks++)).toISOString(),
    onWarning: (w) => warnings.push(w),
  };
}

const start = (deps, launch = RIDGE) => createMission({ launch, title: 'Ridge run' }, deps);

function apply(doc, id, deps) {
  const plan = templateCommands(id, doc);
  assert.equal(plan.blocked, undefined, `'${id}' unexpectedly blocked: ${plan.blocked}`);
  const next = plan.commands.reduce((d, c) => missionReduce(d, c, deps), doc);
  assert.deepEqual(deps.warnings, [], 'a template never authors a command the reducer rejects');
  assert.deepEqual(validateMission(next).errors, []);
  return next;
}

test('the template row is three fixed sketches, each with a label and a hint', () => {
  assert.deepEqual(ROUTE_TEMPLATES.map((t) => t.id), ['mountain-dive', 'ridge-traverse', 'high-altitude-orbit']);
  for (const t of ROUTE_TEMPLATES) {
    assert.ok(t.label.length > 0 && t.hint.length > 0);
  }
  assert.ok(Object.isFrozen(ROUTE_TEMPLATES));
});

test('an unknown template id is blocked, not an exception', () => {
  const deps = harness();
  assert.equal(typeof templateCommands('barrel-roll', start(deps)).blocked, 'string');
});

/* ---------- mountain dive ---------- */

test('mountain dive seeds the three gates, in flight order, stepping down toward the launch elevation', () => {
  const deps = harness();
  const doc = apply(start(deps), 'mountain-dive', deps);
  const gates = doc.scene.dive.gates;
  assert.deepEqual(gates.map((g) => g.kind), ['approach', 'dive', 'recovery']);
  assert.deepEqual(gates.map((g) => g.altitudeMslM), [3298 + 250, 3298 + 120, 3298 + 40],
    'every seed sits above the launch elevation — a fresh sketch never starts underground');
  // No route drawn yet, so the sketch runs north: latitude grows, longitude holds.
  for (const g of gates) {
    assert.ok(g.latitude > RIDGE.latitude);
    assert.ok(Math.abs(g.longitude - RIDGE.longitude) < 1e-9);
  }
});

test('with a route drawn, the dive sketch extends along the route bearing instead', () => {
  const deps = harness();
  const east = { type: 'addWaypoint', payload: { latitude: RIDGE.latitude, longitude: RIDGE.longitude + 0.02 } };
  const routed = missionReduce(start(deps), east, deps);
  const doc = apply(routed, 'mountain-dive', deps);
  for (const g of doc.scene.dive.gates) {
    assert.ok(g.longitude > RIDGE.longitude, 'gates march east, the way the route points');
    assert.ok(Math.abs(g.latitude - RIDGE.latitude) < 0.001);
  }
});

test('re-applying mountain dive moves the same three gates — set-by-kind makes it idempotent', () => {
  const deps = harness();
  const once = apply(start(deps), 'mountain-dive', deps);
  const twice = apply(once, 'mountain-dive', deps);
  assert.deepEqual(twice.scene.dive.gates.map((g) => g.id), once.scene.dive.gates.map((g) => g.id));
  assert.equal(twice.scene.dive.gates.length, 3);
});

test('mountain dive declines when the launch elevation is unknown, and says why', () => {
  const deps = harness();
  const doc = start(deps, { latitude: RIDGE.latitude, longitude: RIDGE.longitude });
  const plan = templateCommands('mountain-dive', doc);
  assert.match(plan.blocked, /launch elevation/i);
  assert.equal(plan.commands, undefined);
});

/* ---------- the waypoint-seeding pair ---------- */

test('ridge traverse sketches three AGL transit legs on an empty route', () => {
  const deps = harness();
  const doc = apply(start(deps), 'ridge-traverse', deps);
  assert.equal(doc.route.waypoints.length, 3);
  for (const s of doc.route.segments) {
    assert.equal(s.intent, 'transit');
    assert.deepEqual(s.altitude, { authored: 60, reference: 'agl', resolvedMslM: null });
  }
});

test('high-altitude orbit sketches one high holding orbit on an empty route', () => {
  const deps = harness();
  const doc = apply(start(deps), 'high-altitude-orbit', deps);
  assert.equal(doc.route.waypoints.length, 1);
  const [s] = doc.route.segments;
  assert.equal(s.intent, 'orbit');
  assert.equal(s.holdS, 60);
  assert.deepEqual(s.altitude, { authored: 120, reference: 'agl', resolvedMslM: null });
});

test('both route-seeding templates decline when waypoints already exist; the dive template does not', () => {
  const deps = harness();
  const routed = missionReduce(start(deps),
    { type: 'addWaypoint', payload: { latitude: 30.62, longitude: -98.12 } }, deps);
  assert.match(templateCommands('ridge-traverse', routed).blocked, /already has waypoints/);
  assert.match(templateCommands('high-altitude-orbit', routed).blocked, /already has waypoints/);
  assert.equal(templateCommands('mountain-dive', routed).blocked, undefined,
    'dive gates live beside the route, not on it');
});
