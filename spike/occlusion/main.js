// The ADR 0004 rendering spike page.
//
// One static page, three scenes, two deck.gl integration modes, all selected by
// query string so the Playwright spec drives every combination against one
// build:
//
//   ?scene=above-ridge|above-valley|occlusion
//   &mode=interleaved|overlaid
//   &exaggeration=<number>            (defaults to 1)
//   &alt=<metres MSL>                 (overrides the scene's path altitude)
//
// `alt` is what turns "the path looks about right" into a measurement. The spec
// re-renders each scene at a sea-level control (alt=0, the documented deck.gl
// failure mode) and at two altitudes straddling the terrain surface, and reads
// the answer off MapLibre's own depth buffer.
//
// Nothing here is production code. It exists to answer four questions and to be
// deleted or promoted on the strength of the answers.

// maplibre-gl is pinned to 5.x on purpose. @deck.gl/mapbox 9.3.7 reaches into
// `map.transform` (`.elevation`, `._nearZ`, `._farZ`, `.height`) to build its
// viewport, and maplibre-gl 6.x removed that property from the Map instance
// entirely — under v6 the very first deck render throws
// "Cannot read properties of undefined (reading 'elevation')" and nothing draws.
// v6 also resolves its worker from `import.meta.url` at runtime, which no
// bundler can follow; the worker 404s, every tile sits in state 'loading'
// forever, and the map never fires 'load'. Both are recorded in the handback.
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { PathLayer } from '@deck.gl/layers';

import 'maplibre-gl/dist/maplibre-gl.css';

import {
  DEM_BOUNDS,
  PATH_COLOR,
  SCENES,
  TILES,
  pathPositions,
} from './scene.mjs';

const params = new URLSearchParams(location.search);
const sceneName = params.get('scene') ?? 'above-ridge';
const scene = SCENES[sceneName];
if (!scene) throw new Error(`unknown scene ${sceneName}`);
const interleaved = (params.get('mode') ?? 'interleaved') === 'interleaved';
const exaggeration = Number(params.get('exaggeration') ?? 1);
const altOverride = params.has('alt') ? Number(params.get('alt')) : null;

/** Everything that went wrong, for the spec to assert on. */
const errors = [];
addEventListener('error', (e) => errors.push(String(e.message)));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

// Relative, not absolute: the spike is served from the preview server's root
// today, but a `new URL(...)` would percent-encode the {z}/{x}/{y} placeholders
// MapLibre needs to see literally.
const base = location.pathname.replace(/[^/]*$/, '');
const demTiles = `${location.origin}${base}tiles/${scene.surface}/{z}/{x}/{y}.png`;

const demSource = {
  tiles: [demTiles],
  tileSize: TILES.size,
  minzoom: TILES.minZoom,
  maxzoom: TILES.maxZoom,
  // Without this a 70-degree pitch puts most of Texas in the frustum and
  // MapLibre requests tiles that were never generated. Vite's preview server
  // answers a missing path with index.html and HTTP 200 rather than 404, so the
  // failure mode is not "tile missing" but "the source image could not be
  // decoded" — `bounds` is load-bearing here, not an optimisation.
  bounds: DEM_BOUNDS,
  attribution: 'synthetic fixture',
};

const style = {
  version: 8,
  layers: [
    // Sky-ish, and nowhere near magenta. Painted in screen space: a background
    // layer is not draped on terrain, so "not this colour" means "terrain (or
    // path) covers this pixel".
    { id: 'sky', type: 'background', paint: { 'background-color': '#8fb8de' } },
    {
      // The DEM tiles again, this time as ordinary raster imagery draped over
      // the terrain. Terrarium RGB happens to be a perfectly good elevation
      // ramp (red is the high byte, so it barely moves; green sweeps the whole
      // range), and using the same bytes for the mesh and its texture means the
      // picture can never disagree with the elevations the probes assert on.
      // Without an opaque drape, hillshade alone leaves flat ground fully
      // transparent and the terrain is indistinguishable from sky.
      id: 'ground',
      type: 'raster',
      source: 'ground',
      paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' },
    },
    {
      id: 'shade',
      type: 'hillshade',
      source: 'dem',
      paint: {
        'hillshade-shadow-color': '#3c4a52',
        'hillshade-highlight-color': '#f2f0ea',
        'hillshade-accent-color': '#7d8b94',
        'hillshade-exaggeration': 0.65,
      },
    },
  ],
  sources: {
    dem: { type: 'raster-dem', encoding: 'terrarium', ...demSource },
    ground: { type: 'raster', ...demSource },
  },
};

const map = new maplibregl.Map({
  container: 'map',
  style,
  center: scene.camera.center,
  zoom: scene.camera.zoom,
  bearing: scene.camera.bearing,
  pitch: scene.camera.pitch,
  // Default maxPitch is 60 and every scene here is pitched past it.
  maxPitch: 85,
  attributionControl: false,
  // No cross-fade between tile zoom levels: the screenshot must be the final
  // frame, not a blend on its way there.
  fadeDuration: 0,
  // Deliberately NOT `interactive: false`. In overlaid mode MapboxOverlay picks
  // up pointer input by subscribing to MapLibre's own 'click'/'mousemove'
  // events, and a non-interactive map never attaches the listeners that produce
  // them — deck would then be unpickable by real clicks for reasons that have
  // nothing to do with deck. The spec never drags or scrolls, so leaving the
  // handlers on costs no determinism.
});

const altM = altOverride ?? scene.path.altM;
const positions = pathPositions(scene, altM);

const pathLayer = new PathLayer({
  id: 'mission-path',
  data: [{ id: 'leg-1', name: 'mission path', path: positions }],
  getPath: (d) => d.path,
  getColor: [...PATH_COLOR, 255],
  // Screen-space width, and billboarded so the ribbon faces the camera instead
  // of lying flat in the ground plane: at a 70-degree pitch a non-billboarded
  // ribbon is nearly edge-on and collapses to a hairline, which would make a
  // pixel probe a test of the ribbon's orientation rather than of its depth.
  widthUnits: 'pixels',
  getWidth: 14,
  widthMinPixels: 14,
  billboard: true,
  jointRounded: true,
  capRounded: true,
  pickable: true,
});

/** What a pick returned, flattened to something structured-cloneable. */
const summarise = (info) => (info?.layer
  ? {
    layerId: info.layer.id,
    index: info.index,
    objectId: info.object?.id ?? null,
    objectName: info.object?.name ?? null,
    coordinate: info.coordinate ?? null,
    pixel: [info.x, info.y],
  }
  : null);

/**
 * What real pointer input resolved to, by route.
 *
 * `deckClick`/`deckHover` come from deck's own onClick/onHover props;
 * `mapClick`/`mapHover` come from an explicit MapLibre event -> pickObject()
 * bridge. Both are recorded because the two integration modes do not agree:
 * MapboxOverlay only subscribes to MapLibre's pointer events in OVERLAID mode
 * (see _onAddOverlaid), so in interleaved mode deck's own handlers never fire
 * for a genuine click and the bridge is the only route that works.
 */
const events = { deckClick: null, deckHover: null, mapClick: null, mapHover: null };

const overlay = new MapboxOverlay({
  interleaved,
  layers: [pathLayer],
  // Deck's own handlers, driven by genuine browser events rather than by a
  // pickObject() call the spec makes itself — the two modes wire pointer input
  // up completely differently (overlaid forwards MapLibre's synthetic events,
  // interleaved attaches deck's event manager straight to the shared canvas),
  // so only a real click exercises what production would actually rely on.
  onClick: (info) => { events.deckClick = summarise(info); },
  onHover: (info) => { events.deckHover = summarise(info); },
});

// The bridge production will need. `pickObject` works in both modes; what does
// not work in both is deck ever being told that a click happened.
// Registered once the overlay exists — pickObject asserts on its Deck instance.
const bridge = (key) => (e) => {
  events[key] = summarise(overlay.pickObject({ x: e.point.x, y: e.point.y, radius: 4 }));
};

/** Resolves once the terrain, the style and deck have all settled. */
const ready = new Promise((resolve, reject) => {
  map.on('error', (e) => {
    // A 404 on a tile outside `bounds` would be a fixture bug, so it is fatal
    // rather than logged: the spike must not pass over missing terrain.
    errors.push(String(e.error?.message ?? e.error ?? e));
  });

  map.once('load', () => {
    map.setTerrain({ source: 'dem', exaggeration });

    // ORDER IS LOAD-BEARING. MapboxOverlay snapshots getViewState(map) when the
    // Deck instance is constructed (i.e. inside addControl) and thereafter only
    // refreshes it from the map's 'move' event. With terrain enabled that view
    // state carries `position: [0, 0, map.transform.elevation]` — the ground
    // height under the camera target — and `transform.elevation` is 0 until
    // MapLibre has actually sampled a DEM tile there. Add the overlay too early
    // over non-zero terrain and deck's own view state stays pinned at elevation
    // 0 until the user first pans, which silently breaks everything that reads
    // it: getViewports(), project(), and pickObject(). The picture stays right,
    // because the interleaved draw path rebuilds its viewport from the live
    // transform every frame — so the bug is invisible until someone clicks.
    map.once('idle', () => {
      map.addControl(overlay);
      map.on('click', bridge('mapClick'));
      map.on('mousemove', bridge('mapHover'));
      // Belt and braces: a 'move' is what MapboxOverlay listens for, and firing
      // one costs nothing even when the elevation was already right.
      map.jumpTo({ center: map.getCenter() });

      // Two frames after: deck's interleaved custom layer draws inside the map's
      // render pass, so "the map is idle" is one frame ahead of "deck has drawn
      // into the frame currently on screen".
      map.triggerRepaint();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.getElementById('status').dataset.ready = '1';
        resolve();
      }));
    });
  });

  setTimeout(() => reject(new Error('spike: map never became ready')), 30_000);
});

/**
 * The viewport deck is drawing with.
 *
 * `_deck` is private-by-convention on MapboxOverlay; there is no public
 * accessor for the viewport, and the whole point of this page is to compare
 * "where deck says a 3D point lands" against "where magenta actually is". If
 * this reaches production, the adapter should keep its own WebMercatorViewport
 * rather than depend on the private field.
 */
function viewport() {
  const vp = overlay._deck?.getViewports?.()[0];
  if (!vp) throw new Error('spike: no deck viewport');
  return vp;
}

window.spike = {
  ready,
  errors,
  map,
  overlay,

  info: () => ({
    scene: sceneName,
    surface: scene.surface,
    mode: interleaved ? 'interleaved' : 'overlaid',
    exaggeration,
    pathAltM: altM,
    center: map.getCenter().toArray(),
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
    canvas: { width: map.getCanvas().clientWidth, height: map.getCanvas().clientHeight },
    devicePixelRatio,
    // Proves the DEM decoded: the spec checks these against the fixture
    // functions before it trusts a single pixel.
    terrainSource: demTiles,
  }),

  /** Screen position of an MSL point, exactly as deck.gl projects it. */
  project: (lng, lat, mslM) => viewport().project([lng, lat, mslM]),

  /** MapLibre's own reading of the terrain surface under a coordinate. */
  terrainAt: (lng, lat) => map.queryTerrainElevation([lng, lat]),

  /** deck.gl picking at a screen position, driven programmatically. */
  pick: (x, y, radius = 0) => summarise(overlay.pickObject({ x, y, radius })),

  /** What deck resolved from the last genuine click / pointer move. */
  events: () => ({ ...events }),
  resetEvents: () => {
    for (const key of Object.keys(events)) events[key] = null;
  },
};
