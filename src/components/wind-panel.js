// components/wind-panel.js — the WindRibbon's expansion (design evolution M11):
// press the ribbon and the sky unfolds under it, on every destination. This
// wave carries W-01 — the wind now, the surface and gust beside it, a compass
// rose, and the hourly outlook for choosing a flight window. The altitude
// ladder (W-02) and heading exposure (W-03) mount as sibling segments in the
// next waves.
//
// Not one figure here is the panel's own. The hero is the same planning wind
// the ribbon compresses, the surface line is the rail's launch-wind sentence
// as a tile, and the outlook chips are faces on the forecast scrubber's state
// — pressing one calls the scrubber's own handler, so the rail slider, the
// honesty banner and this panel can never disagree about which sky the app is
// planning against.
import { svgEl } from '../charts.js';
import { state, units } from '../state.js';
import { compass, f0 } from '../render/format.js';
import { U } from '../domain/physics.js';
import { GUST_SHARE_CAUTION } from '../render/dashboard.js';
import { launchWind, activeWindAt } from '../windprofile.js';
import { forecastOutlook, hourName, hourSummary, clockTime } from '../render/forecast.js';

/**
 * @typedef {object} OutlookChip
 * @property {number} i         absolute index into the scrubber's hours
 * @property {string} label     'Now', '3 PM', 'Fri 9 AM'
 * @property {string|null} wind converted speed figure, no unit
 * @property {string|null} gust converted gust figure when the hour cautions —
 *   printed on the chip, so the warning is a number, never a color alone
 * @property {string} sr        full spoken form, units and gust included
 * @property {boolean} caution  gust share over the same threshold the ribbon ambers on
 * @property {boolean} selected
 */

/**
 * @typedef {object} WindPanelModel
 * @property {{ value: string, unit: string, dir: string, level: string }} hero
 * @property {{ value: string, meta: string }} surface
 * @property {{ value: string, caution: boolean }} gust
 * @property {number} windFromDeg
 * @property {{ chips: OutlookChip[], banner: string|null, readout: string|null,
 *              sun: string|null }|null} outlook
 * @property {string|null} noOutlook  why there is no outlook, when there is none
 */

/**
 * The chip steps, as offsets from "now": dense where a launch decision lives
 * (the next few hours), tapering to the half-day horizon. The rail's slider
 * still reaches all 72 hours — these are the hours worth a one-press audition.
 */
const OUTLOOK_OFFSETS = [0, 1, 2, 3, 4, 6, 9, 12];

/** Hour-only when the hour is today; day + hour once the label crosses midnight. */
function chipLabel(when, nowTime) {
  return when.getDate() === nowTime.getDate() && when.getMonth() === nowTime.getMonth()
    ? when.toLocaleString([], { hour: 'numeric' })
    : hourName(when);
}

/**
 * Whether an hour's gusts cross the share of the usable top speed the whole
 * app cautions on. No plan (no pack fits) means no threshold — never a guess.
 * @param {number|null} gustMph
 * @param {import('../application/analysis/analysis-contracts.js').SolvedPlan|null} plan
 */
export function gustCaution(gustMph, plan) {
  return !!plan && plan.speedLimitMs > 0 && Number.isFinite(gustMph)
    && U.mphToMs(gustMph) / plan.speedLimitMs > GUST_SHARE_CAUTION;
}

/**
 * W-01's model, read off the same state every other wind surface reads.
 * @param {import('../application/analysis/analysis-contracts.js').AnalysisSnapshot|null} snapshot
 * @returns {WindPanelModel}
 */
export function windPanelModelFrom(snapshot) {
  const u = units();
  const env = state.env;
  const plan = snapshot?.plan ?? null;
  const spd = (/** @type {number} */ mph) => `${f0(u.speedFromMph(mph))} ${u.speedUnit}`;

  const hero = {
    value: f0(u.speedFromMph(env.windMph)),
    unit: u.speedUnit,
    dir: `${compass(env.windFromDeg)} · ${f0(env.windFromDeg)}°`,
    level: `Flying height ${state.cruiseAltM} m`,
  };

  // The rail's launch-wind sentence, tile-sized: a measured 10 m reading when
  // the forecast gave one, otherwise the rule of thumb it has always printed.
  const sfc = launchWind(env.windMph);
  const sfcDir = activeWindAt(10);
  const surface = sfc.measured
    ? { value: sfcDir ? `${spd(sfc.mph)} · ${compass(sfcDir.windFromDeg)}` : spd(sfc.mph),
        meta: 'measured at 10 m' }
    : { value: spd(sfc.mph), meta: 'estimated · about half the wind aloft' };

  const gust = { value: spd(env.gustMph), caution: gustCaution(env.gustMph, plan) };

  const o = forecastOutlook();
  if (!o) {
    const why = state.weatherId === 'live'
      ? 'No hourly outlook — live weather hasn’t answered for this launch point.'
      : state.weatherId === 'custom'
        ? 'No hourly outlook for hand-entered conditions — switch Weather to Live for one.'
        : 'No hourly outlook for a preset sky — switch Weather to Live for one.';
    return { hero, surface, gust, windFromDeg: env.windFromDeg, outlook: null, noOutlook: why };
  }

  const nowTime = o.hours[o.now].time;
  const chips = [];
  for (const off of OUTLOOK_OFFSETS) {
    const i = o.now + off;
    if (i >= o.hours.length) break;
    const hr = o.hours[i];
    const label = off === 0 ? 'Now' : chipLabel(hr.time, nowTime);
    const wind = hr.windMph == null ? null : f0(u.speedFromMph(hr.windMph));
    const gusting = hr.gustMph != null && hr.windMph != null && hr.gustMph > hr.windMph
      ? `, gusting ${f0(u.speedFromMph(hr.gustMph))}` : '';
    const caution = gustCaution(hr.gustMph, plan);
    chips.push({
      i, label, wind,
      gust: caution && hr.gustMph != null ? `g ${f0(u.speedFromMph(hr.gustMph))}` : null,
      sr: wind == null ? `${label} — no wind figure` : `${label} — ${wind} ${u.speedUnit}${gusting}`,
      caution,
      selected: i === o.selected,
    });
  }

  const offNow = o.selected !== o.now;
  const sel = o.hours[o.selected];
  const when = hourName(sel.time);
  return {
    hero, surface, gust,
    windFromDeg: env.windFromDeg,
    outlook: {
      chips,
      banner: offNow ? `Planning for ${when} — forecast, not current conditions.` : null,
      readout: offNow ? `${when} — ${hourSummary(sel)}` : null,
      sun: o.golden
        ? `Sunset ${clockTime(o.golden.sunset)} · golden hour from ${clockTime(o.golden.goldenStart)}`
        : null,
    },
    noOutlook: null,
  };
}

/* ---------- render ---------- */

/** The compass rose: ring, cardinal ticks and letters, and the flow arrow —
 * tail on the side the wind comes from, head where it is going. */
function rose(windFromDeg) {
  const svg = svgEl('svg', { class: 'windpanel-rose', viewBox: '0 0 96 96' });
  svg.setAttribute('aria-hidden', 'true');
  svg.appendChild(svgEl('circle', { cx: 48, cy: 48, r: 34, class: 'windpanel-rose-ring' }));
  for (let deg = 0; deg < 360; deg += 45) {
    const cardinal = deg % 90 === 0;
    const a = (deg - 90) * Math.PI / 180;
    const r1 = cardinal ? 29 : 31;
    svg.appendChild(svgEl('line', {
      x1: 48 + r1 * Math.cos(a), y1: 48 + r1 * Math.sin(a),
      x2: 48 + 34 * Math.cos(a), y2: 48 + 34 * Math.sin(a),
      class: 'windpanel-rose-tick',
    }));
    if (cardinal) {
      const t = svgEl('text', {
        x: 48 + 43 * Math.cos(a), y: 48 + 43 * Math.sin(a),
        class: `windpanel-rose-letter${deg === 0 ? ' windpanel-rose-north' : ''}`,
      });
      t.textContent = ['N', 'E', 'S', 'W'][deg / 90];
      svg.appendChild(t);
    }
  }
  const arrow = svgEl('g', { transform: `rotate(${windFromDeg} 48 48)` });
  arrow.appendChild(svgEl('line', { x1: 48, y1: 24, x2: 48, y2: 62, class: 'windpanel-rose-shaft' }));
  arrow.appendChild(svgEl('path', { d: 'M42 60 L48 72 L54 60 Z', class: 'windpanel-rose-head' }));
  svg.appendChild(arrow);
  return svg;
}

function tile(label, value, meta, caution) {
  const el = document.createElement('div');
  el.className = `windpanel-tile${caution ? ' windpanel-tile-caution' : ''}`;
  const l = document.createElement('span');
  l.className = 'windpanel-tile-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'windpanel-tile-value';
  v.textContent = value;
  el.append(l, v);
  if (meta) {
    const m = document.createElement('span');
    m.className = 'windpanel-tile-meta';
    m.textContent = meta;
    el.append(m);
  }
  return el;
}

function line(cls, text) {
  const p = document.createElement('p');
  p.className = cls;
  p.textContent = text;
  return p;
}

/**
 * @param {HTMLElement} host
 * @param {WindPanelModel|null} m  null hides the panel (no snapshot yet)
 * @param {{ open: boolean, onSelectHour: (i: number) => void }} opts
 */
export function renderWindPanel(host, m, { open, onSelectHour }) {
  host.hidden = !open || !m;
  if (host.hidden) { host.replaceChildren(); return; }

  // Selecting an hour re-plans and re-renders this panel; put the keyboard
  // back on the chip that was pressed rather than dropping it on <body>.
  const had = document.activeElement;
  const focusI = had instanceof HTMLElement && host.contains(had) ? had.dataset.i : undefined;

  const now = document.createElement('section');
  now.className = 'windpanel-now';

  const hero = document.createElement('div');
  hero.className = 'windpanel-hero';
  const figures = document.createElement('div');
  figures.className = 'windpanel-figures';
  const big = document.createElement('p');
  big.className = 'windpanel-big';
  const bigV = document.createElement('span');
  bigV.className = 'windpanel-big-value';
  bigV.textContent = m.hero.value;
  const bigU = document.createElement('span');
  bigU.className = 'windpanel-big-unit';
  bigU.textContent = ` ${m.hero.unit}`;
  big.append(bigV, bigU);
  figures.append(big, line('windpanel-dir', m.hero.dir), line('windpanel-level', m.hero.level));
  hero.append(figures, rose(m.windFromDeg));

  const tiles = document.createElement('div');
  tiles.className = 'windpanel-tiles';
  tiles.append(
    tile('Surface', m.surface.value, m.surface.meta, false),
    tile('Gusts', m.gust.value, m.gust.caution ? 'over the caution share' : null, m.gust.caution),
  );

  now.append(hero, tiles);

  if (m.outlook) {
    const o = document.createElement('div');
    o.className = 'windpanel-outlook';
    o.append(line('windpanel-outlook-title', 'Outlook'));
    if (m.outlook.banner) o.append(line('windpanel-banner', m.outlook.banner));
    const row = document.createElement('div');
    row.className = 'windpanel-hours';
    for (const c of m.outlook.chips) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `windpanel-hour${c.caution ? ' windpanel-hour-caution' : ''}`;
      b.dataset.i = String(c.i);
      b.setAttribute('aria-pressed', String(c.selected));
      b.setAttribute('aria-label', c.sr);
      const when = document.createElement('span');
      when.className = 'windpanel-hour-when';
      when.textContent = c.label;
      const wind = document.createElement('span');
      wind.className = 'windpanel-hour-wind';
      wind.textContent = c.wind ?? '—';
      b.append(when, wind);
      if (c.gust) {
        const g = document.createElement('span');
        g.className = 'windpanel-hour-gust';
        g.textContent = c.gust;
        b.append(g);
      }
      b.addEventListener('click', () => onSelectHour(c.i));
      row.append(b);
    }
    o.append(row);
    if (m.outlook.readout) o.append(line('windpanel-readout', m.outlook.readout));
    if (m.outlook.sun) o.append(line('windpanel-sun', m.outlook.sun));
    now.append(o);
  } else {
    now.append(line('windpanel-nodata', m.noOutlook ?? ''));
  }

  host.replaceChildren(now);
  if (focusI !== undefined) {
    /** @type {HTMLElement|null} */
    const again = host.querySelector(`[data-i="${focusI}"]`);
    again?.focus();
  }
}
