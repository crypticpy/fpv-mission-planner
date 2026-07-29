// app.js — control state, mission computation, and render orchestration.
import {
  DRONES, PAYLOADS, WEATHER, SCENARIOS,
  allBatteries, saveCustomBattery, deleteCustomBattery,
  allManufacturers, saveCustomManufacturer, deleteCustomManufacturer,
  loadMapState, saveMapState,
} from './data.js';
import { planMission, parallelBattery, CHEMISTRY, U } from './physics.js';
import { lineChart, barChart, missionProfile, legend, hideTooltip } from './charts.js';
import { unitSystem } from './units.js';
import { setupMapView, showMapView, renderMapView, pauseMapView, resizeMapView, setLaunchPoint } from './map.js';
import { setupShell, syncView } from './shell.js';
import { fetchLiveEnv, launchPoint, isDefaultLaunch, DEFAULT_LAUNCH_NAME } from './weather.js';
import { setupThemes } from './themes.js';

const $ = (id) => document.getElementById(id);
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
const f0 = (x) => x != null && isFinite(x) ? x.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
const f1 = (x) => x != null && isFinite(x) ? x.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 }) : '—';

// Pilots fly the OSD clock, not a decimal minute. Durations render mm:ss, and
// only grow an hours field if something absurd asks for one.
const mmss = (min) => {
  if (min == null || !isFinite(min) || min < 0) return '—';
  const s = Math.round(min * 60);
  const pad = (n) => String(n).padStart(2, '0');
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`
    : `${Math.floor(s / 60)}:${pad(s % 60)}`;
};

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
// The model plans on 80 m wind; the pilot standing at the launch point feels
// roughly half of it. Rule of thumb, labeled as one wherever it prints.
const surfaceMph = (aloftMph) => aloftMph / 2;

const state = {
  view: 'dash', // 'dash' | 'map'
  units: 'imperial',
  droneId: 'moz7v2',
  manufacturerId: 'all',
  batteryId: 'nav5000',
  parallelPacks: false,
  payloadId: 'naked',
  extraG: 0,
  weatherId: 'live', // 'live' | preset id | 'custom' — live is the boot default
  scenarioId: 'longrange',
  env: { elevFt: 800, tempF: 75, rhPct: 40, windMph: 3, gustMph: 5, windFromDeg: 170, windMode: 'headOut' },
  reservePct: 20,
  cruiseMode: 'real',
  manualMph: 40,
  speedMetric: 'radius',
};

/* ---------- session persistence ---------- */

const SESSION_KEY = 'fpv-session';

function saveSession() {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(state)); } catch { /* quota / private mode */ }
}

/**
 * Restore the control surface, all-or-nothing: any unknown id or out-of-range
 * number discards the whole blob, because a half-restored loadout reads as a
 * plan for a rig the pilot never selected. Returns the saved view, if valid.
 */
function restoreSession() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
  if (!s || typeof s !== 'object' || !s.env || typeof s.env !== 'object') return null;
  const env = s.env;
  const num = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  const batt = allBatteries().find(b => b.id === s.batteryId && b.fits.includes(s.droneId));
  const ok = DRONES.some(d => d.id === s.droneId)
    && batt
    && (s.manufacturerId === 'all'
      || (batt.manufacturerId === s.manufacturerId && allManufacturers().some(m => m.id === s.manufacturerId)))
    && PAYLOADS.some(p => p.id === s.payloadId)
    && SCENARIOS.some(x => x.id === s.scenarioId)
    && (s.weatherId === 'live' || s.weatherId === 'custom' || WEATHER.some(w => w.id === s.weatherId))
    && ['imperial', 'metric'].includes(s.units)
    && ['dash', 'map'].includes(s.view)
    && ['real', 'range', 'manual'].includes(s.cruiseMode)
    && ['radius', 'time'].includes(s.speedMetric)
    && ['headOut', 'tailOut', 'cross'].includes(env.windMode)
    && typeof s.parallelPacks === 'boolean'
    && num(s.extraG, 0, 500) && num(s.reservePct, 10, 40) && num(s.manualMph, 5, 120)
    && num(env.elevFt, -1500, 30000) && num(env.tempF, -60, 140) && num(env.rhPct, 0, 100)
    && num(env.windMph, 0, 120) && num(env.gustMph, 0, 160) && num(env.windFromDeg, 0, 359);
  if (!ok) return null;
  Object.assign(state, {
    units: s.units, droneId: s.droneId, manufacturerId: s.manufacturerId, batteryId: s.batteryId,
    parallelPacks: s.parallelPacks, payloadId: s.payloadId, extraG: s.extraG,
    weatherId: s.weatherId, scenarioId: s.scenarioId, reservePct: s.reservePct,
    cruiseMode: s.cruiseMode, manualMph: s.manualMph, speedMetric: s.speedMetric,
    env: {
      elevFt: env.elevFt, tempF: env.tempF, rhPct: env.rhPct, windMph: env.windMph,
      gustMph: env.gustMph, windFromDeg: env.windFromDeg, windMode: env.windMode,
    },
  });
  return s.view;
}

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
function loadoutBattery(batt = battery()) {
  if (!state.parallelPacks) return { ...batt, packCount: 1, extraCdA: 0 };
  const d = drone();
  return parallelBattery(batt, 2, {
    harnessMassG: d.parallelHarnessMassG || 0,
    extraCdA: d.parallelPackCdA || 0,
  });
}

function missionInputs(batt = battery(), envOverride = null) {
  const env = envOverride || state.env;
  const configuredBatt = loadoutBattery(batt);
  return {
    drone: drone(),
    battery: configuredBatt,
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
  $('in-parallel').checked = state.parallelPacks;
  const configuredBatt = loadoutBattery();
  const parallelSummary = $('parallel-summary');
  parallelSummary.hidden = !state.parallelPacks;
  parallelSummary.textContent = state.parallelPacks
    ? `${configuredBatt.config} effective · ${f0(configuredBatt.capAh * 1000)} mAh · ${f0(configuredBatt.massG)} g batteries + harness`
    : '';
  fillSelect($('custom-manufacturer'), allManufacturers().map(m => ({ value: m.id, label: m.name })), 'custom');
  fillSelect($('sel-payload'), PAYLOADS.map(p => ({ value: p.id, label: p.name })), state.payloadId);
  fillSelect($('sel-weather'), [
    { value: 'live', label: 'Live — current conditions' },
    ...WEATHER.map(w => ({ value: w.id, label: w.name })),
    { value: 'custom', label: 'Custom weather' },
  ], state.weatherId);
  fillSelect($('sel-scenario'), SCENARIOS.map(s => ({ value: s.id, label: s.name })), state.scenarioId);
  $('in-elev').value = state.env.elevFt;
  $('in-temp').value = state.env.tempF;
  $('in-rh').value = state.env.rhPct;
  configureNumericInput($('in-wind'), u.input.wind, u.speedFromMph(state.env.windMph));
  configureNumericInput($('in-gust'), u.input.gust, u.speedFromMph(state.env.gustMph));
  $('wind-label').textContent = `Wind aloft (${u.speedUnit})`;
  $('gust-label').textContent = `Gusts (${u.speedUnit})`;
  $('in-winddir').value = state.env.windFromDeg;
  $('wind-note').textContent =
    `The plan flies the 80 m wind — ${f0(u.speedFromMph(state.env.windMph))} ${u.speedUnit} from ${state.env.windFromDeg}° (${compass(state.env.windFromDeg)}). `
    + `At the launch point you’ll feel roughly half of it, about ${f0(u.speedFromMph(surfaceMph(state.env.windMph)))} ${u.speedUnit}.`;
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

// powerAtSpeed memo for the sweep renders, rebuilt every update pass. A cache
// is only valid while mass/air/drag are fixed, so it keys on the pack — the one
// thing the sweeps vary that moves all-up weight.
let packCaches = new Map();
function packCache(b) {
  const key = b?.id ?? '';
  let c = packCaches.get(key);
  if (!c) { c = new Map(); packCaches.set(key, c); }
  return c;
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

/**
 * The zero-radius state reads as a broken app: dashes everywhere while Lift
 * still says VIABLE. Name the lever that actually moves, in the pilot's units.
 * Null unless the craft flies but no out-and-back closes.
 */
function zeroRadiusNote(r) {
  if (!r.flight.viable || (r.legs.out && r.legs.back)) return null;
  const u = units();
  const spd = (ms) => f1(u.speedFromMs(ms));
  const ceiling = `${spd(r.speedLimitMs)} ${u.speedUnit}`;
  const wind = `${spd(r.wind.planningMs)} ${u.speedUnit} ${state.env.windMode === 'cross' ? 'crosswind' : 'headwind'}`;
  // Only worth suggesting a faster cruise while the wind is inside the envelope.
  const outrunnable = r.speedLimitMs > r.wind.planningMs;
  const noWayOut = `even this loadout’s ${ceiling} top speed can’t beat it — wait for calmer wind, or fly a lighter setup.`;
  if (state.cruiseMode === 'range') {
    return `A ${wind} is at or past this loadout’s ${ceiling} usable top speed — no cruise speed gets you home. `
      + 'Wait for calmer wind, or fly a lighter setup.';
  }
  const manual = state.cruiseMode === 'manual';
  const planMs = manual ? U.mphToMs(state.manualMph)
    : Math.min(drone().cruiseMs * scenario().speedFactor, 0.95 * r.speedLimitMs);
  if (manual && planMs > r.speedLimitMs) {
    return `A ${spd(planMs)} ${u.speedUnit} manual airspeed is past what this loadout holds (${ceiling}) `
      + '— dial the airspeed back, or drop weight.';
  }
  const fix = !outrunnable ? noWayOut
    : manual ? `push the airspeed above ${spd(r.wind.planningMs)} ${u.speedUnit}.`
    : `pick a faster flying style, or set cruise speed to Manual and push above ${spd(r.wind.planningMs)} ${u.speedUnit}.`;
  return `At ${spd(planMs)} ${u.speedUnit} you can’t make headway home against a ${wind} — ${fix}`;
}

/**
 * Out-leg and home-leg clock times at the planned cruise. planMission already
 * solved both ground speeds; the home leg has never been shown, and it is the
 * one that decides how early you turn.
 */
function legTimes(r) {
  const { out, back } = r.legs;
  if (!out || !back || !(r.radiusKm > 0)) return null;
  return {
    outMin: r.radiusKm / (out.vg * 3.6) * 60,
    backMin: r.radiusKm / (back.vg * 3.6) * 60,
  };
}

// Where the pack actually finishes the mission: the landing reserve plus
// whatever sag strands below it. The profile timeline already integrates it.
function landingSoc(r) {
  const end = r.timeline.at(-1);
  return end && isFinite(end.soc) ? end.soc : null;
}

/**
 * "Can I fly this, here, now?" — the question the app is opened with. Pure
 * synthesis over the plan: one level, the binding constraint worst-first, and
 * the lever that moves it. Every number here is already on screen elsewhere.
 */
function verdict(r, stranded) {
  const u = units();
  const spd = (ms) => `${f0(u.speedFromMs(ms))} ${u.speedUnit}`;
  const b = loadoutBattery();
  const gustMs = U.mphToMs(state.env.gustMph);
  const gustShare = r.speedLimitMs > 0 ? gustMs / r.speedLimitMs : 0;
  const iRatio = b.maxContA ? r.hover.iA / b.maxContA : 0;
  const tempC = U.fToC(state.env.tempF);
  const coldPack = b.chem === 'liion' ? tempC <= 0 : tempC <= 5;
  const times = legTimes(r);

  const stop = [];
  if (r.flight.code === 'no_lift') {
    stop.push([
      `${f0(r.massKg * 1000)} g is over this rig’s estimated ${f0(r.flight.maxHoverMassG)} g lift ceiling — it will not leave the ground.`,
      'Take the camera and any extra weight off, or fly a lighter pack.',
    ]);
  } else if (r.flight.code === 'no_control_margin') {
    stop.push([
      `Only ${r.flight.thrustToWeight.toFixed(2)}:1 thrust — it may lift off, but nothing is left for a climb or a gust save.`,
      'Strip weight off it, or put a lighter pack on, before this one flies.',
    ]);
  }
  if (stranded) stop.push([stranded, null]);
  if (iRatio > 1) {
    stop.push([
      `Just hovering pulls about ${f0(r.hover.iA)} A from a pack rated for ${f0(b.maxContA)} A — you are over the pack before you move.`,
      'Fly a pack with more punch, or take weight off this one.',
    ]);
  }

  const care = [];
  if (gustShare > 0.45) {
    care.push([
      `Gusts to ${spd(gustMs)} are a big slice of this rig’s ${spd(r.speedLimitMs)} usable top speed.`,
      'Stay closer, keep it low behind cover, and save the long lines for a calmer day.',
    ]);
  }
  if (r.energy.sagLimited) {
    care.push([
      'The pack runs out of push before it runs out of energy — sag ends this flight early, not the capacity.',
      'Land on the timer instead of the low-voltage beep, or grab the bigger pack.',
    ]);
  }
  if (iRatio > 0.6 && iRatio <= 1) {
    care.push([
      `Hover alone is ${f0(iRatio * 100)}% of what this pack is rated to deliver — punch-outs will sag it hard.`,
      'Fly it smoothly, skip the hard climbs, or move to a pack with more headroom.',
    ]);
  }
  if (r.flight.code === 'marginal') {
    care.push([
      `${r.flight.thrustToWeight.toFixed(2)}:1 thrust is thin for gusts, climbs, and catching a bad line.`,
      'Fly gently and low, and leave the punch-outs for a lighter setup.',
    ]);
  }
  if (coldPack) {
    care.push([
      'The pack is cold: expect less capacity than the plan assumes and heavy sag on the first pull.',
      'Keep packs in a pocket until launch, and cut a minute off the timer.',
    ]);
  }
  if (r.densityAltM > 2500) {
    care.push([
      `The air up here is thin — ${f0(U.mToFt(r.densityAltM))} ft density altitude costs you both thrust and efficiency.`,
      'Fly lighter, plan a shorter hop, and give yourself extra height on the way home.',
    ]);
  }

  const level = stop.length ? 'nogo' : care.length ? 'caution' : 'go';
  const label = level === 'nogo' ? 'DON’T FLY' : level === 'caution' ? 'CAUTION' : 'GO';
  const [why, fix] = stop[0] || care[0] || [
    `Nothing in this plan is fighting you — ${f1(u.distanceFromKm(r.radiusKm))} ${u.distanceUnit} out and back in ${mmss(r.timeMin)}, on ${r.flight.thrustToWeight.toFixed(2)}:1 of thrust.`,
    times ? `Fly it — turn for home at ${mmss(times.outMin)} on the timer.` : 'Fly it, and keep an eye on the timer.',
  ];

  const chips = [`lift ${r.flight.thrustToWeight.toFixed(2)}:1`];
  if (r.speedLimitMs > 0) chips.push(`gusts ${f0(gustShare * 100)}% of top speed`);
  if (b.maxContA) chips.push(`hover ${f0(iRatio * 100)}% of pack rating`);
  chips.push(r.energy.sagLimited ? 'sag-limited' : 'sag headroom OK');
  const land = landingSoc(r);
  if (land != null) chips.push(`lands ~${f0(land)}%`);

  return { level, label, why, fix, margins: chips.join(' · ') };
}

function renderVerdict(r, stranded) {
  const v = verdict(r, stranded);
  const host = $('verdict');
  host.className = `verdict verdict-${v.level}`;
  $('verdict-badge').textContent = v.label;
  $('verdict-why').textContent = v.why;
  const fix = $('verdict-fix');
  fix.textContent = v.fix || '';
  fix.hidden = !v.fix;
  $('verdict-margins').textContent = v.margins;
}

function flightLabel(flight) {
  if (flight.code === 'no_lift') return 'WILL NOT FLY';
  if (flight.code === 'no_control_margin') return 'NO CONTROL MARGIN';
  if (flight.code === 'marginal') return 'MARGINAL';
  return 'VIABLE';
}

function setChartFlightState(id, flight, message = null) {
  const host = $(id);
  const invalid = flight.code === 'no_lift';
  host.classList.toggle('flight-invalid', invalid);
  host.dataset.flightMessage = invalid ? (message || 'WILL NOT FLY · lift ceiling exceeded') : '';
}

function renderStats(r) {
  const u = units();
  const noLift = r.flight.code === 'no_lift';
  const hero = document.querySelector('.hero-card');
  hero.classList.toggle('flight-invalid-card', noLift);
  $('hero-value').textContent = noLift ? 'WILL NOT FLY' : f1(u.distanceFromKm(r.radiusKm));
  $('hero-unit').textContent = noLift ? '' : u.distanceUnit;
  const stranded = !noLift && !(r.legs.out && r.legs.back);
  const times = legTimes(r);
  const land = landingSoc(r);
  // Reserve plus whatever sag strands under it — say which, so "35%" doesn't
  // read as the app disagreeing with the reserve slider.
  const landing = land == null ? `${f0(r.energy.reservePct)}% reserve`
    : land - r.energy.reservePct < 0.5 ? `about ${f0(land)}% left, your landing reserve`
    : `about ${f0(land)}% left — your ${f0(r.energy.reservePct)}% reserve plus the bottom the pack can’t use`;
  $('hero-sub').textContent = noLift
    ? `${f0(r.massKg * 1000)} g AUW exceeds ${f0(r.flight.maxHoverMassG)} g estimated continuous lift`
    : stranded
      ? 'Zero radius — you could not fly home from any distance out. See the note above.'
      : `${f1(u.distanceFromKm(r.radiusKm))} ${u.distanceUnit} out — start home at ${mmss(times?.outMin)} on the timer, land at ${mmss(r.timeMin)} with ${landing}`;
  setTile('tile-time', noLift ? '—' : mmss(r.timeMin),
    noLift ? 'mission invalid · insufficient lift'
      : times ? `${mmss(times.outMin)} out · ${mmss(times.backMin)} home · ${f1(u.distanceFromKm(r.totalKm))} ${u.distanceUnit} round trip`
      : 'no out-and-back closes in this wind');
  setTile('tile-hover', noLift ? '—' : mmss(r.hoverTimeMin),
    noLift ? `requires ${f0(r.hover.pW)} W · cannot sustain hover` : `hover · ${f0(r.hover.pW)} W · ${f1(r.hover.iA)} A`);
  setTile('tile-auw', `${f0(r.massKg * 1000)} g`,
    `${f1(r.massKg * 2.20462)} lb · lift ceiling ${f0(r.flight.maxHoverMassG)} g`);
  const d = drone();
  setTile('tile-disc', `${r.discLoadingGcm2.toFixed(2)} g/cm²`, `${d.numRotors}× ${d.propDiaIn}″ props`);
  setTile('tile-eff', `${r.flight.thrustToWeight.toFixed(2)}:1`,
    `${flightLabel(r.flight)} · ${r.flight.limitingComponent} limited · estimated`);
  setTile('tile-da', `${f0(U.mToFt(r.densityAltM))} ft`, `density altitude · ρ ${r.rho.toFixed(3)} kg/m³`);
  const out = r.legs.out, back = r.legs.back;
  setTile('tile-cruise',
    out && back ? `${f0(u.speedFromMs(out.v))} / ${f0(u.speedFromMs(back.v))} ${u.speedUnit}` : '—',
    out && back ? `airspeed out / back · ${f0(u.speedFromMs(out.vg))} / ${f0(u.speedFromMs(back.vg))} ${u.speedUnit} gs`
      : noLift ? 'mission invalid · insufficient lift' : 'wind or propulsion exceeds capability');
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
  const limitPts = pts.length ? [
    { x: pts[0].x, y: r.flight.maxElectricalW },
    { x: pts.at(-1).x, y: r.flight.maxElectricalW },
  ] : [];
  lineChart($('chart-power'), {
    series: [
      { name: 'required electrical power', color: 'var(--series-1)', pts },
      { name: 'continuous power ceiling', color: 'var(--status-critical)', pts: limitPts, dash: '6 5' },
    ],
    markers, height: 250,
    xLabel: `airspeed (${u.speedUnit})`, yLabel: 'W',
    xFmt: v => `${f0(v)}`, yFmt: v => `${f0(v)}`,
    tipTitle: 'airspeed',
  });
  setChartFlightState('chart-power', r.flight);
}

function renderSpeedTradeoff(r) {
  const u = units();
  const d = drone();
  const base = missionInputs();
  const cache = packCache(battery());
  const time = state.speedMetric === 'time';
  const unit = time ? '' : ` ${u.distanceUnit}`;
  const metric = time ? mmss : f1;
  const pts = [];
  let best = null;
  for (let v = 2; v <= d.maxSpeedMs * 0.95; v += 0.5) {
    const rr = planMission({ ...base, cruiseMode: 'manual', manualVMs: v, lite: true, _pCache: cache });
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
    xLabel: `cruise airspeed (${u.speedUnit})`, yLabel: time ? 'mm:ss' : u.distanceUnit,
    xFmt: v => f0(v), yFmt: v => metric(v), tipTitle: 'cruise',
  });
  setChartFlightState('chart-speed', r.flight);
  const note = $('speed-note');
  if (viable && plannedSpeed !== null) {
    const py = nearestY(plannedSpeed);
    const cost = best.y - py;
    note.textContent =
      `${time ? 'Longest flight' : 'Best range'}: ${f0(best.x)} ${u.speedUnit} → ${metric(best.y)}${unit} · ` +
      `planned: ${f0(plannedSpeed)} ${u.speedUnit} → ${metric(py)}${unit}` +
      (atOptimum || cost <= 0.05 ? ' · already at the optimum'
        : ` · pushing costs ${metric(cost)}${time ? ' of flight time' : ` ${u.distanceUnit} of radius`}`);
  } else {
    note.textContent = r.flight.code === 'no_lift'
      ? 'No cruise calculation is valid because the configured aircraft cannot sustain hover.'
      : 'No cruise speed produces a viable out-and-back in this wind or propulsion envelope.';
  }
}

function renderProfile(r) {
  const u = units();
  const empty = $('chart-profile-empty');
  empty.hidden = r.timeline.length > 0;
  empty.textContent = r.flight.code === 'no_lift'
    ? 'WILL NOT FLY — all-up weight exceeds the estimated continuous lift ceiling.'
    : 'No viable mission in these conditions.';
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
  setChartFlightState('chart-profile', r.flight);
}

// Out-leg → home-leg burn. The home leg is the one that strands you, so it
// carries the emphasis; an average would hide it entirely.
function burnCell(r, u) {
  if (!r.legs.out || !r.legs.back) return '—';
  const outBurn = u.burnFromWhPerKm(r.legs.out.whPerKm);
  const backBurn = u.burnFromWhPerKm(r.legs.back.whPerKm);
  const frag = document.createDocumentFragment();
  const homeWorse = backBurn >= outBurn;
  const out = document.createElement(homeWorse ? 'span' : 'strong');
  out.textContent = f1(outBurn);
  const back = document.createElement(homeWorse ? 'strong' : 'span');
  back.textContent = f1(backBurn);
  frag.append(out, ' → ', back, ` ${u.burnUnit}`);
  return frag;
}

function renderComparison() {
  const u = units();
  const batts = compatibleBatteries();
  const runs = batts.map(b => {
    const effective = loadoutBattery(b);
    return { b, effective, r: planMission({ ...missionInputs(b), lite: true, _pCache: packCache(b) }) };
  });
  barChart($('chart-cmp-radius'), {
    items: runs.map(({ b, r }, i) => ({
      label: `${state.parallelPacks ? '2× ' : ''}${b.short || b.name}`, value: u.distanceFromKm(r.radiusKm),
      color: SERIES[i % SERIES.length], note: 'mission radius', invalid: r.flight.code === 'no_lift',
    })),
    valueFmt: v => `${f1(v)} ${u.distanceUnit}`,
  });
  barChart($('chart-cmp-time'), {
    items: runs.map(({ b, r }, i) => ({
      label: `${state.parallelPacks ? '2× ' : ''}${b.short || b.name}`, value: r.timeMin,
      color: SERIES[i % SERIES.length], note: 'flight time', invalid: r.flight.code === 'no_lift',
    })),
    valueFmt: v => mmss(v),
  });

  // table view
  const tbody = $('cmp-table').querySelector('tbody');
  tbody.replaceChildren();
  for (const { b, effective, r } of runs) {
    const tr = document.createElement('tr');
    tr.classList.toggle('row-invalid', r.flight.code === 'no_lift');
    const cells = [
      manufacturer(b.manufacturerId)?.name || 'Custom',
      `${state.parallelPacks ? '2× ' : ''}${b.name}${b.custom ? ' ·custom' : ''}`,
      [b.cellMaker, b.cellModel].filter(Boolean).join(' '),
      effective.config || `${effective.s}S${effective.p || 1}P`,
      CHEMISTRY[b.chem].label + ` ${b.s}S`,
      `${f0(effective.capAh * 1000)} mAh`,
      `${f1(r.energy.packWh)} Wh`,
      `${f0(effective.massG)} g`,
      `${f0(r.massKg * 1000)} g`,
      `${r.discLoadingGcm2.toFixed(2)} g/cm²`,
      `${r.flight.thrustToWeight.toFixed(2)}:1`,
      flightLabel(r.flight),
      `${f1(u.distanceFromKm(r.radiusKm))} ${u.distanceUnit}`,
      mmss(r.timeMin),
      burnCell(r, u),
      effective.priceUsd ? `$${effective.priceUsd}` : '—',
    ];
    cells.forEach((c, i) => {
      const td = document.createElement('td');
      if (c instanceof Node) td.appendChild(c);
      else td.textContent = c || '—';
      if (i >= 5) td.className = 'num';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
}

function renderWindSensitivity(r) {
  const u = units();
  // The pack you're flying always makes the chart; catalog order fills the rest.
  const sel = battery();
  const all = compatibleBatteries();
  const others = all.filter(b => b.id !== sel?.id);
  const batts = (sel ? [sel, ...others] : others).slice(0, 4);
  const series = batts.map((b) => {
    const cache = packCache(b);
    const pts = [];
    for (let w = 0; w <= 30; w += 2) {
      const env = { ...state.env, windMph: w, gustMph: w * 1.5 }; // gusts scale with the sweep
      const rr = planMission({ ...missionInputs(b, env), lite: true, _pCache: cache });
      pts.push({ x: u.speedFromMph(w), y: u.distanceFromKm(rr.radiusKm) });
    }
    // Color follows the pack's catalog position so it matches the shoot-out chart
    // even with the selected pack hoisted to the front.
    return { name: b.short || b.name, color: SERIES[all.findIndex(x => x.id === b.id) % SERIES.length], pts };
  });
  lineChart($('chart-wind'), {
    series, height: 250,
    xLabel: `average wind (${u.speedUnit})`, yLabel: u.distanceUnit,
    xFmt: v => f0(v), yFmt: v => f1(v),
    tipTitle: 'wind',
  });
  legend($('legend-wind'), series);
  setChartFlightState('chart-wind', r.flight);
}

/* ---------- live weather mode ---------- */

let liveSeq = 0;       // stale-response guard: only the latest fetch may apply
let liveFetching = false;
let liveData = null;   // { patch, gust10Mph, at } of the last successful fetch
let liveErr = null;
let geoMsg = null;     // geolocation progress/denial, shown in the same status line

/** Never show live numbers without saying whose sky they came from. */
function launchLabel() {
  const pt = launchPoint();
  return isDefaultLaunch(pt)
    ? `${DEFAULT_LAUNCH_NAME} · default spot, not your location. Use “Use my location”, or move the pin on the Map tab.`
    : `${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)}`;
}

function liveStatusText() {
  if (state.weatherId !== 'live') return geoMsg || '';
  const where = `${liveErr ? 'Launch point' : 'Live'} — ${launchLabel()}`;
  if (geoMsg) return `${where}\n${geoMsg}`;
  if (liveErr) return `${where}\nLive weather unavailable (${liveErr}) — using last values, or pick a preset.`;
  if (liveFetching || !liveData) return `${where}\nFetching live weather at the launch point…`;
  const u = units();
  const p = liveData.patch;
  return `${where}\n`
    + `surface ~${f0(u.speedFromMph(surfaceMph(p.windMph)))} / aloft ${f0(u.speedFromMph(p.windMph))} ${u.speedUnit} `
    + `from ${p.windFromDeg}° (${compass(p.windFromDeg)}) · `
    + `gusts ${f0(u.speedFromMph(Math.max(liveData.gust10Mph, p.windMph)))} ${u.speedUnit} · `
    + `${p.tempF}°F · ${p.rhPct}% RH · fetched ${liveData.at}`;
}

/**
 * Move the launch point to the device's position and refetch. The map reads the
 * saved point when it initializes, so a pin placed here survives the tab switch.
 */
function useMyLocation() {
  if (!navigator.geolocation) {
    geoMsg = 'This browser won’t share a location — move the pin on the Map tab instead.';
    updateLiveUI();
    return;
  }
  geoMsg = 'Getting your location…';
  updateLiveUI();
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const saved = loadMapState();
      const pt = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      saveMapState({ ...pt, zoom: saved?.zoom ?? 13, baseLayer: saved?.baseLayer ?? 'satellite' });
      setLaunchPoint(pt); // sync the on-screen pin if the map is already up
      geoMsg = null;
      goLive(pt);
    },
    (err) => {
      geoMsg = err.code === err.TIMEOUT
        ? 'Location timed out — try again, or drop the pin yourself on the Map tab.'
        : err.code === err.POSITION_UNAVAILABLE
          ? 'Location unavailable — drop the pin yourself on the Map tab.'
          : 'Location denied — the launch point is unchanged. Drop the pin yourself on the Map tab.';
      updateLiveUI();
    },
    { enableHighAccuracy: true, timeout: 8000 },
  );
}

function updateLiveUI() {
  const active = state.weatherId === 'live';
  const btn = $('btn-live');
  btn.classList.toggle('active', active);
  btn.setAttribute('aria-pressed', active);
  const msg = liveStatusText();
  const st = $('live-status');
  st.textContent = msg;
  st.hidden = !msg;
}

async function goLive(pt) {
  const seq = ++liveSeq;
  state.weatherId = 'live';
  liveFetching = true;
  liveErr = null;
  geoMsg = null; // a stale denial/timeout note must not outlive the next fetch
  populateControls();
  update();
  try {
    const { patch, gust10Mph } = await fetchLiveEnv(pt ?? launchPoint());
    if (seq !== liveSeq || state.weatherId !== 'live') return; // superseded meanwhile
    state.env = { ...state.env, ...patch };
    liveData = {
      patch, gust10Mph,
      at: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    };
  } catch (err) {
    if (seq !== liveSeq || state.weatherId !== 'live') return;
    liveErr = err.message;
  } finally {
    if (seq === liveSeq) {
      liveFetching = false;
      // Re-render only while still live: after a dropout the preset/custom
      // handler already rendered, and rewriting inputs would steal the caret.
      if (state.weatherId === 'live') {
        populateControls();
        update();
      }
    }
  }
}

function update() {
  updateLiveUI();
  const u = units();
  const batts = compatibleBatteries();
  if (!batts.find(b => b.id === state.batteryId)) {
    state.batteryId = batts[0]?.id;
    fillSelect($('sel-battery'), batts.map(b => ({ value: b.id, label: `${b.name} · ${b.massG} g` })), state.batteryId);
  }
  saveSession();
  packCaches = new Map();
  const sc = scenario();
  $('scenario-desc').textContent =
    `${sc.desc} ≈${f0(u.speedFromMs(drone().cruiseMs * sc.speedFactor))} ${u.speedUnit} realistic cruise · +${f0((sc.overheadFactor - 1) * 100)}% maneuvering burn.`;
  $('cmp-radius-title').textContent = `Mission radius (${u.distanceUnit})`;
  const r = planMission(missionInputs());
  const stranded = zeroRadiusNote(r);
  if (stranded) {
    // physics.js emits one generic line for this case; swap in the version that
    // names the lever to move.
    const i = r.warnings.findIndex(w => w.text.startsWith('Wind or loaded propulsion'));
    if (i >= 0) r.warnings[i] = { level: 'critical', text: stranded };
    else r.warnings.unshift({ level: 'critical', text: stranded });
  }
  // Both live outside the tab panels — the field answer and its callouts stay
  // on screen whichever tab is open.
  renderVerdict(r, stranded);
  renderWarnings(r.warnings);
  // Render only the visible view: charts measure container width and freeze at
  // a fallback size when drawn inside a hidden container.
  if (state.view === 'map') {
    renderMapView(r);
    return;
  }
  renderStats(r);
  renderPowerCurve(r);
  renderSpeedTradeoff(r);
  renderProfile(r);
  renderComparison();
  renderWindSensitivity(r);
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
  syncView(view);
  if (dash) pauseMapView();
  else showMapView(); // init-if-needed + invalidateSize, now that it's visible
  update();
}

const ESTIMATED_LABELS = {
  massG: 'pack weight',
  capAh: 'capacity',
  irPackMilliOhm: 'pack internal resistance',
  maxContA: 'continuous current limit',
  priceUsd: 'price',
  connector: 'connector',
};

function estimatedPhrase(keys) {
  const names = keys.map(k => ESTIMATED_LABELS[k] || k);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return list.charAt(0).toUpperCase() + list.slice(1);
}

function renderBatteryNote() {
  const host = $('battery-note');
  host.replaceChildren();
  const b = battery();
  const effective = loadoutBattery(b);
  const m = manufacturer(b.manufacturerId);
  const identity = [m?.name, b.cellMaker && b.cellModel ? `${b.cellMaker} ${b.cellModel}` : b.cellModel]
    .filter(Boolean).join(' · ');
  if (identity) host.append(document.createTextNode(`${identity}. `));
  if (state.parallelPacks) {
    host.append(document.createTextNode(
      `Parallel loadout: two identical packs, ${effective.config}, ${f0(effective.massG)} g including the ${f0(effective.harnessMassG)} g harness allowance. `
    ));
  }
  if (b.estimated?.length) {
    host.append(document.createTextNode(
      `${estimatedPhrase(b.estimated)} ${b.estimated.length === 1 ? 'is' : 'are'} estimated; replace with the finished pack’s measured values when available.`
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

let swapTimer = 0;

function showSwapNotice(msg) {
  const el = $('swap-notice');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(swapTimer);
  swapTimer = setTimeout(clearSwapNotice, 12000);
}

function clearSwapNotice() {
  clearTimeout(swapTimer);
  const el = $('swap-notice');
  el.textContent = '';
  el.hidden = true;
}

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
  $('sel-drone').addEventListener('change', e => {
    const prev = allBatteries().find(b => b.id === state.batteryId);
    state.droneId = e.target.value;
    populateControls();
    const now = battery();
    if (prev && now && now.id !== prev.id) {
      showSwapNotice(`${prev.name} doesn’t fit the ${drone().name} — switched to ${now.name}.`);
    } else {
      clearSwapNotice();
    }
    update();
  });
  $('sel-manufacturer').addEventListener('change', e => {
    state.manufacturerId = e.target.value;
    state.batteryId = compatibleBatteries()[0]?.id;
    populateControls();
    update();
  });
  $('sel-battery').addEventListener('change', e => {
    state.batteryId = e.target.value;
    clearSwapNotice();
    update();
  });
  $('in-parallel').addEventListener('change', e => {
    state.parallelPacks = e.target.checked;
    populateControls();
    update();
  });
  $('sel-payload').addEventListener('change', e => { state.payloadId = e.target.value; update(); });
  $('in-extra').addEventListener('input', e => {
    // Clamp to the input's own range: browsers don't enforce max on typed values,
    // and an out-of-range save would void the whole session restore.
    state.extraG = Math.min(500, Math.max(0, +e.target.value || 0));
    update();
  });
  $('btn-live').addEventListener('click', () => goLive());
  $('btn-geo').addEventListener('click', useMyLocation);
  $('sel-weather').addEventListener('change', e => {
    if (e.target.value === 'live') { goLive(); return; }
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
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // Mobile URL-bar collapse and the keyboard fire resize with unchanged
      // width — those only need a map reflow, not a full footprint re-render.
      if (window.innerWidth === lastWidth) {
        if (state.view === 'map') resizeMapView();
        return;
      }
      lastWidth = window.innerWidth;
      update();
    }, 150);
  });
  document.addEventListener('scroll', hideTooltip, { passive: true });
}

setupMapView({
  missionInputs,
  units,
  requestRender: update,
  goLive,
  onLaunchMove: (pt) => { if (state.weatherId === 'live') goLive(pt); },
});
setupThemes(() => {
  hideTooltip();
  update();
});
setupShell({ setView });
const bootView = restoreSession();
populateControls();
bind();
if (bootView === 'map') setView('map'); // renders as a side effect
// Live is the boot default (renders immediately, patches when the fetch lands),
// but a saved preset or hand-entered weather must not be overwritten by it.
if (state.weatherId === 'live') goLive();
else if (bootView !== 'map') update();
