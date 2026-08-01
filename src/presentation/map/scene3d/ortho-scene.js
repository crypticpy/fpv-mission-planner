// ortho-scene.js — the orthographic mission scene: a standalone deck.gl Deck
// over terrain this app decoded itself.
//
// A second host beside scene.js, not a branch inside it, and the spike's verdict
// says why in one line: "folding a viewport with no map into that file would put
// two engines behind one set of invariants" (spike/ortho/SPIKE-VERDICT.md,
// "Integration sketch"). scene.js is a *MapLibre* host, and the four ADR 0004
// constraints in its header are all statements about MapLibre — the overlay
// added after `map.once('idle')`, the explicit click bridge interleaved mode
// needs, `info.coordinate` never read, an explicit `maxPitch`. Not one of them
// is true here. There is no map, no style, no terrain source and no overlay:
// there is a `Deck` with an `OrbitView`, and a mesh this app built from tiles it
// decoded itself.
//
// What replaces them is a different list, and every item was measured in the
// spike rather than reasoned about:
//
//   *Depth state is not free.* A standalone Deck on WebGL inherits luma.gl's
//     pipeline defaults, which do not depth-test at all — deck applies its own
//     draw parameters only on WebGPU. The route then draws straight through the
//     mountain, and back-to-front triangle order makes it look correct anyway.
//     The fix is `DEPTH_PARAMETERS` on the Deck *and* on every layer: the draw
//     pass reads the deck-level ones and the picking pass reads
//     `layer.props.parameters`, so setting one is half a fix.
//
//   *Picking is not depth-correct against terrain.* Measured on two GPUs: a
//     click on a mountainside returns a waypoint buried inside the mountain. A
//     hit whose world Z is below the ground at its own XY is rejected here and
//     read as a click on the terrain, which is what `groundAt()` in
//     ortho-terrain.js exists for.
//
//   *The first `pickObject()` after load returns null.* The picking framebuffer
//     has not been rendered and deck does not render it eagerly. One throwaway
//     pick after the first frame is the whole fix, and without it the pilot's
//     first click on a pin does nothing.
//
//   *An OrbitViewport's zoom is a third numbering.* Not Leaflet's 256 px tile,
//     not MapLibre's 512 — log2 pixels per world metre. The bridge is in
//     ortho-view-state.js, derived, along with the rest of the arithmetic that
//     can be silently wrong and cannot be tested through a GPU.
//
// One capability is deliberately absent: nothing is draggable. The
// OrbitController owns the pointer for the whole canvas, and taking it back
// mid-gesture to move a pin is a interaction the spike never measured. A
// waypoint is still clicked to remove and a leg still clicked to open — the
// gestures scene.js supports minus the two drags — and the pilot who wants to
// move a pin has the 2D map, which is one tab away and better at it.

import {
  AmbientLight,
  Deck,
  DirectionalLight,
  LightingEffect,
  OrbitView,
} from '@deck.gl/core';

import {
  DEPTH_PARAMETERS,
  MESH_ZOOM,
  buildTerrainMesh,
  groundAt,
  loadTerrainGrid,
  orthoTerrainLayer,
} from './ortho-terrain.js';
import {
  boundsInSpace, boundsOf, cartesianSpace, fromSpaceXY, toSpaceXY,
} from './scene-geometry.js';
import { buildSceneLayers, readPalette } from './scene-layers.js';
import {
  ORTHO_CAMERA,
  boundsCover,
  fitViewState,
  gridPlacement,
  groundZReader,
  isOrthographic,
  padBounds,
  projectedViewState,
  terrainModelMatrix,
  toFlatZoomFromOrtho,
  toOrthoZoomFromFlat,
} from './ortho-view-state.js';

/**
 * @typedef {import('../map-adapter.js').LatLng} LatLng
 * @typedef {import('../map-adapter.js').LatLngBounds} LatLngBounds
 * @typedef {import('../map-adapter.js').MapFrame} MapFrame
 * @typedef {import('./ortho-terrain.js').OrthoTerrainGrid} OrthoTerrainGrid
 * @typedef {import('./ortho-view-state.js').OrbitViewState} OrbitViewState
 * @typedef {import('./ortho-view-state.js').OrthoProjection} OrthoProjection
 */

/**
 * The MapLibre host's contract, and this one's additions.
 *
 * The base half is byte-for-byte what `createScene` returns, so map-view.js
 * swaps hosts without learning a second vocabulary. The additions are the two
 * knobs that only exist where the app owns the camera and the mesh — and
 * `projection()` is not a courtesy: the chrome that toggles it has to be able to
 * say which camera the pilot is looking through, and a view labelled
 * Orthographic while drawing in perspective is the one dishonest thing this
 * scene could do.
 *
 * @typedef {import('./scene.js').SceneHandle & {
 *   projection: () => OrthoProjection,
 *   setProjection: (projection: OrthoProjection) => void,
 *   exaggeration: () => number,
 *   setExaggeration: (value: number) => void,
 * }} OrthoSceneHandle
 */

/** How far a pick reaches, in pixels. scene.js's radius, for the same thumb. */
const PICK_RADIUS = 6;

/**
 * How far below the ground a hit may sit before it is read as buried.
 *
 * Not a tolerance for a wrong elevation: the launch pad and every ground-draped
 * vertex are drawn *at* the terrain height in this frame (`drapeLiftM` is zero
 * in a cartesian space), so an exact comparison would reject half of them on
 * floating-point noise. What the rejection is actually for is a pin tens or
 * hundreds of metres inside a hillside, which two metres does not hide.
 */
const PICK_CLEARANCE_M = 2;

/** The terrain slider's ends, as in scene.js — one host, one range. */
const EXAGGERATION_MIN = 1;
const EXAGGERATION_MAX = 2.5;
const EXAGGERATION_DEFAULT = 1;

/** Give up rather than hang: scene.js's budget, and the spike's before it. */
const READY_TIMEOUT_MS = 30_000;

/**
 * How long the camera must sit still before the view counts as settled.
 *
 * MapLibre publishes `moveend`/`zoomend` and scene.js persists on those. An
 * orbit controller publishes every frame of the gesture instead, so the settle
 * is drawn here — and it has to exist, because the alternative is a write to
 * localStorage per frame of a drag.
 */
const VIEW_SETTLE_MS = 200;

const TERRAIN_LAYER_ID = 'ortho-terrain';

/**
 * How hard a click looks for the ground it landed on.
 *
 * The screen ray is walked onto the height field by fixed point: guess a height,
 * unproject at it, read the ground there, guess again. Three steps settle it to
 * well inside a metre under any camera this scene allows, and it converges
 * because the ray is steeper than the hillside — a camera down at the horizon is
 * one where a click on the ground is ambiguous anyway, and there the last
 * estimate is returned rather than a refusal.
 */
const GROUND_RAY_STEPS = 3;
const GROUND_RAY_TOLERANCE_M = 0.5;

/**
 * The mesh's one colour, multiplied by the lighting below.
 *
 * A neutral rock grey rather than a theme token, because there is no terrain
 * colour in `ScenePalette` to read — the MapLibre host draws satellite imagery
 * where this one draws a surface. It sits deliberately below the route and ring
 * colours in both value and saturation: the terrain is what the plan is read
 * against, not a thing to read.
 */
const TERRAIN_COLOR = /** @type {[number, number, number]} */ ([122, 128, 134]);

/**
 * Sun and sky over a Z-up world.
 *
 * The spike's own lights, kept because they are what its screenshots were judged
 * on: a single flat-coloured mesh reads as terrain only through its normals, and
 * the normals only show under a light with a direction. A negative Z component
 * is a light shining down.
 */
const orthoLighting = () => new LightingEffect({
  ambient: new AmbientLight({ color: [255, 255, 255], intensity: 1.1 }),
  sun: new DirectionalLight({
    color: [255, 246, 232], intensity: 2.1, direction: [-1, -0.55, -1.1],
  }),
  fill: new DirectionalLight({
    color: [176, 200, 255], intensity: 0.65, direction: [0.9, 0.7, -0.5],
  }),
});

/**
 * The orthographic scene, live on the given container.
 *
 * `launch` is the extra option this host takes and the MapLibre one does not: a
 * cartesian frame needs an origin at construction, and `ready` resolves before
 * the first `render(frame)` — so there is no frame to read one from when it is
 * needed. It is the launch point for the same reason `cartesianSpace` says it
 * is: every other number in a mission is already measured from there.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container   already visible and sized
 * @param {LatLng} opts.center
 * @param {number} opts.zoom             in the 2D engine's numbering; converted here
 * @param {LatLng} opts.launch           the local frame's origin, fixed for the scene's life
 * @param {boolean} opts.reducedMotion
 * @param {(at: LatLng) => void} opts.onGroundClick  a click on the terrain, not on a pin
 * @param {() => void} opts.onViewChange
 * @param {() => void} [opts.onTileError]
 * @param {OrthoProjection} [opts.projection]  orthographic unless a caller says otherwise
 * @returns {OrthoSceneHandle}
 */
export function createOrthoScene(opts) {
  const { container, center, launch, reducedMotion } = opts;

  const space = cartesianSpace(launch);
  const aborter = new AbortController();

  let projection = /** @type {OrthoProjection} */ (opts.projection ?? 'orthographic');
  let exaggeration = EXAGGERATION_DEFAULT;
  let destroyed = false;
  let warmed = false;
  let tileErrorReported = false;
  let loading = false;
  /** @type {MapFrame|null} */
  let current = null;
  /** @type {OrthoTerrainGrid|null} */
  let grid = null;
  /** @type {import('./ortho-view-state.js').GridPlacement|null} */
  let placement = null;
  /** @type {import('./ortho-terrain.js').OrthoTerrainMesh|null} */
  let mesh = null;
  /** @type {object|null} The terrain layer instance, rebuilt only when it changes. */
  let terrain = null;
  /** What the loaded mesh covers, so a mission growing past it can be noticed. */
  /** @type {LatLngBounds|null} */
  let loaded = null;
  /** The last framing, so a resize can re-derive a zoom that came off a canvas size. */
  /** @type {{ bounds: LatLngBounds, paddingPx: number }|null} */
  let framed = null;
  let settleTimer = 0;

  /* ---------- the camera ---------- */

  const startZoom = toOrthoZoomFromFlat(opts.zoom, center.lat);
  const [startX, startY] = toSpaceXY(space, center.lng, center.lat);
  /** @type {OrbitViewState} */
  let viewState = {
    target: [startX, startY, 0],
    zoom: clampZoom(startZoom ?? 0),
    rotationX: ORTHO_CAMERA.rotationX,
    rotationOrbit: ORTHO_CAMERA.rotationOrbit,
    minZoom: ORTHO_CAMERA.minZoom,
    maxZoom: ORTHO_CAMERA.maxZoom,
  };

  /**
   * The view, rebuilt on every projection change and never otherwise.
   *
   * Both instances take the same `OrbitViewState`, which is why the toggle is a
   * re-render rather than a migration: the azimuth, the zoom and the target pass
   * straight through, and the selection and the layers never hear about it.
   * @param {OrthoProjection} p
   */
  const makeView = (p) => new OrbitView({
    id: 'ortho',
    orbitAxis: 'Z',
    orthographic: isOrthographic(p),
    controller: {
      // A pilot who asked the OS for less motion asked this camera too: no
      // coasting after the finger leaves the glass.
      inertia: !reducedMotion,
      dragRotate: true,
      scrollZoom: { speed: 0.01, smooth: !reducedMotion },
    },
  });

  /** Resolved by deck's own `onLoad`, which is the device and nothing else. */
  let signalLoaded = () => {};
  const deckLoaded = new Promise((resolve) => { signalLoaded = () => resolve(undefined); });

  const deck = new Deck({
    parent: container,
    onLoad: () => signalLoaded(),
    views: [makeView(projection)],
    viewState,
    layers: [],
    effects: [orthoLighting()],
    pickingRadius: PICK_RADIUS,
    // Half of the depth fix; the other half is on every layer (scene-layers.js's
    // CARTESIAN_LAYER_PROPS and ortho-terrain.js's own). The draw pass reads
    // these, the picking pass reads the layer's — and one without the other
    // fails silently in whichever pass was left out.
    parameters: { ...DEPTH_PARAMETERS },
    onViewStateChange: ({ viewState: next }) => {
      viewState = /** @type {OrbitViewState} */ (next);
      /* The pilot moved the camera, so whatever the last `fit` framed is no
       * longer what is on screen — a later resize must not drag them back to it. */
      framed = null;
      deck.setProps({ viewState });
      settle();
    },
    onClick: (info) => { onClick(info); },
    onAfterRender: () => {
      if (warmed || destroyed) return;
      warmed = true;
      /* The throwaway pick. Measured: the first `pickObject()` after load
       * returns null at a coordinate a later one hits, because the picking
       * framebuffer has not been rendered yet. */
      try { deck.pickObject({ x: 1, y: 1, radius: 0 }); } catch { /* pre-GL */ }
    },
    onError: (err) => { console.error('[ortho-scene]', err); },
  });

  /* ---------- readiness ---------- */

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('3D scene never became ready')), READY_TIMEOUT_MS);
    Promise.all([deckLoaded, loadTerrain(pointBounds(launch), true)])
      .then(() => { clearTimeout(timer); resolve(undefined); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });

  /* ---------- the ground ---------- */

  /** The grid's own reading, in its own frame. Null until the tiles land. */
  const sample = (/** @type {number} */ x, /** @type {number} */ y) => (
    grid ? groundAt(grid, x, y) : null);

  /**
   * The ground under a geographic point, at the exaggeration currently drawn.
   *
   * Composed once, in ortho-view-state.js, because three things have to agree
   * about it: the mesh (a Z scale on its model matrix), the route's vertices
   * (this function, through `buildSceneLayers`), and the picking rejection. Two
   * of them disagreeing is a route hovering over the hill it stands on.
   * @type {(lng: number, lat: number) => number|null}
   */
  let groundZAt = () => null;

  /** The same reading, for a point already in the scene's own metres. */
  const groundZAtXY = (/** @type {number} */ x, /** @type {number} */ y) => {
    if (!placement) return null;
    const z = sample(x - placement.offset[0], y - placement.offset[1]);
    return z == null ? null : z * exaggeration;
  };

  /* ---------- terrain ---------- */

  /**
   * Load the mesh over a mission's ground, if what is loaded does not already
   * cover it.
   *
   * Re-entered on a mission that grows past its own terrain — a route drawn out
   * to the edge of the box is a route planned over a cliff of missing ground.
   * The old mesh keeps drawing while the new one loads, because a blank scene is
   * worse than a stale one.
   *
   * @param {LatLngBounds} bounds
   * @param {boolean} [first]  the load `ready` is waiting on
   * @returns {Promise<void>}
   */
  async function loadTerrain(bounds, first = false) {
    const wanted = padBounds(bounds);
    if (loading || boundsCover(loaded, wanted)) return;
    loading = true;
    try {
      const next = await loadTerrainGrid({
        bounds: wanted, zoom: MESH_ZOOM, signal: aborter.signal,
      });
      if (destroyed) return;

      const { coverage } = next.provenance;
      if (coverage === 'empty') {
        /* Nothing decoded. On the first load there is no scene to have — the
         * host chooser falls back to MapLibre exactly as it does when `ready`
         * times out. On a later one there is a mesh already drawn, and throwing
         * it away because the pilot panned towards the sea would be worse than
         * saying so. */
        reportTileError();
        if (first) throw new Error('ortho-scene: no terrain decoded for this mission');
        return;
      }
      if (coverage !== 'complete') reportTileError();

      grid = next;
      loaded = wanted;
      placement = gridPlacement(space, grid.origin);
      groundZAt = groundZReader({
        placement, sample, exaggeration: () => exaggeration,
      });
      mesh = buildTerrainMesh(grid);
      refreshTerrain();
      // The camera looks at sea level until it knows better; a plateau at 2,400 m
      // would otherwise sit off the top of the screen with nothing to say why.
      if (first) setViewState({ ...viewState, target: targetAt(viewState.target) });
      renderLayers();
    } finally {
      loading = false;
    }
  }

  /**
   * The terrain layer, rebuilt only when the mesh or the model matrix changes.
   *
   * deck matches layers by id and treats an unchanged instance as unchanged, so
   * handing the same one back every pass costs nothing — where a fresh
   * `SimpleMeshLayer` per pass would re-upload 35,000 vertices, because its
   * `mesh` prop is compared by reference.
   */
  function refreshTerrain() {
    terrain = mesh && placement
      ? orthoTerrainLayer({
        id: TERRAIN_LAYER_ID,
        mesh,
        color: TERRAIN_COLOR,
        // In the picking pass as well as the draw pass, so that where the depth
        // test does behave the hillside simply wins and the pin behind it is
        // never returned. Where it does not — which is what the spike measured —
        // `pickedKind` throws the buried pin out analytically. The layer being
        // pickable is the cheap half of that fix, not the whole of it.
        pickable: true,
        modelMatrix: terrainModelMatrix(placement.offset, exaggeration),
      })
      : null;
  }

  /** Report a hole in the terrain once, in the app's own words for it — and
   * never for a fetch that only failed because `destroy()` aborted it. */
  function reportTileError() {
    if (tileErrorReported || destroyed) return;
    tileErrorReported = true;
    opts.onTileError?.();
  }

  /* ---------- drawing ---------- */

  function renderLayers() {
    if (!current || destroyed) return;
    deck.setProps({
      layers: [
        // Under everything, and drawn first so the depth buffer it writes is
        // what every ribbon above it is tested against.
        ...(terrain ? [terrain] : []),
        ...buildSceneLayers(current, {
          palette: readPalette(document.documentElement),
          exaggeration,
          groundZAt: (lng, lat) => groundZAt(lng, lat),
          space,
        }),
      ],
    });
  }

  /* ---------- pointer ---------- */

  /**
   * One click, resolved against the same kinds scene.js knows.
   *
   * The buried-hit rejection is the picking fix the spike's verdict mandates: a
   * pin the mountain is standing in front of is not a pin the pilot can see, so
   * a click that returns it means what it looked like it meant — a click on the
   * hillside — and falls through to the ground.
   *
   * @param {{ object?: object|null, x?: number, y?: number }|null} info
   *   deck's own pick, at its radius, carrying the pointer position it was taken at
   */
  function onClick(info) {
    const frame = current;
    if (!frame || destroyed) return;
    // The click a drag leaves behind is not a new gesture — the same guard the
    // 2D map and the MapLibre host raise, through the same frame.
    if (frame.gestures.afterDrag()) return;

    const hit = pickedKind(info?.object ?? null);
    if (hit?.kind === 'waypoint' && hit.id) {
      frame.gestures.markerClicked();
      frame.actions.removeWaypoint(hit.id);
      return;
    }
    // The pad is dragged and never clicked in 2D; here it is neither, and a
    // click on it must still not fall through and drop a waypoint on top of it.
    if (hit?.kind === 'launch') return;
    if (hit?.kind === 'leg' && hit.id) {
      frame.gestures.markerClicked();
      frame.actions.selectSegment(hit.id);
      return;
    }

    const { x, y } = info ?? {};
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const at = groundPoint(/** @type {number} */ (x), /** @type {number} */ (y));
    if (at) opts.onGroundClick(at);
  }

  /**
   * What a picked datum is, once the ground has had its say.
   *
   * The rejection reads the object's own position rather than the pick's
   * unprojected coordinate, because an `OrbitViewport` unprojects a bare screen
   * point onto the plane through its target — the depth-buffer readback that
   * would do better is optional on WebGL, and a fix that quietly stops working
   * on some devices is not a fix. A leg has two ends instead of a position and
   * is rejected only when both are underground: a leg that crosses a ridge is a
   * real leg, and the pilot may well be opening it because of the ridge.
   *
   * @param {object|null} object
   * @returns {{ kind: 'launch'|'waypoint'|'leg', id: string|null }|null}
   */
  function pickedKind(object) {
    const datum = /** @type {{ kind?: string, id?: string, segmentId?: string|null,
     *   position?: number[], path?: number[][] }|null} */ (object);
    if (!datum || datum.kind === 'terrain') return null;
    if (datum.position && buried(datum.position)) return null;
    if (datum.path && datum.path.every((p) => buried(p))) return null;
    if (datum.kind === 'launch') return { kind: 'launch', id: null };
    if (datum.kind === 'waypoint' && datum.id) return { kind: 'waypoint', id: datum.id };
    if (datum.kind === 'leg' && datum.segmentId) return { kind: 'leg', id: datum.segmentId };
    return null;
  }

  /**
   * Whether a drawn point sits below the ground under it.
   * @param {readonly number[]} at  scene metres
   * @returns {boolean}
   */
  function buried(at) {
    if (at.length < 3 || !Number.isFinite(at[2])) return false;
    const ground = groundZAtXY(at[0], at[1]);
    return ground != null && at[2] < ground - PICK_CLEARANCE_M;
  }

  /**
   * Where on the earth a click landed.
   *
   * ADR 0004's third constraint says what not to do here: a ground-plane
   * unprojection names the point the ray crosses sea level, not the point on the
   * hill under the cursor. MapLibre's host answers it with `e.lngLat`, which is
   * unprojected against MapLibre's own terrain mesh. This host has no such
   * thing, so it walks its own height field — which is the second reason the
   * spike's verdict says the mesh has to be ours to query.
   *
   * @param {number} x @param {number} y
   * @returns {LatLng|null}
   */
  function groundPoint(x, y) {
    let height = viewState.target[2];
    let at = rayAt(x, y, height);
    for (let step = 0; at && step < GROUND_RAY_STEPS; step++) {
      const ground = groundZAtXY(at[0], at[1]);
      // Off the mesh, or already there: the estimate in hand is the answer.
      if (ground == null || Math.abs(ground - height) < GROUND_RAY_TOLERANCE_M) break;
      height = ground;
      at = rayAt(x, y, height);
    }
    return at ? fromSpaceXY(space, at[0], at[1]) : null;
  }

  /**
   * Where the ray through a screen point crosses a horizontal plane.
   *
   * Taken from the two ends of the ray rather than from one unprojection with a
   * target height: `OrbitViewport` overrides `unproject` and drops the `targetZ`
   * option the base viewport takes, so asking for a height is quietly ignored.
   * The near and far unprojections are exact under both projections — the
   * perspective divide is inside them — and two points are a line.
   *
   * @param {number} x @param {number} y @param {number} z  metres, in the scene's frame
   * @returns {[number, number]|null}
   */
  function rayAt(x, y, z) {
    const viewport = /** @type {{ unproject: (p: number[]) => number[] }|undefined} */
      (deck.getViewports()[0]);
    if (!viewport) return null;
    const near = viewport.unproject([x, y, 0]);
    const far = viewport.unproject([x, y, 1]);
    const span = far[2] - near[2];
    if (!Number.isFinite(span) || Math.abs(span) < 1e-9) return null;
    const t = (z - near[2]) / span;
    const at = /** @type {[number, number]} */
      ([near[0] + (far[0] - near[0]) * t, near[1] + (far[1] - near[1]) * t]);
    return Number.isFinite(at[0]) && Number.isFinite(at[1]) ? at : null;
  }

  /* ---------- the camera, driven ---------- */

  /** @param {number} zoom */
  function clampZoom(zoom) {
    if (!Number.isFinite(zoom)) return ORTHO_CAMERA.minZoom;
    return Math.max(ORTHO_CAMERA.minZoom, Math.min(ORTHO_CAMERA.maxZoom, zoom));
  }

  /**
   * The target, with its Z on the middle of the terrain at the current stretch.
   *
   * Recentred whenever the exaggeration changes, so the mesh grows about the
   * point the camera is looking at rather than sliding off the top of the frame.
   * @param {readonly number[]} [from]  keeps an existing XY
   * @returns {[number, number, number]}
   */
  function targetAt(from) {
    const mid = grid && grid.minM != null && grid.maxM != null
      ? ((grid.minM + grid.maxM) / 2) * exaggeration
      : 0;
    return [from?.[0] ?? 0, from?.[1] ?? 0, mid];
  }

  /** @param {OrbitViewState} next */
  function setViewState(next) {
    viewState = next;
    deck.setProps({ viewState });
    settle();
  }

  /** One `onViewChange` per settled gesture, not one per frame of it. */
  function settle() {
    clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      if (!destroyed) opts.onViewChange();
    }, VIEW_SETTLE_MS);
  }

  /** The canvas, in CSS pixels — zero while the container is still hidden. */
  const canvasSize = () => ({
    width: deck.width || container.clientWidth,
    height: deck.height || container.clientHeight,
  });

  /**
   * @param {LatLngBounds} bounds
   * @param {{ paddingPx?: number }} [o]
   */
  function fit(bounds, { paddingPx = 0 } = {}) {
    const { width, height } = canvasSize();
    const { target, zoom } = fitViewState(boundsInSpace(bounds, space), {
      width, height, paddingPx, centreZ: targetAt(viewState.target)[2],
    });
    framed = { bounds, paddingPx };
    setViewState({
      ...viewState,
      target,
      ...(zoom != null ? { zoom: clampZoom(zoom) } : null),
    });
  }

  /** A point as a box with no size, which `padBounds` grows into a mission's worth. */
  /** @param {LatLng} at @returns {LatLngBounds} */
  function pointBounds(at) {
    return { southWest: { ...at }, northEast: { ...at } };
  }

  /** Everything the mission puts on the ground, as a box. */
  /** @param {MapFrame} frame @returns {LatLngBounds} */
  function frameBounds(frame) {
    const points = [frame.launch, ...(frame.snapshot.route?.points ?? [])];
    return boundsOf(points) ?? pointBounds(frame.launch);
  }

  /* ---------- what the host holds ---------- */

  return {
    ready,

    render: (frame) => {
      current = frame;
      renderLayers();
      /* Kicked off the pass rather than awaited by it: the scene draws now, on
       * the mesh it has, and picks up the wider one when the tiles arrive. */
      if (!destroyed) loadTerrain(frameBounds(frame)).catch(() => reportTileError());
    },

    view: () => {
      const centre = fromSpaceXY(space, viewState.target[0], viewState.target[1]);
      return {
        center: centre,
        zoom: toFlatZoomFromOrtho(viewState.zoom, centre.lat) ?? opts.zoom,
      };
    },

    setView: (at, zoomLevel) => {
      const [x, y] = toSpaceXY(space, at.lng, at.lat);
      const zoom = zoomLevel != null ? toOrthoZoomFromFlat(zoomLevel, at.lat) : null;
      framed = null;
      setViewState({
        ...viewState,
        target: [x, y, viewState.target[2]],
        ...(zoom != null ? { zoom: clampZoom(zoom) } : null),
      });
    },

    fit,

    resized: () => {
      /* deck re-measures its own canvas, so the picture follows the container by
       * itself. What does not is a zoom that came off a canvas size: a `fit`
       * computed while the container was still hidden framed nothing, and a
       * fitted view that survives into a new shape should still be fitted. */
      if (framed) fit(framed.bounds, { paddingPx: framed.paddingPx });
    },

    destroy: () => {
      destroyed = true;
      clearTimeout(settleTimer);
      // Tiles still in flight belong to a scene that no longer exists.
      aborter.abort();
      deck.finalize();
    },

    /* ---------- the ortho host's own two knobs ---------- */

    projection: () => projection,

    setProjection: (next) => {
      if (next === projection) return;
      projection = next;
      viewState = projectedViewState(viewState, projection);
      /* One re-render with a different view instance, the state passed straight
       * through — the toggle the spike asserted preserves selection, azimuth and
       * every layer (SPIKE-VERDICT.md, "Preserving state across the projection
       * toggle"). */
      deck.setProps({ views: [makeView(projection)], viewState });
    },

    exaggeration: () => exaggeration,

    setExaggeration: (value) => {
      const next = Math.max(EXAGGERATION_MIN, Math.min(EXAGGERATION_MAX, Number(value)));
      if (!Number.isFinite(next) || next === exaggeration) return;
      exaggeration = next;
      /* No mesh is rebuilt: the terrain's Z scale is a matrix, and every altitude
       * in the scene is multiplied by the same number in the same pass — which is
       * what keeps a stem standing on the ground it was drawn above. */
      refreshTerrain();
      setViewState({ ...viewState, target: targetAt(viewState.target) });
      renderLayers();
    },
  };
}
