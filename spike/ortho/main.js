// The orthographic-3D rendering spike page.
//
// One static page, four terrain paths, two projections, all selected by query
// string so one build answers every combination the Playwright spec asks about:
//
//   ?terrain=mesh|polygon|terrain-layer|terrain-layer-tiled
//   &source=terrarium|openmeteo      where the elevation grid comes from
//   &grid=<n>                        samples per axis (Option B only)
//   &demZoom=<z>                     which pyramid level Option B samples
//   &tiles=local|remote               served from public/ or straight from S3
//   &worker=cdn|local                 TerrainLayer's mesh worker (Option A only)
//   &projection=orthographic|perspective
//   &exaggeration=<number>
//   &wireframe=1
//
// The question is not "can deck.gl draw a mountain" — it plainly can. It is
// which terrain-mesh path a standalone `OrbitView({orthographic: true})` can
// actually use, what it costs to build and to orbit, and whether the pixels it
// needs can be in a pilot's pocket at a trailhead. Everything below exists to
// produce those numbers.
//
// Nothing here is production code.

import {
  AmbientLight,
  Deck,
  DirectionalLight,
  LightingEffect,
  OrbitView,
} from '@deck.gl/core';

import { openMeteoGrid, terrariumGrid, groundAt as sampleGround } from './dem.js';
import {
  frameLayer,
  meshTerrainLayer,
  missionLayers,
  polygonTerrainLayer,
  probeLayer,
  terrainLayerOption,
} from './layers.js';
import {
  CAMERA,
  DEFAULT_GRID,
  DEPTH_PROBES,
  LEGS,
  MESH_ZOOM,
  MISSION,
  OCCLUSION_PROBES,
  PALETTE,
  TERRARIUM_URL,
  legMidpoint,
} from './scene.mjs';

const params = new URLSearchParams(location.search);
const num = (key, fallback) => (params.has(key) ? Number(params.get(key)) : fallback);

const config = {
  terrain: params.get('terrain') ?? 'mesh',
  source: params.get('source') ?? 'terrarium',
  grid: Math.max(2, Math.round(num('grid', DEFAULT_GRID))),
  demZoom: Math.round(num('demZoom', MESH_ZOOM)),
  tiles: params.get('tiles') ?? 'local',
  worker: params.get('worker') ?? 'cdn',
  projection: params.get('projection') ?? 'orthographic',
  exaggeration: num('exaggeration', 1),
  wireframe: params.get('wireframe') === '1',
  probes: params.get('probes') === '1',
};

/** Everything that went wrong, for the spec to assert on. */
const errors = [];
addEventListener('error', (e) => errors.push(String(e.message)));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

/* Every URL the page asks for, so "how many round trips did this cost" is a
 * number rather than an impression. Playwright's own request log is the
 * authoritative record of *external* traffic (a worker's importScripts never
 * touches window.fetch); this counts what the page's own code asked for. */
const fetched = [];
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  fetched.push(String(typeof input === 'string' ? input : input?.url ?? input));
  return nativeFetch(input, init);
};

/** Where the DEM comes from: our own copy, or the real public endpoint. */
const tileTemplate = config.tiles === 'remote'
  ? TERRARIUM_URL
  : `${location.origin}${location.pathname.replace(/[^/]*$/, '')}tiles/{z}/{x}/{y}.png`;

/* -------------------------------------------------------------------- view */

let viewState = {
  target: [...CAMERA.target],
  zoom: num('zoom', CAMERA.zoom),
  rotationX: num('elevation', CAMERA.rotationX),
  rotationOrbit: num('azimuth', CAMERA.rotationOrbit),
  minZoom: CAMERA.minZoom,
  maxZoom: CAMERA.maxZoom,
};

/** What the inspector would be showing. The projection toggle must not lose it. */
let selection = null;

const lighting = new LightingEffect({
  ambient: new AmbientLight({ color: [255, 255, 255], intensity: 1.1 }),
  // Z-up world: a direction with a negative Z component is a light shining down.
  sun: new DirectionalLight({ color: [255, 246, 232], intensity: 2.1, direction: [-1, -0.55, -1.1] }),
  fill: new DirectionalLight({ color: [176, 200, 255], intensity: 0.65, direction: [0.9, 0.7, -0.5] }),
});

/** Swapped by the projection toggle; everything else about the view survives. */
const makeView = (projection) => new OrbitView({
  id: 'ortho',
  orbitAxis: 'Z',
  orthographic: projection === 'orthographic',
  // 3D orbit needs both, and the default OrbitController allows dragging
  // vertically to change rotationX only when this is on.
  controller: { inertia: false, dragRotate: true, scrollZoom: { speed: 0.01, smooth: false } },
});

/** Called after each redraw; the orbit measurement swaps it. */
let afterRender = null;

const deck = new Deck({
  parent: document.getElementById('view'),
  views: [makeView(config.projection)],
  viewState,
  onViewStateChange: ({ viewState: next }) => {
    viewState = next;
    deck.setProps({ viewState });
  },
  layers: [],
  effects: [lighting],

  // Without this the mountain does not occlude anything: the route, the stems
  // and the waypoint markers all draw straight through the summit.
  //
  // It is not a deck.gl bug, it is what a *standalone* Deck does. On WebGL,
  // LayersPass applies default draw parameters only for WebGPU devices
  // (`WEBGPU_DEFAULT_DRAW_PARAMETERS`); everything else inherits luma.gl's
  // pipeline defaults, which do not depth-test. Every deck usage in this app so
  // far is interleaved into MapLibre through MapboxOverlay, and MapLibre has
  // already configured the depth state by the time deck draws — so nothing in
  // src/ has ever had to say this, and a production standalone view would
  // rediscover it the same way: as "why is the route in front of the mountain".
  parameters: { depthWriteEnabled: true, depthCompare: 'less-equal' },
  onError: (e) => { errors.push(String(e?.message ?? e)); },
  onAfterRender: () => { afterRender?.(); },
  onClick: (info) => {
    selection = info?.object?.kind === 'waypoint' || info?.object?.kind === 'leg'
      ? { kind: info.object.kind, id: info.object.id }
      : null;
    paintStatus();
  },
  getTooltip: (info) => (info?.object?.name ? { text: info.object.name } : null),
});

/* ------------------------------------------------------------------ scene */

/** @type {import('./dem.js').Grid|null} */
let grid = null;
let terrainStats = { buildMs: 0, vertexCount: 0, triangleCount: 0 };
let firstFrameMs = 0;
const startedAt = performance.now();

async function buildTerrain() {
  if (config.terrain === 'terrain-layer' || config.terrain === 'terrain-layer-tiled') {
    return terrainLayerOption({
      variant: config.terrain === 'terrain-layer' ? 'single' : 'tiled',
      // The single-image variant wants one tile that covers the whole box, so it
      // deliberately runs coarser than the mesh path: at this latitude a z12 tile
      // is 6.9 km across and a z14 tile is 1.7 km, and the box is 5 km.
      z: config.terrain === 'terrain-layer' ? 12 : config.demZoom,
      exaggeration: config.exaggeration,
      baseUrl: tileTemplate,
      worker: config.worker,
      wireframe: config.wireframe,
    });
  }
  if (config.terrain === 'polygon') {
    return polygonTerrainLayer({ grid, exaggeration: config.exaggeration });
  }
  return meshTerrainLayer({
    grid, exaggeration: config.exaggeration, wireframe: config.wireframe,
  });
}

function paintLayers(terrainLayer) {
  const layers = [terrainLayer];
  if (grid) {
    layers.push(frameLayer({ grid, exaggeration: config.exaggeration }));
    layers.push(...missionLayers({ grid, exaggeration: config.exaggeration }));
    if (config.probes) layers.push(probeLayer({ grid, exaggeration: config.exaggeration }));
  }
  deck.setProps({ layers });
}

const ready = (async () => {
  // Option A never builds a grid of its own — that is the point of it — but the
  // route still has to stand on something, so the mission layers need one
  // regardless. Building it for every mode keeps the comparison honest: the
  // terrain *renderer* is what changes between modes, not the scene.
  const t0 = performance.now();
  grid = config.source === 'openmeteo'
    ? await openMeteoGrid({ n: config.grid })
    : await terrariumGrid({ n: config.grid, z: config.demZoom, baseUrl: tileTemplate });
  const gridMs = performance.now() - t0;

  const built = await buildTerrain();
  terrainStats = { ...built.stats, gridMs };
  paintLayers(built.layer);
  paintStatus();

  // Two frames: the first redraw is when deck compiles shaders and uploads
  // buffers, and a frame-time number that includes shader compilation is a
  // number about the driver, not about the mesh.
  await new Promise((resolve) => {
    let seen = 0;
    afterRender = () => {
      seen++;
      if (seen === 1) firstFrameMs = performance.now() - startedAt;
      if (seen >= 2) { afterRender = null; resolve(); }
      deck.redraw(true);
    };
    deck.redraw(true);
    setTimeout(resolve, 15_000);
  });

  // The first pickObject() after load reliably returns null even where a later
  // one at the identical coordinate returns a hit — the picking framebuffer has
  // not been rendered yet, and deck does not render it eagerly. Burn one here so
  // no measurement has to know that.
  try { deck.pickObject({ x: 1, y: 1, radius: 0 }); } catch { /* pre-GL, ignore */ }

  document.getElementById('status').dataset.ready = '1';
})();

ready.catch((e) => { errors.push(String(e?.message ?? e)); });

/* ---------------------------------------------------------------- controls */

function setView(patch) {
  viewState = { ...viewState, ...patch };
  deck.setProps({ viewState });
}

/**
 * Swap the projection, keeping everything else.
 *
 * This is the interaction the asset manifest names — "the projection toggle
 * should preserve route, selection, layers, azimuth, and inspector state" — and
 * the reason it is one line here is that the view is the only thing that
 * changes. Route geometry, selection and layer props all live outside the View,
 * so nothing about them is re-derived. A production toggle between an
 * orthographic deck view and the MapLibre perspective scene is not this cheap
 * (two engines, two cameras), but the state that has to survive is the same set.
 */
function setProjection(projection) {
  config.projection = projection;
  deck.setProps({ views: [makeView(projection)] });
  paintStatus();
}

function paintStatus() {
  const el = document.getElementById('legend');
  if (!el) return;
  el.textContent = [
    `${config.projection} · ${config.terrain}`,
    `azimuth ${Math.round(viewState.rotationOrbit)}°`,
    `${config.exaggeration.toFixed(1)}×`,
    selection ? `selected ${selection.id}` : 'no selection',
  ].join('  |  ');
}

document.getElementById('azimuth')?.addEventListener('input', (e) => {
  setView({ rotationOrbit: Number(e.target.value) });
  paintStatus();
});
document.getElementById('zoom')?.addEventListener('input', (e) => {
  setView({ zoom: Number(e.target.value) });
});
document.getElementById('projection')?.addEventListener('change', (e) => {
  setProjection(e.target.value);
});

/* ------------------------------------------------------------ measurement */

/** The viewport deck is currently drawing with. */
const viewport = () => deck.getViewports()[0];

/** Percentile of a sorted-in-place copy. */
function pct(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

/**
 * Sweep the azimuth and time every frame deck actually painted.
 *
 * Driven off `onAfterRender` rather than off requestAnimationFrame: deck only
 * redraws when something changed, so a rAF-driven clock would happily report
 * 60 fps for a scene that redrew twice. Each frame sets the next azimuth from
 * inside the callback, which makes the loop self-clocking — the (n+1)th frame
 * cannot start before the nth finished.
 */
function orbit({ degrees = 360, frames = 120 } = {}) {
  return new Promise((resolve) => {
    const times = [];
    const base = viewState.rotationOrbit;
    let i = 0;
    let last = 0;
    const started = performance.now();

    afterRender = () => {
      const now = performance.now();
      if (last) times.push(now - last);
      last = now;
      i++;
      if (i > frames) {
        afterRender = null;
        setView({ rotationOrbit: base });
        resolve({
          frames: times.length,
          meanMs: Number((times.reduce((a, b) => a + b, 0) / (times.length || 1)).toFixed(2)),
          p50Ms: Number(pct(times, 0.5).toFixed(2)),
          p95Ms: Number(pct(times, 0.95).toFixed(2)),
          maxMs: Number(Math.max(...times, 0).toFixed(2)),
          wallMs: Number((performance.now() - started).toFixed(1)),
          degrees,
          // deck's own metrics are a one-second rolling aggregate, so they are
          // only meaningful once a sweep has been running for a while — reading
          // them right after load reports zeroes. Sampled here, at the end.
          deck: {
            fps: Number((deck.metrics.fps ?? 0).toFixed(1)),
            framesRedrawn: deck.metrics.framesRedrawn ?? 0,
            gpuTimeMs: Number((deck.metrics.gpuTime ?? 0).toFixed(2)),
            cpuTimeMs: Number((deck.metrics.cpuTime ?? 0).toFixed(2)),
          },
        });
        return;
      }
      setView({ rotationOrbit: base + (degrees * i) / frames });
    };
    setView({ rotationOrbit: base + 0.001 });
  });
}

/** Renderer identity, so a frame time is never quoted without saying what drew it. */
function renderer() {
  try {
    const info = deck.device?.info;
    if (info) return { vendor: info.vendor, renderer: info.renderer, gpu: info.gpu ?? null };
  } catch { /* fall through to the raw probe */ }
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      gpu: null,
    };
  } catch {
    return { vendor: null, renderer: null, gpu: null };
  }
}

window.spike = {
  ready,
  errors,
  deck,
  config,

  info: () => ({
    ...config,
    tileTemplate,
    renderer: renderer(),
    devicePixelRatio,
    canvas: { width: deck.width, height: deck.height },
    // `displayName`, not `constructor.name`: the production build minifies class
    // names to two characters, and a spec asserting on "$S" proves nothing.
    // deck assigns displayName as a string literal, so it survives.
    viewportType: viewport()?.constructor?.displayName ?? null,
    // The claim under test, read off the viewport rather than off the config.
    isGeospatial: Boolean(viewport()?.isGeospatial),
    grid: grid && {
      n: grid.n,
      source: grid.source,
      spacingM: Number(grid.spacingM.toFixed(2)),
      minM: Number(grid.minM.toFixed(1)),
      maxM: Number(grid.maxM.toFixed(1)),
      requests: grid.requests,
      bytes: grid.bytes,
      timings: grid.timings,
    },
  }),

  metrics: () => ({
    ...terrainStats,
    firstFrameMs: Number(firstFrameMs.toFixed(1)),
    pageFetches: fetched.length,
    fetched: [...fetched],
  }),

  /** Screen position of a world point, exactly as deck projects it. */
  project: (x, y, z) => viewport().project([x, y, z]),

  /**
   * The same point through a viewport built with the *other* projection.
   *
   * This is what turns "orthographic" from a label into a measurement: build the
   * identical camera twice, once parallel and once perspective, and compare what
   * each does to a fixed world offset at two different camera depths.
   */
  projectWith: (projection, point) => {
    const vp = makeView(projection).makeViewport({
      width: deck.width, height: deck.height, viewState,
    });
    return vp.project(point);
  },

  groundAt: (x, y) => (grid ? sampleGround(grid, x, y) : null),

  /**
   * The rendered colour at a CSS-pixel position, as [r, g, b, a].
   *
   * Reads the drawing buffer rather than deck's picking buffer, because the two
   * disagree and only this one is what a pilot sees. deck creates its WebGL
   * context with `preserveDrawingBuffer: true`, so a 2D copy after the frame is
   * a faithful sample.
   */
  pixelAt: (x, y) => {
    const canvas = deck.getCanvas();
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const scale = canvas.width / canvas.clientWidth;
    return [...ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data];
  },

  pick: (x, y, radius = 0) => {
    const info = deck.pickObject({ x, y, radius });
    return info?.layer
      ? {
        layerId: info.layer.id,
        index: info.index,
        kind: info.object?.kind ?? null,
        id: info.object?.id ?? null,
      }
      : null;
  },

  viewState: () => ({ ...viewState }),
  setView,
  setProjection,
  selection: () => (selection ? { ...selection } : null),
  select: (value) => { selection = value; paintStatus(); },
  orbit,

  /** The fixture, so the spec never restates a number the page uses. */
  fixture: { MISSION, LEGS, DEPTH_PROBES, OCCLUSION_PROBES, PALETTE, legMidpoint },
};

paintStatus();
