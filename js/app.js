// app.js — the wiring hub: one render pass, the event bindings, and boot.
// State lives in state.js and every render lives in js/render/*; nothing
// imports this file, so app-level callbacks (update, setView) reach those
// modules by one-time injection at boot.
import { WEATHER, allBatteries, allManufacturers, saveCustomBattery, saveCustomManufacturer } from './data.js';
import { planMission } from './physics.js';
import { hideTooltip } from './charts.js';
import {
  setupMapView, showMapView, renderMapView, pauseMapView, resizeMapView,
} from './map.js';
import { setupShell, syncView } from './shell.js';
import { setupThemes } from './themes.js';
import { readForm } from './forms.js';
import {
  state, beginner, drone, battery, compatibleBatteries, missionInputs, scenario, units,
  saveSession, restoreSession,
} from './state.js';
import { $ } from './render/dom.js';
import { f0 } from './render/format.js';
import {
  setupControls, populateControls, fillSelect, renderBatteryNote,
  buildAuthoringForms, BATTERY_FORM, MANUFACTURER_FORM,
} from './render/controls.js';
import {
  resetPackCaches, renderWarnings, zeroRadiusNote, renderVerdict, renderNoBattery,
  renderStats, renderPowerCurve, renderSpeedTradeoff, renderProfile, renderWindSensitivity,
} from './render/dashboard.js';
import { renderComparison } from './render/comparison.js';
import { setupLive, goLive, useMyLocation, updateLiveUI, liveError } from './render/live.js';
import { setupForecast, renderForecastStrip, setForecastHour } from './render/forecast.js';
import { renderSpots, bindSpots } from './render/spots.js';
import { renderSessionPlanner } from './render/session.js';

function update() {
  updateLiveUI();
  const u = units();
  const batts = compatibleBatteries();
  if (!batts.find(b => b.id === state.batteryId)) {
    state.batteryId = batts[0]?.id;
    fillSelect($('sel-battery'), batts.map(b => ({ value: b.id, label: `${b.name} · ${b.massG} g` })), state.batteryId);
  }
  saveSession();
  resetPackCaches();
  const sc = scenario();
  // The speed now rides on the option itself, so this line carries what the
  // dropdown can't: how much extra the stick work costs.
  $('scenario-desc').textContent =
    `${sc.desc} Burns about ${f0((sc.overheadFactor - 1) * 100)}% more than steady cruise.`;
  $('cmp-radius-title').textContent = `Mission radius (${u.distanceUnit})`;
  const r = planMission(missionInputs());
  // Handled, not thrown: with no pack there is no plan, and every render below
  // this line reads one. Say it in the verdict card and stop here.
  if (r.code === 'no_battery') {
    renderNoBattery();
    return;
  }
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
  renderForecastStrip(r);
  // The saved-spots roster lives on the Map tab, and its
  // distance-from-pin metas go stale whenever the pin moves.
  if (state.view === 'map') renderSpots();
  // Render only the visible view: charts measure container width and freeze at
  // a fallback size when drawn inside a hidden container.
  if (state.view === 'map') {
    renderMapView(r);
    return;
  }
  renderStats(r);
  // Same reason the map view skips these: a chart drawn into a display:none
  // container measures nothing and freezes at a fallback size. Beginner mode
  // hides these three cards, so skip the sweeps behind them entirely.
  if (!beginner()) {
    renderPowerCurve(r);
    renderSpeedTradeoff(r);
    renderProfile(r);
  }
  renderComparison();
  renderWindSensitivity(r);
  renderBatteryNote();
  renderSessionPlanner();
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
  $('sel-detail').addEventListener('change', e => {
    state.detail = ['full', 'beginner'].includes(e.target.value) ? e.target.value : 'full';
    // populateControls() stamps the body attribute the CSS reads, rebuilds the
    // cruise options, and resets an expert cruise mode that just went off screen.
    populateControls();
    update();
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
    const v = readForm(e.target, MANUFACTURER_FORM);
    if (!v.name) return;
    const id = 'manufacturer-' + v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    saveCustomManufacturer({
      id,
      name: v.name,
      url: v.url && /^https?:\/\//i.test(v.url) ? v.url : null,
    });
    e.target.reset();
    populateControls();
    $('custom-manufacturer').value = id;
  });

  $('custom-form').addEventListener('submit', e => {
    e.preventDefault();
    const v = readForm(e.target, BATTERY_FORM);
    if (!v.name) return;
    // Free-text brand, deduped behind the scenes: reuse an existing builder by
    // name (case-insensitive) so "gnb" and "GNB" don't fork into two rows, and
    // silently register a new one otherwise. Blank brand keeps the old
    // fallback id — 'custom' is a real catalog entry ("Ungrouped custom").
    const brand = (v.brand || '').trim();
    let manufacturerId = 'custom';
    if (brand) {
      const existing = allManufacturers().find(m => m.name.toLowerCase() === brand.toLowerCase());
      if (existing) {
        manufacturerId = existing.id;
      } else {
        // Same id shape the manufacturer form below already mints by hand.
        manufacturerId = 'manufacturer-' + brand.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        saveCustomManufacturer({ id: manufacturerId, name: brand, url: null });
      }
    }
    // "Any matching" (the default) omits `fits` entirely and leaves
    // registry.compatible()'s computed connector/cell-count rule to decide;
    // "Only specific drones" pins it to whatever got checked.
    const fits = v.fitsMode === 'specific' && v.fitsDrones?.length ? v.fitsDrones : undefined;
    const id = `custom-${manufacturerId}-${v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const s = v.s || 0;
    const p = v.p || 1;
    saveCustomBattery({
      id,
      name: v.name, short: v.name.slice(0, 14),
      chem: v.chem, s, p,
      capAh: (v.mah || 0) / 1000,
      massG: v.mass || 0,
      irPackMilliOhm: v.ir || 25,
      maxContA: v.amps || null,
      connector: v.connector || drone().connector,
      fits,
      manufacturerId,
      cellMaker: v.cellMaker,
      cellModel: v.cellModel,
      config: `${s}S${p}P`,
      priceUsd: v.price || null,
      custom: true,
    });
    state.manufacturerId = manufacturerId;
    state.batteryId = id;
    e.target.reset();
    // reset() doesn't fire 'change', so nudge the fits checklist's visibility
    // back in step with the mode select it just reset to 'any'.
    $('battery-fits-mode').dispatchEvent(new Event('change'));
    populateControls();
    update();
  });

  $('in-forecast-hour').addEventListener('input', e => setForecastHour(+e.target.value));
  bindSpots();
  // Session-planner row count inputs bind their own listener when built in renderSessionPlanner();
  // no static bindings needed here since the rows don't exist until first render.

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

/* ---------- boot ---------- */

// Injection before any render: every render module reaches update() (and the
// live-fetch error state) through these, never by importing this file.
setupControls({ update });
setupLive({ update });
setupForecast({ update, liveError });
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
buildAuthoringForms();
populateControls();
bind();
if (bootView === 'map') setView('map'); // renders as a side effect
// Live is the boot default (renders immediately, patches when the fetch lands),
// but a saved preset or hand-entered weather must not be overwritten by it.
if (state.weatherId === 'live') goLive();
else if (bootView !== 'map') update();
