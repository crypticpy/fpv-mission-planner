// footprint-layer.js — the wind-shaped envelope, drawn from the snapshot.
//
// Two rings and a leg. The rings are the out-and-back turnaround envelope — how
// far out the aircraft can fly on each course and still make it home, not
// general reachability — at the planned cruise and at best-range speed, so the
// gap between them is what the chosen cruise costs. The leg is the one bearing
// the terrain profile actually describes, drawn so the elevation card below the
// map is about a line the pilot can see rather than a compass number they have
// to imagine.
//
// Nothing here computes any of that. The sweep moved into the analysis pipeline
// under ADR 0004 (`snapshot.footprint`), and this file turns polar coordinates
// into points on a map. If a number in this file did not come off the snapshot,
// it is a bug.

import { destination } from '../../../domain/geo.js';

/**
 * @typedef {import('../map-adapter.js').LatLng} LatLng
 * @typedef {import('../map-adapter.js').LatLngBounds} LatLngBounds
 * @typedef {import('../map-adapter.js').MapAdapter} MapAdapter
 * @typedef {import('../map-adapter.js').MapFrame} MapFrame
 * @typedef {import('../map-adapter.js').MapLayer} MapLayer
 * @typedef {import('../map-adapter.js').ShapeOverlay} ShapeOverlay
 */

/** The theme-aware casing that keeps a stroke readable over bright imagery. */
const CASING = { color: 'var(--map-casing)', weight: 7, opacity: 0.62, fill: false };
const BEST_RING = {
  color: 'var(--ring-best)', weight: 3, dashArray: '9 7', fill: false, opacity: 1,
};
const PLANNED_RING = {
  color: 'var(--ring-planned)', weight: 3.5,
  fillColor: 'var(--ring-planned)', fillOpacity: 0.15, opacity: 1,
};
const LEG = { color: 'var(--series-4)', weight: 2.5, dashArray: '2 6', opacity: 0.95 };

/**
 * The footprint layer, plus the one thing the host asks it for: the extent to
 * frame the map on when the pilot presses Fit.
 * @typedef {MapLayer & { bounds: () => LatLngBounds|null }} FootprintLayer
 */

/** @returns {FootprintLayer} */
export function createFootprintLayer() {
  /** @type {ShapeOverlay[]} */
  let drawn = [];
  /* The planned ring if there is one, else the best-range ring — what "fit the
   * map to the footprint" means, in that order of preference. */
  /** @type {ShapeOverlay|null} */
  let frameable = null;

  const clear = () => {
    for (const s of drawn) s.remove();
    drawn = [];
    frameable = null;
  };

  return {
    id: 'footprint',

    render(frame, adapter) {
      clear();
      const { footprint, plan, link } = frame.snapshot;
      if (!footprint || !plan) return;

      /* The sweep's own launch point, not the pin's. They agree on every settled
       * frame; preferring this one means a ring can never be drawn around a
       * place it was not computed for. */
      const from = footprint.launch;
      const anyReal = footprint.byCourse.some((r) => r > 0);
      const anyBest = footprint.bestByCourse.some((r) => r > 0);

      if (anyReal || anyBest) {
        const best = adapter.polygon(
          ringPoints(from, footprint.bestCourses, footprint.bestRadii), BEST_RING);
        drawn.push(best);
        frameable = best;
        if (anyReal) {
          const pts = ringPoints(from, footprint.courses, footprint.radii);
          drawn.push(adapter.polygon(pts, CASING));
          const planned = adapter.polygon(pts, PLANNED_RING);
          drawn.push(planned);
          frameable = planned;
        }
      }

      /* The outbound leg the dashboard plans, and where the terrain cuts the
       * radio before the pack runs out. Splitting it names the difference
       * between "you cannot get there" and "you cannot see what is there" — the
       * ring alone would promise the second as if it were neither. Only this one
       * bearing is profiled; the ring is silent about the radio on every other
       * course, which is what the card under the map says too. */
      if (plan.radiusKm > 0) {
        const course = footprint.plannedCourseDeg;
        const end = at(from, course, plan.radiusKm);
        const clearKm = link?.blocked && typeof link.clearKm === 'number'
          && link.clearKm < plan.radiusKm ? link.clearKm : null;
        const cut = clearKm != null ? at(from, course, clearKm) : end;
        drawn.push(adapter.polyline([from, cut], LEG));
        if (clearKm != null) {
          drawn.push(adapter.polyline([cut, end], {
            // A broken line of sight is a harder no than a grazed Fresnel zone.
            color: link?.losBlockKm != null ? 'var(--status-critical)' : 'var(--status-serious)',
            weight: 3, dashArray: '1 7', opacity: 0.95,
          }));
        }
      }
    },

    bounds: () => frameable?.bounds() ?? null,

    dispose() {
      clear();
    },
  };
}

/**
 * A polar ring as a closed ring of points. A zero radius collapses to the launch
 * point rather than being dropped, so a footprint that has partly collapsed is
 * drawn pinched against its own centre — which is what it is — instead of
 * silently closing across the gap.
 *
 * Consecutive duplicates are skipped: a wholly collapsed sector would otherwise
 * hand the engine hundreds of identical vertices.
 *
 * @param {LatLng} from
 * @param {number[]} courses
 * @param {number[]} radii
 * @returns {LatLng[]}
 */
function ringPoints(from, courses, radii) {
  /** @type {LatLng[]} */
  const pts = [];
  for (let i = 0; i < courses.length; i++) {
    const r = radii[i];
    const p = r > 0 ? at(from, courses[i], r) : { ...from };
    const prev = pts[pts.length - 1];
    if (prev && Math.abs(prev.lat - p.lat) < 1e-9 && Math.abs(prev.lng - p.lng) < 1e-9) continue;
    pts.push(p);
  }
  return pts;
}

/** @param {LatLng} from @param {number} courseDeg @param {number} km @returns {LatLng} */
function at(from, courseDeg, km) {
  const [lat, lng] = destination(from.lat, from.lng, courseDeg, km);
  return { lat, lng };
}
