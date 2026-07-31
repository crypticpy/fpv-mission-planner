import test from 'node:test';
import assert from 'node:assert/strict';

import { routeSpans, segmentIdOrder, worstPinIndex } from '../src/presentation/map/layers/route-layer.js';
import { createSubjectLayer } from '../src/presentation/map/layers/subject-layer.js';

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

/* ---------- the subjects, on the 2D map (M7 wave D) ---------- */

/* A subject layer is mostly markers, and markers are the adapter's business —
 * but three decisions in it are this layer's own and none of them throws when it
 * is wrong: which pin is drawn lit, whether the roster is rebuilt at all, and
 * which gesture ends in which command. A rebuild on every pass is a pin the
 * pilot cannot drag, because it is torn down mid-drag; a click that survives a
 * drag deletes the subject that was just moved. */

/** The two adapter calls this layer makes, recorded rather than rendered. */
function stubAdapter() {
  const made = [];
  return {
    made,
    live: () => made.filter((m) => !m.removed),
    marker(opts) {
      const overlay = { ...opts, removed: false, remove() { overlay.removed = true; } };
      made.push(overlay);
      return overlay;
    },
  };
}

const subjectFrame = (over = {}) => ({
  subjects: [],
  selectedSegmentId: null,
  snapshot: { segments: {} },
  gestures: { dragEnded() {}, afterDrag: () => false, markerClicked() {} },
  actions: { moveSubject() {}, removeSubject() {} },
  ...over,
});

const sub = (over = {}) => ({
  id: 'sub-1', name: 'The barn', lat: 1, lng: 2, elevationMslM: null, radiusM: null, ...over,
});

test('every subject on the frame becomes a draggable pin that names itself', () => {
  const layer = createSubjectLayer();
  const adapter = stubAdapter();
  layer.render(subjectFrame({ subjects: [sub(), sub({ id: 'sub-2', name: 'The mast' })] }), adapter);

  assert.equal(adapter.live().length, 2);
  const [barn] = adapter.live();
  assert.deepEqual(barn.at, { lat: 1, lng: 2 });
  assert.equal(barn.draggable, true);
  assert.match(barn.title, /^The barn — /, 'the pilot’s own name, first');
  assert.match(barn.title, /drag to move, click to remove/, 'and what the gestures do');
});

test('the pin the open segment is framing is the lit one', () => {
  const layer = createSubjectLayer();
  const adapter = stubAdapter();
  layer.render(subjectFrame({
    subjects: [sub(), sub({ id: 'sub-2', name: 'The mast' })],
    selectedSegmentId: 'seg-0',
    // Off the analysis, not the document: a segment whose subjectRef the pass
    // could not resolve has no shot, and lights nothing up.
    snapshot: { segments: { 'seg-0': { shot: { subjectId: 'sub-2' } } } },
  }), adapter);

  const [barn, mast] = adapter.live();
  assert.ok(!barn.html.includes('var(--accent)'));
  assert.ok(mast.html.includes('var(--accent)'), 'the framed subject takes the accent');
});

test('a pass that changes nothing leaves the pins where they are', () => {
  // Every slider on the rail runs a render pass. Rebuilding the roster on each
  // one drops the pin out from under a drag in progress.
  const layer = createSubjectLayer();
  const adapter = stubAdapter();
  const frame = subjectFrame({ subjects: [sub()] });
  layer.render(frame, adapter);
  layer.render(subjectFrame({ subjects: [sub()] }), adapter);
  assert.equal(adapter.made.length, 1);

  // Moving one, renaming one, or changing which is framed is a redraw.
  layer.render(subjectFrame({ subjects: [sub({ lat: 1.5 })] }), adapter);
  assert.equal(adapter.made.length, 2);
  layer.render(subjectFrame({ subjects: [sub({ lat: 1.5, name: 'The old barn' })] }), adapter);
  assert.equal(adapter.made.length, 3);
  assert.equal(adapter.live().length, 1, 'the pin it replaced was taken off the map');
});

test('a drag moves the subject and a click removes it — through commands, never here', () => {
  const layer = createSubjectLayer();
  const adapter = stubAdapter();
  const moved = [];
  const removed = [];
  let afterDrag = false;
  layer.render(subjectFrame({
    subjects: [sub()],
    gestures: { dragEnded() { afterDrag = true; }, afterDrag: () => afterDrag, markerClicked() {} },
    actions: {
      moveSubject: (id, at) => moved.push([id, at]),
      removeSubject: (id) => removed.push(id),
    },
  }), adapter);

  const pin = adapter.live()[0];
  pin.onDragEnd({ lat: 3, lng: 4 });
  assert.deepEqual(moved, [['sub-1', { lat: 3, lng: 4 }]]);

  // The click the engine fires on the pin at the end of a drag is not a delete.
  pin.onClick();
  assert.deepEqual(removed, [], 'the subject just dragged survives its own drop');

  afterDrag = false;
  pin.onClick();
  assert.deepEqual(removed, ['sub-1']);
});

test('a disposed layer leaves nothing on the map and forgets what it drew', () => {
  const layer = createSubjectLayer();
  const adapter = stubAdapter();
  layer.render(subjectFrame({ subjects: [sub()] }), adapter);
  layer.dispose();
  assert.equal(adapter.live().length, 0);

  // And the same roster after a dispose is drawn again rather than skipped as
  // unchanged — the map it was drawn on is gone.
  layer.render(subjectFrame({ subjects: [sub()] }), adapter);
  assert.equal(adapter.live().length, 1);
});

test('a frame with no subjects on it is not an error', () => {
  const layer = createSubjectLayer();
  const adapter = stubAdapter();
  layer.render(subjectFrame(), adapter);
  layer.render(subjectFrame({ subjects: undefined }), adapter);
  assert.equal(adapter.made.length, 0);
});
