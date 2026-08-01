// components/wind-panel.js — the WindRibbon's expansion (design evolution M11):
// press the ribbon and the sky unfolds under it, on every destination. Three
// segments: Now (W-01 — the wind now, the surface and gust beside it, a
// compass rose, and the hourly outlook for choosing a flight window), the
// altitude ladder (W-02), and heading exposure (W-03).
//
// Not one figure here is the panel's own. The hero is the same planning wind
// the ribbon compresses, the surface line is the rail's launch-wind sentence
// as a tile, and the outlook chips are faces on the forecast scrubber's state
// — pressing one calls the scrubber's own handler, so the rail slider, the
// honesty banner and this panel can never disagree about which sky the app is
// planning against.
import { svgEl } from '../charts.js';
import { state, units, beginner } from '../state.js';
import { compass, f0, f1 } from '../render/format.js';
import { U, legVecsFromCourse } from '../domain/physics.js';
import { GUST_SHARE_CAUTION } from '../render/dashboard.js';
import {
  launchWind, activeWindAt, windLevels, windSounding, peakShear, CRUISE_ALTS_M,
} from '../windprofile.js';
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
 * @typedef {object} LadderRow
 * @property {number} altM
 * @property {string} label     '80 m'
 * @property {string|null} wind '18 mph · SSW', null when the level has no reading
 * @property {number|null} dirDeg
 * @property {number|null} tempF  rounded, when the forecast published one there
 * @property {boolean} active  the planning level — where state.cruiseAltM sits
 * @property {string} sr       full spoken form
 *
 * @typedef {object} AltitudeModel
 * @property {LadderRow[]} rows
 * @property {boolean} canSet  false in beginner detail, which pins the level
 * @property {string|null} hint  which sky the ladder describes, when not "now"
 * @property {string|null} shear peak-shear footer line, null under two readings
 * @property {{ label: string, wind: string, tempF: number }[]} sounding
 * @property {string|null} noLadder  why there are no rungs, when there are none
 *
 * @typedef {object} HeadingLeg
 * @property {string} name     'Out' | 'Home'
 * @property {string} course   '192° SSW'
 * @property {string} figures  ground speed, wind components, burn — one line
 *
 * @typedef {object} HeadingRow
 * @property {string} mode     the rail select's own value: headOut | cross | tailOut
 * @property {string} label    'Into the wind'
 * @property {string} course   '192°', or both cross courses
 * @property {string} reach    out-and-back reach on that course, formatted
 * @property {boolean} active  the outbound leg the plan flies
 * @property {string} sr       full spoken form
 *
 * @typedef {object} HeadingsModel
 * @property {HeadingLeg[]} legs   outbound and home, [] when no leg closes
 * @property {string|null} strand  why there are no legs, when the craft flies
 * @property {HeadingRow[]} rows
 * @property {string|null} hint    which sky the exposure describes, off "now"
 * @property {string|null} noHeadings  why there is nothing here at all
 *
 * @typedef {object} WindPanelModel
 * @property {{ value: string, unit: string, dir: string, level: string }} hero
 * @property {{ value: string, meta: string }} surface
 * @property {{ value: string, caution: boolean }} gust
 * @property {number} windFromDeg
 * @property {{ chips: OutlookChip[], banner: string|null, readout: string|null,
 *              sun: string|null }|null} outlook
 * @property {string|null} noOutlook  why there is no outlook, when there is none
 * @property {AltitudeModel} altitude  the W-02 segment
 * @property {HeadingsModel} headings  the W-03 segment
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

/** The reason a wind surface has nothing to show, named for the actual sky. */
function whyNoLive(what) {
  return state.weatherId === 'live'
    ? `No ${what} — live weather hasn’t answered for this launch point.`
    : state.weatherId === 'custom'
      ? `No ${what} for hand-entered conditions — switch Weather to Live for one.`
      : `No ${what} for a preset sky — switch Weather to Live for one.`;
}

/**
 * W-02's model: the ladder the cruise-altitude select already climbs, laid out
 * as rungs. Off the Now step it reads the audited hour's own profile — the
 * same per-hour levels reapplyForecastHour() plans on — so the ladder never
 * shows today's wind under tomorrow's banner.
 * @param {ReturnType<typeof forecastOutlook>} o
 * @returns {AltitudeModel}
 */
function altitudeModelFrom(o) {
  const u = units();
  const spd = (/** @type {number} */ mph) => `${f0(u.speedFromMph(mph))} ${u.speedUnit}`;
  const offNow = !!o && o.selected !== o.now;
  const hr = offNow ? o.hours[o.selected] : null;
  const src = hr ? (hr.levels ?? null) : windLevels();

  const rows = CRUISE_ALTS_M.map((m) => {
    const lvl = src && Number.isFinite(src[m]?.windMph) && Number.isFinite(src[m]?.windFromDeg)
      ? src[m] : null;
    const active = m === state.cruiseAltM;
    const wind = lvl ? `${spd(lvl.windMph)} · ${compass(lvl.windFromDeg)}` : null;
    return {
      altM: m,
      label: `${m} m`,
      wind,
      dirDeg: lvl ? lvl.windFromDeg : null,
      tempF: lvl && Number.isFinite(lvl.tempC) ? Math.round(U.cToF(lvl.tempC)) : null,
      active,
      sr: `${m} m — ${wind ?? 'no reading'}${active ? ' · planning level' : ''}`,
    };
  });

  if (!rows.some((r) => r.wind)) {
    return {
      rows: [], canSet: false, hint: null, shear: null, sounding: [],
      noLadder: whyNoLive('wind profile'),
    };
  }

  const hints = [];
  if (hr) hints.push(`Profile for ${hourName(hr.time)}`);
  if (beginner()) hints.push('Beginner detail plans 80 m');

  const s = peakShear(src);
  const parts = [];
  if (s && s.dSpeedMph) {
    parts.push(`${s.dSpeedMph > 0 ? '+' : '−'}${f0(u.speedFromMph(Math.abs(s.dSpeedMph)))} ${u.speedUnit}`);
  }
  if (s && s.veerDeg) parts.push(`${s.veerDeg > 0 ? 'veers' : 'backs'} ${f0(Math.abs(s.veerDeg))}°`);

  const sounding = (hr ? (hr.sounding ?? []) : windSounding()).map((lv) => ({
    label: `${lv.hPa} hPa · ${(lv.heightM / 1000).toFixed(1)} km`,
    wind: `${spd(lv.windMph)} · ${compass(lv.windFromDeg)}`,
    tempF: Math.round(U.cToF(lv.tempC)),
  }));

  return {
    rows,
    canSet: !beginner(),
    hint: hints.length ? hints.join(' · ') : null,
    shear: parts.length ? `Biggest change ${s.fromM}→${s.toM} m: ${parts.join(', ')}` : null,
    sounding,
    noLadder: null,
  };
}

/**
 * W-03's model: the planned course decomposed leg by leg, and the three
 * wind-relative courses with the out-and-back reach the footprint sweep
 * already computed for each. Tapping a row walks the rail's outbound-leg
 * select path, so this segment is that control with its consequences printed.
 *
 * The wind components come off legVecsFromCourse — the same decomposition the
 * sweep and the route integrator use — at the plan's own planning wind, and
 * the speeds and burn are the solved legs' own numbers, not a re-derivation.
 * @param {import('../application/analysis/analysis-contracts.js').AnalysisSnapshot|null} snapshot
 * @param {ReturnType<typeof forecastOutlook>} o
 * @returns {HeadingsModel}
 */
function headingsModelFrom(snapshot, o) {
  const u = units();
  const r = snapshot?.plan ?? null;
  const fp = snapshot?.footprint ?? null;
  const none = (/** @type {string} */ why) =>
    ({ legs: [], strand: null, rows: [], hint: null, noHeadings: why });
  if (!r || 'code' in r) return none('No heading picture — pick an aircraft and pack first.');
  if (r.flight && !r.flight.viable) return none('Nothing lifts off in this setup — no heading is flyable.');
  if (!fp) return none('No heading picture — the footprint hasn’t swept yet.');

  const spdMs = (/** @type {number} */ ms) => `${f0(u.speedFromMs(ms))} ${u.speedUnit}`;
  const dist = (/** @type {number} */ km) =>
    `${u.distanceFromKm(km).toFixed(1)} ${u.distanceUnit}`;
  // The wind axis rounded to the whole degree the courses quote — the same
  // rounding the Analyze footprint tiles apply.
  const upC = ((Math.round(fp.windFromDeg) % 360) + 360) % 360;

  const rows = [
    { mode: 'headOut', label: 'Into the wind', course: `${upC}°`, reachKm: fp.upwindKm },
    { mode: 'cross', label: 'Crosswind', course: `${(upC + 90) % 360}° / ${(upC + 270) % 360}°`,
      reachKm: fp.crosswindKm },
    { mode: 'tailOut', label: 'Downwind out', course: `${(upC + 180) % 360}°`, reachKm: fp.downwindKm },
  ].map((row) => {
    const active = state.env.windMode === row.mode;
    return {
      mode: row.mode, label: row.label, course: row.course, reach: dist(row.reachKm), active,
      sr: `${row.label} — course ${row.course} — out-and-back reach `
        + `${dist(row.reachKm)}${active ? ' · planned' : ''}`,
    };
  });

  /** @type {HeadingLeg[]} */
  const legs = [];
  let strand = null;
  const out = r.legs?.out, back = r.legs?.back;
  if (out && back && r.radiusKm > 0) {
    const vecs = legVecsFromCourse(fp.plannedCourseDeg, fp.windFromDeg, r.wind.planningMs);
    const wind = (/** @type {{ head: number, cross: number }} */ vec) => {
      const parts = [];
      // Components that round to 0 in the pilot's units stay unprinted — a
      // "headwind 0 mph" is noise, not honesty.
      if (vec.head && f0(u.speedFromMs(Math.abs(vec.head))) !== '0') {
        parts.push(`${vec.head > 0 ? 'headwind' : 'tailwind'} ${spdMs(Math.abs(vec.head))}`);
      }
      if (vec.cross && f0(u.speedFromMs(vec.cross)) !== '0') parts.push(`crosswind ${spdMs(vec.cross)}`);
      return parts.length ? parts.join(' · ') : 'calm air';
    };
    const leg = (/** @type {string} */ name, /** @type {number} */ courseDeg,
      /** @type {{ vg: number, whPerKm: number }} */ sol,
      /** @type {{ head: number, cross: number }} */ vec) => ({
      name,
      course: `${f0(courseDeg)}° ${compass(courseDeg)}`,
      figures: `${spdMs(sol.vg)} over ground · ${wind(vec)}`
        + ` · ${f1(u.burnFromWhPerKm(sol.whPerKm))} ${u.burnUnit}`,
    });
    legs.push(
      leg('Out', fp.plannedCourseDeg, out, vecs[0]),
      leg('Home', (fp.plannedCourseDeg + 180) % 360, back, vecs[1]),
    );
  } else {
    strand = 'No out-and-back closes in this wind — nothing gets home.';
  }

  return {
    legs, strand, rows,
    hint: o && o.selected !== o.now ? `Exposure for ${hourName(o.hours[o.selected].time)}` : null,
    noHeadings: null,
  };
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
    return {
      hero, surface, gust, windFromDeg: env.windFromDeg,
      outlook: null, noOutlook: whyNoLive('hourly outlook'),
      altitude: altitudeModelFrom(null), headings: headingsModelFrom(snapshot, null),
    };
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
    altitude: altitudeModelFrom(o),
    headings: headingsModelFrom(snapshot, o),
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

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

/** A rung's flow arrow: the rose's arrow at ladder scale, same accent classes. */
function arrow(deg) {
  const svg = svgEl('svg', { class: 'windpanel-level-arrow', viewBox: '0 0 20 20' });
  svg.setAttribute('aria-hidden', 'true');
  const g = svgEl('g', { transform: `rotate(${deg} 10 10)` });
  g.appendChild(svgEl('line', { x1: 10, y1: 4, x2: 10, y2: 13, class: 'windpanel-rose-shaft' }));
  g.appendChild(svgEl('path', { d: 'M7 12 L10 17 L13 12 Z', class: 'windpanel-rose-head' }));
  svg.appendChild(g);
  return svg;
}

/** The W-02 segment: the ladder, its shear footer, and the sounding aloft. */
function altitudeSection(a, onSelectLevel) {
  const sec = document.createElement('section');
  sec.className = 'windpanel-altitude';
  if (a.noLadder) {
    sec.append(line('windpanel-nodata', a.noLadder));
    return sec;
  }
  if (a.hint) sec.append(line('windpanel-hint', a.hint));
  const ladder = document.createElement('div');
  ladder.className = 'windpanel-ladder';
  // Highest rung on top — the ladder reads like the sky it describes. In
  // beginner detail the rungs are facts, not controls, matching the rail
  // (which hides the cruise-altitude select entirely there).
  for (const r of [...a.rows].reverse()) {
    const el = document.createElement(a.canSet ? 'button' : 'div');
    el.className = `windpanel-level${r.active ? ' windpanel-level-active' : ''}`;
    if (el instanceof HTMLButtonElement) {
      el.type = 'button';
      el.dataset.i = `L${r.altM}`;
      el.setAttribute('aria-pressed', String(r.active));
      el.setAttribute('aria-label', r.sr);
      el.addEventListener('click', () => onSelectLevel(r.altM));
    }
    el.append(span('windpanel-level-alt', r.label));
    el.append(r.dirDeg == null ? span('windpanel-level-arrow', '') : arrow(r.dirDeg));
    el.append(span('windpanel-level-wind', r.wind ?? '—'));
    if (r.tempF != null) el.append(span('windpanel-level-temp', `${r.tempF}°F`));
    ladder.append(el);
  }
  sec.append(ladder);
  if (a.shear) sec.append(line('windpanel-shear', a.shear));
  if (a.sounding.length) {
    sec.append(line('windpanel-outlook-title', 'Aloft'));
    const list = document.createElement('div');
    list.className = 'windpanel-sounding';
    for (const s of a.sounding) {
      const row = document.createElement('div');
      row.className = 'windpanel-sounding-row';
      row.append(
        span('windpanel-sounding-label', s.label),
        span('windpanel-sounding-wind', s.wind),
        span('windpanel-sounding-temp', `${s.tempF}°F`),
      );
      list.append(row);
    }
    sec.append(list);
  }
  return sec;
}

/** The W-03 segment: the planned course leg by leg, then reach by course. */
function headingsSection(h, onSelectMode) {
  const sec = document.createElement('section');
  sec.className = 'windpanel-headings';
  if (h.noHeadings) {
    sec.append(line('windpanel-nodata', h.noHeadings));
    return sec;
  }
  if (h.hint) sec.append(line('windpanel-hint', h.hint));
  sec.append(line('windpanel-outlook-title', 'Planned course'));
  if (h.legs.length) {
    for (const l of h.legs) {
      const leg = document.createElement('div');
      leg.className = 'windpanel-leg';
      const head = document.createElement('div');
      head.className = 'windpanel-leg-head';
      head.append(span('windpanel-leg-name', l.name), span('windpanel-leg-course', l.course));
      leg.append(head, line('windpanel-leg-figures', l.figures));
      sec.append(leg);
    }
  } else {
    sec.append(line('windpanel-strand', h.strand ?? ''));
  }
  sec.append(line('windpanel-outlook-title', 'Reach by course'));
  const rows = document.createElement('div');
  rows.className = 'windpanel-headingrows';
  for (const r of h.rows) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'windpanel-heading';
    b.dataset.i = `H${r.mode}`;
    b.setAttribute('aria-pressed', String(r.active));
    b.setAttribute('aria-label', r.sr);
    b.addEventListener('click', () => onSelectMode(r.mode));
    b.append(
      span('windpanel-heading-label', r.label),
      span('windpanel-heading-course', r.course),
      span('windpanel-heading-reach', r.reach),
    );
    rows.append(b);
  }
  sec.append(rows);
  return sec;
}

/** The panel's segments — one tab per W-01…W-03 surface (M11). */
const SEGS = [
  { id: 'now', label: 'Now' },
  { id: 'altitude', label: 'Altitude' },
  { id: 'headings', label: 'Headings' },
];

/**
 * @param {HTMLElement} host
 * @param {WindPanelModel|null} m  null hides the panel (no snapshot yet)
 * @param {{ open: boolean, seg: string, onSelectSeg: (id: string) => void,
 *           onSelectHour: (i: number) => void,
 *           onSelectLevel: (m: number) => void,
 *           onSelectMode: (mode: string) => void,
 *           onOpenMap: () => void }} opts
 */
export function renderWindPanel(host, m,
  { open, seg = 'now', onSelectSeg, onSelectHour, onSelectLevel, onSelectMode, onOpenMap }) {
  host.hidden = !open || !m;
  if (host.hidden) { host.replaceChildren(); return; }

  // Selecting an hour or a level re-plans and re-renders this panel; put the
  // keyboard back on the control that was pressed rather than dropping it on
  // <body>.
  const had = document.activeElement;
  const focusI = had instanceof HTMLElement && host.contains(had) ? had.dataset.i : undefined;

  const bar = document.createElement('div');
  bar.className = 'windpanel-segs';
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', 'Wind detail segments');
  for (const s of SEGS) {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = 'windpanel-seg';
    t.setAttribute('role', 'tab');
    t.setAttribute('aria-selected', String(s.id === seg));
    t.setAttribute('aria-controls', 'windpanel-view');
    if (s.id !== seg) t.tabIndex = -1;
    t.dataset.i = `seg-${s.id}`;
    t.textContent = s.label;
    t.addEventListener('click', () => onSelectSeg(s.id));
    bar.append(t);
  }

  const view = seg === 'altitude' ? altitudeSection(m.altitude, onSelectLevel)
    : seg === 'headings' ? headingsSection(m.headings, onSelectMode)
    : nowSection(m, onSelectHour);
  view.id = 'windpanel-view';
  view.setAttribute('role', 'tabpanel');

  // W-04's door: every number above, in route context. On every segment,
  // because "how does this sit over my route" is the question they all raise.
  const mapBtn = document.createElement('button');
  mapBtn.type = 'button';
  mapBtn.className = 'windpanel-openmap';
  mapBtn.dataset.i = 'openmap';
  mapBtn.textContent = 'Open wind map';
  mapBtn.addEventListener('click', () => onOpenMap());

  host.replaceChildren(bar, view, mapBtn);
  if (focusI !== undefined) {
    /** @type {HTMLElement|null} */
    const again = host.querySelector(`[data-i="${focusI}"]`);
    again?.focus();
  }
}

/** The W-01 segment: hero, surface and gust tiles, and the hourly outlook. */
function nowSection(m, onSelectHour) {
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

  return now;
}
