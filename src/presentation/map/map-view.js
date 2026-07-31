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
//
// Since ADR 0004's second wave the host drives two engines, not one. 2D is the
// default and the fallback and is created eagerly; 3D is a lazily imported
// chunk (~442 kB gzip of MapLibre and deck.gl — three times the rest of the app)
// that is fetched the first time a pilot asks for it and never enters the
// offline shell. Both consume the same `frame`, so everything below the toggle
// is engine-agnostic: one pass builds one frame, and whichever engines are on
// screen draw it.

import { wrapLng } from '../../domain/geo.js';
import { loadMapState, saveMapState } from '../../store.js';
import { createLeafletAdapter } from './leaflet-adapter.js';
import { createLayerRegistry } from './layer-registry.js';
import { renderFootprintPanel } from './footprint-panel.js';
import { liveSelection, nextSelection, renderSegmentInspector } from './segment-inspector.js';
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
/** @type {import('./scene3d/scene.js').SceneHandle|null} */
let scene = null;
/** Which engine is on screen. 2D until a pilot says otherwise, every session. */
/** @type {'2d'|'3d'} */
let mode = '2d';
/** Why 3D is not available, when it is not. Composed in front of the pass's own note. */
/** @type {string|null} */
let sceneNote = null;
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
  if (mode === '3d') { scene?.resized(); windLayer.stop(); } else windLayer.start(map);
}

/** Called on switch back to the Planner tab — stop burning frames off-screen. */
export function pauseMapView() {
  windLayer.stop();
}

/** Cheap reflow for height-only resizes (mobile URL bar, keyboard) — no re-render. */
export function resizeMapView() {
  adapter?.resized();
  if (mode === '3d') scene?.resized();
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

  adapter.on('click', onMapClick);
  adapter.on('viewchange', persist);
  adapter.on('tileerror', onTileError);

  bindControls();
  /* The engine choice is a view preference like the base layer, so it is
   * restored the same way — but only if this machine can honour it. A saved '3d'
   * on a device that has since lost WebGL2 opens in 2D, silently and correctly. */
  if (saved?.view === '3d' && supports3d()) void activate3d();

  return adapter;
}

/**
 * A click on the map surface, from whichever engine is drawing it. In route mode
 * it is a waypoint, not a new launch point: the pilot is drawing a line out of a
 * spot they have already chosen.
 * @param {LatLng|null} at
 */
function onMapClick(at) {
  if (!at || gestures.swallowsMapClick()) return;
  if (routeActive()) addWaypoint(at);
  else moveLaunch(at);
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

  const btn3d = $('btn-3d');
  if (supports3d()) btn3d.addEventListener('click', () => { void toggle3d(); });
  else {
    /* Offering a button that cannot work is worse than not offering it, and a
     * button that vanishes without explanation is worse than both. */
    btn3d.hidden = true;
    sceneNote = '3D needs WebGL2, which this browser or device does not provide.';
  }
}

function persist() {
  if (!adapter || !launch) return;
  const view = mode === '3d' && scene ? scene.view() : adapter.view();
  // The launch point rather than the map's centre: this is where the pilot flies
  // from, and it is what src/weather.js falls back to with no mission open.
  saveMapState({
    lat: launch.lat, lng: launch.lng,
    zoom: view.zoom,
    baseLayer: adapter.view().baseLayer,
    view: mode,
  });
}

/* ---------- the 3D scene ---------- */
//
// Everything about 3D that the rest of this file must not care about: whether the
// device can run it, whether the chunk has arrived, and which container is on
// screen. What it deliberately does NOT contain is any drawing — the scene
// consumes the same frame the 2D registry does.

/**
 * Whether this device can run the scene at all.
 *
 * Asked before the button is offered rather than after it is pressed: deck.gl's
 * interleaved mode needs WebGL2 outright, and a 442 kB download that ends in a
 * blank canvas is the worst possible way to find that out.
 */
function supports3d() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

async function toggle3d() {
  if (mode === '3d') deactivate3d();
  else await activate3d();
}

async function activate3d() {
  const btn = $('btn-3d');
  btn.disabled = true;
  const from = adapter.view();
  const container = $('map-3d');
  container.hidden = false;
  $('map-canvas').hidden = true;

  try {
    if (!scene) {
      /* The only path into the chunk, and the reason there is a chunk. Static
       * anywhere and the shell carries MapLibre and deck.gl to every pilot who
       * never opens 3D — which, offline at a trailhead, is all of them. */
      const { createScene } = await import('./scene3d/scene.js');
      scene = createScene({
        container,
        center: from.center,
        zoom: from.zoom,
        reducedMotion: REDUCED_MOTION,
        onGroundClick: onMapClick,
        onViewChange: persist,
        onTileError,
      });
      await scene.ready;
    } else {
      scene.resized();
      scene.setView(from.center, from.zoom);
    }
  } catch (err) {
    /* The chunk is not in the offline shell by design (ADR 0004), so this is the
     * expected outcome of pressing the button with no connection — not a crash,
     * and not a reason to lose the map that does work. */
    console.warn('[map] 3D scene unavailable', err);
    container.hidden = true;
    $('map-canvas').hidden = false;
    adapter.resized();
    scene = null;
    sceneNote = '3D needs a connection the first time — the map stayed in 2D.';
    btn.disabled = false;
    deps.requestRender();
    return;
  }

  mode = '3d';
  sceneNote = null;
  btn.disabled = false;
  // Nothing to animate over a hidden Leaflet container.
  windLayer.stop();
  persist();
  deps.requestRender();
}

function deactivate3d() {
  const from = scene?.view();
  mode = '2d';
  $('map-3d').hidden = true;
  $('map-canvas').hidden = false;
  adapter.resized();
  // Both engines count zoom levels, in numbering systems one level apart; the
  // scene hands its view back already converted, so this is a plain restore.
  if (from) adapter.center(from.center, from.zoom);
  windLayer.start(adapter);
  persist();
  deps.requestRender();
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

/* Which leg the inspector is open on, and nothing more than that.
 *
 * Beside `routeOn` because it is the same kind of thing: a view preference, not
 * part of the plan. It raises no command, is never written to the mission
 * document and is never persisted — a reload comes back with the route and no
 * selection, which is right, because "what I was looking at" is not something
 * the mission knows. Both engines set it through `frame.actions.selectSegment`,
 * and every render pass re-checks that it still names a segment the analysis
 * published. */
let selectedSegmentId = null;

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

  /* Before the frame, so the layers and the panel see the same answer: a
   * waypoint the pilot just dragged away takes its segment with it, and a
   * selection naming a segment that no longer exists is dropped without a word.
   * Editing the route is not an error. */
  selectedSegmentId = liveSelection(selectedSegmentId, snapshot, routeActive());

  const frame = buildFrame(snapshot);
  /* Both engines, always — the 2D pass is what computes the footprint's extent,
   * and it costs a handful of Leaflet overlays in a hidden container. Skipping it
   * in 3D would leave Fit view with nothing to frame on. */
  registry.render(frame, map);
  if (mode === '3d') scene?.render(frame);

  if (needsFit) {
    needsFit = false;
    const bounds = footprintLayer.bounds();
    if (mode === '3d' && scene) {
      if (bounds) scene.fit(bounds, { paddingPx: 24 });
      else scene.setView(frame.launch);
    } else if (bounds) map.fit(bounds, { paddingPx: 24 });
    else map.center(frame.launch);
  }

  renderCanvasNote(snapshot);
  if (snapshot.footprint) {
    renderFootprintPanel({
      plan: snapshot.plan, footprint: snapshot.footprint, units: frame.units,
    });
  }
  renderSegmentInspector({
    snapshot,
    selectedSegmentId,
    units: frame.units,
    onClose: () => frame.actions.selectSegment(null),
  });
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
    selectedSegmentId,
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
      /* The one action that raises no command. Clicking the open leg closes it,
       * clicking another switches, and null is the close button — the toggle
       * lives here so 2D and 3D cannot disagree about what a click means. */
      selectSegment: (id) => {
        selectedSegmentId = nextSelection(selectedSegmentId, id);
        deps.requestRender();
      },
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
  for (const id of ['map-canvas', 'map-3d']) $(id).classList.toggle('flight-invalid-map', noLift);

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
  // Both canvases: the crosshair means the same thing over either engine.
  for (const id of ['map-canvas', 'map-3d']) $(id).classList.toggle('route-mode', frame.routeMode);

  const btn3d = $('btn-3d');
  btn3d.setAttribute('aria-pressed', String(mode === '3d'));
  btn3d.textContent = mode === '3d' ? '3D · on' : '3D';
}

/**
 * The map's one note line, which two things now write to. `sceneNote` is a fact
 * about the engine and outlives a pass; the argument is what this pass has to say
 * about the mission. Composed rather than overwritten, because a render half a
 * second after a failed 3D load must not quietly delete the explanation.
 * @param {string|null} msg
 */
function note(msg) {
  const el = $('map-note');
  const text = [sceneNote, msg].filter(Boolean).join(' ');
  el.textContent = text;
  el.hidden = !text;
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
