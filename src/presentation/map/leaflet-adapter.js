// leaflet-adapter.js — the 2D engine, and the only place in src/ that knows it.
//
// ADR 0004 keeps Leaflet as the 2D adapter: it works, it is vendored, and 2D
// stays the fallback for non-WebGL2 environments and reduced-motion users. What
// changed is that it now lives behind map-adapter.js's contract, so nothing
// above this file imports the vendor bundle. `npm run arch` checks that claim.
//
// Everything Leaflet-shaped that used to be spread across the map view is
// collected here: the two base tile layers, the layer switcher, the scale bar,
// and the tile-error latch. A caller picks a base layer by name and reads it
// back by name; it never holds a tile layer object.

import * as L from '../../../vendor/leaflet/leaflet-src.esm.js';

import {
  SATELLITE_ATTRIBUTION,
  SATELLITE_MAX_NATIVE_ZOOM,
  SATELLITE_URL,
  STREETS_ATTRIBUTION,
  STREETS_URL,
} from './tile-sources.js';

/**
 * @typedef {import('./map-adapter.js').BaseLayerId} BaseLayerId
 * @typedef {import('./map-adapter.js').ControlOverlay} ControlOverlay
 * @typedef {import('./map-adapter.js').ControlSpec} ControlSpec
 * @typedef {import('./map-adapter.js').LatLng} LatLng
 * @typedef {import('./map-adapter.js').LatLngBounds} LatLngBounds
 * @typedef {import('./map-adapter.js').MapAdapter} MapAdapter
 * @typedef {import('./map-adapter.js').MapEventName} MapEventName
 * @typedef {import('./map-adapter.js').MapViewState} MapViewState
 * @typedef {import('./map-adapter.js').MarkerOverlay} MarkerOverlay
 * @typedef {import('./map-adapter.js').MarkerSpec} MarkerSpec
 * @typedef {import('./map-adapter.js').ShapeHandlers} ShapeHandlers
 * @typedef {import('./map-adapter.js').ShapeOverlay} ShapeOverlay
 * @typedef {import('./map-adapter.js').ShapeStyle} ShapeStyle
 */

/** @param {LatLng} p @returns {[number, number]} */
const ll = (p) => [p.lat, p.lng];

/**
 * Build the 2D map.
 *
 * @param {object} opts
 * @param {string} opts.containerId  id of the element to draw into
 * @param {LatLng} opts.center
 * @param {number} opts.zoom
 * @param {BaseLayerId} opts.baseLayer
 * @returns {MapAdapter}
 */
export function createLeafletAdapter({ containerId, center, zoom, baseLayer }) {
  const satellite = L.tileLayer(SATELLITE_URL, {
    attribution: SATELLITE_ATTRIBUTION, maxNativeZoom: SATELLITE_MAX_NATIVE_ZOOM, maxZoom: 21,
  });
  const streets = L.tileLayer(STREETS_URL, {
    attribution: STREETS_ATTRIBUTION, maxNativeZoom: SATELLITE_MAX_NATIVE_ZOOM, maxZoom: 21,
  });

  const map = L.map(containerId, {
    center: ll(center),
    zoom,
    layers: [baseLayer === 'streets' ? streets : satellite],
  });
  L.control.layers({ Satellite: satellite, Streets: streets }).addTo(map);
  L.control.scale().addTo(map);

  /* One `viewchange` out of Leaflet's three: every listener the app has ever had
   * wanted all three, and a caller that has to remember the list is a caller
   * that will eventually forget one. */
  /** @param {() => void} handler */
  const onViewChange = (handler) => { map.on('moveend zoomend baselayerchange', handler); };

  return {
    container: () => map.getContainer(),

    view: () => ({
      center: toLatLng(map.getCenter()),
      zoom: map.getZoom(),
      baseLayer: map.hasLayer(streets) ? 'streets' : 'satellite',
    }),

    // `zoom` undefined keeps the current one, which is what every caller before
    // the 3D toggle wanted. The toggle is the one that has to state both, so a
    // round trip through the other engine lands where it left.
    center: (at, zoom) => { map.setView(ll(at), zoom); },

    fit: (bounds, { paddingPx = 0 } = {}) => {
      map.fitBounds(L.latLngBounds(ll(bounds.southWest), ll(bounds.northEast)),
        { padding: [paddingPx, paddingPx] });
    },

    resized: () => { map.invalidateSize({ pan: false }); },

    polygon: (points, style) => shape(L.polygon(points.map(ll), leafletStyle(style)).addTo(map)),

    polyline: (points, style, handlers) => {
      const onClick = handlers?.onClick;
      const line = L.polyline(points.map(ll), leafletStyle(style, Boolean(onClick))).addTo(map);
      if (onClick) line.on('click', () => onClick());
      return shape(line);
    },

    marker: (spec) => {
      const icon = L.divIcon({
        className: spec.className, html: spec.html,
        iconSize: spec.sizePx, iconAnchor: spec.anchorPx,
      });
      const m = L.marker(ll(spec.at), {
        icon,
        ...(spec.draggable ? { draggable: true } : null),
        ...(spec.title ? { title: spec.title } : null),
        ...(spec.zIndexOffset != null ? { zIndexOffset: spec.zIndexOffset } : null),
      }).addTo(map);
      if (spec.onDragEnd) {
        const onDragEnd = spec.onDragEnd;
        m.on('dragend', () => onDragEnd(toLatLng(m.getLatLng())));
      }
      if (spec.onClick) {
        const onClick = spec.onClick;
        m.on('click', () => onClick());
      }
      return {
        moveTo: (at) => { m.setLatLng(ll(at)); },
        remove: () => { m.remove(); },
      };
    },

    control: (spec) => control(map, spec),

    on: (event, handler) => {
      if (event === 'click') {
        map.on('click', (e) => handler(toLatLng(e.latlng)));
        return;
      }
      if (event === 'viewchange') {
        onViewChange(() => handler(null));
        return;
      }
      // Per tile, and there are a lot of tiles: listeners latch.
      satellite.on('tileerror', () => handler(null));
      streets.on('tileerror', () => handler(null));
    },

    destroy: () => { map.remove(); },
  };
}

/**
 * Every overlay this app draws is decoration over the physics — the pilot points
 * at the map, not at the ring on it — so nothing drawn here takes the pointer
 * unless the caller asked it to by handing over a handler.
 *
 * The one that does asks for `bubblingMouseEvents: false` as well. Leaflet
 * registers the map as an event target for its own container and walks up the
 * DOM from whatever was hit, so by default a click on a shape fires on the map
 * too — which in route mode would drop a waypoint on the very leg just selected.
 * @param {ShapeStyle} style
 * @param {boolean} interactive
 */
function leafletStyle(style, interactive = false) {
  return interactive
    ? { interactive: true, bubblingMouseEvents: false, ...style }
    : { interactive: false, ...style };
}

/**
 * @param {import('../../../vendor/leaflet/leaflet-src.esm.js').Polyline} layer
 * @returns {ShapeOverlay}
 */
function shape(layer) {
  return {
    bounds: () => {
      const b = layer.getBounds();
      return b.isValid()
        ? { southWest: toLatLng(b.getSouthWest()), northEast: toLatLng(b.getNorthEast()) }
        : null;
    },
    remove: () => { layer.remove(); },
  };
}

/**
 * A docked control. Leaflet wants a class, so this builds a throwaway one per
 * control — there are two on this map and they are created once each.
 * @param {import('../../../vendor/leaflet/leaflet-src.esm.js').Map} map
 * @param {ControlSpec} spec
 * @returns {ControlOverlay}
 */
function control(map, spec) {
  const Ctl = L.Control.extend({
    options: { position: leafletPosition(spec.position) },
    onAdd() {
      const div = L.DomUtil.create('div', spec.className);
      div.innerHTML = spec.html;
      // Without this a click on the control zooms the map underneath it.
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  const ctl = new Ctl();
  ctl.addTo(map);
  return {
    element: () => ctl.getContainer() ?? null,
    remove: () => { ctl.remove(); },
  };
}

/** @param {ControlSpec['position']} position */
function leafletPosition(position) {
  return { topright: 'topright', topleft: 'topleft', bottomright: 'bottomright', bottomleft: 'bottomleft' }[position];
}

/** @param {{ lat: number, lng: number }} p @returns {LatLng} */
function toLatLng(p) {
  return { lat: p.lat, lng: p.lng };
}
