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

import { bearingTo, wrapLng } from '../../domain/geo.js';
import { renderSystemState } from '../../components/system-state.js';
import { loadMapState, saveMapState } from '../../store.js';
import { createLeafletAdapter } from './leaflet-adapter.js';
import { createLayerRegistry } from './layer-registry.js';
import { renderAdvisoryLegend } from './advisory-panel.js';
import { renderConditionsCard, renderRouteTemplates } from './conditions-card.js';
import { renderDiveInspector } from './dive-inspector.js';
import { renderDiveSystems } from './dive-dynamics-panel.js';
import { renderDiveRecovery, resetDiveRecovery, abortSeedAltitudeM } from './dive-recovery-panel.js';
import { renderDiveStrip } from './dive-profile-strip.js';
import { liveSelection, nextSelection, renderSegmentInspector } from './segment-inspector.js';
import { createAdvisoryLayer } from './layers/advisory-layer.js';
import { createDiveLayer } from './layers/dive-layer.js';
import { createFootprintLayer } from './layers/footprint-layer.js';
import { createLaunchLayer } from './layers/launch-layer.js';
import { createRouteLayer } from './layers/route-layer.js';
import { createSpotsLayer } from './layers/spots-layer.js';
import { createSubjectLayer } from './layers/subject-layer.js';
import { createWindLayer } from './layers/wind-layer.js';

/**
 * @typedef {import('../../application/analysis/analysis-contracts.js').AnalysisSnapshot} AnalysisSnapshot
 * @typedef {import('./map-adapter.js').LatLng} LatLng
 * @typedef {import('./map-adapter.js').MapAdapter} MapAdapter
 * @typedef {import('./map-adapter.js').MapFrame} MapFrame
 * @typedef {import('./map-adapter.js').SavedSpot} SavedSpot
 */

/**
 * Which renderer draws the 3D view.
 *
 * `'maplibre'` is scene.js — a deck.gl overlay interleaved into a MapLibre map,
 * which is what ships. `'ortho'` is ortho-scene.js — a standalone Deck over
 * terrain this app decodes itself, which is what M12 is measuring. They are
 * alternatives rather than a hierarchy: both take the same options and hand back
 * the same handle, and everything below this seam is written against the handle.
 * @typedef {'maplibre'|'ortho'} SceneHost
 */

/** Where the map opens on a first run, before anything has been saved. */
const AUSTIN = { lat: 30.2672, lng: -97.7431 };
const DEFAULT_ZOOM = 12;

/** Read once, as the app has always read it: a mid-session OS change lands on reload. */
const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const $ = (/** @type {string} */ id) => document.getElementById(id);

/*
 * Injected by app.js: { missionInputs, units, beginner, requestRender, goLive,
 * onLaunchChanged, onLaunchMove, exit3d } plus the route port — { routeWaypoints,
 * onAddWaypoint, onMoveWaypoint, onRemoveWaypoint, onClearRoute } — which is how
 * this view reads and edits a route it does not own. `onLaunchChanged` raises the
 * launch onto the mission document; `onLaunchMove` is the weather rail's cue to
 * refetch for the new spot; `exit3d` walks the Plan tabs back to 2D — the system
 * state cards' way out, owned by app.js because the tabs are. `flushMission`
 * writes the open mission now — the offline card's Retry reloads the document
 * and must not leave a dirty document behind.
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
/* Which engine draws the 3D view when it is asked for. Session-only, like
 * `advisoryOn` below and for a stronger version of the same reason: the saved map
 * state is where the map is looking, and which of two renderers a pilot was
 * trying is not that. Ortho by default since M12 — the terrain this app decodes
 * itself is the shipped scene, and the MapLibre satellite host is one viewbar
 * press away, so nothing was lost by the promotion. */
/** @type {SceneHost} */
let sceneHost = 'ortho';
/** Which engine is on screen. 2D until a pilot says otherwise, every session. */
/** @type {'2d'|'3d'} */
let mode = '2d';
/** Guards a second press racing a first activation — the chunk downloads once. */
let engaging = false;
/** @type {{ spots: SavedSpot[], onSelect: ((spot: SavedSpot) => void)|undefined }|null} */
let spotSpec = null;
/* Whether the mountain-flow zones are drawn (M5). A view preference like route
 * mode, and session-only for the same reason: the saved map state is a whitelist
 * of where the map is looking, and what a pilot had switched on over it is not
 * that. Default on — a hazard advisory a pilot has to find before they can see
 * it is one they will miss. */
let advisoryOn = true;
/* Whether the mountain-dive workspace — the conditions card and the template
 * row (M16) — is up over the 3D stage. Session-only like `advisoryOn`, but
 * default OFF where the advisory defaults on: overlays over the stage are
 * summoned, not standing (the segment card needs a selection, the scene-state
 * card needs a failure), because a standing overlay intercepts taps aimed at
 * the canvas and the viewbar under it. */
let diveOn = false;
/* Which of the two readings the bottom edge is showing (M16, 3D-06 / 3D-07).
 * Session-only like the latch above, and it starts on the profile because that
 * is the reading a plan can always answer: the dynamics need a pack, an air
 * density and a stated dive speed, and a workspace that opened on a screen full
 * of "—" would teach the pilot the screen is broken rather than unstated. */
/** @type {'profile'|'dynamics'} */
let diveReading = 'profile';
/* Why the last edit did not land, when it did not. Beside `sceneNote` and with
 * the same lifetime rule: it is a fact that outlives the pass it happened in, so
 * it is composed into the note line rather than written over by the next render.
 * Cleared by the next edit that succeeds. */
/** @type {string|null} */
let editNote = null;

/* ---------- the mission-editing port ---------- */
//
// What the map cannot get from the snapshot. ADR 0002's rule is that the map
// never holds the mission document, and it still does not: this is the same
// shape of seam `deps.routeWaypoints()` already is for the waypoints — a
// projection handed in from outside presentation/, plus one way to raise a
// command and hear what became of it.
//
// It exists because the snapshot publishes what a shot *is* and not where its
// subject stands: `SegmentShot` carries the subject's id, its name and every
// derived number, but a marker needs a latitude, and a subject roster is not a
// derived number. The camera profile and the shot templates are the same case.
// Registered by src/mission-commands.js, which is the module that already turns
// "the pilot changed something" into a command.

/** @typedef {import('./segment-editor.js').SceneProjection} SceneProjection */
/** @typedef {import('./segment-editor.js').EditResult} EditResult */
/**
 * M16 widened the port the same way for the same reason: the aircraft name the
 * conditions card shows is `doc.aircraftSnapshot.name` — authored state the
 * snapshot never republishes — and a route template is a list of commands only
 * the command module may raise.
 * @typedef {{ aircraftName: string|null, templates: import('./conditions-card.js').TemplateChip[] }} DiveWorkspace
 * @typedef {{
 *   scene: () => SceneProjection,
 *   raise: (command: object) => EditResult,
 *   dive?: () => DiveWorkspace,
 *   applyTemplate?: (id: string) => EditResult,
 * }} MissionEditorPort
 */

/** @type {MissionEditorPort|null} */
let editor = null;

/** Nothing to draw and nothing to edit, which is the state before a document opens. */
const NO_SCENE = { subjects: [], cameraProfile: null, templates: [], dive: null };

/** @param {MissionEditorPort} port */
export function setMissionEditor(port) { editor = port; }

/** @returns {SceneProjection} */
const sceneNow = () => editor?.scene() ?? NO_SCENE;

/**
 * Raise one command and keep its answer. The bridge renders on the commands it
 * accepts and not on the ones it refuses, so a refusal has to ask for the pass
 * that will show its explanation.
 * @param {object} command
 * @returns {EditResult}
 */
function raiseEdit(command) {
  const result = editor?.raise(command)
    ?? { ok: false, message: 'No mission is open yet — nothing to edit.' };
  editNote = result.ok ? null : result.message;
  if (!result.ok) deps?.requestRender();
  return result;
}

const footprintLayer = createFootprintLayer();
const windLayer = createWindLayer({ reducedMotion: REDUCED_MOTION });
const registry = createLayerRegistry([
  // Draw order is z-order: the advisory wash under everything — it is about the
  // ground, not about the plan — then the envelope under the route, the route
  // under the pins, and the launch pin over the spots it might be sitting on.
  createAdvisoryLayer(),
  footprintLayer,
  createRouteLayer(),
  // The things the route is filming, under its pins: a subject is what a leg is
  // about, and a leg is what the pilot is clicking.
  createSubjectLayer(),
  /* Over the route and under the pins the pilot drags most: the dive plan is
     mission geometry, so it draws whenever one exists rather than waiting on the
     dive workspace's latch — a plan that vanished with a panel would be a plan
     the pilot cannot see they authored. */
  createDiveLayer(),
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
  /* The engine choice used to be restored here off the map-state blob; it lives
   * in `state.view` now ('2d'/'3d' are Plan mode tabs), so app.js boots the
   * scene through setMode3d() after the session restore instead. */

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
  /* Subject mode first, and exclusive: the two editing modes both want the same
   * gesture, so the one that is lit wins outright rather than the click meaning
   * both things at once. */
  /* Ahead of both: a recovery placement is armed one press at a time, for one
   * click, and disarms itself either way — it is the most specific thing a
   * click can mean here, and the pilot armed it a moment ago. */
  if (divePlacing) placeRecovery(at);
  else if (subjectActive()) placeSubject(at);
  else if (routeActive()) addWaypoint(at);
  else moveLaunch(at);
}

function bindControls() {
  $('btn-locate').addEventListener('click', locate);
  $('btn-fit').addEventListener('click', () => { needsFit = true; deps.requestRender(); });
  $('btn-baselayer').addEventListener('click', () => {
    /* A two-state toggle, not a menu: there are exactly two base layers, and a
     * button that flips them is one press where Leaflet's switcher was two. */
    adapter.setBaseLayer(adapter.view().baseLayer === 'satellite' ? 'streets' : 'satellite');
    syncBaseLayer();
  });
  $('btn-live-wx').addEventListener('click', () => deps.goLive({ ...launch }));
  $('btn-route').addEventListener('click', () => setRouteMode(!routeModeOn()));
  $('btn-subject').addEventListener('click', () => {
    subjectOn = !subjectOn;
    deps.requestRender();
  });
  $('btn-advisory').addEventListener('click', () => {
    advisoryOn = !advisoryOn;
    deps.requestRender();
  });
  $('btn-route-clear').addEventListener('click', () => {
    // Clearing is not leaving route mode — the pilot is starting the line again,
    // and the mode has to survive the route going empty under it.
    routeOn = true;
    deps.onClearRoute();
  });

  /* The viewbar (M12). Every handler re-asks for the ortho handle at click
   * time — the ortho groups are hidden whenever it is absent, but a tap that
   * raced a host swap must land on nothing rather than on a stale handle. */
  $('vb-proj-ortho').addEventListener('click', () => setOrthoProjection('orthographic'));
  $('vb-proj-persp').addEventListener('click', () => setOrthoProjection('perspective'));
  $('vb-proj-top').addEventListener('click', () => setOrthoProjection('top'));
  $('vb-az-north').addEventListener('click', () => setOrthoAzimuth('north'));
  $('vb-az-route').addEventListener('click', () => setOrthoAzimuth('route'));
  $('vb-az-free').addEventListener('click', () => setOrthoAzimuth('free'));
  $('vb-exag-down').addEventListener('click', () => stepExaggeration(-0.25));
  $('vb-exag-up').addEventListener('click', () => stepExaggeration(0.25));
  $('vb-contours').addEventListener('click', () => {
    const s = orthoScene();
    if (s) { s.setContours(!s.contours()); deps.requestRender(); }
  });
  $('vb-reset').addEventListener('click', () => {
    const s = orthoScene();
    if (s) { s.resetCamera(); deps.requestRender(); }
  });
  $('vb-dive').addEventListener('click', () => {
    diveOn = !diveOn;
    deps.requestRender();
  });
  $('vb-host').addEventListener('click', () => {
    void setSceneHost(sceneHost === 'ortho' ? 'maplibre' : 'ortho');
  });
}

/* ---------- the ortho camera's knobs ---------- */

/** The ortho handle when the ortho host is the engine on screen, else null. */
const orthoScene = () => (mode === '3d' && sceneHost === 'ortho' && scene
  ? /** @type {import('./scene3d/ortho-scene.js').OrthoSceneHandle} */ (scene)
  : null);

/** @param {import('./scene3d/ortho-view-state.js').OrthoProjection} p */
function setOrthoProjection(p) {
  const s = orthoScene();
  if (s) { s.setProjection(p); deps.requestRender(); }
}

/** @param {import('./scene3d/ortho-view-state.js').OrthoAzimuth} m */
function setOrthoAzimuth(m) {
  const s = orthoScene();
  if (s) { s.setAzimuth(m, routeBearing()); deps.requestRender(); }
}

/** @param {number} delta */
function stepExaggeration(delta) {
  const s = orthoScene();
  if (s) { s.setExaggeration(s.exaggeration() + delta); deps.requestRender(); }
}

/**
 * The route's own heading: launch to the farthest authored waypoint.
 *
 * "Route-aligned" needs one bearing out of a line that may bend, and the far
 * point is the one a pilot flying out-and-back is actually pointed at — the
 * first leg's heading would swing wildly on a route that starts with a dogleg.
 * North when there is no route to align to, which makes Route degrade into
 * North rather than into a random azimuth.
 */
function routeBearing() {
  const pts = routeWaypoints();
  if (!launch || !pts.length) return 0;
  const coslat = Math.cos((launch.lat * Math.PI) / 180);
  let far = pts[0];
  let best = -1;
  for (const p of pts) {
    const dx = (p.lng - launch.lng) * coslat;
    const dy = p.lat - launch.lat;
    const d = dx * dx + dy * dy;
    if (d > best) { best = d; far = p; }
  }
  return bearingTo(launch, far);
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
 * Asked before the tab is offered rather than after it is pressed: deck.gl's
 * interleaved mode needs WebGL2 outright, and a 442 kB download that ends in a
 * blank canvas is the worst possible way to find that out.
 */
export function supports3d() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

/**
 * Drive the engine from Plan's mode tabs. Resolves true when the requested
 * engine is the one on screen; false means 3D could not start — no WebGL2, or
 * the chunk is unreachable offline — and the map stayed in 2D, with the reason
 * already written on the map note for the caller to leave alone.
 * @param {boolean} on
 * @returns {Promise<boolean>}
 */
export async function setMode3d(on) {
  ensureMap();
  if (!on) {
    // Leaving the 3D tab dismisses whatever the engine had to say for itself.
    sceneState(null);
    if (mode === '3d') deactivate3d();
    return true;
  }
  if (!supports3d()) {
    /* The tab is offered to everyone now; the answer for a device that cannot
     * take it is this card, on press, over a 2D map that still works — not a
     * tab that vanished without explanation. */
    sceneState({
      kind: 'permission-denied',
      title: '3D unavailable',
      body: '3D needs WebGL2, which this browser or device does not provide. The 2D map tells the same story flat.',
      action: { label: 'Use 2D map', onClick: () => deps.exit3d?.() },
    });
    return false;
  }
  if (mode !== '3d') await activate3d();
  return mode === '3d';
}

/** Which renderer the 3D view is currently set to use. */
export function sceneHostNow() { return sceneHost; }

/**
 * Choose the renderer behind the 3D view.
 *
 * A live scene belongs to the host that built it, so the swap goes out through
 * 2D and back in: `deactivate3d` hands the camera to the Leaflet adapter, the old
 * handle is released, and `activate3d` reads the camera back out and gives it to
 * the other host. That is not a detour — the flat view is the only vocabulary the
 * two of them share, and routing through it is what makes the toggle land the
 * pilot where they were looking rather than at a default.
 *
 * Resolves the same thing `setMode3d` does: whether 3D is on screen when it is
 * done. A host that cannot start falls back through `activate3d`'s own catch, so
 * pressing the toggle offline leaves a working 2D map and a note, exactly as
 * pressing the 3D tab does.
 *
 * @param {SceneHost} host
 * @returns {Promise<boolean>}
 */
export async function setSceneHost(host) {
  if (host !== sceneHost && (host === 'maplibre' || host === 'ortho')) {
    const was = mode;
    sceneHost = host;
    if (was === '3d') deactivate3d();
    try { scene?.destroy(); } catch { /* letting go was the point */ }
    scene = null;
    if (was === '3d') await activate3d();
  }
  return mode === '3d';
}

async function activate3d() {
  if (engaging || mode === '3d') return;
  engaging = true;
  const from = adapter.view();
  const container = $('map-3d');
  container.hidden = false;
  $('map-canvas').hidden = true;
  // Only the first time is a download; a live handle re-engages in one frame.
  if (!scene) {
    sceneState({
      kind: 'loading',
      title: 'Preparing 3D',
      body: 'Downloading the engine and decoding terrain for this area.',
    });
  }

  try {
    if (!scene) {
      /* The only path into the chunk, and the reason there is a chunk. Static
       * anywhere and the shell carries MapLibre and deck.gl to every pilot who
       * never opens 3D — which, offline at a trailhead, is all of them. Two
       * specifiers now, and the bundler splits what they share out behind them:
       * whichever host is asked for, the other engine is not downloaded. */
      const create = sceneHost === 'ortho'
        ? (await import('./scene3d/ortho-scene.js')).createOrthoScene
        : (await import('./scene3d/scene.js')).createScene;
      scene = create({
        container,
        center: from.center,
        zoom: from.zoom,
        /* The one option the two hosts do not share, and it is passed to both
         * rather than branched on: a cartesian scene needs an origin fixed before
         * its first frame — `ready` resolves before `render` is ever called — and
         * the MapLibre host, which is geographic throughout, ignores it. */
        launch: { ...launch },
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
    /* A scene whose `ready` rejected after construction (the ready-timeout path)
     * is still a live MapLibre map holding a WebGL context on this container —
     * without a teardown, the next press would stack a second map on top of it.
     * A half-built scene may refuse even that; the container is emptying either
     * way, and nothing here may derail the 2D recovery below. */
    try { scene?.destroy(); } catch { /* letting go was the point */ }
    scene = null;
    /* The pilot stays on the 3D tab, with the reason as a card over the live 2D
     * map — the designed fallback state, in place of the old silent bounce. */
    sceneFailCard(err);
    deps.requestRender();
    return;
  } finally {
    engaging = false;
  }

  mode = '3d';
  sceneState(null);
  watchContextLoss(container);
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

/* ---------- the 3D system states ---------- */
//
// Every way the scene cannot show itself, as one designed card over the stage
// (SCREEN-INVENTORY's mandated 3D states: WebGL unsupported, engine offline,
// terrain missing, context loss, and the 2D-fallback that underlies them all).
// The 2D map stays live under the card, so "fallback" is a working screen with
// an explanation on it rather than a different place the pilot was sent to.

/** @param {import('../../components/system-state.js').SystemStateSpec|null} spec */
function sceneState(spec) {
  /* renderSystemState owns its host's className outright, so the card gets an
   * inner element to wear it — handing it the overlay itself would overwrite
   * `scene-state`, and the positioning goes with it. */
  const overlay = $('scene-state');
  let card = overlay.firstElementChild;
  if (!card) {
    card = document.createElement('div');
    overlay.appendChild(card);
  }
  renderSystemState(/** @type {HTMLElement} */ (card), spec);
  overlay.hidden = !spec;
}

/**
 * The right card for the way 3D failed. Terrain that decoded to nothing is not
 * the network being down: the first has a satellite host one press away, the
 * second has a retry. Each card names its cause and every way out is a button.
 * @param {unknown} err
 */
function sceneFailCard(err) {
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (/no terrain/i.test(message)) {
    sceneState({
      kind: 'empty',
      title: 'No terrain here',
      body: 'No elevation tiles could be decoded for this area, so the terrain view has no ground to build.',
      action: {
        label: 'Try satellite 3D',
        onClick: () => { sceneHost = 'maplibre'; void activate3d(); },
      },
      secondary: { label: 'Use 2D map', onClick: () => deps.exit3d?.() },
    });
    return;
  }
  sceneState({
    kind: 'offline',
    title: '3D needs a connection',
    body: 'The 3D engine and its terrain download on first use and were unreachable. The 2D map underneath still works.',
    /* A failed dynamic import() is cached as failed in the document's module
       map, so re-calling activate3d() here can never re-fetch the chunk — only
       a fresh document can. The session (view included) is already saved, so
       boot re-engages 3D and the reload *is* the retry. The flush first: a
       document whose debounced save failed stays dirty with no timer armed,
       and this button must not be the thing that loses those edits. */
    action: {
      label: 'Retry 3D',
      onClick: () => {
        void Promise.resolve(deps.flushMission?.())
          .catch(() => { /* still dirty — the storage banner already says so */ })
          .finally(() => window.location.reload());
      },
    },
    secondary: { label: 'Use 2D map', onClick: () => deps.exit3d?.() },
  });
}

/**
 * Stand a watch for the GPU taking the scene away mid-flight.
 *
 * A lost context is not a crash — the browser reclaims contexts under memory
 * pressure, tab-switching on phones does it routinely — but the canvas it
 * leaves behind is dead. The recovery is the same teardown a host swap does,
 * plus the card that says what happened. Guarded by handle identity so a loss
 * event surfacing after a deliberate teardown cannot pull down its successor.
 * @param {HTMLElement} container
 */
function watchContextLoss(container) {
  const owner = scene;
  container.querySelector('canvas')?.addEventListener('webglcontextlost', () => {
    if (!owner || scene !== owner) return;
    if (mode === '3d') deactivate3d();
    try { scene?.destroy(); } catch { /* it is already gone */ }
    scene = null;
    sceneState({
      kind: 'recoverable-error',
      title: '3D stopped',
      body: 'The graphics context was lost — usually the GPU under memory pressure. The 2D map took over.',
      action: { label: 'Restart 3D', onClick: () => { void activate3d(); } },
      secondary: { label: 'Use 2D map', onClick: () => deps.exit3d?.() },
    });
  }, { once: true });
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

/**
 * The selection, readable from outside the map. Analyze's timeline and
 * elevation profile highlight the same leg the inspector is open on — one
 * owner, so the surfaces cannot disagree.
 */
export function selectedSegment() { return selectedSegmentId; }

/**
 * Toggle the selection from any surface — a map click, a timeline row, a span
 * of the elevation profile. The same toggle the engines' click uses, followed
 * by a render pass so every open surface redraws with the new answer.
 * @param {string|null} id
 */
export function selectSegment(id) {
  selectedSegmentId = nextSelection(selectedSegmentId, id);
  /* Two inspectors, one seat: opening a route leg puts the dive leg away rather
     than stacking a second card in the same corner. */
  if (selectedSegmentId) selectedDiveKind = null;
  deps?.requestRender();
}

/* Which dive leg the dive inspector is open on, named by the gate the leg ends
 * at. Beside `selectedSegmentId` and governed by the same rule — view state, no
 * command, never persisted — and separate from it because a mission can carry
 * both a drawn route and a dive plan while only one inspector is on screen. */
let selectedDiveKind = null;

/** The dive selection, for the surfaces outside the map that highlight the same leg. */
export function selectedDiveLeg() { return selectedDiveKind; }

/**
 * Toggle the dive selection from any surface — a gate pin, a corridor, a chip on
 * the elevation strip. Selecting a leg also summons the dive workspace: a pilot
 * who just clicked a gate is asking to work on the dive, and an inspector that
 * opened behind a closed latch would be an inspector nobody can see.
 * @param {string|null} kind
 */
export function selectDiveGate(kind) {
  /* The abort gate is not a leg. Nothing flies to it — it is where the run is
     broken off — so `diveLegChain` leaves it out and the leg inspector has
     nothing to draw for it. Clicking it opens the plan it belongs to instead of
     selecting a kind whose panel does not exist, which used to blank the seat
     and look like the pin was dead. */
  if (kind === 'abort') { toggleDiveRecovery(); return; }
  selectedDiveKind = nextSelection(selectedDiveKind, kind);
  if (selectedDiveKind) {
    selectedSegmentId = null;
    recoveryOn = false;
    diveOn = true;
  }
  deps?.requestRender();
}

/* Whether the recovery plan is open. Its own latch rather than a value of
   `selectedDiveKind`, because that one is re-checked against the gates on every
   pass and drops anything the plan does not carry — and the recovery panel's
   whole job is the case where the plan carries nothing yet. */
let recoveryOn = false;

/** What the next map click places for the recovery plan, if anything. */
/** @type {'abort'|'bailout'|null} */
let divePlacing = null;

function toggleDiveRecovery() {
  recoveryOn = !recoveryOn;
  if (recoveryOn) {
    selectedSegmentId = null;
    selectedDiveKind = null;
    diveOn = true;
  } else {
    divePlacing = null;
    resetDiveRecovery();
  }
  deps?.requestRender();
}

/**
 * Open the dive workspace, optionally on one leg — what a fix link lands on
 * (M16, 3D-08). Deliberately not `selectDiveGate`: that one toggles, which is
 * right for a click on a gate and wrong for a remedy, where arriving at a
 * *closed* panel because the leg happened to already be open would look like
 * the fix did nothing. A null kind opens the plan with nothing selected, which
 * is what the findings about the plan as a whole are asking for.
 * @param {string|null} kind
 */
export function openDivePlan(kind) {
  diveOn = true;
  selectedSegmentId = null;
  /* 'contingency' is not a gate: it is the plan the lost-link altitude, the
     bailout and the abort gate all live in, and the findings about those three
     have no leg to land on. It opens the recovery panel outright rather than
     toggling, for the same reason the rest of this function does not. */
  recoveryOn = kind === 'contingency';
  selectedDiveKind = recoveryOn ? null : kind;
  if (!recoveryOn) divePlacing = null;
  deps?.requestRender();
}

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

/* ---------- subject mode ---------- */
//
// The same shape as route mode and for the same reasons — a view preference, not
// part of the plan, so it is never persisted — with one difference: it starts
// off rather than following the document. A restored mission's *route* comes back
// visible because the line is the plan; a restored mission's subjects come back
// as pins, and putting the map into a mode where the next click drops another one
// is not something a pilot who just opened a file asked for.

let subjectOn = false;

/** Expert-only, like the route tool: a subject is a shot, and beginner mode is not asking about shots. */
const subjectActive = () => subjectOn && !deps.beginner();

/** @param {LatLng} at */
function placeSubject(at) {
  raiseEdit({ type: 'addSubject', payload: { latitude: at.lat, longitude: wrapLng(at.lng) } });
}

/**
 * The armed recovery placement, spent (M16, 3D-08). Disarms first and whatever
 * the command answers: a click that was refused has still been used, and leaving
 * the map armed would put the next pin somewhere the pilot was not aiming.
 *
 * The bailout carries the ground under it as its elevation, sampled once here.
 * That is the terrain field's own answer at the moment of the click, not an
 * assumption — and where the field has no ground the site is stored with none,
 * which every surface that reads it already prints as unsurveyed.
 *
 * @param {LatLng} at
 */
function placeRecovery(at) {
  const what = divePlacing;
  divePlacing = null;
  const latitude = at.lat;
  const longitude = wrapLng(at.lng);
  if (what === 'bailout') {
    const existing = sceneNow().dive?.bailout ?? null;
    raiseEdit({ type: 'setDiveBailout', payload: { bailout: {
      /* A move keeps the name the pilot typed; a first placement takes the
         reducer's default and offers the box to change it. */
      ...(existing ? { name: existing.name } : {}),
      latitude, longitude, elevationMslM: groundSampler(latitude, longitude),
    } } });
  } else if (what === 'abort') {
    const dive = sceneNow().dive;
    const existing = dive?.gates.find((g) => g.kind === 'abort') ?? null;
    const altitudeMslM = existing ? existing.altitudeMslM : abortSeedAltitudeM(dive);
    if (altitudeMslM == null) {
      /* Only reachable if the run's gates went away between arming and clicking.
         The panel disables the button for this case; saying it beats placing a
         gate at an altitude nobody stated. */
      editNote = 'That dive has no gates to read a break-off height from.';
    } else {
      raiseEdit({ type: 'setDiveGate', payload: {
        kind: 'abort', latitude, longitude, altitudeMslM, radiusM: existing?.radiusM ?? null,
      } });
    }
  }
  deps?.requestRender();
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

  /* Read once and shared: the layers draw the subjects and the inspector edits
   * them, and two reads of the document a few statements apart is exactly the
   * kind of "two answers from one pass" ADR 0002 exists to prevent.
   *
   * Named `sceneEdit` and not `scene` on purpose — the module-level `scene` is
   * the 3D handle, and a local of that name shadows it for the rest of this
   * function, which is a live grenade three statements below. */
  const sceneEdit = sceneNow();
  /* The dive selection gets the same re-check the route selection just did, and
     against the same read: a gate the pilot deleted takes its inspector with it. */
  selectedDiveKind = liveDiveSelection(sceneEdit.dive, selectedDiveKind);
  const frame = buildFrame(snapshot, sceneEdit);
  /* Both engines, always — the 2D pass is what computes the footprint's extent,
   * and it costs a handful of Leaflet overlays in a hidden container. Skipping it
   * in 3D would leave Fit view with nothing to frame on. */
  registry.render(frame, map);
  if (mode === '3d') scene?.render(frame);

  if (needsFit) {
    needsFit = false;
    const bounds = footprintLayer.bounds();
    if (mode === '3d' && scene) {
      /* Selected-leg focus (M12, the interaction contract's navigation row):
       * Fit pressed while a leg's inspector is open frames that leg, not the
       * whole mission — "look at this one" is what the selection already said. */
      const leg = selectedLegBounds(snapshot);
      if (leg) scene.fit(leg, { paddingPx: 48 });
      else if (bounds) scene.fit(bounds, { paddingPx: 24 });
      else scene.setView(frame.launch);
    } else if (bounds) map.fit(bounds, { paddingPx: 24 });
    else map.center(frame.launch);
  }

  renderCanvasNote(snapshot);
  renderSegmentInspector({
    snapshot,
    selectedSegmentId,
    units: frame.units,
    onClose: () => frame.actions.selectSegment(null),
    scene: sceneEdit,
    /* The editing half's one way out. Handed over only once a port is registered
     * — before that the panel reads and does not offer to write. */
    raise: editor ? raiseEdit : undefined,
  });
  /* The legend only; the explanation card moved to Analyze with the rest of the
   * numbers (M10), where app.js renders it off the same snapshot. */
  renderAdvisoryLegend({ advisories: snapshot.advisories, visible: frame.advisoryVisible });
  renderDivePanels(snapshot, frame);
  renderToolbar(frame);
}

/**
 * The dive workspace's four surfaces, riding the same pass everything else does
 * so a mode switch or a selection change lands on the next render with no wiring
 * of its own.
 *
 * Three of them wait on the `diveOn` latch — summoned overlays, per the note on
 * the latch itself — and the top-right seat is settled in one place here: the
 * segment inspector outranks the leg inspector, which outranks the standing
 * briefing, because each is a more specific answer to "what am I looking at".
 *
 * The leg inspector is the exception to the latch, and deliberately: the gates
 * are mission geometry and draw on the flat map too, so a pilot who clicks one
 * in 2D must get the panel that click promised. A latch that swallowed it would
 * make the 2D gates a control with no effect.
 *
 * @param {AnalysisSnapshot} snapshot
 * @param {MapFrame} frame
 */
function renderDivePanels(snapshot, frame) {
  const up = mode === '3d' && diveOn;
  const workspace = editor?.dive?.() ?? { aircraftName: null, templates: [] };
  const hasDive = !!frame.dive?.gates.length;
  /* The dynamics reading brings its own card to the seat, so the standing
     briefing stands down for it — the same one-answer-per-seat rule the two
     inspectors already follow, one rung further out. */
  const dynamicsSeat = up && hasDive && diveReading === 'dynamics';
  /* One seat, and the recovery plan sits in it alongside the two inspectors —
     it is an editor the pilot opened, which outranks anything standing. */
  const recoverySeat = recoveryOn && !!frame.dive;
  const seatFree = !selectedSegmentId && !selectedDiveKind && !recoverySeat;
  /* The pad's elevation as the analysis used it, or nothing. `elevM` is what
     every other surface measures a height against, and a launch that never
     resolved one is why the profile can start at the first gate. */
  const elevM = snapshot.inputs.env?.elevM;
  const launchMslM = Number.isFinite(elevM) ? /** @type {number} */ (elevM) : null;

  renderConditionsCard({
    snapshot,
    ladder: deps.windLadder?.() ?? null,
    aircraftName: workspace.aircraftName,
    units: frame.units,
    visible: up && seatFree && !dynamicsSeat,
  });
  renderDiveSystems({
    dynamics: snapshot.dive ?? null,
    link: snapshot.link ?? null,
    units: frame.units,
    visible: dynamicsSeat && seatFree,
    onTune: selectDiveGate,
  });
  renderRouteTemplates({
    templates: workspace.templates,
    /* The strip takes this row's place once a plan exists: by then the first
       sketch has been made, and what the pilot needs along the bottom edge is
       the ground under it. */
    visible: up && !hasDive,
    onApply: (id) => {
      const result = editor?.applyTemplate?.(id)
        ?? { ok: false, message: 'No mission is open yet — nothing to edit.' };
      /* Same contract as raiseEdit: the bridge renders the commands it accepts,
       * so only a refusal has to ask for the pass that shows its sentence. */
      editNote = result.ok ? null : result.message;
      if (!result.ok) deps?.requestRender();
    },
  });
  renderDiveStrip({
    dive: frame.dive,
    launch: frame.launch,
    launchMslM,
    selectedKind: selectedDiveKind,
    groundAt: groundSampler,
    visible: up && hasDive,
    onSelect: selectDiveGate,
    reading: diveReading,
    onReading: (next) => {
      if (diveReading === next) return;
      diveReading = next;
      deps?.requestRender();
    },
    dynamics: snapshot.dive ?? null,
    units: frame.units,
  });
  renderDiveRecovery({
    dive: frame.dive,
    groundAt: groundSampler,
    /* Not behind `up`: the abort gate and the bailout draw on the flat map too,
       and a pilot who tapped one there is owed the panel that tap promised —
       the same exception the leg inspector makes, for the same reason. */
    visible: recoverySeat,
    placing: divePlacing,
    onPlace: (what) => { divePlacing = what; deps?.requestRender(); },
    onClose: () => toggleDiveRecovery(),
    raise: editor ? raiseEdit : undefined,
  });
  renderDiveInspector({
    dive: frame.dive,
    launch: frame.launch,
    launchMslM,
    selectedKind: selectedDiveKind,
    groundAt: groundSampler,
    onClose: () => selectDiveGate(null),
    /* Without an editor the inspector is a read-out: it shows the leg it was
       given and refuses to arm its own Apply, which is the honest answer when
       there is no document to raise a command against. */
    raise: editor ? raiseEdit : undefined,
  });
}

/**
 * The terrain field, as the two dive surfaces ask for it. Answers null until the
 * host has one — and null again for anywhere the field never sampled, which both
 * of them are built to show as a gap rather than as flat ground.
 * @param {number} lat
 * @param {number} lng
 * @returns {number|null}
 */
function groundSampler(lat, lng) {
  const g = deps.groundAt?.(lat, lng);
  return typeof g === 'number' && Number.isFinite(g) ? g : null;
}

/**
 * @param {AnalysisSnapshot} snapshot
 * @param {SceneProjection} sceneEdit
 * @returns {MapFrame}
 */
function buildFrame(snapshot, sceneEdit) {
  return {
    snapshot,
    launch: { ...launch },
    waypoints: routeWaypoints(),
    subjects: sceneEdit.subjects,
    dive: sceneEdit.dive,
    spots: spotSpec?.spots ?? [],
    routeMode: routeActive(),
    subjectMode: subjectActive(),
    selectedSegmentId,
    selectedDiveKind,
    advisoryVisible: advisoryOn,
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
      /* The three subject gestures. Each is one command and nothing else — in
       * particular `removeSubject` does not un-point the segments that framed it
       * first, because the reducer does that in the same reduction and a map that
       * tidied up after it would be a second writer (ADR 0002). */
      placeSubject: (at) => placeSubject(at),
      moveSubject: (id, at) => raiseEdit({
        type: 'moveSubject',
        payload: { id, latitude: at.lat, longitude: wrapLng(at.lng) },
      }),
      removeSubject: (id) => raiseEdit({ type: 'removeSubject', payload: { id } }),
      selectSpot: (spot) => spotSpec?.onSelect?.(spot),
      /* The one action that raises no command. Clicking the open leg closes it,
       * clicking another switches, and null is the close button — the exported
       * toggle is shared with Analyze's surfaces, so no two clicks can mean
       * different things. */
      selectSegment,
      /* The dive pair. Selecting raises nothing, exactly like `selectSegment`;
         moving a gate is one command, and the kind carries the identity, so a
         dragged gate keeps its id without the layer ever holding one. */
      selectDiveGate,
      moveDiveGate: (kind, at) => {
        const gate = sceneEdit.dive?.gates.find((g) => g.kind === kind);
        if (!gate) return;
        raiseEdit({
          type: 'setDiveGate',
          payload: {
            kind,
            latitude: at.lat,
            longitude: wrapLng(at.lng),
            /* Carried, not re-derived: a drag across the map is a move in plan,
               and the altitude the pilot authored is not the drag's to change. */
            altitudeMslM: gate.altitudeMslM,
            radiusM: gate.radiusM,
          },
        });
      },
      moveDiveBailout: (at) => {
        const b = sceneEdit.dive?.bailout;
        if (!b) return;
        const latitude = at.lat;
        const longitude = wrapLng(at.lng);
        raiseEdit({
          type: 'setDiveBailout',
          payload: { bailout: {
            name: b.name,
            latitude,
            longitude,
            /* Re-surveyed, because unlike a gate's altitude this figure is a
               property of the ground and the drag moved the ground. Null where
               the field has none, which every reader already prints as
               unsurveyed rather than as sea level. */
            elevationMslM: groundSampler(latitude, longitude),
          } },
        });
      },
    },
  };
}

/**
 * The dive selection, re-checked against the plan in hand — the same rule
 * `liveSelection` applies to a route leg: a gate the pilot just deleted takes
 * its inspector with it, without a word, because editing the plan is not an
 * error.
 * @param {import('./map-adapter.js').DiveProjection|null} dive
 * @param {string|null} kind
 * @returns {string|null}
 */
function liveDiveSelection(dive, kind) {
  if (!kind) return null;
  return dive?.gates.some((g) => g.kind === kind) ? kind : null;
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

/**
 * The toolbar's latches and titles, which track the mode rather than the route.
 * The buttons are icon-only (M10): state rides on aria-pressed and the title —
 * never on textContent, which would clobber the svg child. The aria-labels are
 * static markup and stay put; a screen reader gets "Route mode, pressed", not a
 * label that mutates under it.
 */
function renderToolbar(frame) {
  const btn = $('btn-route');
  btn.setAttribute('aria-pressed', String(frame.routeMode));
  btn.title = frame.routeMode ? 'Route mode on — map clicks drop waypoints' : 'Route mode';
  $('btn-route-clear').hidden = !frame.routeMode || frame.waypoints.length === 0;
  /* The crosshair means "this click edits the plan", which both modes do — so it
   * is on for either, over either engine. Which edit it is, is what the two
   * buttons say. */
  const editing = frame.routeMode || frame.subjectMode;
  for (const id of ['map-canvas', 'map-3d']) $(id).classList.toggle('route-mode', editing);

  const btnSubject = $('btn-subject');
  btnSubject.setAttribute('aria-pressed', String(frame.subjectMode));
  btnSubject.title = frame.subjectMode ? 'Subject mode on — map clicks drop a thing to film' : 'Subject mode';

  const btnAdvisory = $('btn-advisory');
  btnAdvisory.setAttribute('aria-pressed', String(frame.advisoryVisible));
  btnAdvisory.title = frame.advisoryVisible ? 'Wind zones · on' : 'Wind zones';

  syncBaseLayer();
  syncViewbar();
}

/**
 * The box around the selected leg, when there is one. Segment k runs from
 * point k to point k+1 of [launch, …waypoints] — the numbering routeSpans
 * draws by: segment k arrives at waypoint k.
 * @param {AnalysisSnapshot} snapshot
 * @returns {import('./map-adapter.js').LatLngBounds|null}
 */
function selectedLegBounds(snapshot) {
  const seg = selectedSegmentId ? snapshot.segments?.[selectedSegmentId] : null;
  if (!seg || !Number.isInteger(seg.index) || !launch) return null;
  const pts = [launch, ...routeWaypoints()];
  const a = pts[seg.index];
  const b = pts[seg.index + 1];
  if (!a || !b) return null;
  return {
    southWest: { lat: Math.min(a.lat, b.lat), lng: Math.min(a.lng, b.lng) },
    northEast: { lat: Math.max(a.lat, b.lat), lng: Math.max(a.lng, b.lng) },
  };
}

/**
 * The viewbar's whole state machine, run every pass like the toolbar above it:
 * up only while a 3D engine is on screen, ortho-only groups standing down via
 * data-host when the satellite host draws (that host carries its own in-scene
 * exaggeration control), and every latch read back from the handle rather than
 * mirrored — the handle is the one that knows.
 */
function syncViewbar() {
  const bar = $('scene-viewbar');
  bar.hidden = mode !== '3d';
  if (bar.hidden) return;
  bar.dataset.host = sceneHost;
  const hostBtn = $('vb-host');
  hostBtn.textContent = sceneHost === 'ortho' ? 'Satellite' : 'Terrain';
  hostBtn.title = sceneHost === 'ortho'
    ? 'Switch to satellite 3D — imagery draped on terrain'
    : 'Switch to terrain 3D — the orthographic planner';
  const press = (/** @type {string} */ id, /** @type {boolean} */ on) => (
    $(id).setAttribute('aria-pressed', String(on)));
  // Not ortho-only, so it syncs before the ortho early-out below.
  press('vb-dive', diveOn);
  const s = orthoScene();
  if (!s) return;
  const proj = s.projection();
  press('vb-proj-ortho', proj === 'orthographic');
  press('vb-proj-persp', proj === 'perspective');
  press('vb-proj-top', proj === 'top');
  const az = s.azimuth();
  press('vb-az-north', az === 'north');
  press('vb-az-route', az === 'route');
  press('vb-az-free', az === 'free');
  press('vb-contours', s.contours());
  // 1.0× / 1.25× / 1.5× — two decimals only where the step puts them.
  $('vb-exag-value').textContent = `${s.exaggeration().toFixed(2).replace(/0$/, '')}×`;
}

/**
 * The base-layer button's whole state machine: disabled in 3D, where MapLibre
 * draws its own ground, and titled with what a press will do — not what is up
 * now — because the button is a toggle, not a status light.
 */
function syncBaseLayer() {
  const btn = $('btn-baselayer');
  const in3d = mode === '3d';
  btn.disabled = in3d;
  if (in3d) { btn.title = 'Base layer — 2D only'; return; }
  btn.title = adapter.view().baseLayer === 'satellite'
    ? 'Base layer: satellite — switch to streets'
    : 'Base layer: streets — switch to satellite';
}

/**
 * The map's one note line. `editNote` is the reason the last edit was refused
 * and outlives the pass it was set in; the argument is what this pass has to
 * say about the mission. Composed rather than overwritten, because a render
 * half a second after a rejected command must not quietly delete the
 * explanation. (The engine's own troubles left this line in M12 — they are
 * system-state cards over the stage now, not sentences under it.)
 * @param {string|null} msg
 */
function note(msg) {
  const el = $('map-note');
  const text = [editNote, msg].filter(Boolean).join(' ');
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
