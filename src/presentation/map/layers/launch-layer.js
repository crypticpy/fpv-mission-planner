// launch-layer.js — the pin the whole plan is measured from.
//
// One marker, dragged. The layer does not decide what a move means: it reports
// where the pin ended up, and `frame.actions.moveLaunch` — which is a command on
// the mission document by the time it lands (ADR 0002) — decides the rest. That
// is the whole of this layer's contract with the app, and it is why the launch
// point can now be moved from the weather rail, the spot roster or a restored
// mission without any of them knowing this file exists.

/**
 * @typedef {import('../map-adapter.js').MapAdapter} MapAdapter
 * @typedef {import('../map-adapter.js').MapFrame} MapFrame
 * @typedef {import('../map-adapter.js').MapLayer} MapLayer
 * @typedef {import('../map-adapter.js').MarkerOverlay} MarkerOverlay
 */

/** @returns {MapLayer} */
export function createLaunchLayer() {
  /** @type {MarkerOverlay|null} */
  let pin = null;
  /* The handler is wired once, at creation, but must act on the newest frame —
   * a drag three renders later still raises the callbacks of the pass it
   * happened in, not the pass the marker was built in. */
  /** @type {MapFrame|null} */
  let current = null;

  return {
    id: 'launch',

    render(frame, adapter) {
      current = frame;
      if (!pin) {
        pin = adapter.marker({
          at: frame.launch,
          className: 'launch-marker',
          html: '<div class="launch-dot"></div>',
          sizePx: [18, 18],
          anchorPx: [9, 9],
          title: 'Launch point',
          draggable: true,
          onDragEnd: (at) => {
            /* Leaflet fires a map click straight after a drag. Unguarded, in
             * route mode that click drops a waypoint on the pin just moved. */
            current?.gestures.dragEnded();
            current?.actions.moveLaunch(at);
          },
        });
        return;
      }
      /* Follows whatever the frame says, which is how the pin tracks a launch
       * point moved by something that is not this map — the weather rail, the
       * spot roster, or a mission opened from the roster. It is also what snaps
       * a drag past the antimeridian back onto the wrapped longitude. */
      pin.moveTo(frame.launch);
    },

    dispose() {
      pin?.remove();
      pin = null;
      current = null;
    },
  };
}
