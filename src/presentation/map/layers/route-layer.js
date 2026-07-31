// route-layer.js — the line the pilot drew, and the one the aircraft flies home.
//
// The out legs are solid and the return is dashed, because the return is the
// line the aircraft takes when something goes wrong rather than one anybody
// authored. Colour comes off the verdict: a route the budget cannot cover is
// drawn in the critical colour, so the map agrees with the panel below it
// without the pilot reading the panel.
//
// The waypoints are not held here. They live in the mission document (ADR 0002),
// arrive on the frame, and every gesture on a pin raises a command rather than
// editing anything. Every number about them was integrated once, in the
// analysis, and arrives on `frame.snapshot.route` — this file draws and handles
// the pointer.
//
// The retrace correction lives here too. `planRoute` is handed the waypoint list
// with its own reverse appended when the return policy is `retrace`, so the
// integrated route's `points` contain each interior waypoint twice. Drawing all
// of them as outbound painted the flight home in the outbound style and left the
// dashed return as a single hop from the *first* waypoint back to launch — a
// line the aircraft never flies. `waypointCount` on the snapshot is what makes
// the two halves separable.

/**
 * @typedef {import('../map-adapter.js').LatLng} LatLng
 * @typedef {import('../map-adapter.js').MapAdapter} MapAdapter
 * @typedef {import('../map-adapter.js').MapFrame} MapFrame
 * @typedef {import('../map-adapter.js').MapLayer} MapLayer
 */

/** @typedef {{ remove: () => void }} Drawn */
/** @typedef {{ segmentId: string|null, a: number, b: number, phase: 'out'|'home' }} RouteSpan */

const CASING = { color: 'var(--map-casing)', weight: 7, opacity: 0.6 };
/** Under the drawn line, so the line keeps its own colour on top of the accent. */
const HALO = { color: 'var(--accent)', weight: 9, opacity: 0.85 };
/**
 * Invisible, wide, and last in the pane, so it takes the click. Drawn as its own
 * geometry rather than by splitting the visible line: the return is dashed, and
 * a dash pattern restarts at every polyline start, so per-leg *drawn* lines would
 * change the picture. This changes nothing anybody can see.
 */
const HIT = { color: '#000', weight: 14, opacity: 0, className: 'route-hit' };

/**
 * Which drawn pin, if any, the reserve's worst case sits on.
 *
 * `worst.index` indexes the waypoint list *as the integrator received it*. Under
 * a retrace that list is `[w0…w(n-1), w(n-2)…w0]`, so an index past the turn
 * names a waypoint the aircraft is passing for the second time — and the pin
 * that has to light up is the one it was drawn on the way out. The mirror is
 * `2n - 2 - i`: index n is w(n-2), index 2n-2 is w0.
 *
 * Pure, exported and tested on its own because it is the one piece of arithmetic
 * in this file, and an off-by-one here highlights the wrong waypoint rather than
 * failing loudly.
 *
 * @param {number|null|undefined} worstIndex
 * @param {number} waypointCount  what the pilot authored, before any doubling
 * @param {string} returnMode
 * @returns {number|null} an index into the authored waypoints, or null
 */
export function worstPinIndex(worstIndex, waypointCount, returnMode) {
  if (typeof worstIndex !== 'number' || !Number.isInteger(worstIndex) || worstIndex < 0) return null;
  if (worstIndex < waypointCount) return worstIndex;
  if (returnMode !== 'retrace') return null;
  const mirrored = 2 * waypointCount - 2 - worstIndex;
  return mirrored >= 0 ? mirrored : null;
}

/**
 * Every hop the drawn route makes, each named with the authored segment it is —
 * or with null where it is a hop nobody authored.
 *
 * The integrator's point list is `[launch, …authored, …whatever the return
 * policy appended]`, and the authored segments index the outbound hops one for
 * one: segment `k` is the hop from point `k` to point `k + 1`. The way home is
 * where that stops being obvious. Under a retrace the appended points are the
 * outbound waypoints in reverse, so a hop between two of them is an authored
 * segment flown backwards — and the segment it is, is the *later* of the two
 * ends it touches, because a segment is named by where it arrives. The last hop
 * of a retrace lands on the launch, which is segment 0 flown backwards. Under a
 * direct return that same hop is a line the aircraft flies and nobody drew, so
 * it gets no segment and, downstream, no way to select it.
 *
 * Pure and shared: 2D uses it to place the click targets and 3D to place the
 * pickable legs, and a disagreement between the two would mean clicking the same
 * line opened two different segments.
 *
 * @param {object} input
 * @param {number} input.pointCount     the integrator's own point list length
 * @param {number} input.waypointCount  what the pilot authored, before any doubling
 * @param {string} input.returnMode
 * @param {readonly string[]} input.segmentIds  authored order; segment k arrives at waypoint k
 * @returns {RouteSpan[]}
 */
export function routeSpans({ pointCount, waypointCount, returnMode, segmentIds }) {
  const n = Math.min(waypointCount, pointCount - 1);
  if (n < 1) return [];

  /** Which authored waypoint a point index is, or -1 for the launch. @param {number} k */
  const authoredAt = (k) => (k === 0 ? -1 : (worstPinIndex(k - 1, n, returnMode) ?? -1));
  /** @param {number} i */
  const idAt = (i) => (i >= 0 && i < segmentIds.length ? segmentIds[i] ?? null : null);

  /** @type {RouteSpan[]} */
  const spans = [];
  for (let k = 0; k < n; k++) spans.push({ segmentId: idAt(k), a: k, b: k + 1, phase: 'out' });
  for (let k = n; k < pointCount - 1; k++) {
    spans.push({
      segmentId: idAt(Math.max(authoredAt(k), authoredAt(k + 1))),
      a: k,
      b: k + 1,
      phase: 'home',
    });
  }
  spans.push({
    segmentId: returnMode === 'retrace' ? idAt(0) : null,
    a: pointCount - 1,
    b: 0,
    phase: 'home',
  });
  return spans;
}

/**
 * The authored segment ids in authored order, read off the analysis rather than
 * the document — the map never holds the document (ADR 0002), and every segment
 * the analysis published carries the index it was authored at.
 * @param {Record<string, { index: number }>|null|undefined} segments
 * @returns {string[]}  sparse where the analysis had nothing to say
 */
export function segmentIdOrder(segments) {
  /** @type {string[]} */
  const order = [];
  for (const [id, seg] of Object.entries(segments ?? {})) {
    if (Number.isInteger(seg?.index) && seg.index >= 0) order[seg.index] = id;
  }
  return order;
}

/** @returns {MapLayer} */
export function createRouteLayer() {
  /** @type {Drawn[]} */
  let drawn = [];
  /** @type {MapFrame|null} */
  let current = null;

  const clear = () => {
    for (const d of drawn) d.remove();
    drawn = [];
  };

  return {
    id: 'route',

    render(frame, adapter) {
      current = frame;
      clear();

      const route = frame.snapshot.route;
      /* The snapshot describes the mission, not the view: it integrates whatever
       * route the document holds. The two states that hide the line are view
       * states, and they live on the frame. */
      if (!frame.routeMode || !route || route.empty) return;

      const points = route.points.map(toLatLng);
      /* How many of those points the pilot authored. Everything past index `n`
       * is the mirror a retrace appended. */
      const n = Math.min(route.waypointCount, points.length - 1);
      if (n < 1) return;

      const color = route.fits === false ? 'var(--status-critical)' : 'var(--series-2)';
      const outbound = points.slice(0, n + 1);
      /* From the far waypoint, back through whatever the return policy retraces,
       * and home. For a direct return that is one hop, exactly as before. */
      const home = [...points.slice(n), points[0]];

      const spans = routeSpans({
        pointCount: points.length,
        waypointCount: n,
        returnMode: route.returnMode,
        segmentIds: segmentIdOrder(frame.snapshot.segments),
      });
      const selected = frame.selectedSegmentId;

      // Casing first: a dark stroke under the line keeps it readable over imagery.
      drawn.push(adapter.polyline(outbound, CASING));
      /* Then the accent, still under the line, so a selected leg reads as the
       * same route with a light behind it rather than a different route. */
      for (const span of spans) {
        if (!span.segmentId || span.segmentId !== selected) continue;
        drawn.push(adapter.polyline([points[span.a], points[span.b]], HALO));
      }
      drawn.push(adapter.polyline(outbound, { color, weight: 3.5, opacity: 1 }));
      drawn.push(adapter.polyline(home, {
        color, weight: 2.5, dashArray: '7 6', opacity: 0.95,
      }));

      /* Last of the lines, so it is the one the pointer meets. A hop nobody
       * authored has nothing to open and stays untouchable. */
      for (const span of spans) {
        const id = span.segmentId;
        if (!id) continue;
        drawn.push(adapter.polyline([points[span.a], points[span.b]], HIT, {
          onClick: () => {
            const f = current;
            if (!f || f.gestures.afterDrag()) return;
            /* Same standing-down the pins do: the map is about to hear this
             * click too, and in route mode that would drop a waypoint on the
             * leg just selected. */
            f.gestures.markerClicked();
            f.actions.selectSegment(id);
          },
        }));
      }

      const worst = worstPinIndex(route.worst?.index, n, route.returnMode);
      for (let i = 0; i < n; i++) {
        // points[0] is the launch, so points[i + 1] and waypoints[i] are the same
        // place — both came off the same document in the same pass.
        const id = frame.waypoints[i]?.id;
        if (!id) continue;
        drawn.push(pin(adapter, points[i + 1], i, worst === i, id, () => current));
      }
    },

    dispose() {
      clear();
      current = null;
    },
  };
}

/**
 * @param {MapAdapter} adapter
 * @param {LatLng} at
 * @param {number} i
 * @param {boolean} isWorst
 * @param {string} id
 * @param {() => MapFrame|null} frameNow
 */
function pin(adapter, at, i, isWorst, id, frameNow) {
  return adapter.marker({
    at,
    className: 'route-marker',
    html: `<div class="route-dot${isWorst ? ' route-dot-worst' : ''}">${i + 1}</div>`,
    sizePx: [20, 20],
    anchorPx: [10, 10],
    draggable: true,
    title: `Waypoint ${i + 1} — drag to move, click to remove`,
    onDragEnd: (to) => {
      /* Twice over, for two different clicks: the one Leaflet fires on the map
       * behind the pin, which in route mode would drop a new waypoint, and the
       * one it fires on the pin itself, which would delete what was just moved. */
      frameNow()?.gestures.dragEnded();
      frameNow()?.actions.moveWaypoint(id, to);
    },
    onClick: () => {
      const frame = frameNow();
      if (!frame || frame.gestures.afterDrag()) return;
      frame.gestures.markerClicked();
      frame.actions.removeWaypoint(id);
    },
  });
}

/** @param {{ lat: number, lng: number }} p @returns {LatLng} */
function toLatLng(p) {
  return { lat: p.lat, lng: p.lng };
}
