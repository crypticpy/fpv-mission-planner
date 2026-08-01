// components/elevation-profile.js — the ElevationProfile of the round-2 design
// system (P-04, M10 wave C): the ground under the drawn route as a silhouette,
// the planned MSL line over it, a 30 m clearance band between them, and a badge
// on the closest approach. Everything is read off the corridor the analysis
// already demanded and the TerrainField that answered it — this component asks
// the ground nothing new, which is why it can say "pending" and "missing"
// honestly: those are the field's own words for itself.
//
// The chart is bespoke (per-segment click spans, a band that follows the
// ground) but built on charts.js's exported scaffolding, so its margins, ticks
// and tooltip are the same ones every other chart in the app wears.
import { svgEl, M, frame, drawAxes, niceTicks, showTooltip, hideTooltip, bindHit } from '../charts.js';
import { usableField } from '../application/analysis/route-checks.js';
import { segmentIdOrder } from '../presentation/map/layers/route-layer.js';
import { renderSystemState } from './system-state.js';
import { CLEARANCE_WARN_M } from '../terrain.js';
import { units } from '../state.js';
import { f0, f1 } from '../render/format.js';

/**
 * @typedef {object} ProfileSpan  one authored segment's stretch of the x axis
 * @property {string} segmentId
 * @property {number} x0  km from launch
 * @property {number} x1
 */

/**
 * @typedef {object} ElevationProfileModel
 * @property {'no-route'|'pending'|'unavailable'|'ready'} state
 * @property {number} totalKm
 * @property {{x: number, y: number|null}[]} ground  every centreline station in
 *   corridor order; y null where no elevation answered — a hole, never a guess
 * @property {{x: number, y: number|null, name: string|null}[]} planned  launch
 *   first, then one point per authored waypoint; y null where the segment has
 *   no MSL altitude to plot
 * @property {ProfileSpan[]} spans
 * @property {{minM: number, x: number, groundMslM: number,
 *             tone: 'good'|'serious'|'critical'}|null} worst
 * @property {{missing: number, total: number}|null} holes
 * @property {string|null} attribution
 */

const EMPTY = { totalKm: 0, ground: [], planned: [], spans: [], worst: null, holes: null, attribution: null };

/**
 * Read the profile off the snapshot and the terrain field. Pure and metric —
 * the render converts to the pilot's units. The field is trusted by the same
 * geometric test the clearance pass uses (usableField): a field from the
 * previous route shape would draw the old ground under the new line, which is
 * worse than saying "still reading" — but revision equality is the wrong gate,
 * because the document revision moves for a weather refresh or a rename while
 * the ground under the unchanged line does not.
 * @param {import('../application/analysis/analysis-contracts.js').AnalysisSnapshot} snapshot
 * @param {import('../application/terrain/terrain-contracts.js').TerrainField|null} field
 * @returns {ElevationProfileModel}
 */
export function profileModelFrom(snapshot, field) {
  const order = segmentIdOrder(snapshot.segments);
  const corridor = snapshot.corridor;
  if (order.length === 0 || !corridor || corridor.samples.length === 0) {
    return { state: 'no-route', ...EMPTY };
  }
  if (!usableField(field, corridor)) {
    return { state: 'pending', ...EMPTY };
  }
  if (field.provenance.coverage === 'empty') {
    return { state: 'unavailable', ...EMPTY };
  }

  const stations = field.samples.filter((s) => s.track === 'centre');
  const ground = stations.map((s) => ({ x: s.distanceKm, y: s.groundMslM }));
  const totalKm = stations.length ? stations[stations.length - 1].distanceKm : 0;

  /* One span per authored segment: the stretch of corridor its samples cover.
   * Spans butt against each other, so the previous span's end (launch at 0)
   * starts the next — a click anywhere on the plot lands in exactly one. */
  const spans = [];
  let cursor = 0;
  for (const id of order) {
    const own = stations.filter((s) => s.segmentId === id);
    const x1 = own.length ? own[own.length - 1].distanceKm : cursor;
    spans.push({ segmentId: id, x0: cursor, x1 });
    cursor = x1;
  }

  /* The planned line: launch at ground level, then each waypoint at its
   * segment's MSL altitude. A segment with no altitude leaves a hole in the
   * line — the aircraft flies *something* there, but nothing was planned, and
   * an invented y would defeat the point of the chart. */
  const planned = [
    { x: 0, y: field.launchGroundMslM, name: 'launch' },
    ...spans.map((sp, i) => ({
      x: sp.x1,
      y: snapshot.segments[sp.segmentId]?.altitudeMslM ?? null,
      name: `waypoint ${i + 1}`,
    })),
  ];

  /* The closest the plan comes to the ground, taken from the per-segment
   * clearance checks the analysis already ran — not re-derived here, so the
   * badge and the advisory stack can never disagree about the number. */
  let worst = null;
  for (const id of order) {
    const c = snapshot.segments[id]?.clearance;
    if (!c || c.minM == null || !c.atSampleId) continue;
    if (worst && worst.minM <= c.minM) continue;
    const at = field.byId[c.atSampleId];
    if (!at || at.groundMslM == null) continue;
    worst = {
      minM: c.minM, x: at.distanceKm, groundMslM: at.groundMslM,
      tone: c.minM <= 0 ? 'critical' : c.minM < CLEARANCE_WARN_M ? 'serious' : 'good',
    };
  }

  const missing = ground.filter((g) => g.y == null).length;
  return {
    state: 'ready', totalKm, ground, planned, spans, worst,
    holes: missing > 0 ? { missing, total: ground.length } : null,
    attribution: field.provenance.attribution,
  };
}

/** Split the stations into contiguous drawable runs at the holes. */
function runsOf(ground) {
  const runs = [];
  let run = [];
  for (const g of ground) {
    if (g.y == null) { if (run.length) runs.push(run); run = []; continue; }
    run.push(g);
  }
  if (run.length) runs.push(run);
  return runs;
}

/** Ground at x — the nearest answered station, or null when x sits in a hole. */
function groundAt(ground, x, spacingKm) {
  let best = null;
  for (const g of ground) {
    if (best == null || Math.abs(g.x - x) < Math.abs(best.x - x)) best = g;
  }
  if (!best || best.y == null || Math.abs(best.x - x) > spacingKm * 1.5) return null;
  return best.y;
}

/** Planned MSL at x — linear between waypoints, null across an unplanned gap. */
function plannedAt(planned, x) {
  for (let i = 1; i < planned.length; i += 1) {
    const a = planned[i - 1], b = planned[i];
    if (x < a.x || x > b.x) continue;
    if (a.y == null || b.y == null) return null;
    const t = b.x === a.x ? 1 : (x - a.x) / (b.x - a.x);
    return a.y + (b.y - a.y) * t;
  }
  return null;
}

/** The skeleton. Children are read by position: renderSystemState strips class. */
function ensure(host) {
  if (host.firstChild) return;
  const state = document.createElement('div');
  state.hidden = true;
  const head = document.createElement('div');
  head.className = 'eprofile-head';
  const badge = document.createElement('span');
  badge.className = 'eprofile-badge';
  head.appendChild(badge);
  const chart = document.createElement('div');
  chart.className = 'chart eprofile-chart';
  const note = document.createElement('p');
  note.className = 'rail-note eprofile-note';
  note.setAttribute('role', 'status');
  const attrib = document.createElement('p');
  attrib.className = 'eprofile-attrib';
  host.append(state, head, chart, note, attrib);
}

const STATE_SPECS = {
  'no-route': {
    kind: 'empty', title: 'NO ROUTE YET',
    body: 'Draw waypoints on the 2D map to see the ground under the route. The ring below shows terrain around the launch point in the meantime.',
  },
  pending: {
    kind: 'loading', title: 'READING THE GROUND',
    body: 'The elevation service is answering for this route. The profile draws itself when it lands.',
  },
  unavailable: {
    kind: 'recoverable-error', title: 'NO GROUND DATA',
    body: 'No elevation answered for this corridor — missing data, not clear ground. Check the connection and redraw a waypoint to ask again.',
  },
};

/**
 * Draw the profile. Pure render over the model; selection lives with the map,
 * arrives as an option, and leaves through onSelect.
 * @param {HTMLElement} host
 * @param {ElevationProfileModel} m
 * @param {{selectedSegmentId?: string|null, onSelect?: (id: string) => void}} [opts]
 */
export function renderElevationProfile(host, m, opts = {}) {
  ensure(host);
  const [stateHost, head, chart, note, attrib] =
    /** @type {HTMLElement[]} */ (Array.from(host.children));

  const ready = m.state === 'ready';
  renderSystemState(stateHost, ready ? null : STATE_SPECS[m.state]);
  head.hidden = !ready; chart.hidden = !ready; note.hidden = !ready; attrib.hidden = !ready;
  if (!ready) { chart.replaceChildren(); note.textContent = ''; attrib.textContent = ''; return; }

  const u = units();
  const alt = (mv) => `${f0(u.altFromM(mv))} ${u.altUnit}`;
  const dx = (km) => u.distanceFromKm(km);
  const spacingKm = m.ground.length > 1 ? m.totalKm / (m.ground.length - 1) : m.totalKm || 1;

  /* Badge: the closest approach, in the words the advisory stack uses. */
  const badge = head.firstElementChild;
  if (m.worst) {
    badge.hidden = false;
    badge.dataset.tone = m.worst.tone;
    badge.textContent = m.worst.tone === 'critical'
      ? `Below the ground — ${alt(m.worst.minM)} at closest approach`
      : `Least clearance ${alt(m.worst.minM)}`;
  } else {
    badge.hidden = true;
    badge.textContent = '';
  }

  /* ---------- the chart ---------- */
  const { svg, iw, ih } = frame(chart, 260);
  const yVals = [
    ...m.ground.filter((g) => g.y != null)
      .flatMap((g) => [u.altFromM(g.y), u.altFromM(g.y + CLEARANCE_WARN_M)]),
    ...m.planned.filter((p) => p.y != null).map((p) => u.altFromM(p.y)),
  ];
  if (!yVals.length) { chart.replaceChildren(); return; }
  /* The bottom tick IS the plot floor, like every other chart here — the
   * silhouette's fill drops to the drawn baseline, never past it into the
   * tick labels. niceTicks starts at-or-above min, so extend the ladder in
   * both directions until it brackets the data. */
  const yMinV = Math.min(...yVals);
  const yTicks = niceTicks(yMinV, Math.max(...yVals) * 1.02);
  if (yTicks.length > 1) {
    const step = yTicks[1] - yTicks[0];
    while (yTicks[yTicks.length - 1] < Math.max(...yVals)) {
      yTicks.push(+(yTicks[yTicks.length - 1] + step).toFixed(10));
    }
    while (yTicks[0] > yMinV) {
      yTicks.unshift(+(yTicks[0] - step).toFixed(10));
    }
  }
  const yLo = yTicks[0];
  const yTop = yTicks[yTicks.length - 1];
  const xMax = dx(m.totalKm) || 1;
  const xTicks = niceTicks(0, xMax, 6).filter((t) => t <= xMax);
  const xs = (km) => M.left + dx(km) / xMax * iw;
  const ys = (mv) => M.top + ih - (u.altFromM(mv) - yLo) / (yTop - yLo || 1) * ih;
  drawAxes(svg, xTicks, yTicks, (t) => M.left + t / xMax * iw, (t) => M.top + ih - (t - yLo) / (yTop - yLo || 1) * ih, {
    iw, xFmt: (t) => f1(t), yFmt: (t) => f0(t),
    xLabel: `distance from launch (${u.distanceUnit})`, yLabel: `MSL ${u.altUnit}`,
  });

  /* Selected segment's stretch, under everything. */
  const selected = opts.selectedSegmentId ?? null;
  const sel = selected ? m.spans.find((sp) => sp.segmentId === selected) : null;
  if (sel && sel.x1 > sel.x0) {
    svg.appendChild(svgEl('rect', {
      x: xs(sel.x0), y: M.top, width: xs(sel.x1) - xs(sel.x0), height: ih,
      fill: 'var(--accent)', opacity: 0.08,
    }));
  }

  const runs = runsOf(m.ground);
  /* The clearance band: the 30 m of air the warning threshold owns, drawn on
   * the ground so a planned line entering it is visibly in the zone. */
  for (const run of runs) {
    if (run.length < 2) continue;
    const top = run.map((g, i) => `${i ? 'L' : 'M'}${xs(g.x).toFixed(1)},${ys(g.y + CLEARANCE_WARN_M).toFixed(1)}`).join('');
    const back = [...run].reverse().map((g) => `L${xs(g.x).toFixed(1)},${ys(g.y).toFixed(1)}`).join('');
    svg.appendChild(svgEl('path', { d: `${top}${back}Z`, fill: 'var(--status-serious)', opacity: 0.08, stroke: 'none' }));
  }
  /* The ground itself: silhouette fill plus a 2px line, one per contiguous run —
   * a hole in the data is a hole in the drawing. */
  const floorY = M.top + ih;
  for (const run of runs) {
    const line = run.map((g, i) => `${i ? 'L' : 'M'}${xs(g.x).toFixed(1)},${ys(g.y).toFixed(1)}`).join('');
    if (run.length > 1) {
      svg.appendChild(svgEl('path', {
        d: `${line}L${xs(run[run.length - 1].x).toFixed(1)},${floorY}L${xs(run[0].x).toFixed(1)},${floorY}Z`,
        fill: 'var(--series-2)', opacity: 0.18, stroke: 'none',
      }));
    }
    svg.appendChild(svgEl('path', { d: line, fill: 'none', stroke: 'var(--series-2)', 'stroke-width': 2,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }

  /* The planned MSL line, waypoint to waypoint, with a dot at each. */
  let pen = null;
  let plannedPath = '';
  for (const p of m.planned) {
    if (p.y == null) { pen = null; continue; }
    plannedPath += `${pen ? 'L' : 'M'}${xs(p.x).toFixed(1)},${ys(p.y).toFixed(1)}`;
    pen = p;
  }
  if (plannedPath.includes('L')) {
    svg.appendChild(svgEl('path', { d: plannedPath, fill: 'none', stroke: 'var(--series-4)', 'stroke-width': 2,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }
  for (const p of m.planned) {
    if (p.y == null) continue;
    svg.appendChild(svgEl('circle', { cx: xs(p.x), cy: ys(p.y), r: 3.5,
      fill: 'var(--series-4)', stroke: 'var(--surface-1)', 'stroke-width': 2 }));
  }

  /* The closest-approach marker, on the ground it nearly meets. */
  if (m.worst) {
    const wy = m.worst.groundMslM + Math.max(m.worst.minM, 0);
    svg.appendChild(svgEl('circle', { cx: xs(m.worst.x), cy: ys(wy), r: 4.5,
      fill: `var(--status-${m.worst.tone})`, stroke: 'var(--surface-1)', 'stroke-width': 2 }));
    const t = svgEl('text', { x: xs(m.worst.x), y: ys(wy) - 10, 'text-anchor': 'middle', class: 'viz-marker-label' });
    t.textContent = 'closest';
    svg.appendChild(t);
  }

  /* Crosshair + tooltip + click-to-select, one hit surface for the whole plot. */
  const cross = svgEl('line', { y1: M.top, y2: M.top + ih, stroke: 'var(--baseline)',
    'stroke-width': 1, visibility: 'hidden' });
  svg.appendChild(cross);
  const hit = svgEl('rect', { x: M.left, y: M.top, width: iw, height: ih, fill: 'transparent' });
  svg.appendChild(hit);
  const kmAt = (ev) => {
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / svg.viewBox.baseVal.width;
    const px = (ev.clientX - rect.left) / scale;
    return Math.min(Math.max((px - M.left) / iw, 0), 1) * m.totalKm;
  };
  bindHit(hit, (ev) => {
    const km = kmAt(ev);
    const g = groundAt(m.ground, km, spacingKm);
    const p = plannedAt(m.planned, km);
    const sx = xs(km);
    cross.setAttribute('x1', sx); cross.setAttribute('x2', sx);
    cross.setAttribute('visibility', 'visible');
    showTooltip(ev.clientX, ev.clientY, [
      { color: 'var(--series-4)', value: p == null ? '—' : alt(p), label: 'planned MSL' },
      { color: 'var(--series-2)', value: g == null ? 'no data' : alt(g), label: 'ground' },
      { color: 'transparent', value: g == null || p == null ? '—' : alt(p - g), label: 'clearance' },
    ], `Out: ${f1(dx(km))} ${u.distanceUnit}`);
  }, () => {
    cross.setAttribute('visibility', 'hidden');
    hideTooltip();
  });
  hit.addEventListener('click', (ev) => {
    const km = kmAt(ev);
    const span = m.spans.find((sp) => km >= sp.x0 && km <= sp.x1) ?? m.spans[m.spans.length - 1];
    if (span) opts.onSelect?.(span.segmentId);
  });

  note.textContent = m.holes
    ? `${m.holes.missing} of ${m.holes.total} stations have no elevation — the gaps are unchecked ground, not flat ground.`
    : '';
  note.hidden = !m.holes;
  attrib.textContent = m.attribution ? `Ground: ${m.attribution}` : '';
  attrib.hidden = !m.attribution;
}
