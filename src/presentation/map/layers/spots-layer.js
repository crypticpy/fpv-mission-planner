// spots-layer.js — the saved-spot roster, as small secondary pins.
//
// Everything about a spot except where it is belongs to src/render/spots.js.
// This draws the dots and reports the click; `frame.actions.selectSpot` decides
// that clicking one means flying from it.
//
// The pins are rebuilt only when the roster actually moves. Spots are a stable
// list that a render pass touches on every slider drag, and tearing down a dozen
// markers sixty times a second to put them back where they were is work the map
// can see.

/**
 * @typedef {import('../map-adapter.js').MapAdapter} MapAdapter
 * @typedef {import('../map-adapter.js').MapFrame} MapFrame
 * @typedef {import('../map-adapter.js').MapLayer} MapLayer
 * @typedef {import('../map-adapter.js').MarkerOverlay} MarkerOverlay
 * @typedef {import('../map-adapter.js').SavedSpot} SavedSpot
 */

/** @returns {MapLayer} */
export function createSpotsLayer() {
  /** @type {MarkerOverlay[]} */
  let pins = [];
  /** @type {string|null} */
  let drawnSignature = null;
  /** @type {MapFrame|null} */
  let current = null;

  return {
    id: 'spots',

    render(frame, adapter) {
      current = frame;
      const spots = frame.spots;
      const signature = spots.map((s) => `${s.id}@${s.lat},${s.lng}`).join('|');
      if (signature === drawnSignature) return;
      drawnSignature = signature;

      for (const p of pins) p.remove();
      pins = spots.map((spot) => adapter.marker({
        at: { lat: spot.lat, lng: spot.lng },
        // A 12 px dot inside a 2 px border, and the engine's containers are
        // content-box: the anchor has to be half the rendered box or the dot
        // sits off the point it names.
        className: 'spot-marker',
        html: '<div class="spot-dot"></div>',
        sizePx: [16, 16],
        anchorPx: [8, 8],
        title: `${spot.name} — fly here`,
        zIndexOffset: -200, // never over the launch pin
        onClick: () => {
          /* The engine can still surface a map click behind a marker hit, which
           * would re-drop the launch pin a pixel off the spot just chosen. */
          current?.gestures.markerClicked();
          current?.actions.selectSpot(spot);
        },
      }));
    },

    dispose() {
      for (const p of pins) p.remove();
      pins = [];
      drawnSignature = null;
      current = null;
    },
  };
}
