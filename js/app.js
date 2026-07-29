// app.js — control state, mission computation, and render orchestration.
import { DRONES, PAYLOADS, SCENARIOS, allBatteries, saveCustomBattery, deleteCustomBattery } from './data.js';
import { planMission, CHEMISTRY, U } from './physics.js';
import { lineChart, barChart, missionProfile, legend, hideTooltip } from './charts.js';

const $ = (id) => document.getElementById(id);
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
const f0 = (x) => isFinite(x) ? x.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
const f1 = (x) => isFinite(x) ? x.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 }) : '—';

const state = {
  droneId: 'moz7v2',
  batteryId: 'nav5000',
  payloadId: 'naked',
  extraG: 0,
  scenarioId: 'calm',
  env: { elevFt: 800, tempF: 75, rhPct: 40, windMph: 3, gustMph: 5, windMode: 'headOut' },
  reservePct: 20,
  cruiseMode: 'auto',
  manualMph: 40,
};

function drone() { return DRONES.find(d => d.id === state.droneId); }
function compatibleBatteries() {
  return allBatteries().filter(b => b.fits.includes(state.droneId));
}
function battery() {
  const list = compatibleBatteries();
  return list.find(b => b.id === state.batteryId) || list[0];
}
function payload() { return PAYLOADS.find(p => p.id === state.payloadId) || PAYLOADS[0]; }

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
      windMode: env.windMode,
    },
    reservePct: state.reservePct,
    cruiseMode: state.cruiseMode,
    manualVMs: U.mphToMs(state.manualMph),
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

function populateControls() {
  fillSelect($('sel-drone'), DRONES.map(d => ({ value: d.id, label: d.name })), state.droneId);
  const batts = compatibleBatteries();
  if (!batts.find(b => b.id === state.batteryId)) state.batteryId = batts[0]?.id;
  fillSelect($('sel-battery'), batts.map(b => ({ value: b.id, label: `${b.name} · ${b.massG} g` })), state.batteryId);
  fillSelect($('sel-payload'), PAYLOADS.map(p => ({ value: p.id, label: p.name })), state.payloadId);
  fillSelect($('sel-scenario'),
    [...SCENARIOS.map(s => ({ value: s.id, label: s.name })), { value: 'custom', label: 'Custom conditions' }],
    state.scenarioId);
  $('in-elev').value = state.env.elevFt;
  $('in-temp').value = state.env.tempF;
  $('in-rh').value = state.env.rhPct;
  $('in-wind').value = state.env.windMph;
  $('in-gust').value = state.env.gustMph;
  $('sel-windmode').value = state.env.windMode;
  $('in-reserve').value = state.reservePct;
  $('reserve-val').textContent = `${state.reservePct}%`;
  $('sel-cruise').value = state.cruiseMode;
  $('in-speed').value = state.manualMph;
  $('speed-val').textContent = `${state.manualMph} mph`;
  $('speed-row').hidden = state.cruiseMode !== 'manual';
  $('in-extra').value = state.extraG;
  renderCustomList();
}

function renderCustomList() {
  const host = $('custom-list');
  host.replaceChildren();
  for (const b of allBatteries().filter(b => b.custom)) {
    const row = document.createElement('div');
    row.className = 'custom-row';
    const name = document.createElement('span');
    name.textContent = b.name;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'remove';
    del.className = 'link-btn';
    del.addEventListener('click', () => { deleteCustomBattery(b.id); populateControls(); update(); });
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
  $('hero-value').textContent = f1(U.kmToMi(r.radiusKm));
  $('hero-sub').textContent = `${f1(r.radiusKm)} km out — turn around here and land with ${f0(r.energy.reservePct)}% reserve`;
  setTile('tile-time', `${f1(r.timeMin)} min`, `${f1(U.kmToMi(r.totalKm))} mi round trip`);
  setTile('tile-hover', `${f1(r.hoverTimeMin)} min`, `hover · ${f0(r.hover.pW)} W · ${f1(r.hover.iA)} A`);
  setTile('tile-auw', `${f0(r.massKg * 1000)} g`, `${f1(r.massKg * 2.20462)} lb takeoff`);
  const d = drone();
  setTile('tile-disc', `${r.discLoadingGcm2.toFixed(2)} g/cm²`, `${d.numRotors}× ${d.propDiaIn}″ props`);
  setTile('tile-eff', `${f1(r.hover.gPerW)} g/W`, 'hover efficiency');
  setTile('tile-da', `${f0(U.mToFt(r.densityAltM))} ft`, `density altitude · ρ ${r.rho.toFixed(3)} kg/m³`);
  const out = r.legs.out, back = r.legs.back;
  setTile('tile-cruise',
    out && back ? `${f0(U.msToMph(out.v))} / ${f0(U.msToMph(back.v))} mph` : '—',
    out && back ? `airspeed out / back · ${f0(U.msToMph(out.vg))} / ${f0(U.msToMph(back.vg))} gs` : 'wind exceeds capability');
  setTile('tile-energy', `${f1(r.energy.usableWh)} Wh`, `usable of ${f1(r.energy.packWh)} Wh nominal`);
}

function renderPowerCurve(r) {
  const pts = r.curve.map(p => ({ x: U.msToMph(p.v), y: p.p }));
  const markers = [];
  if (r.endurance) markers.push({ x: U.msToMph(r.endurance.vMs), y: r.endurance.pW, color: 'var(--series-3)', label: 'endurance' });
  if (r.legs.out) markers.push({ x: U.msToMph(r.legs.out.v), y: r.legs.pOut, color: 'var(--series-1)', label: 'out' });
  if (r.legs.back && Math.abs(r.legs.back.v - (r.legs.out?.v ?? -1)) > 0.3) {
    markers.push({ x: U.msToMph(r.legs.back.v), y: r.legs.pBack, color: 'var(--series-2)',
      label: 'back', labelBelow: true });
  }
  lineChart($('chart-power'), {
    series: [{ name: 'electrical power', color: 'var(--series-1)', pts }],
    markers, height: 250,
    xLabel: 'airspeed (mph)', yLabel: 'W',
    xFmt: v => `${f0(v)}`, yFmt: v => `${f0(v)}`,
    tipTitle: 'airspeed',
  });
}

function renderProfile(r) {
  const empty = $('chart-profile-empty');
  empty.hidden = r.timeline.length > 0;
  missionProfile($('chart-profile'), {
    timeline: r.timeline,
    cutoffV: CHEMISTRY[battery().chem].cutoffLoad * battery().s,
    reservePct: r.energy.reservePct,
    colorSoc: 'var(--series-1)',
    colorV: 'var(--series-2)',
    height: 300,
  });
}

function renderComparison() {
  const batts = compatibleBatteries().slice(0, 8);
  const runs = batts.map(b => ({ b, r: planMission(missionInputs(b)) }));
  barChart($('chart-cmp-radius'), {
    items: runs.map(({ b, r }, i) => ({
      label: b.short || b.name, value: U.kmToMi(r.radiusKm),
      color: SERIES[i % SERIES.length], note: 'mission radius',
    })),
    valueFmt: v => `${f1(v)} mi`,
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
      b.name + (b.custom ? ' ·custom' : ''),
      CHEMISTRY[b.chem].label + ` ${b.s}S`,
      `${f0(b.capAh * 1000)} mAh`,
      `${f1(r.energy.packWh)} Wh`,
      `${f0(b.massG)} g`,
      `${f1(U.kmToMi(r.radiusKm))} mi`,
      `${f1(r.timeMin)} min`,
      r.legs.out && r.legs.back ? `${f1((r.legs.out.whPerKm + r.legs.back.whPerKm) / 2 / 0.621371)} Wh/mi` : '—',
      b.priceUsd ? `$${b.priceUsd}` : '—',
    ];
    cells.forEach((c, i) => {
      const td = document.createElement('td');
      td.textContent = c;
      if (i >= 2) td.className = 'num';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
}

function renderWindSensitivity() {
  const batts = compatibleBatteries().slice(0, 4);
  const series = batts.map((b, i) => {
    const pts = [];
    for (let w = 0; w <= 30; w += 2) {
      const env = { ...state.env, windMph: w, gustMph: w * 1.5 }; // gusts scale with the sweep
      const r = planMission(missionInputs(b, env));
      pts.push({ x: w, y: U.kmToMi(r.radiusKm) });
    }
    return { name: b.short || b.name, color: SERIES[i % SERIES.length], pts };
  });
  lineChart($('chart-wind'), {
    series, height: 250,
    xLabel: 'average wind (mph)', yLabel: 'mi',
    xFmt: v => f0(v), yFmt: v => f1(v),
    tipTitle: 'wind',
  });
  legend($('legend-wind'), series);
}

function update() {
  const batts = compatibleBatteries();
  if (!batts.find(b => b.id === state.batteryId)) {
    state.batteryId = batts[0]?.id;
    fillSelect($('sel-battery'), batts.map(b => ({ value: b.id, label: `${b.name} · ${b.massG} g` })), state.batteryId);
  }
  const r = planMission(missionInputs());
  renderStats(r);
  renderWarnings(r.warnings);
  renderPowerCurve(r);
  renderProfile(r);
  renderComparison();
  renderWindSensitivity();
  const b = battery();
  $('battery-note').textContent = b.estimated?.length
    ? `Note: ${b.estimated.join(', ')} for this pack are estimates — weigh the pack and measure IR to tighten the model.`
    : '';
}

/* ---------- events ---------- */

function bind() {
  $('sel-drone').addEventListener('change', e => { state.droneId = e.target.value; populateControls(); update(); });
  $('sel-battery').addEventListener('change', e => { state.batteryId = e.target.value; update(); });
  $('sel-payload').addEventListener('change', e => { state.payloadId = e.target.value; update(); });
  $('in-extra').addEventListener('input', e => { state.extraG = +e.target.value || 0; update(); });
  $('sel-scenario').addEventListener('change', e => {
    state.scenarioId = e.target.value;
    const sc = SCENARIOS.find(s => s.id === state.scenarioId);
    if (sc) {
      state.env = { elevFt: sc.elevFt, tempF: sc.tempF, rhPct: sc.rhPct, windMph: sc.windMph, gustMph: sc.gustMph, windMode: sc.windMode };
      populateControls();
    }
    update();
  });
  const envMap = { 'in-elev': 'elevFt', 'in-temp': 'tempF', 'in-rh': 'rhPct', 'in-wind': 'windMph', 'in-gust': 'gustMph' };
  for (const [id, key] of Object.entries(envMap)) {
    $(id).addEventListener('input', e => {
      state.env[key] = +e.target.value || 0;
      state.scenarioId = 'custom';
      $('sel-scenario').value = 'custom';
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
    state.manualMph = +e.target.value;
    $('speed-val').textContent = `${state.manualMph} mph`;
    update();
  });

  $('custom-form').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = (fd.get('name') || '').toString().trim();
    if (!name) return;
    saveCustomBattery({
      id: 'custom-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name, short: name.slice(0, 14),
      chem: fd.get('chem'), s: +fd.get('s'), p: 1,
      capAh: (+fd.get('mah') || 0) / 1000,
      massG: +fd.get('mass') || 0,
      irPackMilliOhm: +fd.get('ir') || 25,
      maxContA: +fd.get('amps') || null,
      connector: drone().connector,
      fits: [state.droneId],
      custom: true,
    });
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

populateControls();
bind();
update();
