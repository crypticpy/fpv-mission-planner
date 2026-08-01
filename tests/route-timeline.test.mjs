import test from 'node:test';
import assert from 'node:assert/strict';

import { timelineModelFrom } from '../src/components/route-timeline.js';

/* The route timeline, minus its DOM (M10 wave C).
 *
 * The strip itself is buttons and flex-grow and is checked in the browser. What
 * is worth asserting here is the model's arithmetic — the leg↔segment join for
 * each return mode, what a block's minutes and Wh include, and what the tail
 * is. Every test below is one of the ways that can silently go wrong:
 *
 *   a leg wearing another segment's dwell — the join off by one, or a retrace
 *     counting its hold twice on the way back through;
 *   or the totals lying about a flight — a one-way mission's unflown home leg
 *     billed as air time, or an unflyable route sprouting a loiter tail.
 */

const leg = (over = {}) => ({
  phase: 'out', distKm: 1, courseDeg: 0, headMs: 2, crossMs: 1,
  vMs: 15, vgMs: 13, whPerKm: 10, whLeg: 10, timeMin: 1.5, ...over,
});

const seg = (id, index, over = {}) => ({
  segmentId: id, index, intent: 'transit', distanceKm: 1, groundSpeedMs: 13,
  timeMin: 1.5, flightWh: 10, holdWh: 0, energyWh: 10, holdS: 0,
  altitudeMslM: 120, vertical: null, clearance: null, ...over,
});

/** Two authored waypoints; seg_b holds two minutes and climbs. */
const segments = {
  seg_a: seg('seg_a', 0),
  seg_b: seg('seg_b', 1, {
    intent: 'orbit', holdS: 120, holdWh: 5,
    vertical: { climbS: 30, descentS: 30, wh: 2 },
  }),
};

const route = (over = {}) => ({
  empty: false,
  points: [{}, {}, {}],
  waypointCount: 2,
  returnMode: 'direct',
  legs: [
    leg(),
    leg({ timeMin: 2, whLeg: 12 }),
    leg({ phase: 'home', distKm: 1.2, timeMin: 1.8, whLeg: 11 }),
  ],
  fits: true,
  unflyable: false,
  loiter: { min: 4, wh: 12, binds: 'floor' },
  marginWh: 12,
  totalWh: 33,
  missionWh: 40, // 33 flight + 5 dwell + 2 climb
  ...over,
});

test('no route at all is the empty state, not a zero-leg timeline', () => {
  assert.equal(timelineModelFrom({ route: null, segments: {} }).state, 'no-route');
  assert.equal(timelineModelFrom({ route: { empty: true, legs: [] }, segments }).state, 'no-route');
});

test('a direct return joins authored legs to segments and folds home into one', () => {
  const m = timelineModelFrom({ route: route(), segments });
  assert.equal(m.state, 'ready');
  assert.equal(m.blocks.length, 3);
  assert.equal(m.blocks[0].segmentId, 'seg_a');
  assert.equal(m.blocks[0].intent, 'transit');
  assert.equal(m.blocks[1].segmentId, 'seg_b');
  assert.equal(m.blocks[1].intent, 'orbit');
  // The home hop nobody authored: no segment, muted intent, no dwell.
  assert.equal(m.blocks[2].segmentId, null);
  assert.equal(m.blocks[2].phase, 'home');
  assert.equal(m.blocks[2].intent, 'return');
  assert.equal(m.home.label, 'Home — direct line');
  assert.equal(m.home.minutes, 1.8);
  assert.equal(m.home.wh, 11);
});

test("a block's minutes and Wh carry the segment's dwell and climb", () => {
  const m = timelineModelFrom({ route: route(), segments });
  // seg_b: 2 min flight + 2 min hold + 1 min climb/descent.
  assert.equal(m.blocks[1].minutes, 5);
  assert.equal(m.blocks[1].dwellMin, 2);
  // 12 Wh flight + 5 Wh hold + 2 Wh vertical.
  assert.equal(m.blocks[1].wh, 19);
  // seg_a holds nothing, and gets nothing.
  assert.equal(m.blocks[0].minutes, 1.5);
  assert.equal(m.blocks[0].wh, 10);
  // Totals: flown minutes with dwells, mission Wh with dwells.
  assert.equal(m.totalMin, 1.5 + 5 + 1.8);
  assert.equal(m.totalWh, 40);
});

test('a retrace names the authored segment on the way back — dwell not doubled', () => {
  const m = timelineModelFrom({
    route: route({
      returnMode: 'retrace',
      points: [{}, {}, {}, {}],
      legs: [
        leg(), leg({ timeMin: 2, whLeg: 12 }),
        // planRoute marks the mirror legs 'out'; the authored count says home.
        leg(), leg({ phase: 'home' }),
      ],
    }),
    segments,
  });
  assert.equal(m.blocks[2].phase, 'home');
  assert.equal(m.blocks[2].segmentId, 'seg_b');
  assert.equal(m.blocks[3].segmentId, 'seg_a');
  // The retrace flies seg_b's line again but holds station once: 1.5 min flight,
  // no dwell, no climb.
  assert.equal(m.blocks[2].minutes, 1.5);
  assert.equal(m.blocks[2].wh, 10);
  assert.equal(m.home.label, 'Home — retrace the route back');
  assert.equal(m.home.distKm, 2);
});

test("returnMode none: the home leg is reserved, and never flown time", () => {
  const m = timelineModelFrom({
    route: route({ returnMode: 'none', missionWh: 29 }), // 22 out + 5 dwell + 2 climb
    segments,
  });
  assert.equal(m.blocks[2].reserved, true);
  assert.equal(m.home.label, 'Get-home flight (reserved, not planned)');
  // Wheels-up to landing: out legs only — 1.5 + 5, no 1.8 of unflown home.
  assert.equal(m.totalMin, 6.5);
  assert.equal(m.totalWh, 29);
});

test('a route that fits grows a loiter tail; one that does not grows none', () => {
  const fits = timelineModelFrom({ route: route(), segments });
  assert.deepEqual({ kind: fits.tail.kind, min: fits.tail.min }, { kind: 'loiter', min: 4 });

  const over = timelineModelFrom({
    route: route({ fits: false, loiter: null, marginWh: -7 }),
    segments,
  });
  assert.equal(over.tail.kind, 'over');
  assert.equal(over.tail.wh, 7);
});

test('an unflyable leg has no minutes, and an unflyable route no tail', () => {
  const m = timelineModelFrom({
    route: route({
      unflyable: true, fits: false, loiter: null, marginWh: 0,
      legs: [
        leg(),
        leg({ vMs: null, vgMs: null, whPerKm: null, whLeg: null, timeMin: null }),
        leg({ phase: 'home', timeMin: 1.8, whLeg: 11 }),
      ],
    }),
    segments,
  });
  assert.equal(m.unflyable, true);
  assert.equal(m.blocks[1].minutes, null);
  assert.equal(m.blocks[1].wh, null);
  assert.equal(m.tail, null);
  // One dead leg poisons the total honestly — no number is better than a wrong one.
  assert.equal(m.totalMin, null);
});
