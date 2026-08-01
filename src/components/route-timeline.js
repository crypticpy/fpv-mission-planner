// components/route-timeline.js — the RouteTimeline of the round-2 design system
// (T-03, M10 wave C): the drawn route as a strip of time, leg by leg in flight
// order, with the reserve's slack riding the tail — then a row of numbers per
// leg underneath. Everything here is read off the one snapshot the route card
// and the map already draw, joined leg-to-segment by the same routeSpans both
// engines use, so clicking a block opens the same inspector a click on the map
// line would.
//
// The bar is a *time* strip on purpose. Energy already has three surfaces — the
// verdict, the route card, the mission profile chart — and the question this
// component answers is the one none of them draw: where do the minutes go, and
// how many are left at the far end before the reserve calls the flight home.
import { routeSpans, segmentIdOrder } from '../presentation/map/layers/route-layer.js';
import { renderSystemState } from './system-state.js';
import { units } from '../state.js';
import { f0, f1, mmss } from '../render/format.js';

/**
 * @typedef {object} TimelineBlock
 * @property {string|null} segmentId  null on a hop nobody authored (direct home)
 * @property {'out'|'home'} phase
 * @property {string} label          'Launch → 1', '2 → home', …
 * @property {string} intent         the authored intent, or 'return' on the way home
 * @property {number|null} minutes   flight + dwell + climb/descent; null = unflyable
 * @property {number|null} wh        the leg's energy, null when no airspeed holds it
 * @property {boolean} reserved      a home leg nobody flies — returnMode 'none'
 *   still costs the flight home because the reserve is sized against it
 * @property {number} dwellMin       the authored hold at the far end, 0 elsewhere
 * @property {number|null} groundMs
 * @property {number} distKm
 * @property {number} headMs
 * @property {number} crossMs
 */

/**
 * @typedef {object} RouteTimelineModel
 * @property {'no-route'|'ready'} state
 * @property {TimelineBlock[]} blocks
 * @property {{label: string, distKm: number, minutes: number|null, wh: number|null}|null} home
 *   the way home as one aggregate row — every home-phase hop folded together
 * @property {{kind: 'loiter', min: number, wh: number}|{kind: 'over', wh: number}|null} tail
 * @property {number|null} totalMin  sum of every block's minutes, dwells included
 * @property {number} totalWh
 * @property {boolean} unflyable
 * @property {'direct'|'retrace'|'none'} returnMode
 */

/** The same naming the route card's table uses, so the two surfaces agree. */
function legName(i, total) {
  if (i === 0) return total === 1 ? 'Launch → home' : 'Launch → 1';
  if (i === total - 1) return `${i} → home`;
  return `${i} → ${i + 1}`;
}

/**
 * Read the timeline off the snapshot. Pure: no DOM, no units — the render
 * converts. Legs join to authored segments through routeSpans, the shared
 * mapping the 2D click targets and the 3D pickable legs are built from, so a
 * block, a map line and a scene leg can never name three different segments.
 * @param {import('../application/analysis/analysis-contracts.js').AnalysisSnapshot} snapshot
 * @returns {RouteTimelineModel}
 */
export function timelineModelFrom(snapshot) {
  const route = snapshot.route;
  if (!route || route.empty || !Array.isArray(route.legs) || route.legs.length === 0) {
    return { state: 'no-route', blocks: [], home: null, tail: null,
      totalMin: null, totalWh: 0, unflyable: false, returnMode: 'direct' };
  }
  const spans = routeSpans({
    pointCount: route.points.length,
    waypointCount: route.waypointCount,
    returnMode: route.returnMode,
    segmentIds: segmentIdOrder(snapshot.segments),
  });

  /** @type {TimelineBlock[]} */
  const blocks = route.legs.map((leg, i) => {
    const span = spans[i] ?? { segmentId: null, phase: 'home' };
    const phase = /** @type {'out'|'home'} */ (span.phase);
    /* Dwell and climb time belong to the authored pass only: a retrace flies the
     * same line back but the aircraft holds station once, at arrival. */
    const seg = phase === 'out' && span.segmentId ? snapshot.segments[span.segmentId] : null;
    const dwellMin = (seg?.holdS ?? 0) / 60;
    const vertMin = seg?.vertical ? (seg.vertical.climbS + seg.vertical.descentS) / 60 : 0;
    return {
      segmentId: span.segmentId,
      phase,
      label: legName(i, route.legs.length),
      intent: phase === 'home' ? 'return' : (seg?.intent ?? 'transit'),
      minutes: leg.timeMin == null ? null : leg.timeMin + dwellMin + vertMin,
      wh: leg.whLeg == null ? null : leg.whLeg + (seg?.holdWh ?? 0) + (seg?.vertical?.wh ?? 0),
      reserved: phase === 'home' && route.returnMode === 'none',
      dwellMin,
      groundMs: leg.vgMs,
      distKm: leg.distKm,
      headMs: leg.headMs,
      crossMs: leg.crossMs,
    };
  });

  const homeBlocks = blocks.filter((b) => b.phase === 'home');
  const homeMinutes = homeBlocks.reduce(
    (a, b) => (a == null || b.minutes == null ? null : a + b.minutes), /** @type {number|null} */ (0));
  const home = homeBlocks.length === 0 ? null : {
    label: route.returnMode === 'retrace' ? 'Home — retrace the route back'
      : route.returnMode === 'none' ? 'Get-home flight (reserved, not planned)'
      : 'Home — direct line',
    distKm: homeBlocks.reduce((a, b) => a + b.distKm, 0),
    minutes: homeMinutes,
    wh: homeBlocks.reduce(
      (a, b) => (a == null || b.wh == null ? null : a + b.wh), /** @type {number|null} */ (0)),
  };

  /* Flown minutes only: a one-way mission's home leg is costed but never flown,
   * so it counts toward the reserve and not toward wheels-up-to-landing. */
  const totalMin = blocks.reduce(
    (a, b) => (a == null ? null
      : b.reserved ? a
      : b.minutes == null ? null : a + b.minutes), /** @type {number|null} */ (0));

  /* The tail is the same slack the route card's loiter line quotes: minutes of
   * holding station at the last waypoint before the reserve binds. A route that
   * doesn't fit has no slack to draw — the overrun is a sentence, not a block. */
  const tail = route.unflyable ? null
    : route.fits && route.loiter ? { kind: /** @type {const} */ ('loiter'), min: route.loiter.min, wh: route.loiter.wh }
    : route.fits === false ? { kind: /** @type {const} */ ('over'), wh: -route.marginWh }
    : null;

  return {
    state: 'ready', blocks, home, tail, totalMin,
    /* The mission's energy, dwells and climbs included, matching the row sums —
     * and, on a one-way flight, not the home leg nobody flies. */
    totalWh: route.missionWh ?? route.totalWh,
    unflyable: route.unflyable, returnMode: route.returnMode,
  };
}

/** "8 mph head · 3 mph cross" in the pilot's units — the route card's phrasing. */
function windText(b, u) {
  const spd = (ms) => f0(u.speedFromMs(Math.abs(ms)));
  const along = Math.abs(b.headMs) < 0.05 ? 'no along-track wind'
    : `${spd(b.headMs)} ${u.speedUnit} ${b.headMs > 0 ? 'head' : 'tail'}`;
  return b.crossMs > 0.05 ? `${along} · ${spd(b.crossMs)} cross` : along;
}

/** The skeleton, built once per host. Order matters: render() reads children
 *  by position, because renderSystemState strips its host's class on clear. */
function ensure(host) {
  if (host.firstChild) return;
  const state = document.createElement('div');
  state.hidden = true;
  const bar = document.createElement('div');
  bar.className = 'rtl-bar';
  const rows = document.createElement('div');
  rows.className = 'rtl-rows';
  const note = document.createElement('p');
  note.className = 'rail-note rtl-note';
  note.setAttribute('role', 'status');
  host.append(state, bar, rows, note);
}

/** @param {TimelineBlock} b @param {ReturnType<typeof units>} u */
function blockTitle(b, u) {
  const bits = [`${b.label} — ${b.intent}`, `${f1(u.distanceFromKm(b.distKm))} ${u.distanceUnit}`];
  bits.push(b.minutes == null ? 'unflyable in this wind' : mmss(b.minutes));
  if (b.wh != null) bits.push(`${f1(b.wh)} Wh`);
  return bits.join(' · ');
}

/**
 * One cell of a leg row.
 * @param {HTMLElement} row @param {string} text @param {string} [cls]
 */
function cell(row, text, cls = 'rtl-cell') {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  row.appendChild(el);
}

/**
 * Draw the timeline. Pure render over the model: build, retext, and wire the
 * selection callback — the selection itself lives with the map (the one owner
 * both surfaces read), so this component holds no state of its own.
 * @param {HTMLElement} host
 * @param {RouteTimelineModel} m
 * @param {{selectedSegmentId?: string|null, onSelect?: (id: string) => void}} [opts]
 */
export function renderRouteTimeline(host, m, opts = {}) {
  ensure(host);
  const [stateHost, bar, rows, note] =
    /** @type {HTMLElement[]} */ (Array.from(host.children));

  if (m.state !== 'ready') {
    renderSystemState(stateHost, {
      kind: 'empty',
      title: 'NO ROUTE YET',
      body: 'Draw waypoints on the 2D map and every leg lands here — minutes, energy and the reserve’s slack.',
    });
    bar.hidden = true; rows.hidden = true; note.hidden = true;
    bar.replaceChildren(); rows.replaceChildren(); note.textContent = '';
    return;
  }
  renderSystemState(stateHost, null);
  bar.hidden = false; rows.hidden = false; note.hidden = false;

  const u = units();
  const selected = opts.selectedSegmentId ?? null;
  const dist = (km) => `${f1(u.distanceFromKm(km))} ${u.distanceUnit}`;

  /* The strip. Width is minutes; a leg the wind makes unflyable has no minutes,
   * so it rides at a fixed width and wears the hatch instead of a length. */
  bar.replaceChildren();
  bar.classList.toggle('rtl-unflyable', m.unflyable);
  for (const b of m.blocks) {
    const el = document.createElement(b.segmentId ? 'button' : 'div');
    el.className = 'rtl-block';
    el.dataset.intent = b.intent;
    el.dataset.phase = b.phase;
    if (b.reserved) el.dataset.reserved = 'true';
    if (b.minutes == null) el.dataset.unflyable = 'true';
    el.style.flexGrow = b.minutes == null ? '0' : String(Math.max(b.minutes, 0.05));
    el.title = blockTitle(b, u);
    if (b.segmentId) {
      el.type = 'button';
      el.setAttribute('aria-label', blockTitle(b, u));
      el.setAttribute('aria-pressed', String(b.segmentId === selected));
      el.addEventListener('click', () => opts.onSelect?.(/** @type {string} */ (b.segmentId)));
    }
    bar.appendChild(el);
  }
  if (m.tail?.kind === 'loiter' && m.tail.min > 0) {
    const el = document.createElement('div');
    el.className = 'rtl-block rtl-tail';
    el.style.flexGrow = String(m.tail.min);
    el.title = `Loiter budget — ${mmss(m.tail.min)} of holding station on the ${f1(m.tail.wh)} Wh still spare`;
    bar.appendChild(el);
  }

  /* One row per authored leg, then the whole way home as one line — the map's
   * route card still carries the full per-hop table, course and all. */
  rows.replaceChildren();
  for (const b of m.blocks) {
    if (b.phase !== 'out') continue;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'rtl-row';
    row.setAttribute('aria-pressed', String(!!b.segmentId && b.segmentId === selected));
    const chip = document.createElement('span');
    chip.className = 'rtl-chip';
    chip.dataset.intent = b.intent;
    row.appendChild(chip);
    cell(row, b.label, 'rtl-cell rtl-name');
    cell(row, b.intent, 'rtl-cell rtl-intent');
    cell(row, dist(b.distKm));
    cell(row, b.minutes == null ? '—' : mmss(b.minutes)
      + (b.dwellMin > 0 ? ` (${mmss(b.dwellMin)} dwell)` : ''));
    cell(row, b.wh == null ? 'no airspeed holds this' : `${f1(b.wh)} Wh`);
    cell(row, b.groundMs == null ? '—' : `${f0(u.speedFromMs(b.groundMs))} ${u.speedUnit}`,
      'rtl-cell rtl-speed');
    cell(row, windText(b, u), 'rtl-cell rtl-wind');
    if (b.segmentId) {
      const id = b.segmentId;
      row.addEventListener('click', () => opts.onSelect?.(id));
    } else {
      row.disabled = true;
    }
    rows.appendChild(row);
  }
  if (m.home) {
    const row = document.createElement('div');
    row.className = 'rtl-row rtl-home';
    const chip = document.createElement('span');
    chip.className = 'rtl-chip';
    chip.dataset.intent = 'return';
    row.appendChild(chip);
    cell(row, m.home.label, 'rtl-cell rtl-name');
    cell(row, 'return', 'rtl-cell rtl-intent');
    cell(row, dist(m.home.distKm));
    cell(row, m.home.minutes == null ? '—' : mmss(m.home.minutes));
    cell(row, m.home.wh == null ? '—' : `${f1(m.home.wh)} Wh`);
    cell(row, '', 'rtl-cell rtl-speed');
    cell(row, '', 'rtl-cell rtl-wind');
    rows.appendChild(row);
  }

  if (m.unflyable) {
    note.textContent = 'This route cannot be flown as drawn — the hatched legs have no airspeed that makes '
      + 'progress against this wind. The route card on the map names them leg by leg.';
  } else if (m.tail?.kind === 'over') {
    note.textContent = `Doesn’t fit: the whole route costs ${f1(m.totalWh)} Wh, `
      + `${f1(m.tail.wh)} Wh past the reserve. The dashed tail is gone — pull a waypoint in, or fly a bigger pack.`;
  } else if (m.totalMin != null) {
    const loiter = m.tail?.kind === 'loiter' && m.tail.min > 0
      ? ` The dashed tail is the slack: ${mmss(m.tail.min)} of loiter at the last waypoint before the reserve binds.`
      : '';
    const oneWay = m.returnMode === 'none'
      ? ' One-way: the outlined home block is the get-home flight the reserve is sized against, not a leg you fly.'
      : '';
    note.textContent = `Wheels-up to landing ≈ ${mmss(m.totalMin)}, dwells and climbs included, `
      + `for ${f1(m.totalWh)} Wh.${loiter}${oneWay}`;
  } else {
    note.textContent = '';
  }
}
