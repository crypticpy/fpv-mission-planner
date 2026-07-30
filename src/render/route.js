// render/route.js — the route panel (Phase 4 item 7): per-leg numbers for the
// polyline the pilot drew on the map, the verdict against the same budget the
// footprint ring is solved from, and how long they can hold station at the end.
//
// All the arithmetic is src/route.js; the waypoints themselves are map-interaction
// state in src/map.js, beside the launch point. This module owns the wording and
// the one piece of policy a render module is the right place for: the route is an
// expert feature, so beginner mode never sees a route at all — not the panel, not
// the line on the map.
import { planRoute } from '../route.js';
import { routeState } from '../map.js';
import { state, beginner, units, missionInputs } from '../state.js';
import { f0, f1, mmss, compass } from './format.js';
import { $ } from './dom.js';

/**
 * The route integrated against this render pass's plan, or null when there is no
 * route to speak of. Called once in app.js and handed to both the map (which
 * draws it) and the card below (which explains it), so the two cannot disagree
 * about whether it fits.
 */
export function routePlan(r) {
  if (beginner()) return null;
  const rt = routeState();
  if (!rt.on || !rt.launch || rt.waypoints.length === 0) return null;
  return planRoute(r, {
    launch: rt.launch,
    waypoints: rt.waypoints,
    windFromDeg: state.env.windFromDeg,
    inputs: missionInputs(),
  });
}

/** "8 mph head · 3 mph cross", in the pilot's units. */
function windCell(leg, u) {
  const spd = (ms) => f0(u.speedFromMs(Math.abs(ms)));
  const along = Math.abs(leg.headMs) < 0.05 ? 'no along-track'
    : `${spd(leg.headMs)} ${u.speedUnit} ${leg.headMs > 0 ? 'head' : 'tail'}`;
  return leg.crossMs > 0.05 ? `${along} · ${spd(leg.crossMs)} cross` : along;
}

function legName(i, total) {
  if (total === 1) return 'Launch → home';
  if (i === 0) return 'Launch → 1';
  if (i === total - 1) return `${i} → home`;
  return `${i} → ${i + 1}`;
}

function cell(row, text, cls) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  row.appendChild(td);
}

function fillTable(route, u) {
  const body = $('route-rows');
  body.replaceChildren();
  const dist = (km) => `${f1(u.distanceFromKm(km))} ${u.distanceUnit}`;
  const spd = (ms) => `${f0(u.speedFromMs(ms))}`;
  for (const [i, leg] of route.legs.entries()) {
    const tr = document.createElement('tr');
    if (!leg.whPerKm) tr.className = 'row-invalid';
    cell(tr, legName(i, route.legs.length));
    cell(tr, dist(leg.distKm), 'num');
    cell(tr, `${f0(leg.courseDeg)}° ${compass(leg.courseDeg)}`, 'num');
    cell(tr, windCell(leg, u));
    cell(tr, leg.vMs == null ? '—' : `${spd(leg.vMs)} ${u.speedUnit}`, 'num');
    cell(tr, leg.vgMs == null ? '—' : `${spd(leg.vgMs)} ${u.speedUnit}`, 'num');
    cell(tr, leg.timeMin == null ? '—' : mmss(leg.timeMin), 'num');
    cell(tr, leg.whLeg == null ? 'no airspeed holds this' : `${f1(leg.whLeg)} Wh`, 'num');
    body.appendChild(tr);
  }
  const tot = document.createElement('tr');
  tot.className = 'route-total';
  cell(tot, 'Whole route');
  cell(tot, dist(route.totalKm), 'num');
  cell(tot, '', 'num');
  cell(tot, '');
  cell(tot, '', 'num');
  cell(tot, '', 'num');
  cell(tot, mmss(route.totalMin), 'num');
  cell(tot, `${f1(route.totalWh)} Wh`, 'num');
  body.appendChild(tot);
}

/**
 * The route card. Hidden outright unless route mode is on — a card explaining a
 * route nobody has drawn is noise on a tab that already carries five panels.
 */
export function renderRouteCard(r, route) {
  const card = $('route-card');
  const rt = beginner() ? { on: false, waypoints: [] } : routeState();
  if (!rt.on) { card.hidden = true; return; }
  card.hidden = false;

  const u = units();
  const empty = $('route-empty');
  const wrap = $('route-table-wrap');
  const verdict = $('route-verdict');
  const loiterEl = $('route-loiter');
  const caveat = $('route-caveat');
  const floorPct = f0(r.energy.landFloorPct);

  if (!route || route.empty) {
    wrap.hidden = true;
    verdict.textContent = '';
    loiterEl.textContent = '';
    caveat.textContent = '';
    empty.hidden = false;
    empty.textContent = 'Route mode is on — click the map to drop waypoints. The first leg runs from the '
      + 'launch pin, and the last one is the straight line home from wherever you stop. Click a waypoint '
      + 'pin to take it back off.';
    return;
  }
  empty.hidden = true;
  wrap.hidden = false;
  fillTable(route, u);

  const dist = (km) => `${f1(u.distanceFromKm(km))} ${u.distanceUnit}`;
  const worst = route.worst;
  const wpName = worst && route.legs.length > 1 ? `waypoint ${worst.index + 1}` : 'the turnaround';
  const bindWord = route.binds === 'getHome'
    ? `get-home reserve at ${wpName}`
    : `${floorPct}% landing floor`;

  if (route.unflyable) {
    verdict.textContent = 'This route cannot be flown as drawn: on at least one of these headings the wind '
      + 'beats every airspeed this loadout holds, so there is no ground speed to make progress on. The dashed '
      + 'rows are the legs that fail — move those waypoints, or wait for calmer air.';
  } else if (route.fits) {
    verdict.textContent =
      `Fits. ${dist(route.totalKm)} of flying in ${mmss(route.totalMin)} for ${f1(route.totalWh)} Wh, with `
      + `${f1(route.marginWh)} Wh of slack before the ${bindWord} binds. `
      + `Out to the far end is ${dist(route.outKm)} in ${mmss(route.outMin)}.`;
  } else {
    verdict.textContent =
      `Doesn’t fit. ${dist(route.totalKm)} of flying costs ${f1(route.totalWh)} Wh, which puts you `
      + `${f1(-route.marginWh)} Wh past the ${bindWord}. Pull a waypoint in, drop one, or fly it on a `
      + 'bigger pack.';
  }

  /* Where the reserve is measured, and why it isn't simply the last waypoint: a
     dogleg's most expensive place to be stranded is wherever the sum of "already
     burned" and "flight home into the wind" peaks, which is a point the pilot
     cannot pick out by eye. Naming it is the whole value of checking every turn. */
  const reserveLine = worst && route.budget.huntLandWh > 0
    ? ` The reserve is measured at ${wpName}, ${dist(worst.distHomeKm)} from launch on the direct line home: `
      + `getting back from there into the planning wind costs ${f1(worst.homeWh)} Wh, plus `
      + `${f1(route.budget.huntLandWh)} Wh to find a spot and land, against ${f1(route.budget.deliveredWh)} Wh `
      + 'the pack delivers.'
    : '';
  verdict.textContent += reserveLine;

  const lo = route.loiter;
  const holdDiffers = Math.abs(lo.holdPw - lo.pHoverW) / Math.max(lo.pHoverW, 1) > 0.02;
  const loiterBind = lo.binds === 'getHome' ? 'the get-home reserve' : `the ${floorPct}% landing floor`;
  if (!route.fits) {
    loiterEl.textContent = 'No loiter budget: the route already overruns, so there is nothing left to hold '
      + 'station on. Shorten it and this line will say how long you can sit there.';
  } else {
    loiterEl.textContent =
      `Loiter at the last waypoint: ${mmss(lo.min)} of holding station on the ${f1(lo.wh)} Wh still spare, `
      + `at ${f0(lo.pHoverW)} W of hover — then ${loiterBind} is gone and it is time to come home. `
      + 'Hover is the expensive way to hold a frame: every speed between a standstill and best endurance '
      + 'costs less, so a slow orbit stretches that clock rather than shortening it. '
      + (holdDiffers
        ? `Holding a fixed point over the ground is the exception — in this wind that means flying at its `
          + `speed just to stay put, which costs ${f0(lo.holdPw)} W and ${lo.holdPw > lo.pHoverW ? 'cuts' : 'extends'} `
          + `the clock to ${mmss(lo.holdMin)}.`
        : 'In air this calm, holding a point and hovering are the same number.');
  }

  caveat.textContent =
    'The return leg is the straight line home from the last waypoint — what a failsafe flies and what a '
    + 'pilot does when the pack gets low — not the route back down its own legs. Energy, the '
    + `${floorPct}% floor and the get-home reserve are the same ones the footprint ring above is solved `
    + 'from, and the pack’s delivered energy is the figure the planner already quotes. Terrain and radio '
    + 'line of sight are analysed along the plan’s own outbound bearing only, in the card below — nothing '
    + 'here knows what the ground or the link does along these legs.';
}
