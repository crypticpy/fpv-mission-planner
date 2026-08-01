import test from 'node:test';
import assert from 'node:assert/strict';

import { reviewModelFrom } from '../src/components/review-panel.js';

/* Review's resolve-and-confirm model (M10 wave D), minus its DOM. What is
 * worth asserting here: the findings keep ADR 0008's severity order whatever
 * order the producer emitted, every row carries the engine's fix descriptor
 * (or an honest null), and the reserve confirmation says which constraint is
 * actually binding — the words are P-05's whole point. */

const constraint = (code, severity, over = {}) => ({
  id: code, code, severity, text: `${code} text`,
  anchor: { scope: 'mission', refId: null },
  explanation: { inputs: ['wind'], baseline: 'bench discharge', limitations: ['gust gusts'] },
  ...over,
});

const plan = (energyOver = {}, legs = { home: true }) => ({
  energy: {
    landFloorPct: 25, reserveWh: 12.3, holdsHeadwindMs: 9,
    getHomeWh: 8.5, reserveBinds: 'floor', ...energyOver,
  },
  legs,
});

test('no plan is "no-plan", with nothing invented', () => {
  const m = reviewModelFrom(null);
  assert.equal(m.state, 'no-plan');
  assert.deepEqual(m.fixes, []);
  assert.equal(m.reserve, null);
  assert.equal(reviewModelFrom({ constraints: [constraint('W-X', 'critical')] }).state, 'no-plan');
});

test('findings come out worst first, whatever order they went in', () => {
  const m = reviewModelFrom({
    plan: plan(),
    constraints: [
      constraint('W-ENERGY-PACK-COLD', 'caution'),
      constraint('W-ALT-DENSITY-OPTIMISTIC', 'advisory'),
      constraint('W-TERR-CLEARANCE', 'critical'),
      constraint('W-ANALYSIS-UNCLASSIFIED', 'unknown'),
      constraint('W-RF-FRESNEL', 'warning'),
    ],
  });
  assert.equal(m.state, 'ready');
  assert.deepEqual(m.fixes.map((f) => f.severity),
    ['critical', 'warning', 'caution', 'unknown', 'advisory']);
});

test('every row carries the engine\'s descriptor, or an honest null', () => {
  const m = reviewModelFrom({
    plan: plan(),
    constraints: [
      constraint('W-TERR-CLEARANCE', 'critical',
        { anchor: { scope: 'segment', refId: 'seg_2' } }),
      constraint('W-ENERGY-PACK-COLD', 'caution'),
      constraint('W-ANALYSIS-UNCLASSIFIED', 'unknown'),
    ],
  });
  const [terr, pack, unclassified] = m.fixes;
  assert.deepEqual({ ...terr.action },
    { kind: 'segment', segmentId: 'seg_2', label: 'Open this leg' });
  assert.equal(pack.action.control, 'pack-temp');
  assert.equal(unclassified.action, null);
  // The evidence rides through verbatim — the render draws it, never rewrites it.
  assert.equal(terr.explanation.baseline, 'bench discharge');
  assert.equal(terr.text, 'W-TERR-CLEARANCE text');
});

test('the reserve confirmation names the floor when the floor binds', () => {
  const m = reviewModelFrom({ plan: plan(), constraints: [] });
  assert.equal(m.fixes.length, 0);
  assert.equal(m.reserve.lines.length, 2);
  assert.match(m.reserve.lines[0], /Don’t land below 25%/);
  assert.match(m.reserve.lines[0], /12\.3 Wh stays in the pack/);
  assert.match(m.reserve.lines[1], /^The 25% floor is what caps this mission/);
  assert.equal(m.reserve.action.kind, 'conditions');
  assert.equal(m.reserve.action.control, 'reserve');
});

test('the reserve confirmation names get-home when get-home binds', () => {
  const m = reviewModelFrom({
    plan: plan({ reserveBinds: 'getHome' }), constraints: [],
  });
  assert.match(m.reserve.lines[1], /^Getting home is what caps this mission/);
  assert.match(m.reserve.lines[1], /8\.5 Wh at the turnaround/);
});

test('no headwind figure or no home leg keeps the floor line alone', () => {
  const noHold = reviewModelFrom({
    plan: plan({ holdsHeadwindMs: null }), constraints: [],
  });
  assert.equal(noHold.reserve.lines.length, 1);
  const oneWay = reviewModelFrom({
    plan: plan({}, { home: false }), constraints: [],
  });
  assert.equal(oneWay.reserve.lines.length, 1);
});
