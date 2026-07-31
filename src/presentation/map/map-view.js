// map-view.js — the map tab: lifecycle, view state, and the pass that drives the
// layers.
//
// What this file is *not* is where the map is drawn. ADR 0004 split that into an
// engine adapter and a registry of layers, and what is left here is the host:
//
//   the engine's lifecycle — created on first sight of the tab, re-measured when
//     the container changes shape, and never touched by a layer;
//
//   the view state that outlives a session — where the map is looking and which
//     base layer is showing, persisted on every settle;
//
//   the frame — one object per pass, built from the analysis snapshot, the
//     document's waypoints and the view's own preferences, handed to every layer.
//     A layer reads its frame and draws. It does not fetch, compute or write;
//
//   the chrome around the canvas: the two note lines, the buttons, and the
//     footprint panel under it.
//
// The launch point lives here rather than in the document because the pin is a
// gesture before it is a fact: it moves under the pilot's finger, and only then
// is raised onto the mission document as a `setLaunch` command (ADR 0002). The
// document's copy is what the analysis and the brief read; this one is what the
// pilot is dragging.

import { wrapLng } from '../../domain/geo.js';
import { loadMapState, saveMapState } from '../../store.js';
import { createLeafletAdapter } from './leaflet-adapter.js';
import { createLayerRegistry } from './layer-registry.js';
import { renderFootprintPanel } from './footprint-panel.js';
import { createFootprintLayer } from './layers/footprint-layer.js';
import { createLaunchLayer } from './layers/launch-layer.js';
import { createRouteLayer } from './layers/route-layer.js';
import { createSpotsLayer } from './layers/spots-layer.js';
import { createWindLayer } from './layers/wind-layer.js';

/**
 * @typedef {import('../../application/analysis/analysis-contracts.js').AnalysisSnapshot} AnalysisSnapshot
 * @typedef {import('./map-adapter.js').LatLng} LatLng
 * @typedef {import('./map-adapter.js').MapAdapter} MapAdapter
 * @typedef {import('./map-adapter.js').MapFrame} MapFrame
 * @typedef {import('./map-adapter.js').SavedSpot} SavedSpot
 */

/** Where the map opens on a first run, before anything has been saved. */
const AUSTIN = { lat: 30.2672, lng: -97.7431 };
const DEFAULT_ZOOM = 12;

/** Read once, as the app has always read it: a mid-session OS change lands on reload. */
const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const $ = (/** @type {string} */ id) => document.getElementById(id);

/*
 * Injected by app.js: { missionInputs, units, beginner, requestRender, goLive,
 * onLaunchChanged, onLaunchMove } plus the route port — { routeWaypoints,
 * onAddWaypoint, onMoveWaypoint, onRemoveWaypoint, onClearRoute } — which is how
 * this view reads and edits a route it does not own. `onLaunchChanged` raises the
 * launch onto the mission document; `onLaunchMove` is the weather rail's cue to
 * refetch for the new spot.
 */
let deps = null;
/** @type {MapAdapter|null} */
let adapter = null;
/** @type {LatLng|null} */
let launch = null;
let needsFit = false;
let tileErrorShown = false;
/** @type {{ spots: SavedSpot[], onSelect: ((spot: SavedSpot) => void)|undefined }|null} */
let spotSpec = null;

const footprintLayer = createFootprintLayer();
const windLayer = createWindLayer({ reducedMotion: REDUCED_MOTION });
const registry = createLayerRegistry([
  // Draw order is z-order: the envelope under the route, the route under the
  // pins, and the launch pin over the spots it might be sitting on.
  footprintLayer,
  createRouteLayer(),
  createSpotsLayer(),
  createLaunchLayer(),
  windLayer,
]);

const gestures = createGestureGuard();

export function setupMapView(d) { deps = d; }

/** Called on switch to the Map tab, after the container is un-hidden. */
export function showMapView() {
  const map = ensureMap();
  map.resized();
  windLayer.start(map);
}

/** Called on switch back to the Planner tab — stop burning frames off-screen. */
export function pauseMapView() {
  windLayer.stop();
}

/** Cheap reflow for height-only resizes (mobile URL bar, keyboard) — no re-render. */
export function resizeMapView() {
  adapter?.resized();
}

/* ---------- the engine ---------- */

/** @returns {MapAdapter} */
function ensureMap() {
  if (adapter) return adapter;

  const saved = loadMapState();
  launch = saved ? { lat: saved.lat, lng: saved.lng } : { ...AUSTIN };
  // Nothing saved means nothing to restore, so the first render frames the map
  // on the footprint instead of dropping the pilot at an arbitrary zoom.
  needsFit = !saved;

  adapter = createLeafletAdapter({
    containerId: 'map-canvas',
    center: launch,
    zoom: saved ? saved.zoom : DEFAULT_ZOOM,
    baseLayer: saved?.baseLayer === 'streets' ? 'streets' : 'satellite',
  });

  adapter.on('click', (at) => {
    if (!at || gestures.swallowsMapClick()) return;
    // In route mode a click is a waypoint, not a new launch point: the pilot is
    // drawing a line out of a spot they have already chosen.
    if (routeActive()) addWaypoint(at);
    else moveLaunch(at);
  });
  adapter.on('viewchange', persist);
  adapter.on('tileerror', onTileError);

  bindControls();
  return adapter;
}

function bindControls() {
  $('btn-locate').addEventListener('click', locate);
  $('btn-fit').addEventListener('click', () => { needsFit = true; deps.requestRender(); });
  $('btn-live-wx').addEventListener('click', () => deps.goLive({ ...launch }));
  $('btn-route').addEventListener('click', () => setRouteMode(!routeModeOn()));
  $('btn-route-clear').addEventListener('click', () => {
    // Clearing is not leaving route mode — the pilot is starting the line again,
    // and the mode has to survive the route going empty under it.
    routeOn = true;
    deps.onClearRoute();
  });
}

function persist() {
  if (!adapter || !launch) return;
  const view = adapter.view();
  // The launch point rather than the map's centre: this is where the pilot flies
  // from, and it is what src/weather.js falls back to with no mission open.
  saveMapState({ lat: launch.lat, lng: launch.lng, zoom: view.zoom, baseLayer: view.baseLayer });
}

/**
 * @param {LatLng} at
 * @param {{ notify?: boolean, raise?: boolean }} [opts]
 */
function moveLaunch(at, { notify = true, raise = true } = {}) {
  launch = { lat: at.lat, lng: wrapLng(at.lng) };
  needsFit = true;
  persist();
  /* The route survives (ADR 0002). Moving the pin used to throw the waypoints
   * away; it is a `setLaunch` command on the mission document now — raised here,
   * at the gesture, rather than inferred from the rail by a later render pass —
   * and the waypoints keep their absolute coordinates. What the document drops
   * is the *resolved* altitude behind each leg, because the new site's elevation
   * is not the old one's. `raise: false` is the other direction: the document
   * moved first and the pin is following it. */
  if (raise) deps.onLaunchChanged?.({ ...launch });
  deps.requestRender();
  if (notify) deps.onLaunchMove?.({ ...launch }); // live weather refetches for the new spot
}

/* The weather rail moves the launch point too; it handles its own refetch, so
   this skips the onLaunchMove notification. Before the map first initializes
   there is nothing to sync — ensureMap reads the same saved point. */
export function setLaunchPoint(at) {
  if (adapter) moveLaunch(at, { notify: false, raise: false });
}

function locate() {
  if (!navigator.geolocation) { note('Geolocation is not available in this browser.'); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => moveLaunch({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
    () => note('Location unavailable — check browser permissions.'),
    { enableHighAccuracy: true, timeout: 8000 },
  );
}

function onTileError() {
  if (tileErrorShown) return;
  tileErrorShown = true;
  wxNote('Some map tiles failed to load — the footprint math is unaffected.');
}

/* ---------- route mode ---------- */
//
// The waypoints are not held here. They live in the mission document (ADR 0002),
// which is why they survive a reload and a launch-point move: this view raises
// `addWaypoint` / `moveWaypoint` / `removeWaypoint` through its injected deps and
// reads the result back through `deps.routeWaypoints()`. Every number derived
// from them lives in src/domain/route.js, every sentence about them in
// src/render/route.js.
//
// The *mode* stays here, because it is a view preference rather than part of the
// plan: which pilot has the route tool open says nothing about the mission.
// It is tri-state. `null` means "follow the document" — a restored mission with
// waypoints comes back with its route visible, which is the whole point of
// persisting it, and an empty one does not put the map into an editing mode
// nobody asked for. The first deliberate route gesture latches a real boolean,
// and from there the pilot's choice sticks for the session.

let routeOn = null;

/** The route port, tolerant of a boot render before the mission document exists. */
const routeWaypoints = () => deps.routeWaypoints?.() ?? [];

const routeModeOn = () => (routeOn === null ? routeWaypoints().length > 0 : routeOn);

/* Route mode is an expert affordance, so beginner mode has none of it: not the
   button, not the crosshair, and not the click that drops a waypoint. Asking
   here rather than latching the flag off means a pilot who drops to beginner to
   show someone the plan gets their route back when they switch out again — and
   in the meantime a map click still moves the launch pin, which is the only
   thing a beginner-mode click has ever meant. */
const routeActive = () => routeModeOn() && !deps.beginner();

/**
 * What the route panel and the drawing pass both read. The waypoints carry their
 * document ids so a pin can name itself in the command it raises; src/domain/route.js
 * and src/render/route.js read nothing but lat/lng off them.
 */
export function routeState() {
  return {
    on: routeActive(),
    launch: launch ? { ...launch } : null,
    waypoints: routeWaypoints().map((w) => ({ ...w })),
  };
}

export function setRouteMode(on) {
  routeOn = !!on;
  deps.requestRender();
}

function addWaypoint(at) {
  routeOn = true;
  deps.onAddWaypoint({ lat: at.lat, lng: wrapLng(at.lng) });
}

/* ---------- saved spots ---------- */

/**
 * Hand over the saved-spot roster. Safe to call on every render pass and before
 * the map exists; the pins are drawn on the next pass, and clicking one calls
 * `onSelect(spot)`.
 */
export function renderSpotMarkers(spots, onSelect) {
  spotSpec = { spots: Array.isArray(spots) ? spots : [], onSelect };
}

/* ---------- the render pass ---------- */

/**
 * One pass over the snapshot: build the frame, drive the layers, then the panel
 * and the chrome around them.
 *
 * The signature is the snapshot itself rather than the three pieces of it the
 * old drawing wanted, because a map that is handed a plan, a link and a route
 * separately can be handed three that came from different passes. This one
 * cannot.
 *
 * @param {AnalysisSnapshot} snapshot
 */
export function renderMapView(snapshot) {
  if (!deps || !snapshot.plan) return;
  const map = ensureMap();
  map.resized();

  const frame = buildFrame(snapshot);
  registry.render(frame, map);

  if (needsFit) {
    needsFit = false;
    const bounds = footprintLayer.bounds();
    if (bounds) map.fit(bounds, { paddingPx: 24 });
    else map.center(frame.launch);
  }

  renderCanvasNote(snapshot);
  if (snapshot.footprint) {
    renderFootprintPanel({
      plan: snapshot.plan, footprint: snapshot.footprint, units: frame.units,
    });
  }
  renderRouteControls(frame);
}

/**
 * @param {AnalysisSnapshot} snapshot
 * @returns {MapFrame}
 */
function buildFrame(snapshot) {
  return {
    snapshot,
    launch: { ...launch },
    waypoints: routeWaypoints(),
    spots: spotSpec?.spots ?? [],
    routeMode: routeActive(),
    units: deps.units(),
    env: snapshot.inputs.env ?? {},
    gestures,
    actions: {
      moveLaunch: (at) => moveLaunch(at),
      moveWaypoint: (id, at) => {
        routeOn = true;
        deps.onMoveWaypoint(id, { lat: at.lat, lng: wrapLng(at.lng) });
      },
      removeWaypoint: (id) => {
        routeOn = true;
        deps.onRemoveWaypoint(id);
      },
      selectSpot: (spot) => spotSpec?.onSelect?.(spot),
    },
  };
}

/**
 * What the map says about itself when the rings cannot say it. A collapsed
 * footprint is not an empty map — it is a specific answer, and the pilot is owed
 * the reason rather than a blank satellite view.
 * @param {AnalysisSnapshot} snapshot
 */
function renderCanvasNote(snapshot) {
  const plan = snapshot.plan;
  const fp = snapshot.footprint;
  const noLift = plan.flight.code === 'no_lift';
  $('map-canvas').classList.toggle('flight-invalid-map', noLift);

  const anyReal = !!fp?.byCourse.some((r) => r > 0);
  const anyBest = !!fp?.bestByCourse.some((r) => r > 0);
  if (!anyReal && !anyBest) {
    note(noLift
      ? `WILL NOT FLY — ${plan.massKg * 1000 > 0 ? (plan.massKg * 1000).toFixed(0) : '—'} g all-up `
        + `weight exceeds the ${plan.flight.estimated === false ? 'measured' : 'estimated'} `
        + `${plan.flight.maxHoverMassG.toFixed(0)} g continuous lift ceiling.`
      : 'No viable mission in these conditions — the footprint collapses to the launch point.');
    return;
  }
  note(anyReal ? null
    : 'No reach at the planned cruise in this wind — the dashed ring is what best-range speed could still manage.');
}

/** The route tool's own affordances, which track the mode rather than the route. */
function renderRouteControls(frame) {
  const btn = $('btn-route');
  btn.setAttribute('aria-pressed', String(frame.routeMode));
  btn.textContent = frame.routeMode ? 'Route · on' : 'Route';
  $('btn-route-clear').hidden = !frame.routeMode || frame.waypoints.length === 0;
  $('map-canvas').classList.toggle('route-mode', frame.routeMode);
}

function note(msg) {
  const el = $('map-note');
  el.textContent = msg || '';
  el.hidden = !msg;
}

function wxNote(msg) {
  const el = $('wx-note');
  el.textContent = msg || '';
  el.hidden = !msg;
}

/* ---------- the synthetic click a gesture leaves behind ---------- */

/**
 * Leaflet fires a map click after a marker drag, and can surface one behind a
 * marker hit. Unguarded, the click that ends a waypoint drag drops a second
 * waypoint on top of it, and the click that deletes a pin immediately re-adds
 * one. Both are suppressed for exactly one turn of the event loop, which is how
 * long the synthetic click takes to arrive.
 *
 * One guard for the whole map, because the click it swallows lands on the map,
 * which no single layer owns.
 *
 * @returns {import('./map-adapter.js').GestureGuard
 *   & { swallowsMapClick: () => boolean }}
 */
function createGestureGuard() {
  let dragged = false;
  let clicked = false;
  return {
    dragEnded() {
      dragged = true;
      setTimeout(() => { dragged = false; }, 0);
    },
    markerClicked() {
      clicked = true;
      setTimeout(() => { clicked = false; }, 0);
    },
    // A pin's own click handler stands down after a drag: the click a drag
    // leaves behind is not a delete.
    afterDrag: () => dragged,
    swallowsMapClick: () => dragged || clicked,
  };
}
