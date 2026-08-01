// dive-inspector.js — one dive leg, authored (M16, 3D-06).
//
// The segment inspector beside it reads a leg of the *route* out of the
// analysis. This one edits a leg of the *dive*, and the difference is where the
// numbers come from: no analysis pass computes a dive gate, so every figure here
// is either something the pilot typed or plain geometry over two things they
// typed. There is no third category, and that is the rule this file is built on.
//
//   *Derived is derived, and only from authored.* Drop and pitch are
//     `diveLeg()` over the two gate altitudes and their positions — trigonometry
//     over the pilot's own numbers. The pullout figures are `pulloutArc()` and
//     `pulloutClearance()` over a speed and a load factor the pilot *stated*.
//     No speed is assumed, no load factor is defaulted, and where either is
//     absent the chip says which one is missing rather than filling it in.
//
//   *A leg is edited whole, then applied.* Two altitudes are one thought — the
//     entry and the exit of the same dive — so they stage locally and go as two
//     `setDiveGate` commands on Apply, stopping at the first refusal. Until then
//     the rows above preview what those numbers would make, which is the whole
//     reason a pilot dials them.
//
//   *AGL is a display frame, not a stored one.* Gate altitudes are MSL in the
//     document and stay MSL; the toggle converts for reading and for typing,
//     using the terrain sampler. Where the sampler has no ground the AGL view
//     says so and refuses the conversion rather than showing MSL wearing an AGL
//     label.
//
// Not a map layer: no overlays, and it renders whether or not an engine is up.

import { DIVE_PULLOUT_CLEARANCE_WARN_M } from '../../application/analysis/analysis-contracts.js';
import { diveLeg, pulloutArc, pulloutClearance } from '../../domain/dive.js';
import { DIVE_LEG_STYLE, diveLegChain } from './layers/dive-layer.js';
import { f0, f1 } from '../../render/format.js';

/**
 * @typedef {import('./map-adapter.js').LatLng} LatLng
 * @typedef {import('./map-adapter.js').DiveGateView} DiveGateView
 * @typedef {import('./map-adapter.js').DiveProjection} DiveProjection
 * @typedef {import('./segment-editor.js').EditResult} EditResult
 * @typedef {import('./segment-editor.js').Raise} Raise
 * @typedef {(lat: number, lng: number) => number|null} GroundAt
 */

const $ = (/** @type {string} */ id) => document.getElementById(id);

/* Staged altitudes, keyed by the gate kind they belong to, and the display frame
 * they were typed in. Module state for the same reason segment-editor.js keeps
 * its signature here: the panel is rebuilt on every render pass, and a number
 * half-typed must survive the pass an unrelated slider triggers. */
/** @type {Map<string, number>} */
const staged = new Map();
let aglView = false;
/** Which leg the staging belongs to. */
/** @type {string|null} */
let openKind = null;
/** What the panel last drew, so an unchanged pass leaves the controls alone. */
/** @type {string|null} */
let drawnSignature = null;

/** Forget the staging — the selection closed, or moved to another leg. */
export function resetDiveInspector() {
  staged.clear();
  openKind = null;
  drawnSignature = null;
  say(null);
}

/**
 * The pullout, or the reason there isn't one.
 *
 * Both inputs are authored and both are nullable, so there are three distinct
 * absences and each gets its own sentence: no speed, no load allowance, and no
 * ground under the dive gate. A clearance figure quoted over any of them would
 * be the panel inventing the number the pilot came here to check.
 *
 * @param {object} spec
 * @param {number} spec.pitchDeg      the dive leg's flight-path angle, negative down
 * @param {number} spec.gateMslM      the dive gate the pull starts at
 * @param {number|null} spec.groundMslM
 * @param {number|null} spec.speedMs
 * @param {number|null} spec.loadG
 * @returns {{ tone: 'good'|'warning'|'serious'|'unknown', text: string }}
 */
export function pulloutChip({ pitchDeg, gateMslM, groundMslM, speedMs, loadG }) {
  if (speedMs == null && loadG == null) {
    return { tone: 'unknown', text: 'No dive speed or pullout load stated — no arc to check.' };
  }
  if (speedMs == null) return { tone: 'unknown', text: 'No dive speed stated — no arc to check.' };
  if (loadG == null) return { tone: 'unknown', text: 'No pullout load stated — no arc to check.' };

  const arc = pulloutArc({ speedMs, pitchDeg, loadG });
  if (!arc) {
    return {
      tone: 'unknown',
      text: 'At this speed and load allowance there is no arc — the rotors hold the weight or turn the path, not both.',
    };
  }
  if (groundMslM == null) {
    return {
      tone: 'unknown',
      text: `The pull sinks ${f0(arc.sinkM)} m through a ${f0(arc.radiusM)} m arc. `
        + 'No ground under the dive gate was sampled, so the clearance is unknown.',
    };
  }
  const { clearanceM } = pulloutClearance({ gateMslM, groundMslM, sinkM: arc.sinkM });
  if (clearanceM <= 0) {
    return {
      tone: 'serious',
      text: `The pull sinks ${f0(arc.sinkM)} m and goes ${f0(-clearanceM)} m into the ground. `
        + 'Start higher, fly slower, or pull harder.',
    };
  }
  return {
    /* The same floor the constraint pass warns at, imported rather than repeated:
       a chip that turned amber at a different figure than the finding under it
       would make the pilot pick which of the two to believe. */
    tone: clearanceM < DIVE_PULLOUT_CLEARANCE_WARN_M ? 'warning' : 'good',
    text: `The pull sinks ${f0(arc.sinkM)} m through a ${f0(arc.radiusM)} m arc, `
      + `clearing the ground under the gate by ${f0(clearanceM)} m.`,
  };
}

/**
 * The leg the selection names, resolved against the plan in hand.
 * @param {DiveProjection|null} dive
 * @param {LatLng} launch
 * @param {string|null} kind
 * @returns {{ kind: string, from: LatLng, to: LatLng,
 *   gate: DiveGateView, fromGate: DiveGateView|null }|null}
 */
export function selectedDiveLegOf(dive, launch, kind) {
  if (!kind || !dive) return null;
  return diveLegChain(launch, dive.gates).find((l) => l.kind === kind) ?? null;
}

/* ---------- the DOM half ---------- */

/**
 * The panel, or nothing at all. Called on every map render pass, like every
 * other surface here: the cheapest way to have no stale inspector is for the
 * pass that draws the gates to decide whether the panel is up.
 *
 * @param {object} view
 * @param {DiveProjection|null} view.dive
 * @param {LatLng} view.launch
 * @param {number|null} view.launchMslM  the pad's elevation, or null if unknown
 * @param {string|null} view.selectedKind
 * @param {GroundAt} view.groundAt
 * @param {() => void} view.onClose
 * @param {Raise} [view.raise]  absent until the mission bridge hands its port
 *   over, and the panel then reads without offering controls that land nowhere
 */
export function renderDiveInspector({ dive, launch, launchMslM, selectedKind, groundAt, onClose, raise }) {
  const card = $('dive-card');
  if (!card) return;

  const leg = selectedDiveLegOf(dive, launch, selectedKind);
  if (!leg) { card.hidden = true; resetDiveInspector(); return; }
  card.hidden = false;
  /* Staging belongs to the leg it was typed on. Two adjacent legs share a gate,
     so a number left pending on the leg before would otherwise arm Apply on this
     one and then apply nothing the pilot can see. */
  if (openKind !== leg.kind) { staged.clear(); openKind = leg.kind; drawnSignature = null; say(null); }

  const startMslM = leg.fromGate ? leg.fromGate.altitudeMslM : launchMslM;
  /* The approach leg starts at the pad, and a pad whose elevation never resolved
     gives the leg no start — so drop and pitch are unknown rather than measured
     from an assumed sea-level launch (ADR 0003's rule, in this panel's words). */
  const flyable = startMslM != null;

  /* Rebuilt only when what it shows actually moved. The staged values are in the
     signature so typing into one box redraws the derived rows beside it, and the
     ground is in it because the terrain field lands asynchronously. */
  const signature = JSON.stringify([
    leg.kind, leg.gate.lat, leg.gate.lng, leg.gate.altitudeMslM,
    leg.fromGate?.kind ?? null, leg.fromGate?.lat ?? null, leg.fromGate?.lng ?? null, startMslM,
    dive?.speedMs ?? null, dive?.pulloutLoadG ?? null,
    aglView, [...staged], !!raise,
    groundAt(leg.to.lat, leg.to.lng),
  ]);
  if (signature === drawnSignature) return;
  drawnSignature = signature;

  const head = document.createElement('div');
  head.className = 'card-head';
  const title = document.createElement('h3');
  title.textContent = DIVE_LEG_STYLE[leg.kind]?.label ?? leg.kind;
  head.appendChild(title);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'map-btn';
  close.id = 'btn-dive-close';
  close.textContent = 'Close';
  close.onclick = () => { resetDiveInspector(); onClose(); };
  head.appendChild(close);

  const body = document.createElement('dl');
  body.className = 'segment-facts dive-facts';
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

  /* ---- the display frame, which changes nothing that is stored ---- */
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'map-btn dive-frame-toggle';
  toggle.id = 'btn-dive-frame';
  toggle.textContent = aglView ? 'AGL' : 'MSL';
  toggle.title = 'Show and type gate altitudes above ground, or above sea level';
  toggle.setAttribute('aria-pressed', String(aglView));
  toggle.onclick = () => {
    /* The staging is cleared with the frame: a number typed as MSL is not the
       same number in AGL, and silently reinterpreting it would author a gate
       hundreds of metres from where the pilot put it. */
    staged.clear();
    aglView = !aglView;
    drawnSignature = null;
    say(null);
    render();
  };
  add('Altitudes shown', [toggle]);

  /* ---- the two ends of the leg ---- */
  if (leg.fromGate) {
    add('Start altitude', [altitudeBox(leg.fromGate, groundAt)], frameNote(leg.fromGate, groundAt));
  } else {
    add('Start altitude', [launchMslM == null
      ? 'launch elevation not set'
      : `${f0(launchMslM)} m MSL`], 'the launch pad — set on the rail, not here');
  }
  add('End altitude', [altitudeBox(leg.gate, groundAt)], frameNote(leg.gate, groundAt));

  /* ---- what those two make, and nothing more ---- */
  const shape = flyable ? previewGeometry(leg, startMslM) : null;
  add('Drop', [shape ? `${f0(shape.dropM)} m` : 'unknown'],
    shape ? undefined : 'the launch elevation this leg starts from never resolved');
  add('Pitch', [shape ? `${f1(Math.abs(shape.pitchDeg))}° down` : 'unknown']);

  /* ---- the authored pair the pullout is read from ---- */
  const send = (/** @type {{ type: string, payload: object }} */ command) => {
    drawnSignature = null;
    say(raise ? raise(command).message : 'No mission is open yet — nothing to edit.');
  };
  add('Dive speed (m/s)', [field('speedMs', dive?.speedMs ?? null, { step: '1', min: '0' }, (speedMs) => {
    send({ type: 'setDiveProfile', payload: { speedMs } });
  })], 'what you expect to be doing at the bottom — nothing here measures it');
  add('Pullout load (g)', [field('pulloutLoadG', dive?.pulloutLoadG ?? null, { step: '0.1', min: '1' }, (pulloutLoadG) => {
    send({ type: 'setDiveProfile', payload: { pulloutLoadG } });
  })], 'the load factor you intend to pull');

  card.replaceChildren(head, body);

  /* ---- the chip, on the leg the pull actually happens on ---- */
  if (leg.kind === 'dive' && shape) {
    const chip = pulloutChip({
      /* Signed, as `pulloutArc` reads it: a pitch handed over positive would
         clamp to level and quote a pullout that sinks nothing at all. */
      pitchDeg: shape.pitchDeg,
      gateMslM: previewAltitude(leg.gate),
      groundMslM: groundAt(leg.to.lat, leg.to.lng),
      speedMs: dive?.speedMs ?? null,
      loadG: dive?.pulloutLoadG ?? null,
    });
    const el = document.createElement('p');
    el.className = 'dive-pullout';
    el.id = 'dive-pullout';
    el.dataset.tone = chip.tone;
    el.textContent = chip.text;
    card.appendChild(el);
  }

  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'map-btn dive-apply';
  apply.id = 'btn-dive-apply';
  apply.textContent = 'Apply leg';
  apply.disabled = !raise || staged.size === 0;
  apply.onclick = () => applyStaged(leg, raise);
  card.appendChild(apply);

  const status = document.createElement('p');
  status.className = 'segment-status';
  status.id = 'dive-status';
  status.hidden = true;
  card.appendChild(status);
  say(pendingMessage);

  /* One box per authored profile figure. Unlike the altitudes these go straight
     out as commands — a single number is a whole thought, with no second one to
     wait for. */
  /**
   * @param {string} name  the document field it writes, and the box's own handle
   * @param {number|null} value
   * @param {{ step?: string, min?: string }} attrs
   * @param {(value: number|null) => void} onCommit
   */
  function field(name, value, attrs, onCommit) {
    const box = number(value, attrs, onCommit, !raise);
    box.dataset.field = name;
    return box;
  }

  /* One input box per gate, seeded from the staged value if the pilot has typed
     one, and in the frame the toggle is showing. */
  /**
   * @param {DiveGateView} gate
   * @param {GroundAt} ground
   */
  function altitudeBox(gate, ground) {
    const g = ground(gate.lat, gate.lng);
    const blocked = aglView && g == null;
    /* `staged` is MSL whatever frame it was typed in, so the box has to convert
       both ways: out of MSL to show, and back into it on commit. Doing it here
       and nowhere else is what lets the preview, the chip and the command all
       read one number. */
    const datum = aglView ? (g ?? 0) : 0;
    const stored = staged.get(gate.kind) ?? gate.altitudeMslM;
    const shown = blocked ? null : Math.round(stored - datum);
    const box = number(shown, { step: '10' }, (value) => {
      if (value == null) staged.delete(gate.kind);
      else staged.set(gate.kind, value + datum);
      drawnSignature = null;
      render();
    }, blocked || !raise);
    box.dataset.gate = gate.kind;
    box.classList.add('dive-alt-input');
    return box;
  }

  /** Re-run this panel with the state it just changed, without a full map pass. */
  function render() {
    renderDiveInspector({ dive, launch, launchMslM, selectedKind, groundAt, onClose, raise });
  }
}

/* ---------- staging, and what it previews ---------- */

/** What a message stays up across the panel's own re-renders. */
let pendingMessage = /** @type {string|null} */ (null);

/**
 * @param {string|null} message
 */
function say(message) {
  pendingMessage = message;
  const el = $('dive-status');
  if (!el) return;
  el.textContent = message ?? '';
  el.hidden = !message;
}

/**
 * The altitude a gate would have if Apply were pressed now: the staged number
 * converted back out of the display frame, or the stored one.
 * @param {DiveGateView} gate
 * @returns {number}
 */
function previewAltitude(gate) {
  /* `staged` holds MSL whatever frame the box was typed in — the conversion
     happens once, in the box (see altitudeBox) — so the preview, the chip and
     the command can never disagree about what the pilot typed. */
  return staged.get(gate.kind) ?? gate.altitudeMslM;
}

/**
 * The leg as the staged numbers would make it: the same trigonometry that will
 * describe it once Apply lands, run one gesture early.
 * @param {{ from: LatLng, to: LatLng, gate: DiveGateView, fromGate: DiveGateView|null }} leg
 * @param {number|null} startMslM
 */
function previewGeometry(leg, startMslM) {
  const y0 = leg.fromGate ? previewAltitude(leg.fromGate) : /** @type {number} */ (startMslM);
  return diveLeg(
    { latitude: leg.from.lat, longitude: leg.from.lng, altitudeMslM: y0 },
    { latitude: leg.to.lat, longitude: leg.to.lng, altitudeMslM: previewAltitude(leg.gate) },
  );
}

/**
 * Send the staged altitudes as `setDiveGate` commands, one gate at a time,
 * stopping at the first refusal — the same rule `applyTemplate` follows, and for
 * the same reason: a half-applied leg the pilot was not told about is worse than
 * an edit that stops and says which gate it stopped at.
 *
 * Position and radius are carried through untouched. This panel edits height.
 *
 * @param {{ gate: DiveGateView, fromGate: DiveGateView|null }} leg
 * @param {Raise} [raise]
 */
function applyStaged(leg, raise) {
  if (!raise) { say('No mission is open yet — nothing to edit.'); return; }
  for (const gate of [leg.fromGate, leg.gate]) {
    if (!gate || !staged.has(gate.kind)) continue;
    const result = raise({
      type: 'setDiveGate',
      payload: {
        kind: gate.kind,
        latitude: gate.lat,
        longitude: gate.lng,
        altitudeMslM: staged.get(gate.kind),
        radiusM: gate.radiusM,
      },
    });
    if (!result.ok) { say(result.message); return; }
    staged.delete(gate.kind);
  }
  drawnSignature = null;
  say(null);
}

/**
 * What the box's number is measured from, said next to it. In MSL there is
 * nothing to explain; in AGL the ground it was taken over is the fact that makes
 * the number checkable, and its absence is the fact that makes it impossible.
 * @param {DiveGateView} gate
 * @param {GroundAt} groundAt
 * @returns {string|undefined}
 */
function frameNote(gate, groundAt) {
  if (!aglView) return `${f0(gate.altitudeMslM)} m MSL is what is stored`;
  const g = groundAt(gate.lat, gate.lng);
  return g == null
    ? 'no ground under this gate was sampled — it cannot be typed above ground'
    : `over ${f0(g)} m of ground; ${f0(gate.altitudeMslM)} m MSL is what is stored`;
}

/**
 * The same number box segment-editor.js uses, with the AGL frame folded in on
 * commit: `staged` always holds MSL, so nothing downstream has to remember which
 * frame a number was typed in.
 * @param {number|null} value
 * @param {{ step?: string, min?: string }} attrs
 * @param {(value: number|null) => void} onCommit
 * @param {boolean} [disabled]
 * @returns {HTMLInputElement}
 */
function number(value, attrs, onCommit, disabled) {
  const el = document.createElement('input');
  el.type = 'number';
  el.className = 'card-select';
  el.inputMode = 'decimal';
  if (attrs.step) el.step = attrs.step;
  if (attrs.min) el.min = attrs.min;
  el.value = value == null ? '' : String(value);
  el.disabled = !!disabled;
  el.addEventListener('change', () => {
    const raw = el.value.trim();
    if (raw === '') { onCommit(null); return; }
    const n = Number(raw);
    onCommit(Number.isFinite(n) ? n : null);
  });
  return el;
}
