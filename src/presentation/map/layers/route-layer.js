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

const CASING = { color: 'var(--map-casing)', weight: 7, opacity: 0.6 };

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

      // Casing first: a dark stroke under the line keeps it readable over imagery.
      drawn.push(adapter.polyline(outbound, CASING));
      drawn.push(adapter.polyline(outbound, { color, weight: 3.5, opacity: 1 }));
      drawn.push(adapter.polyline(home, {
        color, weight: 2.5, dashArray: '7 6', opacity: 0.95,
      }));

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
