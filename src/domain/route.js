// route.js — waypoint/dogleg routes and loiter-at-range (Phase 4 item 7).
//
// The footprint answers "how far out and straight back". Pilots don't only fly
// that: they run a river, cut across to a ridge, and then hold station filming a
// cliff. Both of those are the same arithmetic read the other way round — instead
// of solving for the radius that exhausts the budget, take the polyline the pilot
// drew, integrate Wh along it, and report what is left.
//
// Nothing here re-derives the physics. `legSolverFrom()` rebuilds the very leg
// solver `planMission` ran on, so a route that happens to trace the planned
// out-and-back reproduces that plan's own numbers by identity rather than by a
// second implementation agreeing with the first. Pure and node-testable: no DOM,
// no Leaflet, no state.
//
// The three modeling choices worth arguing about, made out loud:
//
//   the return is direct. From the last waypoint the aircraft flies straight
//     home, not back down the polyline. That is what a failsafe RTH does, what a
//     pilot does when the pack gets low, and the assumption the reserve below is
//     already built on. Retracing the route would be a longer, more expensive
//     return that nobody actually flies, and planning to it would shorten every
//     route for a flight that isn't the one at risk.
//
//   the reserve covers the worst point, not the last one. A dogleg's farthest
//     point from home — in energy, not in metres — can be an intermediate
//     waypoint, and the whole get-home constraint is that the pack can still make
//     it back from wherever the route has taken you. So every waypoint is checked:
//     energy spent reaching it, plus the adverse-wind return from it, plus the
//     hunt-and-land allowance, against the delivered energy. Same shape as
//     planMission's `rHome`, evaluated at each turn instead of solved for one.
//
//   the energy budget is the plan's. `deliveredWh` comes off the discharge
//     integration planMission already ran, at the planned mission's average
//     power. A dogleg's own average is a little different, and re-integrating for
//     it would move the figure by well under a percent while making this panel
//     disagree with the hero card about how much is in the pack. One pack, one
//     number.

import { distanceKm, bearingTo } from './geo.js';
import { legVecsFromCourse, legSolverFrom, powerAtSpeed } from './physics.js';

/** An empty answer, so callers never have to null-check the shape. */
function emptyRoute(points) {
  return {
    empty: true, points, legs: [], holds: [],
    totalKm: 0, totalMin: 0, totalWh: 0, outKm: 0, outMin: 0, outWh: 0,
    fits: null, unflyable: false, binds: null, marginWh: 0, worst: null,
    budget: null, loiter: null,
  };
}

/**
 * Integrate a route against a solved mission plan.
 *
 * `plan` is a `planMission()` result — the same one the dashboard and the
 * footprint ring are drawn from, so the route is measured against the loadout,
 * the air, the cruise policy and the pack-care floor already on screen.
 *
 * `waypoints` are the points the pilot dropped, launch NOT included: the route is
 * launch → wp1 → … → wpN → launch. `windFromDeg` is the meteorological bearing
 * the wind blows from, the same field `planMission` reads. `inputs` is the input
 * bag that produced `plan` — only the cruise policy is read from it, to rebuild
 * the plan's own leg solver.
 *
 * Returns per-leg distance/course/wind/speeds/energy, the route totals, the
 * verdict with the constraint that binds it, and the loiter budget at the last
 * waypoint.
 */
export function planRoute(plan, { launch, waypoints, windFromDeg, inputs } = {}) {
  const wps = (Array.isArray(waypoints) ? waypoints : []).filter(
    w => w && Number.isFinite(w.lat) && Number.isFinite(w.lng));
  const points = launch ? [launch, ...wps] : wps;
  if (!launch || wps.length === 0 || !plan || !plan.energy) {
    return emptyRoute(points);
  }

  const windMs = plan.wind.planningMs;
  const fromDeg = Number.isFinite(windFromDeg) ? windFromDeg : 0;
  const solveLeg = legSolverFrom(plan, inputs || {});
  // The out-leg half of the pair: the wind as this course actually meets it.
  const vecFor = (courseDeg) => legVecsFromCourse(courseDeg, fromDeg, windMs)[0];

  /* The adverse return, exactly as planMission defines it: the same wind with its
   * along-track sign made hostile, not a wind from a new direction. `getHomeWindMs`
   * is null when the caller planned with no reserve policy at all, and then there
   * is no get-home constraint to apply — the route is an unreserved measurement,
   * the same as the mission it was planned beside. */
  const ghWindMs = plan.energy.getHomeWindMs;
  const homeScale = ghWindMs == null ? 0 : windMs > 0 ? ghWindMs / windMs : 0;
  const adverseFor = (courseDeg) => {
    if (ghWindMs == null) return null;
    if (!(windMs > 0)) return { head: ghWindMs, cross: 0 }; // dead calm, overridden
    const v = vecFor(courseDeg);
    return { head: Math.abs(v.head) * homeScale, cross: v.cross * homeScale };
  };

  let unflyable = false;
  const leg = (from, to, phase) => {
    const distKm = distanceKm(from, to);
    const courseDeg = bearingTo(from, to);
    const vec = vecFor(courseDeg);
    const s = solveLeg(vec);
    if (!s) unflyable = true;
    return {
      phase, from, to, distKm, courseDeg,
      headMs: vec.head, crossMs: vec.cross,
      vMs: s ? s.v : null,
      vgMs: s ? s.vg : null,
      whPerKm: s ? s.whPerKm : null,
      whLeg: s ? distKm * s.whPerKm : null,
      timeMin: s ? distKm / (s.vg * 3.6) * 60 : null,
    };
  };

  const legs = [];
  for (let i = 0; i < wps.length; i++) legs.push(leg(points[i], points[i + 1], 'out'));
  legs.push(leg(points[points.length - 1], launch, 'home'));

  const sum = (list, f) => list.reduce((a, l) => a + (f(l) ?? 0), 0);
  const outLegs = legs.filter(l => l.phase === 'out');
  const outKm = sum(outLegs, l => l.distKm);
  const outWh = sum(outLegs, l => l.whLeg);
  const outMin = sum(outLegs, l => l.timeMin);
  const totalKm = sum(legs, l => l.distKm);
  const totalWh = sum(legs, l => l.whLeg);
  const totalMin = sum(legs, l => l.timeMin);

  /* The reserve, evaluated at every waypoint. `needWh` is what this turn commits
   * the pack to: everything burned getting here, plus the adverse-wind flight
   * straight home from here, plus the hunt-and-land allowance. The route is
   * reserve-safe when the worst of those still fits inside the delivered energy —
   * which for a single waypoint is planMission's own `rHome` constraint, written
   * out rather than solved. */
  const deliveredWh = plan.energy.deliveredWh;
  const huntLandWh = plan.energy.huntLandWh || 0;
  const floorWh = deliveredWh * (1 - (plan.energy.landFloorPct || 0) / 100);
  const holds = [];
  let spentWh = 0;
  let worst = null;
  for (let k = 0; k < wps.length; k++) {
    spentWh += legs[k].whLeg ?? 0;
    const courseHome = bearingTo(wps[k], launch);
    const vec = adverseFor(courseHome);
    const s = vec ? solveLeg(vec) : null;
    if (vec && !s) unflyable = true;
    const distHomeKm = distanceKm(wps[k], launch);
    const homeWh = s ? distHomeKm * s.whPerKm : 0;
    const hold = {
      index: k, spentWh, distHomeKm, courseHome,
      homeWhPerKm: s ? s.whPerKm : null,
      homeWh,
      // What the pack is committed to at this turn, hunt-and-land included.
      needWh: spentWh + homeWh + huntLandWh,
      solved: !vec || !!s,
    };
    holds.push(hold);
    if (!worst || hold.needWh > worst.needWh) worst = hold;
  }

  const floorMarginWh = floorWh - totalWh;
  const homeMarginWh = ghWindMs == null || !worst ? Infinity : deliveredWh - worst.needWh;
  const marginWh = Math.min(floorMarginWh, homeMarginWh);
  const binds = homeMarginWh < floorMarginWh ? 'getHome' : 'floor';
  const fits = !unflyable && marginWh >= 0;

  /* Loiter at the last waypoint: hold station there until either constraint runs
   * out. Two of them, and the tighter one is the answer — the pack-care floor
   * counts the planned return home, the get-home reserve counts the adverse one.
   *
   * Hover is the power quoted because it is the one a camera drone holding a
   * frame actually spends, and it is the conservative read in calm air: every
   * speed between a standstill and the best-endurance point costs less than
   * hover, so a slow orbit stretches these minutes rather than shortening them.
   * The wind is the exception and it is reported beside it — station-keeping over
   * a fixed point in moving air means flying at the wind's own speed, and
   * `holdPw` is what that costs. In calm air the two are the same number. */
  const last = holds[holds.length - 1];
  const loiterFloorWh = floorMarginWh;
  const loiterHomeWh = ghWindMs == null ? Infinity : deliveredWh - last.needWh;
  const loiterWh = Math.max(0, Math.min(loiterFloorWh, loiterHomeWh));
  const pHoverW = plan.hover.pW;
  const holdPw = powerAtSpeed(plan.cfg, windMs);
  const loiter = {
    wh: loiterWh,
    pHoverW,
    holdPw,
    min: pHoverW > 0 ? loiterWh / pHoverW * 60 : 0,
    holdMin: holdPw > 0 ? loiterWh / holdPw * 60 : 0,
    binds: loiterHomeWh < loiterFloorWh ? 'getHome' : 'floor',
  };

  return {
    empty: false, points, legs, holds,
    totalKm, totalMin, totalWh, outKm, outMin, outWh,
    fits, unflyable, binds, marginWh, worst,
    budget: { deliveredWh, floorWh, huntLandWh, landFloorPct: plan.energy.landFloorPct },
    loiter,
  };
}
