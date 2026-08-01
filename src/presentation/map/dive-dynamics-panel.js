// dive-dynamics-panel.js — the dive as it is flown (M16, 3D-07).
//
// The profile strip beside this one answers "where does the line go"; this one
// answers "what happens along it". Both draw the same four gates, and they are
// deliberately fed from different places:
//
//   The strip is pure geometry over gates the pilot is dragging right now, so
//   it recomputes locally and lands on the same frame as the drag. The dynamics
//   need the pack, the air and the terrain corridor, so they ride the analysis
//   and arrive a pass later. That lag is the honest one: a sag figure that kept
//   up with a drag would be a sag figure that was not computed from the pack.
//
// Two rules govern everything below, both inherited from dive-inspector.js:
//
//   *Nothing is drawn that was not computed.* Every track breaks where its
//     series is null rather than bridging the gap, and every fact reads "—"
//     with the reason beside it. A continuous line over a stretch nobody
//     modelled is the picture that gets a pilot to fly a dive into a col.
//
//   *There is no thermal card.* The mockup this screen is built from has one,
//     between Energy and Link. Nothing in this tool measures or estimates motor
//     or ESC temperature, so the card is absent and the panel says why — an
//     empty seat a pilot can see is worth more than a green badge nobody
//     computed.
//
// Link is reported the way the RF engine actually speaks: blocked distance in
// the pilot's units. The mockup asks for decibels; no decibel exists anywhere
// in this codebase, so none is printed.

import { svgEl } from '../../charts.js';
import { DIVE_LEG_STYLE } from './layers/dive-layer.js';
import { f0, f1 } from '../../render/format.js';

/**
 * @typedef {import('../../domain/dive-dynamics.js').DiveDynamics} DiveDynamics
 * @typedef {import('../../domain/dive-dynamics.js').DivePhase} DivePhase
 * @typedef {import('../../domain/units.js').UnitSystem} UnitSystem
 */

const $ = (/** @type {string} */ id) => document.getElementById(id);

/** The plot's own units. Stretched to the host by preserveAspectRatio. */
const W = 1000;
const TRACK_H = 40;
const PAD = 5;

/** The pullout is an arc, not a leg, so it carries the colour of the leg it ends. */
const PHASE_STYLE = /** @type {Record<string, {cssVar: string, label: string}>} */ ({
  ...DIVE_LEG_STYLE,
  pullout: { cssVar: '--status-good', label: 'Pullout' },
});

/**
 * Which leg's inspector a phase chip opens. The pullout is authored on the dive
 * leg — its speed and load boxes live there — so the chip that says "Pullout"
 * and the chip that says "Approach → dive" lead to the same panel. That is not
 * a redundancy: a pilot reading a pullout they dislike is looking for the two
 * numbers that shape it, and this is where they are.
 * @param {string} kind
 */
const legOf = (kind) => (kind === 'pullout' ? 'dive' : kind);

/* ---------- the bottom edge: three tracks on one axis ---------- */

/**
 * The timeline body, for the strip host to place under its tabs.
 *
 * The x axis is time when a dive speed has been stated and distance when it has
 * not, and it says which — the same number of metres flown at an unstated speed
 * takes an unknown number of seconds, and an axis labelled "time" over it would
 * be the panel inventing the one figure the pilot did not give it.
 *
 * @param {DiveDynamics} d
 * @param {object} opts
 * @param {UnitSystem} opts.units
 * @param {string|null} opts.selectedKind
 * @param {(kind: string) => void} opts.onSelect
 * @returns {HTMLElement}
 */
export function diveTimelinePlot(d, { units: u, selectedKind, onSelect }) {
  const timed = d.totalS != null && d.totalS > 0;
  const span = timed ? /** @type {number} */ (d.totalS) : d.totalM;
  /** Where a phase's start and end land, as a fraction of the run. */
  const at = (/** @type {DivePhase} */ p) => {
    const a = timed ? p.startS : p.startM;
    const b = timed ? p.endS : p.endM;
    return a == null || b == null || span <= 0
      ? null
      : { x0: (a / span) * W, x1: (b / span) * W };
  };

  const body = document.createElement('div');
  body.className = 'dive-timeline';

  body.appendChild(phaseChips(d, { selectedKind, onSelect, timed }));

  const grid = document.createElement('div');
  grid.className = 'dive-tracks';

  /* Altitude, then the two things it is changing at. Reading down the column is
     reading the same instant three ways, which is why they share one axis. */
  grid.append(...track({
    label: 'Altitude', unit: `${u.altUnit} MSL`, phases: d.phases, at, selectedKind,
    /* The pullout dips below the gate it starts at, so the floor has to know
       about it or the arc would be drawn clipped to the bottom of its own row. */
    values: (p) => [p.startMslM, p.endMslM],
    show: (m) => `${f0(u.altFromM(m))}`,
  }));
  grid.append(...track({
    label: 'Vertical speed', unit: u.speedUnit, phases: d.phases, at, selectedKind,
    values: (p) => (p.verticalSpeedMs == null ? [] : [p.verticalSpeedMs, p.verticalSpeedMs]),
    show: (ms) => `${f0(u.speedFromMs(ms))}`,
    zero: true,
  }));
  grid.append(...track({
    label: 'Clearance', unit: `${u.altUnit} AGL`, phases: d.phases, at, selectedKind,
    values: (p) => (p.startClearanceM == null || p.endClearanceM == null
      ? [] : [p.startClearanceM, p.endClearanceM]),
    show: (m) => `${f0(u.altFromM(m))}`,
    zero: true,
  }));

  /* The axis goes inside the track grid rather than under it, in the plot
     column: it has to start exactly where the plots start, and the name column
     is sized by its own longest label. A margin outside the grid would be that
     width written down a second time, in a stylesheet, in pixels. */
  grid.appendChild(axis(d, timed, span));
  body.appendChild(grid);
  return body;
}

/**
 * One row: its name, and the series drawn across the shared axis. A phase whose
 * series has no value contributes no line at all — the row simply has a hole
 * where that phase is, which is the true picture of an unmodelled stretch.
 *
 * @param {object} spec
 * @param {string} spec.label
 * @param {string} spec.unit
 * @param {DivePhase[]} spec.phases
 * @param {(p: DivePhase) => {x0: number, x1: number}|null} spec.at
 * @param {string|null} spec.selectedKind
 * @param {(p: DivePhase) => number[]} spec.values  the row's pair, or [] for a hole
 * @param {(v: number) => string} spec.show
 * @param {boolean} [spec.zero]  keep zero in frame — a sign change is the reading
 * @returns {HTMLElement[]}
 */
function track({ label, unit, phases, at, selectedKind, values, show, zero }) {
  const all = phases.flatMap(values);
  const name = document.createElement('div');
  name.className = 'dive-track-name';
  const strong = document.createElement('span');
  strong.textContent = label;
  const sub = document.createElement('span');
  sub.className = 'dive-track-unit';
  name.append(strong, sub);

  const cell = document.createElement('div');
  cell.className = 'dive-track-plot';

  if (!all.length) {
    sub.textContent = unit;
    cell.classList.add('is-empty');
    cell.textContent = 'not modelled';
    return [name, cell];
  }

  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const range = Math.max(1e-6, hi - lo);
  const y = (/** @type {number} */ v) => TRACK_H - PAD - ((v - lo) / range) * (TRACK_H - PAD * 2);
  /* A dash between the bounds reads as a range right up until the low bound is
     negative, where "56–-33" puts two dashes back to back and the reader has to
     work out which one is the minus. Vertical speed is the row that goes below
     zero — a dive is a negative climb — so it is the row that says "to". */
  const loText = show(lo);
  sub.textContent = `${show(hi)}${loText.startsWith('-') ? ' to ' : '–'}${loText} ${unit}`;

  const svg = svgEl('svg', {
    class: 'dive-track-svg',
    viewBox: `0 0 ${W} ${TRACK_H}`,
    preserveAspectRatio: 'none',
    'aria-hidden': 'true', // the name and range beside it carry the readable version
  });

  for (const p of phases) {
    const x = at(p);
    if (!x) continue;
    svg.appendChild(svgEl('rect', {
      class: `dive-track-band${p.kind === selectedKind || legOf(p.kind) === selectedKind ? ' is-selected' : ''}`,
      x: x.x0.toFixed(2), y: '0', width: Math.max(0, x.x1 - x.x0).toFixed(2), height: String(TRACK_H),
    }));
  }
  if (zero && lo < 0 && hi > 0) {
    svg.appendChild(svgEl('line', {
      class: 'dive-track-zero', x1: '0', x2: String(W), y1: y(0).toFixed(2), y2: y(0).toFixed(2),
    }));
  }
  for (const p of phases) {
    const x = at(p);
    const pair = values(p);
    if (!x || pair.length !== 2) continue;
    const style = PHASE_STYLE[p.kind] ?? PHASE_STYLE.abort;
    svg.appendChild(svgEl('line', {
      class: 'dive-track-line',
      x1: x.x0.toFixed(2), y1: y(pair[0]).toFixed(2),
      x2: x.x1.toFixed(2), y2: y(pair[1]).toFixed(2),
      stroke: `var(${style.cssVar})`,
      'vector-effect': 'non-scaling-stroke',
    }));
  }
  cell.appendChild(svg);
  return [name, cell];
}

/**
 * The phases as buttons, each carrying how long it lasts. Selecting one opens
 * the leg it belongs to, so this row is a control and not a key.
 * @param {DiveDynamics} d
 * @param {{selectedKind: string|null, onSelect: (kind: string) => void, timed: boolean}} opts
 */
function phaseChips(d, { selectedKind, onSelect, timed }) {
  const row = document.createElement('div');
  row.className = 'dive-phases';
  row.id = 'dive-phases';
  for (const p of d.phases) {
    const style = PHASE_STYLE[p.kind] ?? PHASE_STYLE.abort;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dive-phase';
    btn.dataset.phase = p.kind;
    btn.style.setProperty('--gate-color', `var(${style.cssVar})`);
    btn.setAttribute('aria-pressed', String(legOf(p.kind) === selectedKind));
    const name = document.createElement('span');
    name.textContent = p.kind === 'pullout' ? 'Pullout' : style.label;
    const len = document.createElement('span');
    len.className = 'dive-phase-len';
    len.textContent = timed && p.startS != null && p.endS != null
      ? `${f0(p.endS - p.startS)} s`
      : `${f0(p.endM - p.startM)} m`;
    btn.append(name, len);
    btn.title = `${style.label} — open this leg`;
    btn.addEventListener('click', () => onSelect(legOf(p.kind)));
    row.appendChild(btn);
  }
  return row;
}

/**
 * The axis and what it is measuring. Ticks are placed as percentages on HTML
 * rather than drawn in the stretched SVG, where the labels would shear.
 * @param {DiveDynamics} d
 * @param {boolean} timed
 * @param {number} span
 */
function axis(d, timed, span) {
  const el = document.createElement('div');
  el.className = 'dive-axis';
  el.id = 'dive-axis';
  for (let i = 0; i <= 4; i += 1) {
    const tick = document.createElement('span');
    tick.className = 'dive-tick';
    tick.style.left = `${(i / 4) * 100}%`;
    const v = (span * i) / 4;
    tick.textContent = timed ? `${f0(v)}s` : `${f0(v)}m`;
    el.appendChild(tick);
  }
  const note = document.createElement('span');
  note.className = 'dive-axis-note';
  note.textContent = timed
    ? `${f0(/** @type {number} */ (d.totalS))} s at the stated dive speed`
    : 'distance along the line — no dive speed stated, so there is no clock';
  el.appendChild(note);
  return el;
}

/* ---------- the seat: what the dive costs the aircraft ---------- */

/**
 * The systems card, or nothing at all. Takes the standing briefing's seat while
 * the dynamics are up and no leg is selected, on the same rule every other panel
 * in this stage follows: the more specific answer wins the seat.
 *
 * @param {object} view
 * @param {DiveDynamics|null} view.dynamics
 * @param {import('../../application/analysis/analysis-contracts.js').LinkResult|null} view.link
 * @param {UnitSystem} view.units
 * @param {boolean} view.visible
 * @param {(kind: string) => void} view.onTune
 */
export function renderDiveSystems({ dynamics, link, units: u, visible, onTune }) {
  const card = $('dive-systems');
  if (!card) return;
  card.hidden = !(visible && dynamics);
  if (card.hidden || !dynamics) { card.replaceChildren(); return; }

  const s = dynamics.systems;
  const head = document.createElement('div');
  head.className = 'card-head';
  const title = document.createElement('h3');
  title.textContent = 'Systems margin';
  head.appendChild(title);

  const facts = document.createElement('dl');
  facts.className = 'segment-facts dive-facts';
  /** @param {string} label @param {string} value @param {string} [note] */
  const add = (label, value, note) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (note) {
      const n = document.createElement('span');
      n.className = 'segment-note';
      n.textContent = note;
      dd.appendChild(n);
    }
    facts.append(dt, dd);
  };

  add('Peak vertical speed', s.peakVerticalSpeedMs == null
    ? '—'
    : `${f0(u.speedFromMs(Math.abs(s.peakVerticalSpeedMs)))} ${u.speedUnit} down`,
  s.peakVerticalSpeedMs == null ? 'needs a stated dive speed' : undefined);
  add('Pullout load', s.pulloutLoadG == null ? '—' : `${f1(s.pulloutLoadG)} g`,
    s.pulloutLoadG == null ? 'not stated' : 'as stated, not as measured');
  add('Pullout clearance', s.pulloutClearanceM == null
    ? '—' : `${f0(u.altFromM(s.pulloutClearanceM))} ${u.altUnit}`,
  s.pulloutClearanceM == null ? 'no arc, or no ground under the gate' : undefined);
  add('Pack sag', s.packSagV == null ? '—' : `${f1(s.packSagV)} V`,
    s.packSagV == null ? 'needs a pack and a stated pullout' : 'under the pull, at this state of charge');
  add('Motor margin', pct(s.motorMarginFrac), s.motorMarginFrac == null
    ? 'this aircraft carries no motor current limit' : 'of the motor current ceiling, unused');
  add('ESC margin', pct(s.escMarginFrac), s.escMarginFrac == null
    ? 'this aircraft carries no ESC current limit' : 'of the ESC current ceiling, unused');
  add('Recovery reserve', pct(s.recoveryReserveFrac), s.recoveryReserveFrac == null
    ? 'needs a pack and a way home' : 'left after the climb out and the flight home');

  card.replaceChildren(head, facts, marginCards(s, link, u), absence(s));

  const tune = document.createElement('button');
  tune.type = 'button';
  tune.className = 'map-btn dive-apply';
  tune.id = 'btn-dive-tune';
  tune.textContent = 'Tune pullout';
  tune.title = 'Open the dive leg, where the speed and the load are authored';
  tune.onclick = () => onTune('dive');
  card.appendChild(tune);

  /* The way out, from the card that reads the way in (M16, 3D-08). Beside the
     pullout button because a pilot reading these margins is the pilot deciding
     what they do when one of them does not hold, and until this button the only
     door to the recovery plan was a pin they might never have placed. */
  const out = document.createElement('button');
  out.type = 'button';
  out.className = 'map-btn dive-apply';
  out.id = 'btn-dive-recovery';
  out.textContent = 'Recovery plan';
  out.title = 'Open the lost-link climb, the break-off gate and the bailout landing';
  out.onclick = () => onTune('abort');
  card.appendChild(out);
}

/**
 * The three margins that have an engine behind them, as badges. Thermal is the
 * fourth in the mockup and is not here; `absence()` below says so out loud
 * rather than leaving a gap the pilot has to notice.
 * @param {import('../../domain/dive-dynamics.js').DiveSystems} s
 * @param {import('../../application/analysis/analysis-contracts.js').LinkResult|null} link
 * @param {UnitSystem} u
 */
function marginCards(s, link, u) {
  const row = document.createElement('div');
  row.className = 'dive-margins';
  row.id = 'dive-margins';

  /** @type {{key: string, label: string, tone: string, value: string}[]} */
  const cards = [];

  cards.push({
    key: 'energy',
    label: 'Energy',
    ...(s.recoveryReserveFrac == null
      ? { tone: 'unknown', value: 'not modelled' }
      : {
        tone: s.recoveryReserveFrac <= 0 ? 'serious' : s.recoveryReserveFrac < 0.15 ? 'warning' : 'good',
        value: `${f0(s.recoveryReserveFrac * 100)}% left`,
      }),
  });

  const elec = [s.motorMarginFrac, s.escMarginFrac].filter((v) => v != null);
  cards.push({
    key: 'electrical',
    label: 'Electrical',
    ...(elec.length === 0
      ? { tone: 'unknown', value: 'no current limits' }
      : {
        tone: Math.min(...elec) <= 0 ? 'serious' : Math.min(...elec) <= 0.1 ? 'warning' : 'good',
        value: `${f0(Math.min(...elec) * 100)}% spare`,
      }),
  });

  cards.push({
    key: 'pullout',
    label: 'Pullout',
    ...(s.pulloutClearanceM == null
      ? { tone: 'unknown', value: 'unchecked' }
      : {
        tone: s.pulloutClearanceM <= 0 ? 'serious' : s.pulloutClearanceM < 30 ? 'warning' : 'good',
        value: `${f0(u.altFromM(s.pulloutClearanceM))} ${u.altUnit}`,
      }),
  });

  /* The RF engine answers in metres of blocked path, never in decibels, so this
     badge says blocked distance. A "link margin, dB" row would be a number with
     no engine under it. */
  const blockedKm = typeof link?.losBlockKm === 'number' ? link.losBlockKm : null;
  cards.push({
    key: 'link',
    label: 'Link',
    ...(link == null
      ? { tone: 'unknown', value: 'not checked' }
      : blockedKm == null || blockedKm <= 0
        ? { tone: 'good', value: 'line of sight clear' }
        : { tone: 'warning', value: `${f1(u.distFromKm(blockedKm))} ${u.distUnit} blocked` }),
  });

  for (const c of cards) {
    const el = document.createElement('div');
    el.className = 'dive-margin';
    el.dataset.margin = c.key;
    el.dataset.tone = c.tone;
    const label = document.createElement('span');
    label.className = 'dive-margin-label';
    label.textContent = c.label;
    const value = document.createElement('strong');
    value.textContent = c.value;
    el.append(label, value);
    row.appendChild(el);
  }
  return row;
}

/**
 * What this card does not show, and why. Named rather than omitted: a pilot who
 * knows the mockup — or who simply expects a temperature on a screen about a
 * full-throttle pullout — is owed the reason there isn't one.
 * @param {import('../../domain/dive-dynamics.js').DiveSystems} s
 */
function absence(s) {
  const el = document.createElement('p');
  el.className = 'dive-absent';
  el.id = 'dive-absent';
  const parts = ['No thermal margin is shown: nothing here measures or estimates motor or ESC temperature.'];
  if (s.missing.length) parts.push(`Unstated: ${s.missing.join('; ')}.`);
  el.textContent = parts.join(' ');
  return el;
}

/** @param {number|null} frac */
const pct = (frac) => (frac == null ? '—' : `${f0(frac * 100)}%`);
