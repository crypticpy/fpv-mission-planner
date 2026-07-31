// subject-layer.js — what the flight is filming, as pins that can be moved.
//
// A subject is the one thing on this map that is neither where the aircraft goes
// nor where it launches from: it is the thing the camera is pointed at, and the
// shot the analysis publishes (`segment.shot` — distances, framing fraction,
// screen direction) is entirely about the geometry between a leg and one of
// these. That record carries the subject's *id* and *name*, never its position,
// because a distance is not a place. So the roster arrives on the frame beside
// the waypoints, from the same document, by the same route (ADR 0002).
//
// The gestures are the route pins' gestures, deliberately: drag to move, click to
// remove. A pilot who has learned one has learned the other, and both end in a
// command — `moveSubject` and `removeSubject` — rather than an edit here.
// Removing is safe to offer without a confirmation because the reducer un-points
// every segment that framed the subject in the same reduction; there is no window
// in which the document holds a dangling reference for this layer to tidy up.
//
// The pin the open segment is framing is drawn in the accent, which is the same
// visual sentence the route layer writes with its halo: the selected leg and the
// subject it is about light up together, so a shot reads as one object across two
// kinds of geometry.

/**
 * @typedef {import('../map-adapter.js').LatLng} LatLng
 * @typedef {import('../map-adapter.js').MapAdapter} MapAdapter
 * @typedef {import('../map-adapter.js').MapFrame} MapFrame
 * @typedef {import('../map-adapter.js').MapLayer} MapLayer
 * @typedef {import('../map-adapter.js').MarkerOverlay} MarkerOverlay
 * @typedef {import('../map-adapter.js').SceneSubject} SceneSubject
 */

/**
 * The pin's own appearance, inline rather than in a class.
 *
 * Every other marker on this map is styled by app.css and this one would rather
 * be too; it is written here because the stylesheet is not this change's to edit,
 * and a pin with no rule behind it is an invisible pin. A rounded square instead
 * of a circle so a subject is never mistaken for a waypoint, a launch point or a
 * saved spot at a glance — the three round pins already on the same imagery.
 */
const DOT = 'width:14px;height:14px;border-radius:3px;'
  + 'border:2px solid var(--marker-border);box-shadow:0 1px 4px var(--shadow);cursor:pointer;';

/** @param {boolean} framed */
const dotStyle = (framed) => DOT + (framed
  ? 'background:var(--accent);'
  : 'background:var(--ink-2);opacity:0.85;');

/**
 * Which subject the open segment is pointed at, off the analysis rather than off
 * the document — the shot record is what decided the segment *has* a subject, and
 * a segment whose `subjectRef` names a subject the analysis could not resolve has
 * no shot and lights nothing up.
 * @param {MapFrame} frame
 * @returns {string|null}
 */
function framedSubjectId(frame) {
  const id = frame.selectedSegmentId;
  if (!id) return null;
  return frame.snapshot?.segments?.[id]?.shot?.subjectId ?? null;
}

/** @returns {MapLayer} */
export function createSubjectLayer() {
  /** @type {MarkerOverlay[]} */
  let pins = [];
  /** @type {string|null} */
  let drawnSignature = null;
  /* The newest frame, for the same reason launch-layer.js keeps one: a drag three
   * passes later raises the callbacks of the pass it happened in. */
  /** @type {MapFrame|null} */
  let current = null;

  const clear = () => {
    for (const p of pins) p.remove();
    pins = [];
  };

  return {
    id: 'subjects',

    render(frame, adapter) {
      current = frame;
      const subjects = frame.subjects ?? [];
      const framed = framedSubjectId(frame);
      /* Rebuilt only when the roster or the highlight actually moves — the same
       * economy spots-layer.js makes, and for the same reason: a slider drag runs
       * this pass and tearing down every pin to put it back where it was is work
       * the map can see. */
      const signature = `${framed ?? ''}#${subjects.map(key).join('|')}`;
      if (signature === drawnSignature) return;
      drawnSignature = signature;

      clear();
      pins = subjects.map((s) => adapter.marker({
        at: { lat: s.lat, lng: s.lng },
        className: 'subject-marker',
        html: `<div style="${dotStyle(s.id === framed)}"></div>`,
        sizePx: [18, 18],
        anchorPx: [9, 9],
        title: `${s.name} — drag to move, click to remove`,
        draggable: true,
        zIndexOffset: -100, // under the route pins, over the saved spots
        onDragEnd: (to) => {
          /* Twice over, for two different clicks: the one the engine fires on the
           * map behind the pin, which in route mode would drop a waypoint, and
           * the one it fires on the pin, which would delete what was just moved. */
          current?.gestures.dragEnded();
          current?.actions.moveSubject(s.id, to);
        },
        onClick: () => {
          const f = current;
          if (!f || f.gestures.afterDrag()) return;
          f.gestures.markerClicked();
          f.actions.removeSubject(s.id);
        },
      }));
    },

    dispose() {
      clear();
      drawnSignature = null;
      current = null;
    },
  };
}

/**
 * What a redraw is worth doing for. Position and name only: the elevation and the
 * radius change what the *shot* is and the 3D scene draws, and change nothing
 * about a flat pin.
 * @param {SceneSubject} s
 */
function key(s) {
  return `${s.id}@${s.lat},${s.lng}:${s.name}`;
}
