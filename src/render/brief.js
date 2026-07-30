// render/brief.js — the mission brief on screen and on paper (Phase 4 item 8).
//
// src/brief.js holds every number and every sentence; this module holds elements,
// one inline SVG, and the open/close/print plumbing. The overlay and the print
// view are the same DOM: what a pilot reads on a phone in the sun is exactly what
// comes out of window.print(), which is the only way the two can't drift apart.
//
// Two design calls worth stating:
//
//   the footprint is drawn, not screenshotted. Rasterising the Leaflet view would
//     hand the pilot a map they cannot use: the tiles are online-only (the service
//     worker deliberately never caches them, per the providers' terms), they carry
//     attribution that has to travel with any copy, and satellite imagery prints
//     as a grey smear on any printer and washes out entirely in direct sun. A
//     north-up line drawing off the same sweep the ring was drawn from — bearing
//     ticks, a labelled scale ring, the wind arrow, the planned leg and the route
//     — carries strictly more of the information a spotter needs and survives
//     being printed in black and white on a folded sheet in a pocket.
//
//   the brief forces its own palette. Every other surface in this app follows the
//     theme; this one is black on white in all of them, because it is the artifact
//     you read at arm's length in the sun and the artifact that goes through a
//     printer. A themed brief would be a Night Ops brief printed as a black
//     rectangle.

import { buildBrief } from '../brief.js';
import { footprintState } from '../map.js';
import { bearingTo, distanceKm } from '../geo.js';
import {
  state, beginner, units, drone, battery, loadoutBattery, scenario, payload,
} from '../state.js';
import { verdict, zeroRadiusNote, legTimes } from './dashboard.js';
import { terrainStatsFor } from './terrain.js';
import { plannedLaunchTime } from './forecast.js';
import { f0 } from './format.js';
import { $ } from './dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

let deps = null; // injected by app.js: { latest }
let open = false;
let returnFocus = null;

export function setupBrief(d) { deps = d; }

/* ---------- the footprint plate ---------- */

/** A round scale-ring step at or above `raw`, in whatever unit is on screen. */
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (raw <= m * mag) return m * mag;
  }
  return 10 * mag;
}

const el = (name, attrs = {}, text = null) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = text;
  return node;
};

/**
 * The north-up footprint plate. `fp` is map.js's own last sweep, so the outline
 * here and the ring on the map are the same numbers rather than two agreeing
 * computations. Returns null when nothing closes — a plate with no shape on it
 * is worse than the sentence that replaces it.
 */
function footprintSvg(fp, route, u) {
  if (!fp || !fp.radii.some(r => r > 0)) return null;
  const SIZE = 340, C = SIZE / 2, R = 132;
  const maxKm = Math.max(...fp.radii);
  const maxDisp = u.distanceFromKm(maxKm);
  const step = niceStep(maxDisp / 2);
  const rings = Math.max(1, Math.ceil(maxDisp / step - 1e-9));
  const fullDisp = rings * step;
  const px = (km) => u.distanceFromKm(km) / fullDisp * R;
  // Compass bearing to screen space: 0° is up, and degrees run clockwise.
  const at = (bearingDeg, rPx) => [
    C + rPx * Math.sin(bearingDeg * Math.PI / 180),
    C - rPx * Math.cos(bearingDeg * Math.PI / 180),
  ];

  const svg = el('svg', {
    viewBox: `0 0 ${SIZE} ${SIZE}`, class: 'brief-plate',
    role: 'img',
    'aria-label': `North-up mission footprint, ${f0(fullDisp)} ${u.distanceUnit} to the outer ring`,
  });

  // Scale rings, outermost labelled — the one number that makes the plate a map.
  for (let i = 1; i <= rings; i++) {
    svg.appendChild(el('circle', {
      cx: C, cy: C, r: R * i / rings, class: 'plate-ring',
    }));
  }
  // Bearing ticks every 30°, longer on the cardinals.
  for (let b = 0; b < 360; b += 30) {
    const cardinal = b % 90 === 0;
    const [x1, y1] = at(b, R);
    const [x2, y2] = at(b, R - (cardinal ? 12 : 6));
    svg.appendChild(el('line', { x1, y1, x2, y2, class: 'plate-tick' }));
  }
  for (const [b, label] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
    const [x, y] = at(b, R + 15);
    svg.appendChild(el('text', { x, y: y + 4, class: 'plate-cardinal', 'text-anchor': 'middle' }, label));
  }

  // The footprint itself.
  const pts = fp.courses.map((c, i) => at(c, px(fp.radii[i])).join(',')).join(' ');
  svg.appendChild(el('polygon', { points: pts, class: 'plate-foot' }));

  // The bearing the plan actually flies out on, out to its own radius.
  const plannedKm = fp.byCourse[Math.round(fp.plannedCourseDeg) % 360] || 0;
  if (plannedKm > 0) {
    const [x2, y2] = at(fp.plannedCourseDeg, px(plannedKm));
    svg.appendChild(el('line', { x1: C, y1: C, x2, y2, class: 'plate-leg' }));
  }

  // The route, projected into the same north-up frame off the launch point.
  if (route && !route.empty && fp.launch) {
    const proj = (p) => at(bearingTo(fp.launch, p), px(distanceKm(fp.launch, p)));
    const wps = route.points.slice(1).map(proj);
    const outPts = [[C, C], ...wps].map(p => p.join(',')).join(' ');
    svg.appendChild(el('polyline', { points: outPts, class: 'plate-route' }));
    if (wps.length) {
      svg.appendChild(el('line', {
        x1: wps[wps.length - 1][0], y1: wps[wps.length - 1][1], x2: C, y2: C, class: 'plate-route-home',
      }));
    }
    wps.forEach(([x, y], i) => {
      svg.appendChild(el('circle', { cx: x, cy: y, r: 7.5, class: 'plate-wp' }));
      svg.appendChild(el('text', {
        x, y: y + 3.5, class: 'plate-wp-label', 'text-anchor': 'middle',
      }, String(i + 1)));
    });
  }

  // Launch point.
  svg.appendChild(el('circle', { cx: C, cy: C, r: 4.5, class: 'plate-launch' }));

  // Wind, drawn as the direction the air moves rather than the bearing it is
  // named by — an arrow labelled "from 170°" that points at 170° is the classic
  // way to fly the wrong way round a plan.
  const wx = 34, wy = 34, len = 17;
  const toDeg = (fp.windFromDeg + 180) % 360;
  const dx = Math.sin(toDeg * Math.PI / 180), dy = -Math.cos(toDeg * Math.PI / 180);
  svg.appendChild(el('line', {
    x1: wx - dx * len, y1: wy - dy * len, x2: wx + dx * len, y2: wy + dy * len, class: 'plate-wind',
  }));
  const head = [
    [wx + dx * len, wy + dy * len],
    [wx + dx * (len - 9) - dy * 5, wy + dy * (len - 9) + dx * 5],
    [wx + dx * (len - 9) + dy * 5, wy + dy * (len - 9) - dx * 5],
  ].map(p => p.join(',')).join(' ');
  svg.appendChild(el('polygon', { points: head, class: 'plate-wind-head' }));
  // The label lives in the bottom-left corner, opposite the scale legend, rather
  // than under the arrow: the corners are the only empty space on the plate, and
  // a caption laid over the outer ring is exactly the sort of clutter that costs
  // a second to read in bright sun.
  svg.appendChild(el('text', { x: 4, y: SIZE - 8, class: 'plate-note', 'text-anchor': 'start' },
    `wind from ${f0(fp.windFromDeg)}° · arrow points downwind`));

  // Scale legend, bottom-right, on the ring it describes.
  svg.appendChild(el('text', { x: SIZE - 8, y: SIZE - 8, class: 'plate-note', 'text-anchor': 'end' },
    `outer ring ${f0(fullDisp)} ${u.distanceUnit} · rings every ${f0(step)}`));
  return svg;
}

/* ---------- the sheet ---------- */

const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function section(title) {
  const s = h('section', 'brief-block');
  s.appendChild(h('h3', 'brief-h', title));
  return s;
}

function rowTable(rows, cols) {
  const table = h('table', 'brief-table');
  const body = h('tbody');
  for (const r of rows) {
    const tr = h('tr');
    for (const c of cols) tr.appendChild(h('td', c.cls, c.get(r)));
    body.appendChild(tr);
  }
  table.appendChild(body);
  return table;
}

function renderSheet(b, fp, route, u) {
  const host = $('brief-sheet');
  host.replaceChildren();

  const head = h('header', 'brief-head');
  const title = h('h2', 'brief-title', b.title);
  title.id = 'brief-title';
  head.append(title, h('p', 'brief-date', [b.dateLabel, b.loadout].filter(Boolean).join(' · ')));
  host.appendChild(head);

  if (b.verdict) {
    const v = h('div', `brief-verdict brief-verdict-${b.verdict.level}`);
    v.append(h('span', 'brief-badge', b.verdict.label), h('span', 'brief-why', b.verdict.why));
    host.appendChild(v);
    if (b.verdict.fix) host.appendChild(h('p', 'brief-fix', b.verdict.fix));
  }

  // The headline: the one line the whole artifact exists to carry.
  const clock = h('div', 'brief-clock');
  clock.append(h('p', 'brief-clock-big', b.clock.ok ? `Turn around at ${b.clock.turn}` : 'No turnaround'));
  clock.appendChild(h('p', 'brief-clock-sub', b.clock.headline));
  if (b.clock.ok) {
    clock.appendChild(h('p', 'brief-clock-sub',
      `Land at ${b.clock.land} on the timer.`
      + (b.clock.wall
        ? ` Launching ${b.clock.wall.launch}: turn ${b.clock.wall.turn}, land ${b.clock.wall.land}.`
        : ' Elapsed on the timer from the moment the props spin up — no clock needed.')));
  }
  host.appendChild(clock);

  const grid = h('div', 'brief-grid');

  // Left column: the plate and the launch point.
  const left = h('div', 'brief-col');
  const plate = section('Footprint · north up');
  const svg = footprintSvg(fp, route, u);
  if (svg) plate.appendChild(svg);
  else plate.appendChild(h('p', 'brief-empty', 'No footprint closes in these conditions.'));
  left.appendChild(plate);

  if (b.launch) {
    const loc = section('Launch point');
    const dl = h('dl', 'brief-dl');
    dl.append(h('dt', null, 'Decimal'), h('dd', 'brief-mono', b.launch.decimal));
    dl.append(h('dt', null, 'Deg / min'), h('dd', 'brief-mono', b.launch.degMin));
    dl.append(h('dt', null, 'Wind'), h('dd', null, b.wind.line));
    dl.append(h('dt', null, 'Air'), h('dd', null, b.wind.airLine));
    dl.append(h('dt', null, 'Planned leg'), h('dd', null, b.reach.courseText));
    loc.appendChild(dl);
    left.appendChild(loc);
  }
  grid.appendChild(left);

  // Right column: the numbers.
  const right = h('div', 'brief-col');
  if (b.cardinals.length) {
    const reach = section(`Reach by bearing · ${b.reach.radiusText} on the planned leg`);
    const t = h('table', 'brief-table brief-compass');
    const body = h('tbody');
    for (let i = 0; i < b.cardinals.length; i += 4) {
      const tr = h('tr');
      for (const c of b.cardinals.slice(i, i + 4)) {
        const td = h('td');
        td.append(h('span', 'brief-compass-label', c.label), h('span', 'brief-compass-val', c.text));
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    t.appendChild(body);
    reach.appendChild(t);
    if (b.reach.areaText) {
      reach.appendChild(h('p', 'brief-note', `Envelope area ${b.reach.areaText}. `
        + 'Out-and-back turnaround reach — energy only, and it knows nothing about the ground.'));
    }
    right.appendChild(reach);
  }

  const energy = section('Energy budget');
  energy.appendChild(rowTable(b.energy.rows, [
    { cls: 'brief-k', get: r => r.label },
    { cls: 'brief-v', get: r => r.value },
    { cls: 'brief-n', get: r => r.note },
  ]));
  energy.appendChild(h('p', 'brief-note', b.energy.binds));
  right.appendChild(energy);
  grid.appendChild(right);
  host.appendChild(grid);

  if (b.route) {
    const rt = section('Route');
    rt.appendChild(rowTable(b.route.legs, [
      { cls: 'brief-k', get: r => r.name },
      { cls: 'brief-v', get: r => r.dist },
      { cls: 'brief-v', get: r => r.course },
      { cls: 'brief-v', get: r => r.time },
      { cls: 'brief-v', get: r => r.wh },
    ]));
    rt.appendChild(h('p', 'brief-note', b.route.verdict));
    if (b.route.loiter) rt.appendChild(h('p', 'brief-note', b.route.loiter));
    rt.appendChild(h('p', 'brief-note', b.route.note));
    host.appendChild(rt);
  }

  if (b.terrainLine || b.linkLine) {
    const ground = section(b.linkLine
      ? (b.terrainLine ? 'Ground and radio, on the planned leg' : 'Radio, on the planned leg')
      : 'Ground, on the planned leg');
    if (b.terrainLine) ground.appendChild(h('p', 'brief-note', b.terrainLine));
    if (b.linkLine) ground.appendChild(h('p', 'brief-note', b.linkLine));
    host.appendChild(ground);
  }

  if (b.warnings.length) {
    const warn = section('Warnings');
    for (const w of b.warnings) {
      const p = h('p', `brief-warn brief-warn-${w.level}`);
      p.append(h('span', 'brief-warn-level', w.level), h('span', null, w.text));
      warn.appendChild(p);
    }
    if (b.warningsHeld > 0) {
      warn.appendChild(h('p', 'brief-note',
        `${b.warningsHeld} further note${b.warningsHeld === 1 ? '' : 's'} on the planner screen.`));
    }
    host.appendChild(warn);
  }

  const checks = section('Before you launch');
  const ol = h('ol', 'brief-checks');
  for (const item of b.checklist) {
    const li = h('li');
    li.append(h('span', 'brief-box', '☐'), h('span', null, item));
    ol.appendChild(li);
  }
  checks.appendChild(ol);
  host.appendChild(checks);

  host.appendChild(h('p', 'brief-foot',
    `FPV Mission Planner · generated ${b.generatedAt.toLocaleString()} · a planning estimate, `
    + 'not a guarantee. Fly with margin.'));
}

/* ---------- open / close ---------- */

function chrome() {
  return [
    document.querySelector('.masthead'),
    document.querySelector('.view-tabs'),
    document.querySelector('.layout'),
    document.querySelector('.dock'),
  ].filter(Boolean);
}

export function openBrief() {
  const latest = deps?.latest?.();
  if (!latest || !latest.plan) return;
  const u = units();
  const fp = footprintState();
  const route = latest.route;
  const r = latest.plan;
  const b = buildBrief({
    plan: r,
    verdict: verdict(r, zeroRadiusNote(r)),
    warnings: r.warnings,
    footprint: fp,
    route,
    link: latest.link,
    terrain: terrainStatsFor(r),
    // The pin the footprint was swept around, not the rail's idea of it: the two
    // agree, and preferring the sweep's own copy means the coordinates printed
    // can never describe a different point from the plate above them.
    launch: fp ? fp.launch : null,
    drone: drone(),
    battery: battery(),
    packCount: loadoutBattery()?.packCount ?? 1,
    payloadLabel: payload()?.name || null,
    extraG: state.extraG,
    env: state.env,
    scenarioLabel: scenario()?.name || null,
    cruiseAltM: state.cruiseAltM,
    times: legTimes(r),
    launchAt: plannedLaunchTime(),
    units: u,
    expert: !beginner(),
  });
  renderSheet(b, fp, route, u);

  returnFocus = document.activeElement;
  open = true;
  const host = $('brief');
  host.hidden = false;
  document.body.classList.add('brief-open');
  for (const node of chrome()) node.inert = true;
  $('brief-sheet').focus({ preventScroll: true });
  host.scrollTop = 0;
}

export function closeBrief() {
  if (!open) return;
  open = false;
  // Order matters: lift inert and hand focus back *before* hiding the sheet.
  // Hiding a container that holds the focused element makes the browser reset
  // focus to <body> on its own, and that reset lands after any focus() called in
  // the same tick — the button the pilot opened the brief from would lose focus
  // a frame later, dropping a keyboard user back at the top of the document.
  for (const node of chrome()) node.inert = false;
  if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
  $('brief').hidden = true;
  document.body.classList.remove('brief-open');
}

export function bindBrief() {
  $('btn-brief').addEventListener('click', openBrief);
  $('brief-close').addEventListener('click', closeBrief);
  $('brief-print').addEventListener('click', () => window.print());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) { e.stopPropagation(); closeBrief(); }
  });
}
