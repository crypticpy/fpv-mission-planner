// components/forecast-chart.js — the L-03 forecast day as one picture: the
// wind line over its gust band (one mph scale), rain bars on their own
// percent scale below, and the golden-hour strip under both, all sharing one
// time axis with a scrub cursor. Pure DOM over a model, the contract
// recovery-entry.js and mission-card.js draw under: the caller resolves every
// number (including which altitude's wind this is) and owns what picking an
// hour means; this module only draws.
//
// The SVG is decorative (aria-hidden): the caller's reading line and range
// input say everything this picture shows, in words a screen reader gets.
// Colors follow the app's fixed series order — wind is series-1 everywhere it
// is drawn, gust series-2, rain series-3, and the golden hour wears series-4 —
// so a pilot who learned the legend once keeps it across days and heights.
// No per-hour direction arrows or value labels: the scrub cursor plus the
// reading line answer "what exactly is this hour" without 24 tiny glyphs.

const SVG_NS = 'http://www.w3.org/2000/svg';

const W = 640;
const H = 208;
const PAD_L = 34;
const PAD_R = 10;
const MPH_TOP = 10;
const MPH_BOT = 106;
const RAIN_TOP = 122;
const RAIN_BOT = 158;
const GOLD_TOP = 168;
const GOLD_BOT = 176;
const LABEL_Y = 196;

/** @param {string} tag @param {Record<string, string|number>} attrs */
function el(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** @param {number} n number of hours */
const xAt = (n) => (i) => n < 2 ? (PAD_L + W - PAD_R) / 2 : PAD_L + (i * (W - PAD_L - PAD_R)) / (n - 1);

/**
 * Polyline segments for a per-hour series, split where the model has no
 * reading — a null is a gap in the line, never a bridge drawn across it.
 * @param {(number|null)[]} values
 * @param {(i: number) => number} x
 * @param {(v: number) => number} y
 * @returns {string[]} one points-attribute string per unbroken run
 */
function segments(values, x, y) {
  const runs = [];
  let run = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (run.length > 1) runs.push(run.join(' '));
      run = [];
      return;
    }
    run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (run.length > 1) runs.push(run.join(' '));
  return runs;
}

/**
 * @typedef {object} ForecastChartModel
 * @property {{ time: Date, windMph: number|null, gustMph: number|null,
 *   precipPct: number|null }[]} hours  one forecast day, already resolved to
 *   the altitude the caller is showing
 * @property {{ goldenStart: Date, sunset: Date }|null} golden
 * @property {number} selected  index of the hour under the cursor
 * @property {(d: Date) => string} label  tick formatter — the caller's own
 *   clock spelling, so the axis and its reading line never disagree
 * @property {(i: number) => void} onPick  an hour was chosen on the picture;
 *   the caller re-renders and speaks the new reading
 */

/**
 * @param {ForecastChartModel} model
 * @returns {HTMLElement}
 */
export function forecastChart(model) {
  const host = document.createElement('div');
  host.className = 'forecast-chart';
  const { hours } = model;
  const n = hours.length;
  const svg = el('svg', { class: 'forecast-chart-svg', viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
  host.appendChild(svg);
  if (!n) return host;

  const x = xAt(n);
  const gustMax = Math.max(20, ...hours.map((h) => h.gustMph ?? 0), ...hours.map((h) => h.windMph ?? 0));
  const mphMax = Math.ceil(gustMax / 10) * 10;
  const yMph = (v) => MPH_BOT - ((MPH_BOT - MPH_TOP) * Math.min(v, mphMax)) / mphMax;
  const yRain = (v) => RAIN_BOT - ((RAIN_BOT - RAIN_TOP) * Math.min(v, 100)) / 100;

  // Scaffolding: a baseline under each panel, one mid gridline and the axis
  // figures for the mph scale, recessive by token.
  for (const v of [mphMax, mphMax / 2]) {
    svg.appendChild(el('line', { class: 'fc-grid', x1: PAD_L, y1: yMph(v), x2: W - PAD_R, y2: yMph(v) }));
    const t = el('text', { class: 'fc-axis', x: PAD_L - 4, y: yMph(v) + 3, 'text-anchor': 'end' });
    t.textContent = String(v);
    svg.appendChild(t);
  }
  svg.appendChild(el('line', { class: 'fc-base', x1: PAD_L, y1: MPH_BOT, x2: W - PAD_R, y2: MPH_BOT }));
  svg.appendChild(el('line', { class: 'fc-base', x1: PAD_L, y1: RAIN_BOT, x2: W - PAD_R, y2: RAIN_BOT }));

  // The gust band: filled from the baseline, drawn first so the wind line
  // rides on top of it. Split on gaps the same way the line is.
  let band = [];
  const flushBand = () => {
    if (band.length > 1) {
      const first = band[0];
      const last = band[band.length - 1];
      const poly = el('polygon', {
        class: 'fc-gust',
        points: `${first.x.toFixed(1)},${MPH_BOT} ${band.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} ${last.x.toFixed(1)},${MPH_BOT}`,
      });
      svg.appendChild(poly);
    }
    band = [];
  };
  hours.forEach((h, i) => {
    if (h.gustMph == null) { flushBand(); return; }
    band.push({ x: x(i), y: yMph(h.gustMph) });
  });
  flushBand();

  for (const points of segments(hours.map((h) => h.windMph), x, yMph)) {
    svg.appendChild(el('polyline', { class: 'fc-wind', points }));
  }

  // Rain bars on their own percent scale — never the mph axis (one axis per
  // panel; two measures of different scale get two panels).
  const barW = Math.min(10, ((W - PAD_L - PAD_R) / Math.max(n - 1, 1)) * 0.6);
  hours.forEach((h, i) => {
    if (h.precipPct == null || h.precipPct <= 0) return;
    svg.appendChild(el('rect', {
      class: 'fc-rain',
      x: x(i) - barW / 2, y: yRain(h.precipPct),
      width: barW, height: RAIN_BOT - yRain(h.precipPct),
    }));
  });

  // The golden-hour strip: a muted track for the day, the last hour of light
  // in series-4 gold. Time maps by interpolation across the day's hours.
  const t0 = hours[0].time.getTime();
  const t1 = hours[n - 1].time.getTime();
  svg.appendChild(el('rect', {
    class: 'fc-gold-track', x: PAD_L, y: GOLD_TOP, width: W - PAD_L - PAD_R, height: GOLD_BOT - GOLD_TOP,
  }));
  if (model.golden && t1 > t0) {
    const xOf = (t) => PAD_L + ((W - PAD_L - PAD_R) * Math.min(Math.max((t - t0) / (t1 - t0), 0), 1));
    const gx0 = xOf(model.golden.goldenStart.getTime());
    const gx1 = xOf(model.golden.sunset.getTime());
    if (gx1 > gx0) {
      svg.appendChild(el('rect', {
        class: 'fc-gold', x: gx0, y: GOLD_TOP, width: gx1 - gx0, height: GOLD_BOT - GOLD_TOP,
      }));
    }
  }

  // Hour ticks every fourth hour, in the caller's own clock spelling.
  hours.forEach((h, i) => {
    if (i % 4 !== 0) return;
    const t = el('text', { class: 'fc-axis', x: x(i), y: LABEL_Y, 'text-anchor': 'middle' });
    t.textContent = model.label(h.time);
    svg.appendChild(t);
  });

  // The scrub cursor: a line through every panel and a dot on the wind line.
  // The component moves its own cursor when an hour is picked on it, so a drag
  // never needs the caller to rebuild the SVG mid-gesture (which would tear the
  // pointer capture out from under the scrub).
  const cursor = el('line', { class: 'fc-cursor', x1: 0, y1: MPH_TOP - 4, x2: 0, y2: GOLD_BOT + 4 });
  const dot = el('circle', { class: 'fc-cursor-dot', cx: 0, cy: 0, r: 3.5 });
  svg.append(cursor, dot);
  const moveCursor = (i) => {
    const cx = x(i);
    cursor.setAttribute('x1', cx.toFixed(1));
    cursor.setAttribute('x2', cx.toFixed(1));
    const wind = hours[i].windMph;
    dot.setAttribute('visibility', wind == null ? 'hidden' : 'visible');
    if (wind != null) {
      dot.setAttribute('cx', cx.toFixed(1));
      dot.setAttribute('cy', yMph(wind).toFixed(1));
    }
  };
  moveCursor(Math.min(Math.max(model.selected, 0), n - 1));

  // Picking on the picture: nearest hour to the pointer, on press or drag.
  const pick = (ev) => {
    const rect = svg.getBoundingClientRect();
    const fx = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.min(Math.max(Math.round(((fx - PAD_L) / (W - PAD_L - PAD_R)) * (n - 1)), 0), n - 1);
    moveCursor(i);
    model.onPick(i);
  };
  svg.addEventListener('pointerdown', (ev) => { svg.setPointerCapture(ev.pointerId); pick(ev); });
  svg.addEventListener('pointermove', (ev) => { if (ev.buttons) pick(ev); });

  return host;
}
