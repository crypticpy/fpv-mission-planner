// scene.js — the 3D mission scene: MapLibre terrain with deck.gl drawn inside it.
//
// This module is the whole of the app's dependency on WebGL. It is reached only
// through `import('./scene3d/scene.js')` from map-view.js, which is what keeps
// ~442 kB gzip of map engine out of the shell that has to open at a trailhead on
// one bar (ADR 0004). Nothing above it imports maplibre or deck, and `npm run
// arch` checks that the bare specifiers below appear nowhere else in src/.
//
// It is a *host*, not an adapter. The 2D contract in map-adapter.js describes
// polygons, polylines and DOM markers, which is exactly the wrong shape for a
// library whose whole model is "hand me every layer again each pass". Contorting
// one to fit the other would cost both. What the two engines genuinely share is
// the frame — the same object the 2D registry consumes, built once per pass by
// map-view.js — so that is what this file consumes too, and the split stays at
// the seam where the two engines actually differ.
//
// ADR 0004 lists five integration constraints whose violation fails silently.
// Four of them are load-bearing here and each is marked at its line:
//
//   1. the overlay is added only after `map.once('idle')` *following* setTerrain;
//   2. interleaved mode wires no pointer handlers, so every pick is an explicit
//      `map.on('click')` → `overlay.pickObject()` bridge;
//   3. `info.coordinate` is a ground-plane unprojection and is never read — the
//      position of a picked thing comes from the object, the position of a
//      gesture comes from MapLibre's terrain-aware `lngLat`;
//   4. `maxPitch` is set explicitly, because the default 60 is below every
//      camera that makes terrain worth drawing.
//
// The fifth (billboarded ribbons span real world height) is a drawing concern and
// lives in scene-layers.js.

import { MapboxOverlay } from '@deck.gl/mapbox';
import maplibregl from 'maplibre-gl';

import 'maplibre-gl/dist/maplibre-gl.css';

import {
  SATELLITE_ATTRIBUTION,
  SATELLITE_MAX_NATIVE_ZOOM,
  SATELLITE_URL,
  TERRAIN_DEM_ATTRIBUTION,
  TERRAIN_DEM_MAX_ZOOM,
  TERRAIN_DEM_TILE_SIZE,
  TERRAIN_DEM_URL,
} from '../tile-sources.js';
import { boundsOf, toFlatZoom, toSceneZoom } from './scene-geometry.js';
import { buildSceneLayers, readPalette } from './scene-layers.js';

/**
 * @typedef {import('../map-adapter.js').LatLng} LatLng
 * @typedef {import('../map-adapter.js').LatLngBounds} LatLngBounds
 * @typedef {import('../map-adapter.js').MapFrame} MapFrame
 */

/** How far a pick reaches, in pixels. Wide enough for a thumb on a 10 px dot. */
const PICK_RADIUS = 6;

/**
 * How far a pointer must travel before a press on a pin counts as a drag.
 *
 * Without it every press is a drag: a stationary click on a waypoint would
 * commit a move to wherever the cursor sat inside the pick radius and then
 * suppress its own click, so the pin could never be clicked at all. Leaflet
 * draws the same line at the same distance (`Draggable`'s `clickTolerance`),
 * which is what keeps a click on a pin meaning the same thing in both engines.
 */
const DRAG_THRESHOLD_PX = 3;

/** The terrain slider's ends. 1 is the truth; 2.5 is where a 40 m rise reads. */
const EXAGGERATION_MIN = 1;
const EXAGGERATION_MAX = 2.5;
const EXAGGERATION_DEFAULT = 1;

/** Give up rather than hang: the same budget the spike's readiness gate used. */
const READY_TIMEOUT_MS = 30_000;

/**
 * The 3D scene, live on the given container.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container   already visible and sized
 * @param {LatLng} opts.center
 * @param {number} opts.zoom             in the 2D engine's numbering; converted here
 * @param {boolean} opts.reducedMotion
 * @param {(at: LatLng) => void} opts.onGroundClick  a click on the terrain, not on a pin
 * @param {() => void} opts.onViewChange
 * @param {() => void} [opts.onTileError]
 * @returns {SceneHandle}
 */
export function createScene(opts) {
  const { container, center, zoom, reducedMotion } = opts;

  let exaggeration = EXAGGERATION_DEFAULT;
  /** @type {MapFrame|null} */
  let current = null;
  /** What a pointer is currently dragging, so the pin can follow it live. */
  /** @type {{ kind: 'launch'|'waypoint', id: string|null, from: [number, number],
   *           moved: boolean, lngLat: [number, number] }|null} */
  let drag = null;
  let destroyed = false;
  /** Coalesces the re-render that new DEM tiles ask for. */
  let demTimer = 0;

  const map = new maplibregl.Map({
    container,
    style: buildStyle(),
    center: [center.lng, center.lat],
    zoom: toSceneZoom(zoom),
    // (4) The default is 60. Every camera that makes a ridge legible is past it.
    maxPitch: 85,
    // Off, then re-added compact: the credits for imagery and for the DEM are
    // two different organisations and both have to be on screen, which is the
    // same mechanism the 2D engine uses for Esri and OSM rather than a new one.
    attributionControl: false,
    fadeDuration: 0,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
  /* Top-left, stacked under the navigation control: top-right belongs to the
   * MapToolbar (M10), which rides over both engines from outside this
   * container, and the bottom edge belongs to the attribution — expanded, its
   * credit strip grows leftward across the whole corner and would sit on top
   * of anything placed there. */
  map.addControl(sceneControls(), 'top-left');

  const overlay = new MapboxOverlay({ interleaved: true, layers: [] });

  map.on('error', (e) => {
    /* Tile failures are routine on a bad connection and the app already has a
     * line for them; anything else would be a bug, and swallowing it silently is
     * how a blank 3D view becomes unexplainable. */
    const status = /** @type {{ status?: number }} */ (e?.error ?? {}).status;
    if (status != null) opts.onTileError?.();
    else console.error('[scene3d]', e?.error ?? e);
  });

  /** Resolves once terrain, style and deck have all settled. */
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('3D scene never became ready')), READY_TIMEOUT_MS);

    map.once('load', () => {
      map.setTerrain({ source: 'dem', exaggeration });

      /* (1) ORDER IS LOAD-BEARING, and the failure is invisible. MapboxOverlay
       * snapshots the map's view state when its Deck instance is constructed —
       * inside addControl — and that snapshot carries the ground elevation under
       * the camera target, which is 0 until MapLibre has actually sampled a DEM
       * tile there. Add the overlay before the terrain has settled and deck's
       * `project()` and `pickObject()` stay wrong until the first pan, while the
       * picture looks perfect. Every click would land somewhere else. */
      map.once('idle', () => {
        if (destroyed) return;
        map.addControl(overlay);
        bindPointer();
        // What MapboxOverlay listens for; free even when the elevation was right.
        map.jumpTo({ center: map.getCenter() });
        renderLayers();
        map.triggerRepaint();
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  });

  map.on('moveend', () => opts.onViewChange());
  map.on('zoomend', () => opts.onViewChange());

  /* New DEM tiles change the answer for every ground-draped vertex — the rings,
   * the launch pad, any leg whose altitude never resolved. Re-render off the
   * source's own event rather than off 'idle': deck's interleaved draw asks the
   * map to repaint, so an idle-driven re-render would chase its own tail. */
  map.on('sourcedata', (e) => {
    if (e.sourceId !== 'dem' || !e.isSourceLoaded) return;
    clearTimeout(demTimer);
    demTimer = window.setTimeout(() => { if (!destroyed) renderLayers(); }, 150);
  });

  /* ---------- drawing ---------- */

  /**
   * MapLibre's reading of the surface, already multiplied by the exaggeration
   * (Terrain.getElevation is `getDEMElevation(...) * exaggeration`), which is why
   * altitudes in scene-layers are multiplied too. Null while the tile under a
   * point is still loading; the geometry treats that as "not known yet" rather
   * than as sea level.
   * @param {number} lng @param {number} lat @returns {number|null}
   */
  const groundZAt = (lng, lat) => {
    const z = map.queryTerrainElevation([lng, lat]);
    return typeof z === 'number' && Number.isFinite(z) ? z : null;
  };

  function renderLayers() {
    if (!current || !map.getTerrain?.()) return;
    overlay.setProps({
      layers: buildSceneLayers(applyDrag(current), {
        palette: readPalette(document.documentElement),
        exaggeration,
        groundZAt,
      }),
    });
  }

  /**
   * The frame as it looks mid-gesture: the pin under the finger is where the
   * finger is, and everything derived from the analysis is still where the
   * analysis put it. Exactly what a Leaflet marker drag does in 2D — the line
   * catches up when the command lands.
   * @param {MapFrame} frame
   * @returns {MapFrame}
   */
  function applyDrag(frame) {
    // Before the threshold there is no position to show: the press may still
    // turn out to be a click, and `lngLat` is not read until it is a drag.
    if (!drag?.moved) return frame;
    if (drag.kind === 'launch') {
      return { ...frame, launch: { lat: drag.lngLat[1], lng: drag.lngLat[0] } };
    }
    return frame;
  }

  /* ---------- pointer ---------- */
  //
  // (2) Interleaved mode wires nothing: deck's own onClick never fires for a real
  // click, because in this mode deck is a custom layer inside MapLibre's render
  // pass rather than a canvas with its own event manager. Every gesture below is
  // an explicit bridge, and the spike exists because that is not discoverable
  // from the picture.

  function bindPointer() {
    map.on('click', (e) => {
      const frame = current;
      if (!frame) return;
      // The click a drag leaves behind is not a new gesture: without this it
      // would drop a waypoint on the pin just moved, or delete it.
      if (frame.gestures.afterDrag()) return;

      const hit = pick(e.point.x, e.point.y);
      if (hit?.kind === 'waypoint' && hit.id) {
        frame.gestures.markerClicked();
        frame.actions.removeWaypoint(hit.id);
        return;
      }
      if (hit?.kind === 'launch') return; // the pad is dragged, never clicked
      if (hit?.kind === 'leg' && hit.id) {
        // View state only: the same toggle the 2D layer raises, through the same
        // action, so the two engines cannot disagree about what is selected.
        frame.gestures.markerClicked();
        frame.actions.selectSegment(hit.id);
        return;
      }

      /* (3) `info.coordinate` would be a z=0 ground-plane unprojection — the
       * point the ray crosses sea level, not the point on the hill under the
       * cursor. MapLibre's own `lngLat` is unprojected against the terrain mesh
       * (`transform.screenPointToLocation(point, this.terrain)`), so a click on a
       * ridge names the ridge. */
      opts.onGroundClick({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });

    const canvas = map.getCanvasContainer();

    canvas.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || !current) return;
      const hit = pick(...localPoint(ev));
      // A leg is selectable, not draggable: only the two pins move anything.
      if (!hit || hit.kind === 'leg') return;
      drag = {
        kind: hit.kind, id: hit.id, from: localPoint(ev), moved: false, lngLat: [0, 0],
      };
      // Otherwise the map pans out from under the pin being dragged.
      map.dragPan.disable();
      map.dragRotate.disable();
      canvas.setPointerCapture(ev.pointerId);
      canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', (ev) => { if (drag) moveDrag(ev); });

    const end = (/** @type {PointerEvent} */ ev) => {
      const frame = current;
      if (!drag || !frame) return;
      const gesture = drag;
      drag = null;
      map.dragPan.enable();
      map.dragRotate.enable();
      canvas.style.cursor = '';
      if (canvas.hasPointerCapture?.(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);

      /* A press that never travelled is a click, and belongs to the click
       * handler above: nothing to commit, and no guard to raise — raising it
       * here is what used to swallow every click on a pin. */
      if (!gesture.moved) return;
      const [lng, lat] = gesture.lngLat;

      // Twice over, for two clicks: the one MapLibre may fire on the terrain
      // behind the pin, and the one it may fire having barely moved at all.
      frame.gestures.dragEnded();
      if (gesture.kind === 'launch') frame.actions.moveLaunch({ lat, lng });
      else if (gesture.id) frame.actions.moveWaypoint(gesture.id, { lat, lng });
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  /** @param {PointerEvent} ev */
  function moveDrag(ev) {
    if (!drag) return;
    const point = localPoint(ev);
    if (!drag.moved) {
      const dx = point[0] - drag.from[0];
      const dy = point[1] - drag.from[1];
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      drag.moved = true;
    }
    const at = map.unproject(point);
    drag.lngLat = [at.lng, at.lat];
    /* A waypoint's pin comes off the integrated route, not off the frame's
     * waypoint list, so only the launch pad can follow the finger before the
     * command lands. The rest catches up on the next pass, exactly as in 2D. */
    if (drag.kind === 'launch') renderLayers();
  }

  /** @param {PointerEvent} ev @returns {[number, number]} */
  function localPoint(ev) {
    const box = map.getCanvas().getBoundingClientRect();
    return [ev.clientX - box.left, ev.clientY - box.top];
  }

  /**
   * What is under a screen position, as something the gesture code can act on.
   *
   * A leg only counts when it carries a segment id. The hop home under a direct
   * return is drawn from the same array and picks like anything else, but it is
   * a line nobody authored — there is nothing to open, so it reads as terrain
   * and the click falls through to where it always went.
   * @param {number} x @param {number} y
   * @returns {{ kind: 'launch'|'waypoint'|'leg', id: string|null }|null}
   */
  function pick(x, y) {
    const info = overlay.pickObject({ x, y, radius: PICK_RADIUS });
    const object = /** @type {{ kind?: string, id?: string, segmentId?: string|null }|null} */
      (info?.object ?? null);
    if (object?.kind === 'launch') return { kind: 'launch', id: null };
    if (object?.kind === 'waypoint' && object.id) return { kind: 'waypoint', id: object.id };
    if (object?.kind === 'leg' && object.segmentId) return { kind: 'leg', id: object.segmentId };
    return null;
  }

  /* ---------- in-scene controls ---------- */

  /**
   * The two controls that only mean anything in 3D, built here rather than in
   * index.html: a page that never enters 3D should not carry them, and neither
   * should the 2D map.
   * @returns {maplibregl.IControl}
   */
  function sceneControls() {
    const el = document.createElement('div');
    el.className = 'maplibregl-ctrl maplibregl-ctrl-group scene3d-controls';
    el.innerHTML = `
      <label class="scene3d-slider" for="scene3d-exaggeration">
        <span>Terrain</span>
        <input id="scene3d-exaggeration" type="range"
               min="${EXAGGERATION_MIN}" max="${EXAGGERATION_MAX}" step="0.1"
               value="${EXAGGERATION_DEFAULT}"
               aria-label="Terrain exaggeration">
        <output id="scene3d-exaggeration-out">${EXAGGERATION_DEFAULT.toFixed(1)}&times;</output>
      </label>
      <button id="btn-scene3d-field" class="scene3d-btn" type="button">Field view</button>`;

    const slider = /** @type {HTMLInputElement} */ (el.querySelector('#scene3d-exaggeration'));
    const out = /** @type {HTMLOutputElement} */ (el.querySelector('#scene3d-exaggeration-out'));
    slider.addEventListener('input', () => {
      exaggeration = Number(slider.value);
      out.textContent = `${exaggeration.toFixed(1)}×`;
      map.setTerrain({ source: 'dem', exaggeration });
      // Every altitude in the scene is measured against the same multiplier the
      // mesh is, or the route sinks into the hills it was drawn above.
      renderLayers();
    });

    el.querySelector('#btn-scene3d-field')?.addEventListener('click', fieldView);

    return {
      onAdd: () => el,
      onRemove: () => { el.remove(); },
    };
  }

  /** Straight down, north up, framed on the mission — the view a pilot checks against. */
  function fieldView() {
    const frame = current;
    const points = [
      ...(frame ? [frame.launch] : []),
      ...(frame?.snapshot.route?.points ?? []),
    ];
    const bounds = boundsOf(points);
    if (bounds) {
      fit(bounds, { paddingPx: 48, pitch: 0, bearing: 0 });
      return;
    }
    move({ pitch: 0, bearing: 0 });
  }

  /**
   * @param {LatLngBounds} bounds
   * @param {{ paddingPx?: number, pitch?: number, bearing?: number }} [o]
   */
  function fit(bounds, { paddingPx = 0, pitch, bearing } = {}) {
    map.fitBounds(
      [[bounds.southWest.lng, bounds.southWest.lat], [bounds.northEast.lng, bounds.northEast.lat]],
      {
        padding: paddingPx,
        ...(pitch != null ? { pitch } : null),
        ...(bearing != null ? { bearing } : null),
        // A pilot who asked the OS for less motion asked this map too.
        animate: !reducedMotion,
        ...(reducedMotion ? { duration: 0 } : null),
      },
    );
  }

  /** @param {Record<string, unknown>} to */
  function move(to) {
    if (reducedMotion) map.jumpTo(to);
    else map.easeTo(to);
  }

  /* ---------- what the host holds ---------- */

  /**
   * @typedef {object} SceneHandle
   * @property {Promise<unknown>} ready
   * @property {(frame: MapFrame) => void} render
   * @property {() => { center: LatLng, zoom: number }} view  zoom in the 2D engine's numbering
   * @property {(at: LatLng, zoom?: number) => void} setView
   * @property {(bounds: LatLngBounds, o?: { paddingPx?: number }) => void} fit
   * @property {() => void} resized
   * @property {() => void} destroy
   */
  return {
    ready,

    render: (frame) => {
      current = frame;
      renderLayers();
    },

    view: () => {
      const c = map.getCenter();
      return { center: { lat: c.lat, lng: c.lng }, zoom: toFlatZoom(map.getZoom()) };
    },

    setView: (at, zoomLevel) => {
      map.jumpTo({
        center: [at.lng, at.lat],
        ...(zoomLevel != null ? { zoom: toSceneZoom(zoomLevel) } : null),
      });
    },

    fit: (bounds, o) => fit(bounds, o),

    resized: () => { map.resize(); },

    destroy: () => {
      destroyed = true;
      clearTimeout(demTimer);
      map.remove();
    },
  };
}

/**
 * Imagery over a DEM, and nothing else.
 *
 * Both sources carry their own `attribution`, which is what puts Esri and
 * Mapzen/AWS in the control at the corner — the same mechanism the 2D engine
 * uses for its tile layers, rather than a second place credits can be forgotten.
 * The elevation *profile* under the map is a different dataset with a different
 * licence and keeps its own line on the terrain card; this credit is for the
 * mesh and the pixels on it.
 */
function buildStyle() {
  const dem = {
    tiles: [TERRAIN_DEM_URL],
    tileSize: TERRAIN_DEM_TILE_SIZE,
    maxzoom: TERRAIN_DEM_MAX_ZOOM,
    attribution: TERRAIN_DEM_ATTRIBUTION,
  };
  return {
    version: 8,
    sources: {
      satellite: {
        type: 'raster',
        tiles: [SATELLITE_URL],
        tileSize: 256,
        maxzoom: SATELLITE_MAX_NATIVE_ZOOM,
        attribution: SATELLITE_ATTRIBUTION,
      },
      dem: { type: 'raster-dem', encoding: 'terrarium', ...dem },
    },
    layers: [
      // Painted in screen space, so it is the horizon rather than ground: what
      // is left when the terrain runs out under a pitched camera.
      { id: 'sky', type: 'background', paint: { 'background-color': '#0a1017' } },
      {
        id: 'imagery',
        type: 'raster',
        source: 'satellite',
        paint: { 'raster-fade-duration': 0 },
      },
    ],
  };
}
