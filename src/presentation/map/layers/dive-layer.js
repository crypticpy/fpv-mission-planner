// dive-layer.js — the mountain dive plan as gates and the corridors between them.
//
// A dive gate is authored geometry, like a subject and unlike everything the
// analysis publishes: no pass computes where the pilot decided to break off the
// run, so the roster arrives on the frame from the document by the same route the
// subjects take (ADR 0002). That is also why this layer draws whenever a dive
// plan exists rather than waiting on the workspace's own latch — the gates *are*
// the mission at that point, and a plan that vanished when a panel closed would
// be a plan the pilot cannot see they authored.
//
// Three legs, three colours, and the leg is named by the gate it *ends* at: the
// run out to the ridge ends at `approach`, the ridge-to-entry leg ends at `dive`,
// and the dive itself ends at `recovery`. Naming a leg by its end is what lets a
// single kind identify both the gate the pilot dragged and the leg the inspector
// opened, with no second id to keep in step.
//
// The abort gate is drawn and joined to nothing. It is where the run is broken
// off instead of flown, so a corridor leading to it would draw a flight path that
// is only ever taken by not taking this one.

/**
 * @typedef {import('../map-adapter.js').LatLng} LatLng
 * @typedef {import('../map-adapter.js').MapFrame} MapFrame
 * @typedef {import('../map-adapter.js').MapLayer} MapLayer
 * @typedef {import('../map-adapter.js').MarkerOverlay} MarkerOverlay
 * @typedef {import('../map-adapter.js').ShapeOverlay} ShapeOverlay
 * @typedef {import('../map-adapter.js').DiveGateView} DiveGateView
 */

/**
 * How one dive leg looks, in both engines' vocabularies.
 *
 * Carried here and imported by scene3d/scene-layers.js exactly the way
 * ADVISORY_CLASS_STYLE is: two pictures of one plan that disagreed about which
 * leg is the dive would be worse than either alone. The literal channels beside
 * each token are the 3D fallback, which is what recording them here is for.
 *
 * @typedef {object} DiveLegStyle
 * @property {string} cssVar
 * @property {number[]} rgb   the same colour as three literal channels
 * @property {string} label   the leg in the pilot's words, for a tooltip or a row
 */

export const DIVE_LEG_STYLE = Object.freeze(/** @type {Record<string, DiveLegStyle>} */ ({
  approach: Object.freeze({ cssVar: '--series-1', rgb: [73, 166, 255], label: 'Launch → approach' }),
  dive: Object.freeze({ cssVar: '--series-2', rgb: [255, 120, 79], label: 'Approach → dive' }),
  recovery: Object.freeze({ cssVar: '--status-good', rgb: [53, 208, 127], label: 'Dive → recovery' }),
  /* Not a leg, and it has a style because the gate still has to be drawn: the
     break-off point wears the critical colour it will wear in the contingency
     review, so the pilot learns one colour for "this is the way out". */
  abort: Object.freeze({ cssVar: '--status-critical', rgb: [240, 82, 82], label: 'Abort' }),
}));

/** Flight order, and the order the numbers on the dots run in. */
export const DIVE_LEG_ORDER = Object.freeze(['approach', 'dive', 'recovery', 'abort']);

/**
 * The chain the corridors are drawn along: the launch point, then every gate the
 * plan carries, in flight order. Each leg is returned under the kind of the gate
 * it ends at, which is the id the inspector and the strip both select by.
 *
 * The abort gate is deliberately not in the chain (see the header), and a plan
 * missing its middle gate still draws — `launch → dive` under the kind `dive` is
 * a true picture of a half-authored plan, and refusing to draw one would hide
 * the state the pilot is in the middle of leaving.
 *
 * `fromGate` is the gate the leg starts at, or null when it starts at the pad.
 * Carried rather than looked up by name downstream: with a middle gate missing,
 * "the gate before `recovery`" and "the gate this leg actually leaves from" are
 * two different answers, and only the chain knows the second one.
 *
 * @param {LatLng} launch
 * @param {DiveGateView[]} gates
 * @returns {{ kind: string, from: LatLng, to: LatLng,
 *   gate: DiveGateView, fromGate: DiveGateView|null }[]}
 */
export function diveLegChain(launch, gates) {
  const out = [];
  let from = launch;
  /** @type {DiveGateView|null} */
  let fromGate = null;
  for (const kind of ['approach', 'dive', 'recovery']) {
    const gate = gates.find((g) => g.kind === kind);
    if (!gate) continue;
    const to = { lat: gate.lat, lng: gate.lng };
    out.push({ kind, from, to, gate, fromGate });
    from = to;
    fromGate = gate;
  }
  return out;
}

/**
 * The gates a plan carries, in flight order and numbered from one.
 * @param {DiveGateView[]} gates
 * @returns {{ gate: DiveGateView, ordinal: number }[]}
 */
export function orderedGates(gates) {
  return DIVE_LEG_ORDER
    .map((kind) => gates.find((g) => g.kind === kind))
    .filter((g) => !!g)
    .map((gate, i) => ({ gate: /** @type {DiveGateView} */ (gate), ordinal: i + 1 }));
}

/** @returns {MapLayer} */
export function createDiveLayer() {
  /** @type {ShapeOverlay[]} */
  let corridors = [];
  /** @type {MarkerOverlay[]} */
  let pins = [];
  /** @type {string|null} */
  let drawnSignature = null;
  /* The newest frame, for the reason every gesture-bearing layer here keeps one:
     a click three passes later must raise the actions of the pass it happened in. */
  /** @type {MapFrame|null} */
  let current = null;

  const clear = () => {
    for (const c of corridors) c.remove();
    for (const p of pins) p.remove();
    corridors = [];
    pins = [];
  };

  return {
    id: 'dive',

    render(frame, adapter) {
      current = frame;
      const gates = frame.dive?.gates ?? [];
      const selected = frame.selectedDiveKind ?? null;
      /* Redrawn only when the plan or the selection actually moves — a slider
         drag runs this pass too, and rebuilding four pins to put them back where
         they were is work the map can see. */
      const signature = `${selected ?? ''}#${frame.launch.lat},${frame.launch.lng}`
        + `#${gates.map(gateKey).join('|')}`;
      if (signature === drawnSignature) return;
      drawnSignature = signature;

      clear();
      if (!gates.length) return;

      for (const leg of diveLegChain(frame.launch, gates)) {
        const style = DIVE_LEG_STYLE[leg.kind];
        const on = leg.kind === selected;
        corridors.push(adapter.polyline([leg.from, leg.to], {
          color: `var(${style.cssVar})`,
          weight: on ? 6 : 4,
          opacity: on ? 0.95 : 0.7,
          className: 'dive-corridor',
        }, {
          /* The corridor selects the same leg its end gate does: a pilot aiming
             at a thin dot on a phone can hit the line instead. */
          onClick: () => current?.actions.selectDiveGate(leg.kind),
        }));
      }

      pins = orderedGates(gates).map(({ gate, ordinal }) => {
        const style = DIVE_LEG_STYLE[gate.kind] ?? DIVE_LEG_STYLE.abort;
        const on = gate.kind === selected;
        return adapter.marker({
          at: { lat: gate.lat, lng: gate.lng },
          className: 'dive-gate-marker',
          html: `<div class="dive-gate-dot${on ? ' is-selected' : ''}" `
            + `style="--gate-color: var(${style.cssVar})">${ordinal}</div>`
            /* Labels alternate above and below the dot. Gates run in a line, so
               the collision that actually happens is a gate against its own
               neighbour — and alternating is the one placement rule that cannot
               produce it, at any zoom, without measuring anything. */
            + `<div class="dive-gate-alt${ordinal % 2 === 0 ? ' is-above' : ''}">`
            + `${Math.round(gate.altitudeMslM)} m</div>`,
          sizePx: [24, 24],
          anchorPx: [12, 12],
          title: `${gateTitle(gate.kind)} gate — ${Math.round(gate.altitudeMslM)} m MSL`
            + ' · drag to move, click to open',
          draggable: true,
          zIndexOffset: 200, // over the route pins: this is what the pilot is authoring
          onDragEnd: (to) => {
            /* Twice over, for two clicks: the one the engine fires on the map
               behind the pin, which in route mode would drop a waypoint, and the
               one it fires on the pin, which would open what was just moved. */
            current?.gestures.dragEnded();
            current?.actions.moveDiveGate(gate.kind, to);
          },
          onClick: () => {
            const f = current;
            if (!f || f.gestures.afterDrag()) return;
            f.gestures.markerClicked();
            f.actions.selectDiveGate(gate.kind);
          },
        });
      });
    },

    dispose() {
      clear();
      drawnSignature = null;
      current = null;
    },
  };
}

/** The gate in the pilot's words, for the pin's tooltip. */
function gateTitle(/** @type {string} */ kind) {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * What a redraw is worth doing for. The altitude is in because it is printed on
 * the pin; the corridor radius is not, because nothing flat draws it.
 * @param {DiveGateView} g
 */
function gateKey(g) {
  return `${g.kind}@${g.lat},${g.lng}:${g.altitudeMslM}`;
}
