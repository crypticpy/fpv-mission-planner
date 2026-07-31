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
 * @typedef {import('./map-adapter.js').ShapeOverlay} ShapeOverlay
 * @typedef {import('./map-adapter.js').ShapeStyle} ShapeStyle
 */

/**
 * Esri World Imagery. `maxNativeZoom` is where the imagery actually stops;
 * `maxZoom` lets the pilot keep zooming past it on upscaled tiles, which is what
 * makes a launch point placeable on a driveway.
 */
const SATELLITE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const SATELLITE_ATTRIBUTION =
  'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community';

const STREETS_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const STREETS_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

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
    attribution: SATELLITE_ATTRIBUTION, maxNativeZoom: 19, maxZoom: 21,
  });
  const streets = L.tileLayer(STREETS_URL, {
    attribution: STREETS_ATTRIBUTION, maxNativeZoom: 19, maxZoom: 21,
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

    center: (at) => { map.setView(ll(at)); },

    fit: (bounds, { paddingPx = 0 } = {}) => {
      map.fitBounds(L.latLngBounds(ll(bounds.southWest), ll(bounds.northEast)),
        { padding: [paddingPx, paddingPx] });
    },

    resized: () => { map.invalidateSize({ pan: false }); },

    polygon: (points, style) => shape(L.polygon(points.map(ll), leafletStyle(style)).addTo(map)),

    polyline: (points, style) => shape(L.polyline(points.map(ll), leafletStyle(style)).addTo(map)),

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
 * at the map, not at the ring on it — so nothing drawn here takes the pointer.
 * @param {ShapeStyle} style
 */
function leafletStyle(style) {
  return { interactive: false, ...style };
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
