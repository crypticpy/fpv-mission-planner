// dive-profile-strip.js — the dive line against the ground it is flown at
// (M16, 3D-06's bottom edge).
//
// The elevation profile in Analyze does this for the whole route off the
// analysis's corridor. This one does it for the dive alone, off the gates the
// pilot is authoring right now, because the corridor is a pass behind them: a
// gate dragged 200 m up the ridge changes this strip on the same frame it
// changes the map, and waiting for terrain sampling to catch up would make the
// one surface that shows the ground the last to know about it.
//
// It draws what dive-profile.js computed and adds nothing. In particular the
// silhouette *breaks* where the sampler had no ground rather than closing over
// the gap — a continuous horizon under a stretch nobody sampled is the picture
// that gets a pilot to fly a dive into a col.
//
// The gates are real buttons over the plot, not shapes in it: they are the
// selection control for the leg inspector, they have to be thumb-sized on a
// phone, and a `<button>` gets focus, Enter and a name from the platform.

import { svgEl } from '../../charts.js';
import { DIVE_LEG_STYLE } from './layers/dive-layer.js';
import { diveProfileFrom } from './dive-profile.js';
import { f0 } from '../../render/format.js';

/**
 * @typedef {import('./map-adapter.js').LatLng} LatLng
 * @typedef {import('./map-adapter.js').DiveProjection} DiveProjection
 * @typedef {import('./dive-profile.js').DiveProfile} DiveProfile
 */

const $ = (/** @type {string} */ id) => document.getElementById(id);

/** The plot's own units. Stretched to the host by preserveAspectRatio. */
const W = 1000;
const H = 100;
/** Headroom above the highest thing drawn and below the lowest, in plot units. */
const PAD = 8;

/**
 * Where a metres-MSL height and a metres-along distance land in plot units.
 * Returned as a pair of closures so the SVG and the HTML buttons over it are
 * placed by one scale — two of them a few statements apart is how a gate ends
 * up beside its own corner.
 * @param {DiveProfile} p
 */
export function scaleOf(p) {
  const span = Math.max(1, p.maxMslM - p.minMslM);
  const x = (/** @type {number} */ m) => (p.totalM > 0 ? (m / p.totalM) * W : 0);
  const y = (/** @type {number} */ msl) => H - PAD - ((msl - p.minMslM) / span) * (H - PAD * 2);
  return { x, y };
}

/**
 * The runs of ground the sampler actually answered, split at every hole. Each
 * run becomes its own filled shape, which is what leaves the gaps visible.
 * @param {DiveProfile['ground']} ground
 * @returns {{ x: number, groundMslM: number }[][]}
 */
export function groundRuns(ground) {
  /** @type {{ x: number, groundMslM: number }[][]} */
  const runs = [];
  /** @type {{ x: number, groundMslM: number }[]} */
  let run = [];
  for (const s of ground) {
    if (s.groundMslM == null) {
      if (run.length > 1) runs.push(run);
      run = [];
      continue;
    }
    run.push({ x: s.x, groundMslM: s.groundMslM });
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/**
 * The strip, or nothing at all.
 *
 * @param {object} view
 * @param {DiveProjection|null} view.dive
 * @param {LatLng} view.launch
 * @param {number|null} view.launchMslM
 * @param {string|null} view.selectedKind
 * @param {(lat: number, lng: number) => number|null} view.groundAt
 * @param {boolean} view.visible
 * @param {(kind: string) => void} view.onSelect
 */
export function renderDiveStrip({ dive, launch, launchMslM, selectedKind, groundAt, visible, onSelect }) {
  const host = $('dive-strip');
  if (!host) return;

  const profile = visible && dive?.gates.length
    ? diveProfileFrom({ launch, launchMslM, gates: dive.gates, groundAt })
    : null;
  host.hidden = !profile;
  if (!profile) { host.replaceChildren(); return; }

  const { x, y } = scaleOf(profile);
  const svg = svgEl('svg', {
    class: 'dive-strip-plot',
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'none',
    'aria-hidden': 'true', // the gate buttons below carry the readable version
  });

  /* The ground first, so the flight line is over it. Each run closes down to the
     floor of the plot; the holes between runs stay empty. */
  for (const run of groundRuns(profile.ground)) {
    const top = run.map((s) => `${x(s.x).toFixed(2)},${y(s.groundMslM).toFixed(2)}`).join(' L');
    svg.appendChild(svgEl('path', {
      class: 'dive-strip-ground',
      d: `M${top} L${x(run[run.length - 1].x).toFixed(2)},${H} L${x(run[0].x).toFixed(2)},${H} Z`,
    }));
  }

  for (const leg of profile.legs) {
    const style = DIVE_LEG_STYLE[leg.kind] ?? DIVE_LEG_STYLE.abort;
    svg.appendChild(svgEl('line', {
      class: `dive-strip-leg${leg.kind === selectedKind ? ' is-selected' : ''}`,
      x1: x(leg.x0).toFixed(2), y1: y(leg.y0).toFixed(2),
      x2: x(leg.x1).toFixed(2), y2: y(leg.y1).toFixed(2),
      stroke: `var(${style.cssVar})`,
      'vector-effect': 'non-scaling-stroke',
    }));
  }

  const plot = document.createElement('div');
  plot.className = 'dive-strip-canvas';
  plot.appendChild(svg);

  /* One button per gate on the flown line. The abort gate is not on it — it is
     where the run is *not* flown — so it has no place on a distance axis and is
     reached on the map instead. */
  for (const gate of profile.gates) {
    const style = DIVE_LEG_STYLE[gate.kind] ?? DIVE_LEG_STYLE.abort;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dive-strip-gate';
    btn.dataset.gate = gate.kind;
    btn.textContent = String(gate.ordinal);
    btn.style.setProperty('--gate-color', `var(${style.cssVar})`);
    btn.style.left = `${(x(gate.x) / W) * 100}%`;
    btn.style.top = `${(y(gate.altitudeMslM) / H) * 100}%`;
    btn.title = `${gate.kind} gate — ${f0(gate.altitudeMslM)} m MSL`;
    btn.setAttribute('aria-label', `${gate.kind} gate, ${f0(gate.altitudeMslM)} metres MSL`);
    btn.setAttribute('aria-pressed', String(gate.kind === selectedKind));
    btn.addEventListener('click', () => onSelect(gate.kind));
    plot.appendChild(btn);
  }

  host.replaceChildren(plot, caption(profile));
}

/**
 * The line under the plot: what the strip is measuring, and what it could not.
 * The pad's absence is named because it changes where the profile *starts*, and
 * a pilot reading a dive that begins mid-air is owed the reason.
 * @param {DiveProfile} p
 * @returns {HTMLElement}
 */
function caption(p) {
  const el = document.createElement('p');
  el.className = 'dive-strip-caption';
  el.id = 'dive-strip-caption';
  const parts = [`${f0(p.totalM)} m of run, ${f0(p.maxMslM - p.minMslM)} m of height`];
  if (!p.fromLaunch) parts.push('starts at the first gate — no launch elevation resolved');
  if (p.missing > 0) {
    parts.push(`${p.missing} of ${p.ground.length} stations have no ground — `
      + 'the gaps are unsurveyed, not clear');
  }
  el.textContent = parts.join(' · ');
  return el;
}
