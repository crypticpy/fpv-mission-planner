import test from 'node:test';
import assert from 'node:assert/strict';

import { worstPinIndex } from '../src/presentation/map/layers/route-layer.js';

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
