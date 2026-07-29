// app.js — control state, mission computation, and render orchestration.
import {
  DRONES, PAYLOADS, WEATHER, SCENARIOS,
  allBatteries, saveCustomBattery, deleteCustomBattery,
  allManufacturers, saveCustomManufacturer, deleteCustomManufacturer,
} from './data.js';
import { planMission, CHEMISTRY, U } from './physics.js';
import { lineChart, barChart, missionProfile, legend, hideTooltip } from './charts.js';
import { unitSystem } from './units.js';
import { setupMapView, showMapView, renderMapView } from './map.js';

const $ = (id) => document.getElementById(id);
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
const f0 = (x) => isFinite(x) ? x.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
const f1 = (x) => isFinite(x) ? x.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 }) : '—';

const state = {
  view: 'dash', // 'dash' | 'map' — session-only, never persisted
  units: 'imperial',
  droneId: 'moz7v2',
  manufacturerId: 'all',
  batteryId: 'nav5000',
  payloadId: 'naked',
  extraG: 0,
  weatherId: 'calm',
  scenarioId: 'longrange',
  env: { elevFt: 800, tempF: 75, rhPct: 40, windMph: 3, gustMph: 5, windFromDeg: 170, windMode: 'headOut' },
  reservePct: 20,
  cruiseMode: 'real',
  manualMph: 40,
  speedMetric: 'radius',
};

function drone() { return DRONES.find(d => d.id === state.droneId); }
function droneBatteries() {
  return allBatteries().filter(b => b.fits.includes(state.droneId));
}
function compatibleBatteries() {
  const batts = droneBatteries();
  return state.manufacturerId === 'all'
    ? batts
    : batts.filter(b => b.manufacturerId === state.manufacturerId);
}
function battery() {
  const list = compatibleBatteries();
  return list.find(b => b.id === state.batteryId) || list[0];
}
function manufacturer(id) {
  return allManufacturers().find(m => m.id === id);
}
function payload() { return PAYLOADS.find(p => p.id === state.payloadId) || PAYLOADS[0]; }
function scenario() { return SCENARIOS.find(s => s.id === state.scenarioId) || SCENARIOS[0]; }
function units() { return unitSystem(state.units); }

function missionInputs(batt = battery(), envOverride = null) {
  const env = envOverride || state.env;
  return {
    drone: drone(),
    battery: batt,
    payloadG: payload().massG,
    payloadCdA: payload().cdA,
    extraG: state.extraG,
    env: {
      elevM: U.ftToM(env.elevFt),
      tempC: U.fToC(env.tempF),
      rhPct: env.rhPct,
      windAvgMs: U.mphToMs(env.windMph),
      windGustMs: U.mphToMs(env.gustMph),
      windFromDeg: env.windFromDeg,
      windMode: env.windMode,
    },
    reservePct: state.reservePct,
    cruiseMode: state.cruiseMode,
    realVMs: drone().cruiseMs * scenario().speedFactor,
    manualVMs: U.mphToMs(state.manualMph),
    overheadF: scenario().overheadFactor,
  };
}

/* ---------- control population ---------- */

function fillSelect(sel, items, value) {
  sel.replaceChildren();
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.value;
    o.textContent = it.label;
    sel.appendChild(o);
  }
  sel.value = value;
}

function configureNumericInput(input, config, value) {
  input.min = config.min;
  input.max = config.max;
  input.step = config.step;
  input.value = Math.round(value / config.step) * config.step;
}

function populateControls() {
  const u = units();
  $('sel-units').value = state.units;
  fillSelect($('sel-drone'), DRONES.map(d => ({ value: d.id, label: d.name })), state.droneId);
  const manufacturerIds = new Set(droneBatteries().map(b => b.manufacturerId || 'custom'));
  const availableManufacturers = allManufacturers().filter(m => manufacturerIds.has(m.id));
  if (state.manufacturerId !== 'all' && !manufacturerIds.has(state.manufacturerId)) state.manufacturerId = 'all';
  fillSelect($('sel-manufacturer'), [
    { value: 'all', label: 'All manufacturers' },
    ...availableManufacturers.map(m => ({ value: m.id, label: m.name })),
  ], state.manufacturerId);

  const batts = compatibleBatteries();
  if (!batts.find(b => b.id === state.batteryId)) state.batteryId = batts[0]?.id;
  fillSelect($('sel-battery'), batts.map(b => ({ value: b.id, label: `${b.name} · ${b.massG} g` })), state.batteryId);
  fillSelect($('custom-manufacturer'), allManufacturers().map(m => ({ value: m.id, label: m.name })), 'custom');
  fillSelect($('sel-payload'), PAYLOADS.map(p => ({ value: p.id, label: p.name })), state.payloadId);
  fillSelect($('sel-weather'),
    [...WEATHER.map(w => ({ value: w.id, label: w.name })), { value: 'custom', label: 'Custom weather' }],
    state.weatherId);
  fillSelect($('sel-scenario'), SCENARIOS.map(s => ({ value: s.id, label: s.name })), state.scenarioId);
  $('in-elev').value = state.env.elevFt;
  $('in-temp').value = state.env.tempF;
  $('in-rh').value = state.env.rhPct;
  configureNumericInput($('in-wind'), u.input.wind, u.speedFromMph(state.env.windMph));
  configureNumericInput($('in-gust'), u.input.gust, u.speedFromMph(state.env.gustMph));
  $('wind-label').textContent = `Wind avg (${u.speedUnit})`;
  $('gust-label').textContent = `Gusts (${u.speedUnit})`;
  $('in-winddir').value = state.env.windFromDeg;
  $('sel-windmode').value = state.env.windMode;
  $('in-reserve').value = state.reservePct;
  $('reserve-val').textContent = `${state.reservePct}%`;
  $('sel-cruise').value = state.cruiseMode;
  configureNumericInput($('in-speed'), u.input.manualSpeed, u.speedFromMph(state.manualMph));
  $('speed-val').textContent = `${f0(u.speedFromMph(state.manualMph))} ${u.speedUnit}`;
  $('speed-row').hidden = state.cruiseMode !== 'manual';
  $('in-extra').value = state.extraG;
  renderCustomList();
  renderManufacturerList();
}

function renderCustomList() {
  const host = $('custom-list');
  host.replaceChildren();
  for (const b of allBatteries().filter(b => b.custom)) {
    const row = document.createElement('div');
    row.className = 'custom-row';
    const name = document.createElement('span');
    name.textContent = `${manufacturer(b.manufacturerId)?.name || 'Custom'} · ${b.name}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'remove';
    del.className = 'link-btn';
    del.addEventListener('click', () => { deleteCustomBattery(b.id); populateControls(); update(); });
    row.append(name, del);
    host.appendChild(row);
  }
}

function renderManufacturerList() {
  const host = $('manufacturer-list');
  host.replaceChildren();
  const customBatts = allBatteries().filter(b => b.custom);
  for (const m of allManufacturers().filter(m => m.custom)) {
    const row = document.createElement('div');
    row.className = 'custom-row';
    const name = document.createElement('span');
    const batteryCount = customBatts.filter(b => b.manufacturerId === m.id).length;
    name.textContent = `${m.name}${batteryCount ? ` · ${batteryCount} pack${batteryCount === 1 ? '' : 's'}` : ''}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = batteryCount ? 'in use' : 'remove';
    del.className = 'link-btn';
    del.disabled = batteryCount > 0;
    del.title = batteryCount ? 'Remove this manufacturer’s batteries first.' : '';
    del.addEventListener('click', () => {
      deleteCustomManufacturer(m.id);
      populateControls();
      update();
    });
    row.append(name, del);
    host.appendChild(row);
  }
}

/* ---------- rendering ---------- */

function setTile(id, value, sub) {
  $(id).querySelector('.tile-value').textContent = value;
  if (sub !== undefined) $(id).querySelector('.tile-sub').textContent = sub;
}

function renderWarnings(warnings) {
  const host = $('warnings');
  host.replaceChildren();
  const order = { critical: 0, serious: 1, warning: 2 };
  for (const w of warnings.sort((a, b) => order[a.level] - order[b.level])) {
    const el = document.createElement('div');
    el.className = `warn warn-${w.level}`;
    const icon = document.createElement('span');
    icon.className = 'warn-icon';
    icon.textContent = w.level === 'critical' ? '✕' : w.level === 'serious' ? '▲' : '●';
    const label = document.createElement('span');
    label.className = 'warn-level';
    label.textContent = w.level;
    const text = document.createElement('span');
    text.textContent = w.text;
    el.append(icon, label, text);
    host.appendChild(el);
  }
  host.hidden = warnings.length === 0;
}

function renderStats(r) {
  const u = units();
  $('hero-value').textContent = f1(u.distanceFromKm(r.radiusKm));
  $('hero-unit').textContent = u.distanceUnit;
  $('hero-sub').textContent = `${f1(u.distanceFromKm(r.radiusKm))} ${u.distanceUnit} out — turn around here and land with ${f0(r.energy.reservePct)}% reserve`;
  setTile('tile-time', `${f1(r.timeMin)} min`, `${f1(u.distanceFromKm(r.totalKm))} ${u.distanceUnit} round trip`);
  setTile('tile-hover', `${f1(r.hoverTimeMin)} min`, `hover · ${f0(r.hover.pW)} W · ${f1(r.hover.iA)} A`);
  setTile('tile-auw', `${f0(r.massKg * 1000)} g`, `${f1(r.massKg * 2.20462)} lb takeoff`);
  const d = drone();
  setTile('tile-disc', `${r.discLoadingGcm2.toFixed(2)} g/cm²`, `${d.numRotors}× ${d.propDiaIn}″ props`);
  setTile('tile-eff', `${f1(r.hover.gPerW)} g/W`, 'hover efficiency');
  setTile('tile-da', `${f0(U.mToFt(r.densityAltM))} ft`, `density altitude · ρ ${r.rho.toFixed(3)} kg/m³`);
  const out = r.legs.out, back = r.legs.back;
  setTile('tile-cruise',
    out && back ? `${f0(u.speedFromMs(out.v))} / ${f0(u.speedFromMs(back.v))} ${u.speedUnit}` : '—',
    out && back ? `airspeed out / back · ${f0(u.speedFromMs(out.vg))} / ${f0(u.speedFromMs(back.vg))} ${u.speedUnit} gs` : 'wind exceeds capability');
  setTile('tile-energy', `${f1(r.energy.usableWh)} Wh`,
    `usable of ${f1(r.energy.packWh)} Wh nominal${r.overheadF > 1 ? ` · burn ×${r.overheadF.toFixed(2)}` : ''}`);
}

function renderPowerCurve(r) {
  const u = units();
  const pts = r.curve.map(p => ({ x: u.speedFromMs(p.v), y: p.p }));
  const markers = [];
  if (r.endurance) markers.push({ x: u.speedFromMs(r.endurance.vMs), y: r.endurance.pW, color: 'var(--series-3)', label: 'endurance' });
  if (r.legs.out) markers.push({ x: u.speedFromMs(r.legs.out.v), y: r.legs.pOut, color: 'var(--series-1)', label: 'out' });
  if (r.legs.back && Math.abs(r.legs.back.v - (r.legs.out?.v ?? -1)) > 0.3) {
    markers.push({ x: u.speedFromMs(r.legs.back.v), y: r.legs.pBack, color: 'var(--series-2)',
      label: 'back', labelBelow: true });
  }
  lineChart($('chart-power'), {
    series: [{ name: 'electrical power', color: 'var(--series-1)', pts }],
    markers, height: 250,
    xLabel: `airspeed (${u.speedUnit})`, yLabel: 'W',
    xFmt: v => `${f0(v)}`, yFmt: v => `${f0(v)}`,
    tipTitle: 'airspeed',
  });
}

function renderSpeedTradeoff(r) {
  const u = units();
  const d = drone();
  const base = missionInputs();
  const time = state.speedMetric === 'time';
  const unit = time ? 'min' : u.distanceUnit;
  const pts = [];
  let best = null;
  for (let v = 2; v <= d.maxSpeedMs * 0.95; v += 0.5) {
    const rr = planMission({ ...base, cruiseMode: 'manual', manualVMs: v });
    const p = { x: u.speedFromMs(v), y: time ? rr.timeMin : u.distanceFromKm(rr.radiusKm) };
    pts.push(p);
    if (!best || p.y > best.y) best = p;
  }
  const nearestY = x => pts.reduce((a, b) => Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a).y;
  const markers = [];
  const viable = best && best.y > 0;
  const peakLabel = time ? 'longest flight' : 'best range';
  if (viable) markers.push({ x: best.x, y: best.y, color: 'var(--series-3)', label: peakLabel });
  const plannedSpeed = r.legs.out ? u.speedFromMs(r.legs.out.v) : null;
  const atOptimum = viable && plannedSpeed !== null && Math.abs(plannedSpeed - best.x) < u.speedFromMs(2 / 3.6);
  if (viable && plannedSpeed !== null && !atOptimum) {
    markers.push({ x: plannedSpeed, y: nearestY(plannedSpeed), color: 'var(--series-2)', label: 'planned',
      labelBelow: Math.abs(best.x - plannedSpeed) < 0.12 * (pts.at(-1).x - pts[0].x) });
  }
  lineChart($('chart-speed'), {
    series: [{ name: time ? 'mission time' : 'mission radius', color: 'var(--series-1)', pts }],
    markers, height: 250,
    xLabel: `cruise airspeed (${u.speedUnit})`, yLabel: unit,
    xFmt: v => f0(v), yFmt: v => f1(v), tipTitle: 'cruise',
  });
  const note = $('speed-note');
  if (viable && plannedSpeed !== null) {
    const py = nearestY(plannedSpeed);
    const cost = best.y - py;
    note.textContent =
      `${time ? 'Longest flight' : 'Best range'}: ${f0(best.x)} ${u.speedUnit} → ${f1(best.y)} ${unit} · ` +
      `planned: ${f0(plannedSpeed)} ${u.speedUnit} → ${f1(py)} ${unit}` +
      (atOptimum || cost <= 0.05 ? ' · already at the optimum'
        : ` · pushing costs ${f1(cost)} ${time ? 'min of flight time' : `${u.distanceUnit} of radius`}`);
  } else {
    note.textContent = 'No cruise speed produces a viable out-and-back in this wind.';
  }
}

function renderProfile(r) {
  const u = units();
  const empty = $('chart-profile-empty');
  empty.hidden = r.timeline.length > 0;
  missionProfile($('chart-profile'), {
    timeline: r.timeline,
    cutoffV: CHEMISTRY[battery().chem].cutoffLoad * battery().s,
    reservePct: r.energy.reservePct,
    colorSoc: 'var(--series-1)',
    colorV: 'var(--series-2)',
    distanceFromKm: u.distanceFromKm,
    distanceUnit: u.distanceUnit,
    height: 300,
  });
}

function renderComparison() {
  const u = units();
  const batts = compatibleBatteries();
  const runs = batts.map(b => ({ b, r: planMission(missionInputs(b)) }));
  barChart($('chart-cmp-radius'), {
    items: runs.map(({ b, r }, i) => ({
      label: b.short || b.name, value: u.distanceFromKm(r.radiusKm),
      color: SERIES[i % SERIES.length], note: 'mission radius',
    })),
    valueFmt: v => `${f1(v)} ${u.distanceUnit}`,
  });
  barChart($('chart-cmp-time'), {
    items: runs.map(({ b, r }, i) => ({
      label: b.short || b.name, value: r.timeMin,
      color: SERIES[i % SERIES.length], note: 'flight time',
    })),
    valueFmt: v => `${f1(v)} min`,
  });

  // table view
  const tbody = $('cmp-table').querySelector('tbody');
  tbody.replaceChildren();
  for (const { b, r } of runs) {
    const tr = document.createElement('tr');
    const cells = [
      manufacturer(b.manufacturerId)?.name || 'Custom',
      b.name + (b.custom ? ' ·custom' : ''),
      [b.cellMaker, b.cellModel].filter(Boolean).join(' '),
      b.config || `${b.s}S${b.p || 1}P`,
      CHEMISTRY[b.chem].label + ` ${b.s}S`,
      `${f0(b.capAh * 1000)} mAh`,
      `${f1(r.energy.packWh)} Wh`,
      `${f0(b.massG)} g`,
      `${f1(u.distanceFromKm(r.radiusKm))} ${u.distanceUnit}`,
      `${f1(r.timeMin)} min`,
      r.legs.out && r.legs.back ? `${f1(u.burnFromWhPerKm((r.legs.out.whPerKm + r.legs.back.whPerKm) / 2))} ${u.burnUnit}` : '—',
      b.priceUsd ? `$${b.priceUsd}` : '—',
    ];
    cells.forEach((c, i) => {
      const td = document.createElement('td');
      td.textContent = c || '—';
      if (i >= 5) td.className = 'num';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
}

function renderWindSensitivity() {
  const u = units();
  const batts = compatibleBatteries().slice(0, 4);
  const series = batts.map((b, i) => {
    const pts = [];
    for (let w = 0; w <= 30; w += 2) {
      const env = { ...state.env, windMph: w, gustMph: w * 1.5 }; // gusts scale with the sweep
      const r = planMission(missionInputs(b, env));
      pts.push({ x: u.speedFromMph(w), y: u.distanceFromKm(r.radiusKm) });
    }
    return { name: b.short || b.name, color: SERIES[i % SERIES.length], pts };
  });
  lineChart($('chart-wind'), {
    series, height: 250,
    xLabel: `average wind (${u.speedUnit})`, yLabel: u.distanceUnit,
    xFmt: v => f0(v), yFmt: v => f1(v),
    tipTitle: 'wind',
  });
  legend($('legend-wind'), series);
}

function update() {
  const u = units();
  const batts = compatibleBatteries();
  if (!batts.find(b => b.id === state.batteryId)) {
    state.batteryId = batts[0]?.id;
    fillSelect($('sel-battery'), batts.map(b => ({ value: b.id, label: `${b.name} · ${b.massG} g` })), state.batteryId);
  }
  const sc = scenario();
  $('scenario-desc').textContent =
    `${sc.desc} ≈${f0(u.speedFromMs(drone().cruiseMs * sc.speedFactor))} ${u.speedUnit} realistic cruise · +${f0((sc.overheadFactor - 1) * 100)}% maneuvering burn.`;
  $('cmp-radius-title').textContent = `Mission radius (${u.distanceUnit})`;
  const r = planMission(missionInputs());
  // Render only the visible view: charts measure container width and freeze at
  // a fallback size when drawn inside a hidden container.
  if (state.view === 'map') {
    renderMapView(r);
    return;
  }
  renderStats(r);
  renderWarnings(r.warnings);
  renderPowerCurve(r);
  renderSpeedTradeoff(r);
  renderProfile(r);
  renderComparison();
  renderWindSensitivity();
  renderBatteryNote();
}

function setView(view) {
  if (state.view === view) return;
  state.view = view;
  const dash = view === 'dash';
  $('view-dash').hidden = !dash;
  $('view-map').hidden = dash;
  $('tab-dash').setAttribute('aria-selected', dash);
  $('tab-map').setAttribute('aria-selected', !dash);
  $('tab-dash').tabIndex = dash ? 0 : -1;
  $('tab-map').tabIndex = dash ? -1 : 0;
  if (!dash) showMapView(); // init-if-needed + invalidateSize, now that it's visible
  update();
}

function renderBatteryNote() {
  const host = $('battery-note');
  host.replaceChildren();
  const b = battery();
  const m = manufacturer(b.manufacturerId);
  const identity = [m?.name, b.cellMaker && b.cellModel ? `${b.cellMaker} ${b.cellModel}` : b.cellModel]
    .filter(Boolean).join(' · ');
  if (identity) host.append(document.createTextNode(`${identity}. `));
  if (b.estimated?.length) {
    host.append(document.createTextNode(
      `${b.estimated.join(', ')} ${b.estimated.length === 1 ? 'is' : 'are'} estimated; replace with the finished pack’s measured values when available.`
    ));
  }
  if (m?.url) {
    host.append(document.createTextNode(' '));
    const link = document.createElement('a');
    link.href = m.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Builder source';
    host.appendChild(link);
  }
}

/* ---------- events ---------- */

function bind() {
  $('tab-dash').addEventListener('click', () => setView('dash'));
  $('tab-map').addEventListener('click', () => setView('map'));
  document.querySelector('.view-tabs').addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = state.view === 'dash' ? 'map' : 'dash';
    setView(next);
    $(next === 'dash' ? 'tab-dash' : 'tab-map').focus();
  });
  $('sel-units').addEventListener('change', e => {
    state.units = e.target.value;
    populateControls();
    update();
  });
  $('sel-drone').addEventListener('change', e => { state.droneId = e.target.value; populateControls(); update(); });
  $('sel-manufacturer').addEventListener('change', e => {
    state.manufacturerId = e.target.value;
    state.batteryId = compatibleBatteries()[0]?.id;
    populateControls();
    update();
  });
  $('sel-battery').addEventListener('change', e => { state.batteryId = e.target.value; update(); });
  $('sel-payload').addEventListener('change', e => { state.payloadId = e.target.value; update(); });
  $('in-extra').addEventListener('input', e => { state.extraG = +e.target.value || 0; update(); });
  $('sel-weather').addEventListener('change', e => {
    state.weatherId = e.target.value;
    const w = WEATHER.find(x => x.id === state.weatherId);
    if (w) {
      state.env = { ...state.env, elevFt: w.elevFt, tempF: w.tempF, rhPct: w.rhPct, windMph: w.windMph, gustMph: w.gustMph, windFromDeg: w.windFromDeg };
      populateControls();
    }
    update();
  });
  $('sel-scenario').addEventListener('change', e => { state.scenarioId = e.target.value; update(); });
  $('sel-speed-metric').addEventListener('change', e => { state.speedMetric = e.target.value; update(); });
  const envMap = { 'in-elev': 'elevFt', 'in-temp': 'tempF', 'in-rh': 'rhPct', 'in-winddir': 'windFromDeg' };
  for (const [id, key] of Object.entries(envMap)) {
    $(id).addEventListener('input', e => {
      state.env[key] = +e.target.value || 0;
      state.weatherId = 'custom';
      $('sel-weather').value = 'custom';
      update();
    });
  }
  for (const [id, key] of [['in-wind', 'windMph'], ['in-gust', 'gustMph']]) {
    $(id).addEventListener('input', e => {
      state.env[key] = units().speedToMph(+e.target.value || 0);
      state.weatherId = 'custom';
      $('sel-weather').value = 'custom';
      update();
    });
  }
  $('sel-windmode').addEventListener('change', e => { state.env.windMode = e.target.value; update(); });
  $('in-reserve').addEventListener('input', e => {
    state.reservePct = +e.target.value;
    $('reserve-val').textContent = `${state.reservePct}%`;
    update();
  });
  $('sel-cruise').addEventListener('change', e => {
    state.cruiseMode = e.target.value;
    $('speed-row').hidden = state.cruiseMode !== 'manual';
    update();
  });
  $('in-speed').addEventListener('input', e => {
    state.manualMph = units().speedToMph(+e.target.value);
    $('speed-val').textContent = `${f0(+e.target.value)} ${units().speedUnit}`;
    update();
  });

  $('manufacturer-form').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = (fd.get('name') || '').toString().trim();
    if (!name) return;
    const id = 'manufacturer-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const rawUrl = (fd.get('url') || '').toString().trim();
    saveCustomManufacturer({
      id,
      name,
      url: /^https?:\/\//i.test(rawUrl) ? rawUrl : null,
    });
    e.target.reset();
    populateControls();
    $('custom-manufacturer').value = id;
  });

  $('custom-form').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = (fd.get('name') || '').toString().trim();
    if (!name) return;
    const manufacturerId = fd.get('manufacturer') || 'custom';
    const id = `custom-${manufacturerId}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    saveCustomBattery({
      id,
      name, short: name.slice(0, 14),
      chem: fd.get('chem'), s: +fd.get('s'), p: +fd.get('p') || 1,
      capAh: (+fd.get('mah') || 0) / 1000,
      massG: +fd.get('mass') || 0,
      irPackMilliOhm: +fd.get('ir') || 25,
      maxContA: +fd.get('amps') || null,
      connector: (fd.get('connector') || drone().connector).toString().trim(),
      fits: [state.droneId],
      manufacturerId,
      cellMaker: (fd.get('cellMaker') || '').toString().trim() || null,
      cellModel: (fd.get('cellModel') || '').toString().trim() || null,
      config: `${+fd.get('s')}S${+fd.get('p') || 1}P`,
      priceUsd: +fd.get('price') || null,
      custom: true,
    });
    state.manufacturerId = manufacturerId;
    state.batteryId = id;
    e.target.reset();
    populateControls();
    update();
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(update, 150);
  });
  document.addEventListener('scroll', hideTooltip, { passive: true });
}

setupMapView({
  missionInputs,
  units,
  requestRender: update,
  applyEnv: patch => {
    state.env = { ...state.env, ...patch };
    state.weatherId = 'custom';
    populateControls();
    update();
  },
});
populateControls();
bind();
update();
