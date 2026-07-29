// charts.js — hand-rolled SVG charts: hairline grid, 2px lines, ≤24px bars with
// rounded data-ends, crosshair + tooltip hover layer. Colors come from CSS vars.

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function niceTicks(min, max, count = 5) {
  if (!isFinite(min) || !isFinite(max) || min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2.2 ? 5 : norm >= 1.2 ? 2 : 1) * mag;
  const lo = Math.ceil(min / step) * step;
  const ticks = [];
  for (let t = lo; t <= max + 1e-9; t += step) ticks.push(+t.toFixed(10));
  return ticks;
}

let tooltipEl = null;
function tooltip() {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'viz-tooltip';
    tooltipEl.setAttribute('role', 'status');
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

function showTooltip(x, y, rows, title) {
  const tip = tooltip();
  tip.replaceChildren();
  if (title) {
    const h = document.createElement('div');
    h.className = 'viz-tooltip-title';
    h.textContent = title;
    tip.appendChild(h);
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'viz-tooltip-row';
    const key = document.createElement('span');
    key.className = 'viz-tooltip-key';
    key.style.background = r.color || 'transparent';
    const val = document.createElement('strong');
    val.textContent = r.value;
    const lab = document.createElement('span');
    lab.className = 'viz-tooltip-label';
    lab.textContent = r.label;
    row.append(key, val, lab);
    tip.appendChild(row);
  }
  tip.style.display = 'block';
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const px = Math.min(x + 14, window.innerWidth - w - 8);
  const py = Math.max(y - h - 12, 8);
  tip.style.left = `${px}px`;
  tip.style.top = `${py}px`;
}

export function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = 'none';
}

const M = { top: 14, right: 18, bottom: 34, left: 52 };

function frame(container, height) {
  container.replaceChildren();
  const width = container.clientWidth || 560;
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height });
  container.appendChild(svg);
  return { svg, width, height, iw: width - M.left - M.right, ih: height - M.top - M.bottom };
}

function drawAxes(svg, xTicks, yTicks, xs, ys, opts = {}) {
  for (const t of yTicks) {
    const y = ys(t);
    svg.appendChild(svgEl('line', { x1: M.left, x2: M.left + opts.iw, y1: y, y2: y,
      stroke: 'var(--grid)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
    const lbl = svgEl('text', { x: M.left - 8, y: y + 3.5, 'text-anchor': 'end', class: 'viz-tick' });
    lbl.textContent = opts.yFmt ? opts.yFmt(t) : t;
    svg.appendChild(lbl);
  }
  const baseY = ys(yTicks[0] ?? 0);
  svg.appendChild(svgEl('line', { x1: M.left, x2: M.left + opts.iw, y1: baseY, y2: baseY,
    stroke: 'var(--baseline)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
  for (const t of xTicks) {
    const x = xs(t);
    const lbl = svgEl('text', { x, y: baseY + 16, 'text-anchor': 'middle', class: 'viz-tick' });
    lbl.textContent = opts.xFmt ? opts.xFmt(t) : t;
    svg.appendChild(lbl);
  }
  if (opts.xLabel) {
    const l = svgEl('text', { x: M.left + opts.iw / 2, y: baseY + 30, 'text-anchor': 'middle', class: 'viz-axis-label' });
    l.textContent = opts.xLabel;
    svg.appendChild(l);
  }
  if (opts.yLabel) {
    const l = svgEl('text', { x: M.left, y: M.top - 3, 'text-anchor': 'start', class: 'viz-axis-label' });
    l.textContent = opts.yLabel;
    svg.appendChild(l);
  }
}

/**
 * Multi-series line chart with crosshair + all-series tooltip.
 * series: [{ name, color, pts: [{x, y}] }]
 */
export function lineChart(container, { series, height = 240, xLabel, yLabel, xFmt, yFmt,
                                       markers = [], yMin = 0, tipTitle }) {
  const { svg, iw, ih } = frame(container, height);
  const allPts = series.flatMap(s => s.pts);
  if (!allPts.length) return;
  const xMin = Math.min(...allPts.map(p => p.x));
  const xMax = Math.max(...allPts.map(p => p.x));
  const yMaxV = Math.max(...allPts.map(p => p.y), ...markers.map(m => m.y ?? 0));
  const yTicks = niceTicks(yMin, yMaxV * 1.06);
  if (yTicks.length > 1) {
    const step = yTicks[1] - yTicks[0];
    while (yTicks[yTicks.length - 1] < yMaxV) yTicks.push(+(yTicks[yTicks.length - 1] + step).toFixed(10));
  }
  const yTop = yTicks[yTicks.length - 1];
  const xTicks = niceTicks(xMin, xMax, 6);
  const xs = x => M.left + (x - xMin) / (xMax - xMin || 1) * iw;
  const ys = y => M.top + ih - (y - yMin) / (yTop - yMin || 1) * ih;
  drawAxes(svg, xTicks, yTicks, xs, ys, { iw, xFmt, yFmt, xLabel, yLabel });

  for (const s of series) {
    const d = s.pts.map((p, i) => `${i ? 'L' : 'M'}${xs(p.x).toFixed(1)},${ys(p.y).toFixed(1)}`).join('');
    svg.appendChild(svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }
  for (const m of markers) {
    if (m.y == null) continue;
    svg.appendChild(svgEl('circle', { cx: xs(m.x), cy: ys(m.y), r: 4.5, fill: m.color,
      stroke: 'var(--surface-1)', 'stroke-width': 2 }));
    if (m.label) {
      const t = svgEl('text', { x: xs(m.x), y: ys(m.y) + (m.labelBelow ? 18 : -10),
        'text-anchor': 'middle', class: 'viz-marker-label' });
      t.textContent = m.label;
      svg.appendChild(t);
    }
  }

  // Crosshair + tooltip
  const cross = svgEl('line', { y1: M.top, y2: M.top + ih, stroke: 'var(--baseline)',
    'stroke-width': 1, visibility: 'hidden' });
  svg.appendChild(cross);
  const dots = series.map(s => {
    const d = svgEl('circle', { r: 4, fill: s.color, stroke: 'var(--surface-1)',
      'stroke-width': 2, visibility: 'hidden' });
    svg.appendChild(d);
    return d;
  });
  const hit = svgEl('rect', { x: M.left, y: M.top, width: iw, height: ih, fill: 'transparent' });
  svg.appendChild(hit);
  const nearestAt = (px) => {
    const xVal = xMin + (px - M.left) / iw * (xMax - xMin);
    return series.map(s => {
      let best = s.pts[0];
      for (const p of s.pts) if (Math.abs(p.x - xVal) < Math.abs(best.x - xVal)) best = p;
      return best;
    });
  };
  hit.addEventListener('pointermove', ev => {
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / svg.viewBox.baseVal.width;
    const px = (ev.clientX - rect.left) / scale;
    const pts = nearestAt(px);
    const snapX = xs(pts[0].x);
    cross.setAttribute('x1', snapX); cross.setAttribute('x2', snapX);
    cross.setAttribute('visibility', 'visible');
    pts.forEach((p, i) => {
      dots[i].setAttribute('cx', xs(p.x));
      dots[i].setAttribute('cy', ys(p.y));
      dots[i].setAttribute('visibility', 'visible');
    });
    showTooltip(ev.clientX, ev.clientY,
      series.map((s, i) => ({ color: s.color, value: yFmt ? yFmt(pts[i].y) : pts[i].y.toFixed(1), label: s.name })),
      (tipTitle || xLabel || 'x') + ': ' + (xFmt ? xFmt(pts[0].x) : pts[0].x.toFixed(1)));
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dots.forEach(d => d.setAttribute('visibility', 'hidden'));
    hideTooltip();
  });
}

/**
 * Horizontal bar panel. items: [{ label, value, color, note }]
 */
export function barChart(container, { items, height, valueFmt, maxValue }) {
  const rowH = 34, barH = 18;
  const h = height || items.length * rowH + M.top + 8;
  container.replaceChildren();
  const width = container.clientWidth || 560;
  const labelW = 132;
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${h}`, width: '100%', height: h });
  container.appendChild(svg);
  const iw = width - labelW - 76;
  const vMax = maxValue || Math.max(...items.map(i => i.value), 1e-9);

  items.forEach((it, idx) => {
    const y = M.top + idx * rowH;
    const w = Math.max(it.value / vMax * iw, 0);
    const lbl = svgEl('text', { x: labelW - 10, y: y + barH / 2 + 4, 'text-anchor': 'end', class: 'viz-bar-label' });
    lbl.textContent = it.label;
    svg.appendChild(lbl);
    const r = Math.min(4, w / 2);
    const bar = svgEl('path', {
      d: `M${labelW},${y} h${Math.max(w - r, 0)} a${r},${r} 0 0 1 ${r},${r} v${barH - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${Math.max(w - r, 0)} z`,
      fill: it.color, class: 'viz-bar' });
    svg.appendChild(bar);
    const val = svgEl('text', { x: labelW + w + 8, y: y + barH / 2 + 4, class: 'viz-bar-value' });
    val.textContent = valueFmt ? valueFmt(it.value) : it.value.toFixed(1);
    svg.appendChild(val);
    const hit = svgEl('rect', { x: 0, y: y - (rowH - barH) / 2, width, height: rowH, fill: 'transparent' });
    hit.addEventListener('pointermove', ev => {
      bar.classList.add('is-hover');
      showTooltip(ev.clientX, ev.clientY,
        [{ color: it.color, value: valueFmt ? valueFmt(it.value) : it.value, label: it.note || it.label }], it.label);
    });
    hit.addEventListener('pointerleave', () => { bar.classList.remove('is-hover'); hideTooltip(); });
    svg.appendChild(hit);
  });
}

/**
 * Mission profile — two stacked panels sharing the time axis:
 * top: battery % remaining (line + 10% area wash, turnaround marker)
 * bottom: pack voltage under load, with cutoff hairline.
 */
export function missionProfile(container, {
  timeline, cutoffV, reservePct, height = 300, colorSoc, colorV,
  distanceFromKm = km => km, distanceUnit = 'km',
}) {
  container.replaceChildren();
  if (!timeline.length) return;
  const width = container.clientWidth || 560;
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height });
  container.appendChild(svg);
  const iw = width - M.left - M.right;
  const gap = 30;
  const phTop = (height - M.top - M.bottom - gap) * 0.55;
  const phBot = (height - M.top - M.bottom - gap) * 0.45;
  const tMax = timeline[timeline.length - 1].tMin;
  const xs = t => M.left + t / (tMax || 1) * iw;
  const turn = timeline.find(p => p.phase === 'back');

  // --- SoC panel ---
  const y0 = M.top;
  const ysS = v => y0 + phTop - (v / 100) * phTop;
  for (const t of [0, 25, 50, 75, 100]) {
    svg.appendChild(svgEl('line', { x1: M.left, x2: M.left + iw, y1: ysS(t), y2: ysS(t),
      stroke: 'var(--grid)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
    const lbl = svgEl('text', { x: M.left - 8, y: ysS(t) + 3.5, 'text-anchor': 'end', class: 'viz-tick' });
    lbl.textContent = `${t}%`;
    svg.appendChild(lbl);
  }
  const title1 = svgEl('text', { x: M.left, y: y0 - 3, class: 'viz-axis-label' });
  title1.textContent = 'Battery remaining';
  svg.appendChild(title1);
  const line = timeline.map((p, i) => `${i ? 'L' : 'M'}${xs(p.tMin).toFixed(1)},${ysS(p.soc).toFixed(1)}`).join('');
  svg.appendChild(svgEl('path', {
    d: `${line}L${xs(tMax)},${ysS(0)}L${xs(0)},${ysS(0)}Z`, fill: colorSoc, opacity: 0.1 }));
  svg.appendChild(svgEl('path', { d: line, fill: 'none', stroke: colorSoc, 'stroke-width': 2,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  if (reservePct > 0) {
    svg.appendChild(svgEl('line', { x1: M.left, x2: M.left + iw, y1: ysS(reservePct), y2: ysS(reservePct),
      stroke: 'var(--status-serious)', 'stroke-width': 1, 'stroke-dasharray': '1 3' }));
    const rl = svgEl('text', { x: M.left + iw, y: ysS(reservePct) - 4, 'text-anchor': 'end', class: 'viz-marker-label' });
    rl.textContent = `${reservePct.toFixed(0)}% reserve`;
    svg.appendChild(rl);
  }

  // --- Voltage panel ---
  const y1 = M.top + phTop + gap;
  const vVals = timeline.map(p => p.vLoad).filter(v => isFinite(v));
  const vLo = Math.min(...vVals, cutoffV) - 0.3;
  const vHi = Math.max(...vVals) + 0.3;
  const ysV = v => y1 + phBot - (v - vLo) / (vHi - vLo || 1) * phBot;
  for (const t of niceTicks(vLo, vHi, 4).filter(t => t >= vLo && t <= vHi)) {
    svg.appendChild(svgEl('line', { x1: M.left, x2: M.left + iw, y1: ysV(t), y2: ysV(t),
      stroke: 'var(--grid)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
    const lbl = svgEl('text', { x: M.left - 8, y: ysV(t) + 3.5, 'text-anchor': 'end', class: 'viz-tick' });
    lbl.textContent = `${t.toFixed(1)}V`;
    svg.appendChild(lbl);
  }
  const title2 = svgEl('text', { x: M.left, y: y1 - 3, class: 'viz-axis-label' });
  title2.textContent = 'Pack voltage under load';
  svg.appendChild(title2);
  const vLine = timeline.filter(p => isFinite(p.vLoad))
    .map((p, i) => `${i ? 'L' : 'M'}${xs(p.tMin).toFixed(1)},${ysV(p.vLoad).toFixed(1)}`).join('');
  svg.appendChild(svgEl('path', { d: vLine, fill: 'none', stroke: colorV, 'stroke-width': 2,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  svg.appendChild(svgEl('line', { x1: M.left, x2: M.left + iw, y1: ysV(cutoffV), y2: ysV(cutoffV),
    stroke: 'var(--status-critical)', 'stroke-width': 1, 'stroke-dasharray': '1 3' }));
  const cl = svgEl('text', { x: M.left + iw, y: ysV(cutoffV) - 4, 'text-anchor': 'end', class: 'viz-marker-label' });
  cl.textContent = 'cutoff';
  svg.appendChild(cl);

  // Turnaround marker across both panels
  if (turn) {
    const tx = xs(turn.tMin);
    svg.appendChild(svgEl('line', { x1: tx, x2: tx, y1: M.top, y2: y1 + phBot,
      stroke: 'var(--baseline)', 'stroke-width': 1 }));
    const tl = svgEl('text', { x: tx, y: M.top - 3, 'text-anchor': 'middle', class: 'viz-marker-label' });
    tl.textContent = 'turnaround';
    svg.appendChild(tl);
  }

  // X ticks (minutes)
  const baseY = y1 + phBot;
  svg.appendChild(svgEl('line', { x1: M.left, x2: M.left + iw, y1: baseY, y2: baseY,
    stroke: 'var(--baseline)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
  for (const t of niceTicks(0, tMax, 6)) {
    const lbl = svgEl('text', { x: xs(t), y: baseY + 16, 'text-anchor': 'middle', class: 'viz-tick' });
    lbl.textContent = `${t.toFixed(0)}m`;
    svg.appendChild(lbl);
  }

  // Crosshair spanning both panels
  const cross = svgEl('line', { y1: M.top, y2: baseY, stroke: 'var(--baseline)', 'stroke-width': 1, visibility: 'hidden' });
  svg.appendChild(cross);
  const hit = svgEl('rect', { x: M.left, y: M.top, width: iw, height: baseY - M.top, fill: 'transparent' });
  svg.appendChild(hit);
  hit.addEventListener('pointermove', ev => {
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / width;
    const px = (ev.clientX - rect.left) / scale;
    const tVal = (px - M.left) / iw * tMax;
    let best = timeline[0];
    for (const p of timeline) if (Math.abs(p.tMin - tVal) < Math.abs(best.tMin - tVal)) best = p;
    const sx = xs(best.tMin);
    cross.setAttribute('x1', sx); cross.setAttribute('x2', sx);
    cross.setAttribute('visibility', 'visible');
    showTooltip(ev.clientX, ev.clientY, [
      { color: colorSoc, value: `${best.soc.toFixed(0)}%`, label: 'battery remaining' },
      { color: colorV, value: isFinite(best.vLoad) ? `${best.vLoad.toFixed(1)}V` : '—', label: 'under load' },
      { color: 'transparent', value: `${distanceFromKm(best.distKm).toFixed(1)} ${distanceUnit}`, label: best.phase === 'out' ? 'outbound' : 'returning' },
    ], `T+${best.tMin.toFixed(1)} min`);
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTooltip(); });
}

/** Legend row — line keys for line charts. */
export function legend(container, series) {
  container.replaceChildren();
  for (const s of series) {
    const item = document.createElement('span');
    item.className = 'viz-legend-item';
    const key = document.createElement('span');
    key.className = 'viz-legend-key';
    key.style.background = s.color;
    const name = document.createElement('span');
    name.textContent = s.name;
    item.append(key, name);
    container.appendChild(item);
  }
}
