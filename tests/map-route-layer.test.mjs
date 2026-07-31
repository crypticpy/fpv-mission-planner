import test from 'node:test';
import assert from 'node:assert/strict';

import { routeSpans, segmentIdOrder, worstPinIndex } from '../src/presentation/map/layers/route-layer.js';

/* The one piece of arithmetic in the route layer.
 *
 * `planRoute` is handed the waypoint list with its own reverse appended when the
 * return policy is `retrace`, so `worst.index` — the turn the reserve is
 * measured against — can name a waypoint the aircraft is passing for the second
 * time. There is only one pin for that place, drawn on the way out, and this is
 * the map back to it.
 *
 * Worth its own test rather than an assertion inside a render: an off-by-one
 * here does not throw. It quietly rings the wrong waypoint, and the pilot's
 * tightest turn looks like an ordinary one. */

test('a direct return passes the index straight through', () => {
  assert.equal(worstPinIndex(0, 3, 'direct'), 0);
  assert.equal(worstPinIndex(1, 3, 'direct'), 1);
  assert.equal(worstPinIndex(2, 3, 'direct'), 2);
  // `none` flies no return leg at all, so its indices are the authored ones too.
  assert.equal(worstPinIndex(1, 3, 'none'), 1);
});

test('a retrace folds the mirrored half back onto the pins it was drawn from', () => {
  // Three authored waypoints become [w0, w1, w2, w1, w0] on the way to planRoute.
  assert.equal(worstPinIndex(0, 3, 'retrace'), 0);
  assert.equal(worstPinIndex(1, 3, 'retrace'), 1);
  assert.equal(worstPinIndex(2, 3, 'retrace'), 2, 'the turn itself is not mirrored');
  assert.equal(worstPinIndex(3, 3, 'retrace'), 1, 'the second pass over w1');
  assert.equal(worstPinIndex(4, 3, 'retrace'), 0, 'the second pass over w0');
});

test('two waypoints is the tightest retrace there is', () => {
  // [w0, w1, w0] — one interior point, seen twice.
  assert.equal(worstPinIndex(0, 2, 'retrace'), 0);
  assert.equal(worstPinIndex(1, 2, 'retrace'), 1);
  assert.equal(worstPinIndex(2, 2, 'retrace'), 0);
});

test('a single waypoint is never doubled, whatever the policy says', () => {
  // compute() only appends the reverse when there is more than one waypoint, so
  // a lone waypoint under a retrace policy is still a one-pin route.
  assert.equal(worstPinIndex(0, 1, 'retrace'), 0);
  assert.equal(worstPinIndex(1, 1, 'retrace'), null, 'there is no pin to light up');
});

test('an index nothing drew is null, not a pin chosen at random', () => {
  assert.equal(worstPinIndex(null, 3, 'direct'), null, 'no worst turn — an empty route');
  assert.equal(worstPinIndex(undefined, 3, 'retrace'), null);
  assert.equal(worstPinIndex(7, 3, 'direct'), null, 'past the authored list');
  assert.equal(worstPinIndex(9, 3, 'retrace'), null, 'past the doubled list too');
  assert.equal(worstPinIndex(-1, 3, 'retrace'), null);
  assert.equal(worstPinIndex(1.5, 3, 'direct'), null);
});

/* Which drawn hop is which authored segment (M4 wave C).
 *
 * The same arithmetic decides where 2D puts its click targets and which datum
 * 3D hands back from a pick, so the two engines opening *different* inspectors
 * for the same line is exactly the failure this file exists to catch. Like the
 * mirror above, it does not throw when it is wrong. */

const ids = (n) => Array.from({ length: n }, (_, i) => `s${i}`);
const named = (spans) => spans.map((s) => s.segmentId);

test('the outbound hops are the authored segments, one for one', () => {
  const spans = routeSpans({
    pointCount: 4, waypointCount: 3, returnMode: 'direct', segmentIds: ids(3),
  });
  const out = spans.filter((s) => s.phase === 'out');
  assert.deepEqual(named(out), ['s0', 's1', 's2']);
  assert.deepEqual(out.map((s) => [s.a, s.b]), [[0, 1], [1, 2], [2, 3]]);
});

test('a direct return is a line nobody drew, so it names no segment', () => {
  // Selecting it would open an inspector for a leg the pilot never authored and
  // the analysis never published.
  const spans = routeSpans({
    pointCount: 4, waypointCount: 3, returnMode: 'direct', segmentIds: ids(3),
  });
  const home = spans.filter((s) => s.phase === 'home');
  assert.equal(home.length, 1, 'a direct return is one hop');
  assert.equal(home[0].segmentId, null);
  assert.deepEqual([home[0].a, home[0].b], [3, 0], 'from the far waypoint back to the launch');
});

test('a retrace names each hop home after the segment it is flying backwards', () => {
  // Three waypoints reach planRoute as [w0, w1, w2, w1, w0], so the points are
  // [L, w0, w1, w2, w1, w0]. A segment is named by where it arrives, so the hop
  // back from w2 to w1 is segment 2 in reverse — not segment 1.
  const spans = routeSpans({
    pointCount: 6, waypointCount: 3, returnMode: 'retrace', segmentIds: ids(3),
  });
  assert.deepEqual(named(spans), ['s0', 's1', 's2', 's2', 's1', 's0']);
  assert.deepEqual(spans.map((s) => s.phase), ['out', 'out', 'out', 'home', 'home', 'home']);
  // Every hop of the drawn line is here, including the one that closes it.
  assert.deepEqual(spans.map((s) => [s.a, s.b]),
    [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0]]);
});

test('a lone waypoint under a retrace flies its one segment out and back', () => {
  // compute() only appends the reverse for more than one waypoint, so the point
  // list is [L, w0] and the hop home is segment 0 again rather than nothing.
  const spans = routeSpans({
    pointCount: 2, waypointCount: 1, returnMode: 'retrace', segmentIds: ids(1),
  });
  assert.deepEqual(named(spans), ['s0', 's0']);
  assert.deepEqual(spans.map((s) => s.phase), ['out', 'home']);
});

test('a route with nothing drawn on it has no hops at all', () => {
  for (const input of [
    { pointCount: 0, waypointCount: 0, returnMode: 'direct', segmentIds: [] },
    { pointCount: 1, waypointCount: 0, returnMode: 'direct', segmentIds: [] },
    { pointCount: 2, waypointCount: 0, returnMode: 'retrace', segmentIds: ['s0'] },
  ]) {
    assert.deepEqual(routeSpans(input), []);
  }
});

test('a hop the analysis published no segment for is null, not the wrong segment', () => {
  // The analysis can come back short — an unplannable leg publishes nothing.
  // Guessing an id here would open the inspector on somebody else's numbers.
  const spans = routeSpans({
    pointCount: 4, waypointCount: 3, returnMode: 'direct', segmentIds: ['s0'],
  });
  assert.deepEqual(named(spans), ['s0', null, null, null]);
});

test('the segment ids come back in the order the pilot authored them', () => {
  // Object key order is insertion order, and nothing promises the analysis built
  // the record in index order — so the index on each segment is what decides.
  assert.deepEqual(segmentIdOrder({
    'seg-c': { index: 2 }, 'seg-a': { index: 0 }, 'seg-b': { index: 1 },
  }), ['seg-a', 'seg-b', 'seg-c']);
  assert.deepEqual(segmentIdOrder({}), []);
  assert.deepEqual(segmentIdOrder(null), []);
});
