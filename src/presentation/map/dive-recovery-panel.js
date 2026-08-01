// dive-recovery-panel.js — the dive's way out, authored (M16, 3D-08).
//
// Three questions a mountain dive has to answer and no other mission asks: how
// high the aircraft climbs when the link drops, where it puts down if it cannot
// come home, and which gate the pilot breaks the run off at. Every other part of
// the loop was already built — the reducer takes the three commands, the
// analysis checks the three answers, the scene draws two of them — and nothing
// raised one. Review's recovery card linked to a fix that could not be applied,
// which is the one thing the fix-linking engine refuses to do.
//
// The rules are the leg inspector's, next door:
//
//   *Nothing here is derived.* Every row is a number or a place the pilot
//     stated. An unstated one is drawn as unstated rather than as a default: a
//     lost-link altitude this panel chose would be the app telling a pilot their
//     aircraft has a plan it does not have.
//
//   *One number is one thought.* The leg inspector stages, because two gate
//     altitudes are the two ends of one dive and mean nothing apart. Nothing
//     here pairs with anything, so each row commits on change and there is no
//     Apply to press.
//
//   *A place is placed on the map.* The abort gate and the bailout are
//     positions, so the panel arms the map for one click rather than asking for
//     typed coordinates. The arming belongs to the host, exclusive with its
//     other placement modes; this panel only says which one it wants.
//
// Altitudes are typed in metres MSL, as they are in the leg inspector — the
// dive plan is authored in the frame it is stored in, and one panel converting
// while its neighbour does not is how two numbers that must agree stop agreeing.

import { f0 } from '../../render/format.js';

/**
 * @typedef {import('./map-adapter.js').DiveProjection} DiveProjection
 * @typedef {import('./segment-editor.js').Raise} Raise
 * @typedef {(lat: number, lng: number) => number|null} GroundAt
 * @typedef {'abort'|'bailout'} PlaceTarget
 */

const $ = (/** @type {string} */ id) => document.getElementById(id);

/** A refusal, or the sentence a placement left behind, across the panel's own passes. */
let pendingMessage = /** @type {string|null} */ (null);
/** What the panel last drew, so an unchanged pass leaves the controls alone. */
let drawnSignature = /** @type {string|null} */ (null);

/** Forget the message — the panel closed, or the pilot moved on. */
export function resetDiveRecovery() { pendingMessage = null; drawnSignature = null; }

/**
 * The altitude a freshly placed abort gate starts at: the highest gate the plan
 * already carries. Exported because the host places the gate — the map click
 * arrives there, not here — and one seed read from two places is one seed that
 * can disagree with itself.
 *
 * Not a guess: the break-off happens somewhere on the run, and the top of the
 * run is the only figure in the document that is certainly on it. The pilot
 * lowers it to where they mean; the panel says so in the row's note.
 *
 * @param {DiveProjection|null} dive
 * @returns {number|null} null when the plan has no gate to read, and the
 *   placement is refused rather than invented
 */
export function abortSeedAltitudeM(dive) {
  const flying = (dive?.gates ?? []).filter((g) => g.kind !== 'abort');
  if (!flying.length) return null;
  return Math.max(...flying.map((g) => g.altitudeMslM));
}

/**
 * @param {object} opts
 * @param {DiveProjection|null} opts.dive
 * @param {GroundAt} opts.groundAt
 * @param {boolean} opts.visible
 * @param {PlaceTarget|null} opts.placing  which placement the host has armed
 * @param {(what: PlaceTarget|null) => void} opts.onPlace
 * @param {() => void} opts.onClose
 * @param {Raise} [opts.raise]  absent until an editor port is registered, and
 *   then the panel reads without offering to write
 */
export function renderDiveRecovery({ dive, groundAt, visible, placing, onPlace, onClose, raise }) {
  const host = $('dive-recovery');
  if (!host) return;
  host.hidden = !visible || !dive;
  if (host.hidden) { host.replaceChildren(); drawnSignature = null; return; }
  const plan = /** @type {DiveProjection} */ (dive);

  /* Every pass rebuilds every panel, and a rebuilt input is a half-typed number
     thrown away — so a pass that would draw the same controls draws nothing.
     Same guard as the leg inspector, over the same kind of state: what is
     stored, what is armed, and whether there is an editor to write with. */
  const abortNow = plan.gates.find((g) => g.kind === 'abort') ?? null;
  const signature = JSON.stringify([
    plan.rthAltitudeMslM,
    abortNow && [abortNow.lat, abortNow.lng, abortNow.altitudeMslM, abortNow.radiusM],
    plan.bailout && [plan.bailout.name, plan.bailout.lat, plan.bailout.lng, plan.bailout.elevationMslM],
    abortSeedAltitudeM(plan), placing, !!raise,
  ]);
  if (signature === drawnSignature) return;
  drawnSignature = signature;

  const head = document.createElement('div');
  head.className = 'card-head';
  const title = document.createElement('h3');
  title.textContent = 'Recovery plan';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'map-btn';
  close.id = 'btn-recovery-close';
  close.textContent = 'Close';
  close.onclick = () => { resetDiveRecovery(); onClose(); };
  head.append(title, close);

  const body = document.createElement('dl');
  body.className = 'segment-facts dive-facts recovery-facts';
  /** @type {(label: string, nodes: (Node|string)[], note?: string) => void} */
  const add = (label, nodes, note) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.append(...nodes);
    if (note) {
      const n = document.createElement('span');
      n.className = 'segment-note';
      n.textContent = note;
      dd.appendChild(n);
    }
    body.append(dt, dd);
  };

  /** Raise one command and keep whatever it said about itself. */
  const send = (/** @type {{ type: string, payload: object }} */ command) => {
    say(raise ? raise(command).message : 'No mission is open yet — nothing to edit.');
  };

  /* ---- the climb, which is a number and nothing else ---- */
  const top = abortSeedAltitudeM(plan);
  const rthBox = number(plan.rthAltitudeMslM, { step: '10' }, (altitudeMslM) => {
    /* Empty is a real answer here — it clears the plane and puts the plan back
       to saying nothing, which is what a pilot who typed a figure they no longer
       stand behind is asking for. */
    send({ type: 'setDiveRthAltitude', payload: { altitudeMslM } });
  }, !raise);
  rthBox.id = 'recovery-rth';
  add('Lost-link climb', [rthBox], top == null
    ? 'metres MSL — where the aircraft goes when the link drops'
    : `metres MSL — the highest gate on this run is ${f0(top)} m`);

  /* ---- the gate the run is broken off at ---- */
  const abort = abortNow;
  if (abort) {
    const box = number(abort.altitudeMslM, { step: '10' }, (altitudeMslM) => {
      if (altitudeMslM == null) { say('The abort gate needs an altitude. Remove it instead.'); return; }
      /* Position and radius ride through untouched: this row edits height, and
         the map click is what edits where. */
      send({ type: 'setDiveGate', payload: {
        kind: 'abort', latitude: abort.lat, longitude: abort.lng, altitudeMslM, radiusM: abort.radiusM,
      } });
    }, !raise);
    box.dataset.gate = 'abort';
    box.classList.add('dive-alt-input');
    add('Break off at', [box, placeButton('abort', 'Move', placing, onPlace, !raise),
      removeButton('abort-remove', () => send({ type: 'removeDiveGate', payload: { kind: 'abort' } }), !raise)],
    'metres MSL — nothing flies to this gate, so it has no leg of its own');
  } else {
    const blocked = top == null;
    add('Break off at', [placeButton('abort', 'Place on the map', placing, onPlace, !raise || blocked)],
      blocked
        ? 'place the run’s gates first — the break-off height is read off the run'
        : `not set — a placed gate starts at ${f0(top)} m MSL, the top of the run`);
  }

  /* ---- the ground it puts down on ---- */
  const bailout = plan.bailout;
  if (bailout) {
    const name = text(bailout.name, (next) => {
      if (!next) { say('A bailout landing needs a name.'); return; }
      send({ type: 'setDiveBailout', payload: { bailout: {
        name: next, latitude: bailout.lat, longitude: bailout.lng, elevationMslM: bailout.elevationMslM,
      } } });
    }, !raise);
    name.id = 'recovery-bailout-name';
    add('Bailout landing', [name, placeButton('bailout', 'Move', placing, onPlace, !raise),
      removeButton('bailout-remove', () => send({ type: 'setDiveBailout', payload: { bailout: null } }), !raise)]);
    /* Surveyed, or said to be unsurveyed. The elevation came from the terrain
       field at the moment of the click and is not re-sampled here: a figure that
       changed under the pilot because a tile loaded is a figure they never
       agreed to. */
    const g = groundAt(bailout.lat, bailout.lng);
    add('Its elevation', [bailout.elevationMslM == null
      ? 'not surveyed'
      : `${f0(bailout.elevationMslM)} m MSL`],
    bailout.elevationMslM == null
      ? (g == null ? 'the terrain field has no ground here' : 'move the pin to survey it')
      : 'from the terrain field where the pin was dropped');
  } else {
    add('Bailout landing', [placeButton('bailout', 'Place on the map', placing, onPlace, !raise)],
      'no site chosen — somewhere you would rather put it down than lose it');
  }

  const status = document.createElement('p');
  status.className = 'segment-status';
  status.id = 'recovery-status';
  status.hidden = true;
  host.replaceChildren(head, body, status);
  say(pendingMessage);
}

/* ---------- the pieces ---------- */

/**
 * @param {string|null} message
 */
function say(message) {
  pendingMessage = message;
  const el = $('recovery-status');
  if (!el) return;
  el.textContent = message ?? '';
  el.hidden = !message;
}

/**
 * The map-arming control. Lit, it is its own cancel: a pilot who armed the wrong
 * one has to be able to put it down without placing anything, and the second
 * press is the gesture already in their hand.
 *
 * @param {PlaceTarget} what
 * @param {string} label
 * @param {PlaceTarget|null} placing
 * @param {(what: PlaceTarget|null) => void} onPlace
 * @param {boolean} disabled
 */
function placeButton(what, label, placing, onPlace, disabled) {
  const armed = placing === what;
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'map-btn recovery-place';
  el.id = `btn-place-${what}`;
  el.textContent = armed ? 'Click the map…' : label;
  el.disabled = disabled;
  el.setAttribute('aria-pressed', String(armed));
  el.onclick = () => onPlace(armed ? null : what);
  return el;
}

/**
 * @param {string} id
 * @param {() => void} onRemove
 * @param {boolean} disabled
 */
function removeButton(id, onRemove, disabled) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'map-btn recovery-remove';
  el.id = `btn-${id}`;
  el.textContent = 'Remove';
  el.disabled = disabled;
  el.onclick = onRemove;
  return el;
}

/**
 * @param {number|null} value
 * @param {{ step?: string, min?: string }} attrs
 * @param {(value: number|null) => void} onCommit
 * @param {boolean} disabled
 */
function number(value, attrs, onCommit, disabled) {
  const el = document.createElement('input');
  el.type = 'number';
  el.className = 'card-select';
  el.inputMode = 'decimal';
  if (attrs.step) el.step = attrs.step;
  if (attrs.min) el.min = attrs.min;
  el.value = value == null ? '' : String(Math.round(value));
  el.disabled = disabled;
  el.addEventListener('change', () => {
    const raw = el.value.trim();
    if (raw === '') { onCommit(null); return; }
    const n = Number(raw);
    onCommit(Number.isFinite(n) ? n : null);
  });
  return el;
}

/**
 * @param {string} value
 * @param {(value: string) => void} onCommit
 * @param {boolean} disabled
 */
function text(value, onCommit, disabled) {
  const el = document.createElement('input');
  el.type = 'text';
  el.className = 'card-select recovery-name';
  el.value = value;
  el.disabled = disabled;
  el.addEventListener('change', () => onCommit(el.value.trim()));
  return el;
}
