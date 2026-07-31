// app.js — the wiring hub: one render pass, the event bindings, and boot.
// State lives in state.js and every render lives in src/render/*; nothing
// imports this file, so app-level callbacks (update, setView) reach those
// modules by one-time injection at boot.
import { WEATHER, allBatteries, allManufacturers, saveCustomBattery, saveCustomManufacturer } from './data.js';
import { hideTooltip } from './charts.js';
import {
  setupMapView, showMapView, renderMapView, pauseMapView, resizeMapView,
} from './presentation/map/map-view.js';
import { setupShell, syncDest } from './shell.js';
import { setupThemes } from './themes.js';
import { setupUpdateNotice } from './render/update-notice.js';
import { readForm } from './forms.js';
import {
  state, beginner, drone, battery, compatibleBatteries, missionInputs, scenario, units,
  saveSession, restoreSession, restoredDest, packPreheatSeedF, PACK_TEMP_RANGE_F,
} from './state.js';
import { loadMapState } from './store.js';
import { $, fillSelect } from './render/dom.js';
import { f0 } from './render/format.js';
import {
  setupControls, populateControls, renderWindNotes, renderPackTempNote, renderBatteryNote,
  buildAuthoringForms, BATTERY_FORM, MANUFACTURER_FORM,
} from './render/controls.js';
import { setupDroneForm, buildDroneForm } from './render/droneform.js';
import { setupPackInstances, buildPackInstanceForm } from './render/packinstances.js';
import { resolvePackIr, resetBatteryChecks } from './render/batterychecks.js';
import { setupFlightLog, buildFlightLogForm } from './render/flightlog.js';
import { setupCalibration, renderDriftChart } from './render/calibration.js';
import {
  resetPackCaches, renderWarnings, renderVerdict, renderNoBattery, renderReserveNote,
  renderStats, renderPowerCurve, renderSpeedTradeoff, renderProfile, renderWindSensitivity,
} from './render/dashboard.js';
import { renderComparison } from './render/comparison.js';
import { setupLive, goLive, useMyLocation, updateLiveUI, liveError, liveProvenance } from './render/live.js';
import {
  setupForecast, renderForecastStrip, setForecastHour, reapplyForecastHour,
} from './render/forecast.js';
import { setupTerrain, renderTerrainCard } from './render/terrain.js';
import { isLinkBand } from './rf.js';
import { isCruiseAlt, activeLevelPatch } from './windprofile.js';
import { renderRouteCard } from './render/route.js';
import {
  setupMissionBridge, openMissionBridge, missionWaypoints,
  addWaypoint, moveWaypoint, removeWaypoint, clearRoute,
  missionDocument, importMission,
} from './mission-bridge.js';
import { setupInterop } from './interop.js';
import {
  analyzeNow, analysisRevision, acceptAsync, setupAnalysisHost, groundAt,
  restoreEvidenceFor, forgetEvidence,
} from './analysis-host.js';
import {
  missionSeed, restoreLaunch, pushLaunch, pushLoadout, pushEnvironment, pushPolicy,
} from './mission-commands.js';
import { renderMissions, renderMissionStorage, bindMissions } from './render/missions.js';
import { renderSpots, bindSpots } from './render/spots.js';
import { setupShare, bindShare } from './render/share.js';
import { renderSessionPlanner } from './render/session.js';
import { renderWindRibbon, windModelFrom } from './components/wind-ribbon.js';
import { renderMissionSummary, summaryModelFrom } from './components/mission-summary.js';

/**
 * The analysis snapshot this render pass drew, for the mission brief (Phase 4
 * item 8).
 *
 * The brief has to print the plan the pilot is looking at, not a fresh one it
 * solved for itself — a re-plan a keystroke later would be a different document
 * from the screen it was opened off. So the pass hands its own snapshot over here
 * and render/brief.js reads it through injection, the same way every other render
 * module reaches update(): nothing imports this file.
 *
 * @type {import('./application/analysis/analysis-contracts.js').AnalysisSnapshot|null}
 */
let latest = null;

/**
 * The wind ribbon's last-drawn model, kept so the minute tick can refresh its
 * age text ("3 min ago" → "4 min ago") without an analysis pass. Only the
 * wall-clock wording moves between updates — the stale *color* is decided by
 * the snapshot's own forecast-age constraints, which re-analyze on their own
 * threshold crossings.
 * @type {import('./components/wind-ribbon.js').WindRibbonModel|null}
 */
let ribbonModel = null;

/** @type {Promise<typeof import('./render/brief.js')>|null} */
let briefPromise = null;

/**
 * The brief rides in its own lazy chunk, the same shape as interop's engine():
 * one dynamic import on first click, cached forever after. render/brief.js
 * drags src/brief.js — every sentence and number the brief prints — with it,
 * none of which the entry bundle needs before a pilot asks for the brief.
 * First load also wires the module's own close/print/Escape listeners.
 */
function briefUi() {
  briefPromise ??= import('./render/brief.js').then((m) => {
    m.setupBrief({ latest: () => latest });
    m.bindBrief();
    return m;
  }).catch((e) => {
    // A chunk fetch that failed offline should succeed the moment
    // connectivity returns (ADR 0012 §4) — caching the rejection forever
    // would mean only a full reload could ever retry it.
    briefPromise = null;
    throw e;
  });
  return briefPromise;
}

/**
 * One render pass: refresh the rail's own text, ask the analysis host for the
 * snapshot, and hand that one object to everything that draws. Nothing below
 * this line computes physics — every number and every warning on screen comes
 * out of the snapshot, which is what makes the brief and the rail incapable of
 * disagreeing (ADR 0008).
 */
function update() {
  latest = null;
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
  // Ahead of the no-pack bail-out below, because this one owns the visibility of
  // its own control: a rig with no compatible pack still has a rail the pilot can
  // tick the pack-temperature box on.
  renderPackTempNote();
  const snapshot = analyzeNow();
  // Nothing to draw until the repository has handed a document back — a round
  // trip to IndexedDB at boot, after which openMissionBridge() asks for its own
  // render. The rail above this line is already up, which is what the pilot sees.
  if (!snapshot) return;
  // The warning stack is the one render that survives a mission with no plan:
  // "no pack selected" is itself a coded constraint on the snapshot.
  renderWarnings(snapshot.constraints);
  // So is the wind ribbon (M9): persistent chrome on every destination, ahead
  // of the no-plan bail because the sky is real whether or not a pack fits.
  ribbonModel = windModelFrom(snapshot);
  renderWindRibbon($('wind-ribbon'), ribbonModel);
  // Handled, not thrown: with no pack there is no plan, and every render below
  // this line reads one. Say it in the verdict card and stop here.
  if (!snapshot.plan) {
    renderNoBattery();
    return;
  }
  document.body.dataset.plan = 'ok'; // undoes renderNoBattery()'s panel blackout
  // Both live outside the tab panels — the field answer and its callouts stay
  // on screen whichever tab is open.
  latest = snapshot;
  const r = snapshot.plan;
  const link = snapshot.link;
  renderVerdict(snapshot);
  renderForecastStrip(r);
  // Rail text that tracks the sliders rather than the tabs: both of these sit
  // beside the controls that move them, and both stay live on the map tab.
  renderWindNotes();
  renderReserveNote(r);
  // Render only the open destination — and inside Plan, only the visible
  // workspace mode: charts measure container width and freeze at a fallback
  // size when drawn inside a display:none container.
  if (state.dest === 'field') {
    renderMissionSummary($('mission-summary'), summaryModelFrom(r));
    renderSessionPlanner();
    return;
  }
  if (state.dest === 'library') {
    // The roster's distance-from-pin metas go stale whenever the pin moves.
    renderSpots();
    return;
  }
  if (state.dest === 'aircraft') {
    // Beginner mode hides the two performance cards, so skip the sweeps
    // behind them entirely.
    if (!beginner()) {
      renderPowerCurve(r);
      renderSpeedTradeoff(r);
    }
    renderComparison();
    renderBatteryNote();
    // populateControls draws this at boot, possibly while Aircraft is hidden —
    // redraw at the real container width now that it is showing.
    renderDriftChart();
    return;
  }
  if (state.view === 'map') {
    // The route (Phase 4 item 7) is integrated once, inside the analysis, and
    // handed to both the map that draws it and the card that explains it — so the
    // line and the verdict under it cannot disagree about whether it fits. Both
    // decide for themselves whether route mode is showing.
    renderMapView(snapshot);
    renderRouteCard(r, snapshot.route);
    // The licence line rides in on the snapshot's provenance (CC BY 4.0, task
    // #47): whichever elevation source answered — the corridor field or the
    // single-bearing profile — the card credits the one that did.
    renderTerrainCard(r, link, snapshot.provenance.terrainAttribution);
    return;
  }
  renderStats(r);
  if (!beginner()) renderProfile(r);
  renderWindSensitivity(r);
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
  // The tabs are only clickable inside Plan, but boot restores the saved mode
  // before the saved destination — starting the map inside a hidden Plan would
  // have Leaflet measure a 0×0 container.
  if (state.dest !== 'plan') {
    saveSession();
    return;
  }
  if (dash) pauseMapView();
  else showMapView(); // init-if-needed + invalidateSize, now that it's visible
  update();
}

/**
 * Switch destinations (Field / Plan / Library / Aircraft). Sections toggle by
 * [hidden]; the body attribute drives the rail's visibility and the layout
 * column count, and update() draws only what just became visible.
 */
function setDest(dest) {
  if (state.dest === dest) return;
  const wasPlan = state.dest === 'plan';
  state.dest = dest;
  document.body.dataset.dest = dest;
  for (const d of ['plan', 'field', 'library', 'aircraft']) {
    $(`dest-${d}`).hidden = d !== dest;
  }
  syncDest(dest);
  // The mission list only re-reads IndexedDB on fold-open and on document
  // change, and the fold ships open now — re-list on entry so a mission saved
  // in another tab is there when the pilot arrives. Here, not in update()'s
  // library branch: update() runs on every input event while the rail is live.
  if (dest === 'library') renderMissions();
  // The map only lives inside Plan: stop its animation work while it's off
  // screen, and bring it back (init-if-needed + invalidateSize) on return.
  if (wasPlan && state.view === 'map') pauseMapView();
  if (dest === 'plan' && state.view === 'map') showMapView();
  saveSession();
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

/**
 * Move the plan onto another level of the wind profile (Phase 4 item 9), and
 * re-plan for it.
 *
 * In live mode the hourly scrubber owns the sky, so it re-reads whichever hour is
 * on screen at the new level; with no forecast behind it the level applies to the
 * current-conditions patch instead. A preset or hand-entered wind is left exactly
 * as typed — that is a number the pilot chose, not a profile to index into.
 */
function setCruiseAlt(m) {
  state.cruiseAltM = m;
  pushPolicy();
  if (reapplyForecastHour()) return; // re-plans on its own
  if (state.weatherId === 'live') {
    const patch = activeLevelPatch(m);
    if (patch) state.env = { ...state.env, ...patch };
  }
  populateControls();
  update();
}

/* A rail edit is a mission edit (ADR 0002). Each control's own handler says which
   part of the document it moved and then re-plans, so the write happens where the
   intent is rather than being inferred by a later comparison pass. A command the
   reducer refuses returns false and warns on the console; the rail keeps the value
   the pilot typed, and this pass renders it either way. */
const editLoadout = () => { pushLoadout(); update(); };
// liveProvenance(): a rail edit that leaves live mode active (the wind-level
// select) must re-push the live fetch's own bag, not erase it (ADR 0012 §1).
const editEnv = () => { pushEnvironment(liveProvenance()); update(); };
const editPolicy = () => { pushPolicy(); update(); };

function bind() {
  $('tab-dash').addEventListener('click', () => setView('dash'));
  $('tab-map').addEventListener('click', () => setView('map'));
  document.querySelector('.view-tabs').addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    // The conditions-sheet button rides in the same row but is not a tab.
    if (!(e.target instanceof HTMLElement) || !e.target.classList.contains('view-tab')) return;
    e.preventDefault();
    const next = state.view === 'dash' ? 'map' : 'dash';
    setView(next);
    $(next === 'dash' ? 'tab-dash' : 'tab-map').focus();
  });
  $('sel-detail').addEventListener('change', e => {
    state.detail = ['full', 'beginner'].includes(e.target.value) ? e.target.value : 'full';
    // populateControls() stamps the body attribute the CSS reads, rebuilds the
    // cruise options, and resets an expert cruise mode that just went off screen.
    const prevAlt = state.cruiseAltM;
    populateControls();
    // Beginner mode pins the cruise altitude back to the default, and the wind on
    // the rail has to follow it off the level that just went off screen.
    if (state.cruiseAltM !== prevAlt) setCruiseAlt(state.cruiseAltM);
    else update();
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
    editLoadout();
  });
  $('sel-manufacturer').addEventListener('change', e => {
    state.manufacturerId = e.target.value;
    state.batteryId = compatibleBatteries()[0]?.id;
    populateControls();
    editLoadout();
  });
  $('sel-battery').addEventListener('change', e => {
    state.batteryId = e.target.value;
    clearSwapNotice();
    editLoadout();
  });
  $('in-parallel').addEventListener('change', e => {
    state.parallelPacks = e.target.checked;
    populateControls();
    editLoadout();
  });
  $('sel-payload').addEventListener('change', e => { state.payloadId = e.target.value; editLoadout(); });
  $('in-extra').addEventListener('input', e => {
    // Clamp to the input's own range: browsers don't enforce max on typed values,
    // and an out-of-range save would void the whole session restore.
    state.extraG = Math.min(500, Math.max(0, +e.target.value || 0));
    editLoadout();
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
    editEnv();
  });
  $('sel-scenario').addEventListener('change', e => { state.scenarioId = e.target.value; update(); });
  $('sel-speed-metric').addEventListener('change', e => { state.speedMetric = e.target.value; update(); });
  const envMap = { 'in-elev': 'elevFt', 'in-temp': 'tempF', 'in-rh': 'rhPct', 'in-winddir': 'windFromDeg' };
  for (const [id, key] of Object.entries(envMap)) {
    $(id).addEventListener('input', e => {
      state.env[key] = +e.target.value || 0;
      state.weatherId = 'custom';
      $('sel-weather').value = 'custom';
      // Typing an elevation moves the launch point's elevation, which is the
      // document's, not the rail's — so that field raises both commands.
      if (key === 'elevFt') pushLaunch();
      editEnv();
    });
  }
  for (const [id, key] of [['in-wind', 'windMph'], ['in-gust', 'gustMph']]) {
    $(id).addEventListener('input', e => {
      state.env[key] = units().speedToMph(+e.target.value || 0);
      state.weatherId = 'custom';
      $('sel-weather').value = 'custom';
      editEnv();
    });
  }
  $('sel-windmode').addEventListener('change', e => { state.env.windMode = e.target.value; editEnv(); });
  $('sel-cruise-alt').addEventListener('change', e => {
    const m = +e.target.value;
    if (!isCruiseAlt(m)) return; // a select value from nowhere is not a level
    setCruiseAlt(m);
  });
  $('sel-link-band').addEventListener('change', e => {
    if (!isLinkBand(e.target.value)) return; // a select value from nowhere is not a band
    state.linkBand = e.target.value;
    editPolicy();
  });
  $('in-reserve').addEventListener('input', e => {
    state.landFloorPct = +e.target.value;
    $('reserve-val').textContent = `${state.landFloorPct}%`;
    editPolicy();
  });
  $('in-gustf').addEventListener('input', e => {
    state.gustFactorPct = Math.min(100, Math.max(0, +e.target.value || 0));
    $('gustf-val').textContent = `${state.gustFactorPct}%`;
    editPolicy();
  });
  $('in-packtemp-on').addEventListener('change', e => {
    // On, the pack starts at a plausible preheat rather than an empty field; off,
    // it goes back to tracking the air, which is the default and the honest one.
    state.packTempF = e.target.checked ? packPreheatSeedF() : null;
    update();
  });
  $('in-packtemp').addEventListener('input', e => {
    // An empty or half-typed field ("-", "") is someone mid-edit, not a pack at
    // 0 °F — leave the last good number in place and wait.
    const v = e.target.value === '' ? NaN : +e.target.value;
    if (!Number.isFinite(v)) return;
    // Clamped to the input's own range for the same reason in-extra is: a typed
    // out-of-range value would void the whole session restore.
    const [lo, hi] = PACK_TEMP_RANGE_F;
    state.packTempF = Math.min(hi, Math.max(lo, v));
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
    $('battery-brand').value = v.name;
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
    // "Pin to specific drones" adds those drones as a guarantee — it does not
    // stop another drone from matching by connector and cell count too.
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
      // Per-cell entry mode multiplies up to the pack figure here; whole-pack mode
      // is the field as typed. Either way one pack-level number is stored, because
      // that is what physics.js reads.
      irPackMilliOhm: resolvePackIr(v) || 25,
      irTempC: v.irTempC,
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
    // Same for the resistance entry mode, and the cross-check line under it now
    // has an empty form to describe.
    resetBatteryChecks();
    populateControls();
    editLoadout();
  });

  $('in-forecast-hour').addEventListener('input', e => setForecastHour(+e.target.value));
  bindSpots();
  bindMissions();
  // Bound synchronously so the button works from first paint; the chunk loads
  // inside the first click. openBrief itself is async either way (it already
  // awaits the interop engine for the loss report), so nothing observable moved.
  $('btn-brief').addEventListener('click', () => {
    void briefUi().then((m) => m.openBrief()).catch((e) => {
      // Dropped, not surfaced: briefUi() already reset its own cache above, so
      // the next click retries the chunk fetch (ADR 0012 §4) rather than
      // replaying this failure or needing a dedicated error UI for it.
      console.warn('brief: the brief UI could not be loaded.', e);
    });
  });
  // An import adds rigs, packs and flights all at once, so the Share fold needs
  // the same pair the authoring forms do: rebuild the rail, then re-plan.
  bindShare();
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
        if (state.dest === 'plan' && state.view === 'map') resizeMapView();
        return;
      }
      lastWidth = window.innerWidth;
      update();
    }, 150);
  });
  document.addEventListener('scroll', hideTooltip, { passive: true });
  // The ribbon's freshness age is wall-clock text ("4 min ago"); tick it over
  // once a minute so a phone left open in the field doesn't read "just now"
  // an hour later. Re-draws the last model — no analysis, no fetch.
  setInterval(() => {
    if (ribbonModel) renderWindRibbon($('wind-ribbon'), ribbonModel);
  }, 60000);
}

/* ---------- boot ---------- */

// Injection before any render: every render module reaches update() (and the
// live-fetch error state) through these, never by importing this file.
setupControls({ update });
// The drone form re-picks the pack and the manufacturer filter after a save or a
// delete, so it needs populateControls() as well as update().
setupDroneForm({ update, populateControls });
// Choosing which physical pack is on the rig can change the plan (its measured
// resistance replaces the model's), so the same pair.
setupPackInstances({ update, populateControls });
// Logging a flight can change what the airframe flies like, so the same pair:
// the rail redraws its own status line and list, then the plan re-renders.
setupFlightLog({ update, populateControls });
// Applying a fit changes what the planner is flying, so the status line needs
// the same pair. The drift chart's view toggle only re-renders itself.
setupCalibration({ update, populateControls });
setupShare({ update, populateControls });
// The two async fetches land after the render that asked for them, so both need
// a way back in — and a way to find out whether the mission has moved on since,
// which is the analysis host's staleness guard (M2b §5).
const asyncPorts = { update, revision: analysisRevision, accept: acceptAsync };
setupLive(asyncPorts);
setupForecast({ update, liveError });
setupTerrain(asyncPorts);
// The third async landing (M3b): the ground under the whole corridor, not just
// the outbound bearing. Wiring it here rather than at import time is what lets
// the pipeline tests analyse a mission without a network — an unwired field port
// is a stated unknown, never a clear route.
setupAnalysisHost({ update });
setupMapView({
  missionInputs,
  units,
  beginner,
  requestRender: update,
  goLive,
  onLaunchMove: (pt) => { if (state.weatherId === 'live') goLive(pt); },
  // Dragging or clicking the pin moves the mission's launch point, and says so
  // here rather than being noticed by a later comparison pass (ADR 0002/0005).
  onLaunchChanged: pushLaunch,
  // The route belongs to the mission document now (ADR 0002): the map draws what
  // it reads back through here, and every edit it makes is a command.
  routeWaypoints: missionWaypoints,
  onAddWaypoint: addWaypoint,
  onMoveWaypoint: moveWaypoint,
  onRemoveWaypoint: removeWaypoint,
  onClearRoute: clearRoute,
});
// The mission document itself: seeded from the rail when there is nothing saved
// to open, and restoring the launch point onto the map and the rail when there
// is (src/mission-bridge.js's header has the whole story).
setupMissionBridge({
  seed: missionSeed,
  onLaunchRestored: (launch) => {
    // Read before restoreLaunch overwrites the saved point it is compared to.
    const prev = loadMapState();
    restoreLaunch(launch);
    // A live sky is the launch point's sky: a document swap that lands somewhere
    // else needs its own fetch, exactly as dragging the pin there does through
    // the map deps. Same-spot restores — every normal boot — fetch nothing, so
    // the boot fetch three lines below this wiring is not doubled.
    const moved = !prev
      || Math.abs(prev.lat - launch.latitude) > 1e-6
      || Math.abs(prev.lng - launch.longitude) > 1e-6;
    if (moved && state.weatherId === 'live') goLive();
    // Same-spot restore while live: the boot fetch may already have resolved
    // before this document existed, in which case its pushEnvironment() was
    // silently dropped by the bridge's no-document guard and the fetched sky
    // is on screen with nothing in the document to say where it came from.
    // Re-push the rail's environment with the live module's stashed bag
    // (ADR 0012 §1) — no second fetch, just the honesty the drop lost. Only
    // when there *is* a bag: a fetch still in flight makes its own push once
    // it lands (the document exists now), and a fetch that failed — an
    // offline boot — left liveProvenance() null, where pushing would replace
    // the document's saved provenance with null and persist the loss.
    else if (state.weatherId === 'live') {
      const prov = liveProvenance();
      if (prov) pushEnvironment(prov);
    }
  },
  // A document just became the open one: analysis-host.js's evidence restore
  // (ADR 0012 §2) asks the store whether it remembers this mission's ground.
  onMissionOpened: restoreEvidenceFor,
  requestRender: update,
  onMissionChanged: renderMissions,
  onMissionRemoved: forgetEvidence,
  onStorage: renderMissionStorage,
  // How an `agl` waypoint altitude becomes a metres-MSL figure (ADR 0003): the
  // corridor field the analysis host holds, read nearest-station. Stable across
  // every field that lands, and null-answering until one has — which the
  // resolver states as 'missing-terrain-sample' rather than guessing.
  terrainSampler: groundAt,
});
// Wave D (ADR 0010 §6): the export/import router for every foreign mission
// format. Reads the same open document and terrain host as the bridge above,
// and reuses the bridge's own importMission so a foreign file is validated,
// persisted and opened exactly as a native one is.
setupInterop({
  missionDocument, importMission, groundAt, requestRender: update,
});
setupThemes(() => {
  hideTooltip();
  update();
});
setupUpdateNotice();
setupShell({ setDest });
const bootView = restoreSession();
const bootDest = restoredDest();
buildAuthoringForms();
buildDroneForm();
buildFlightLogForm();
buildPackInstanceForm();
populateControls();
bind();
// Mode before destination: setView only starts the map while Plan is the open
// destination (it is, at boot), so a session saved on Aircraft with the Map
// mode armed still restores both without Leaflet measuring a hidden container.
if (bootView === 'map') setView('map'); // renders as a side effect
if (bootDest !== 'plan') setDest(bootDest); // renders as a side effect too
// Live is the boot default (renders immediately, patches when the fetch lands),
// but a saved preset or hand-entered weather must not be overwritten by it.
if (state.weatherId === 'live') goLive();
else if (bootView !== 'map' && bootDest === 'plan') update();
// Last, and deliberately not awaited: opening the repository is a round trip to
// IndexedDB, and the first render must not wait on it. The bridge restores the
// launch point and the route from the saved mission and asks for its own render
// when it lands.
openMissionBridge().catch((e) => {
  console.error('The mission repository could not be opened.', e);
});
