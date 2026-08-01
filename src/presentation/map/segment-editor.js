// segment-editor.js — the editing half of the segment inspector (ADR 0011 §5).
//
// The panel beside this one reads a leg out of the analysis. This one changes
// the leg — and it is the first surface in the app that edits anything below the
// launch point. `setSegmentIntent`, `setSegmentAltitude` and `setSegmentSpeed`
// have existed on the reducer since M2 with nothing calling them; M7's cinematic
// commands joined them in wave B. This file is where all thirteen get their call
// sites.
//
// It still computes nothing. Every control is seeded from a value the analysis
// carried verbatim off the document (`altitudeAuthoredM`, `speedMode`, `holdS`,
// `subjectRef`, `camera` are all published exactly as authored), and every
// gesture ends in one command handed to `raise` — which is the mission bridge by
// the time it lands, outside presentation/ entirely (ADR 0002). Nothing here
// writes to a document, and nothing here decides whether an edit is legal.
//
// Three things are worth stating, because each of them is a rule the reducer
// enforces and this file has to agree with rather than duplicate:
//
//   *A rejection is shown, not swallowed.* `missionReduce` answers a bad command
//     by returning the document it was given and explaining itself through its
//     warning channel. A UI that treated that as "nothing happened" would leave a
//     pilot pressing a control that silently does nothing. Every raise here puts
//     its answer on the status line, and only a rejection stays up.
//
//   *`setSegmentCamera` replaces the bag; it does not merge.* So every camera
//     control rebuilds the whole `{pitchDeg, yawOffsetDeg, orbit}` shape from
//     what the segment already carries plus the one field that changed. Sending
//     a partial bag would quietly delete the other two fields.
//
//   *The controls that are meaningless are absent, not disabled.* A dwell time
//     exists on `hold` and `orbit`; an orbit radius exists on `orbit`. The
//     reducer rejects them anywhere else, so offering them anywhere else would be
//     offering a control whose only outcome is an error message.
//
// Rebuilt only when what it is showing actually changed. The render pass runs on
// every slider drag on the rail beside it, and a `<select>` or a half-typed
// number that is torn down mid-gesture is a control that cannot be used.

import { SEGMENT_INTENTS, SPEED_MODES, intentHoldsStation } from '../../domain/mission/mission-schema.js';
import { CAMERAS } from '../../catalog/cameras.js';

/**
 * @typedef {import('../../application/analysis/analysis-contracts.js').SegmentAnalysis} SegmentAnalysis
 * @typedef {import('../../domain/mission/mission-schema.js').SegmentCamera} SegmentCamera
 * @typedef {{ id: string, name: string }} Named
 * @typedef {import('./map-adapter.js').DiveProjection} DiveProjection
 * @typedef {{ subjects: Named[], cameraProfile: { name: string }|null, templates: Named[], dive: DiveProjection|null }} SceneProjection
 * @typedef {{ ok: boolean, message: string|null }} EditResult
 * @typedef {(command: { type: string, payload: object }) => EditResult} Raise
 */

const $ = (/** @type {string} */ id) => document.getElementById(id);

/** How the reducer spells an altitude frame, in the pilot's words. */
const REFERENCES = [
  { value: 'launchRelative', label: 'above the launch' },
  { value: 'agl', label: 'above ground' },
  { value: 'msl', label: 'MSL' },
];

/** The three speed policies, in the words the route table already uses. */
const SPEED_WORDS = {
  cruise: 'planned cruise',
  fixed: 'a fixed airspeed',
  maxRange: 'best range',
};

/**
 * What the editor is currently showing, as a string. Two passes with the same
 * signature draw the same controls with the same values, so the second one is
 * skipped — which is what keeps a `<select>` the pilot has open, and a number
 * they are halfway through typing, alive across the render an unrelated slider
 * triggers.
 * @param {SegmentAnalysis} segment
 * @param {SceneProjection} scene
 */
function signatureOf(segment, scene) {
  return JSON.stringify([
    segment.segmentId, segment.intent,
    segment.altitudeAuthoredM, segment.altitudeReference,
    segment.speedMode, segment.speedTargetMs, segment.holdS,
    segment.subjectRef, segment.camera,
    scene.subjects.map((s) => `${s.id}\0${s.name}`),
    scene.templates.map((t) => `${t.id}\0${t.name}`),
    scene.cameraProfile?.name ?? null,
  ]);
}

let drawnSignature = /** @type {string|null} */ (null);

/** Forget what is on screen — the panel closed, or opened on another leg. */
export function resetSegmentEditor() {
  drawnSignature = null;
  say(null);
}

/**
 * The one place a command's answer becomes a sentence. A rejection is the
 * reducer's own message, verbatim, for the same reason the warning rail prints a
 * constraint's text verbatim (ADR 0008): the producer knows which field it
 * refused and why, and a paraphrase downstream is a second, worse explanation.
 * @param {string|null} message
 */
function say(message) {
  const el = $('segment-status');
  if (!el) return;
  el.textContent = message ?? '';
  el.hidden = !message;
}

/**
 * The editing controls, or nothing at all.
 *
 * @param {object} view
 * @param {SegmentAnalysis} view.segment  the analysis's copy of the authored leg
 * @param {SceneProjection} view.scene    subjects, profile and templates, off the document
 * @param {Raise} view.raise              one command in, its verdict out
 */
export function renderSegmentEditor({ segment, scene, raise }) {
  const host = $('segment-editor');
  if (!host) return;

  const signature = signatureOf(segment, scene);
  if (signature === drawnSignature) return;
  drawnSignature = signature;

  /* Every control ends here. The signature is dropped first so the pass this
   * kicks off rebuilds against the new document rather than recognising the
   * values it just sent and skipping. */
  const send = (/** @type {{ type: string, payload: object }} */ command) => {
    drawnSignature = null;
    say(raise(command).message);
  };
  const id = segment.segmentId;

  host.replaceChildren();
  const add = (/** @type {string} */ label, /** @type {Element[]} */ controls) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.append(...controls);
    host.append(dt, dd);
  };

  /* ---- intent, which decides which of the rows below exist at all ---- */
  add('Intent', [select(
    SEGMENT_INTENTS.map((v) => ({ value: v, label: v })),
    segment.intent,
    (intent) => send({ type: 'setSegmentIntent', payload: { segmentId: id, intent } }),
  )]);

  /* ---- altitude: the figure and the frame it was typed in (ADR 0003) ---- */
  const reference = () => /** @type {HTMLSelectElement} */ (host.querySelector('#segment-alt-ref')).value;
  const altitude = number(segment.altitudeAuthoredM, { step: '1' }, (authored) => {
    if (authored == null) { say('An altitude needs a number of metres.'); return; }
    send({ type: 'setSegmentAltitude', payload: { segmentId: id, authored, reference: reference() } });
  });
  const altRef = select(REFERENCES, segment.altitudeReference, (value) => {
    // Same parse as number()'s change handler: a cleared box is '', and
    // Number('') is 0 — the one coercion that would silently re-author the
    // leg at ground level when only the frame was being changed.
    const raw = altitude.value.trim();
    const authored = raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(authored)) { say('An altitude needs a number of metres.'); return; }
    send({ type: 'setSegmentAltitude', payload: { segmentId: id, authored, reference: value } });
  });
  altRef.id = 'segment-alt-ref';
  add('Altitude (m)', [altitude, altRef]);

  /* ---- speed: the policy, and the target only where one is read ---- */
  const speedTarget = number(segment.speedTargetMs, { step: '0.5', min: '0' }, (targetMs) => {
    send({ type: 'setSegmentSpeed', payload: { segmentId: id, speedPolicy: { mode: 'fixed', targetMs } } });
  });
  const speedControls = [select(
    SPEED_MODES.map((v) => ({ value: v, label: SPEED_WORDS[v] ?? v })),
    segment.speedMode,
    (mode) => send({
      type: 'setSegmentSpeed',
      payload: { segmentId: id, speedPolicy: { mode, targetMs: segment.speedTargetMs ?? null } },
    }),
  )];
  if (segment.speedMode === 'fixed') speedControls.push(speedTarget);
  add('Speed', speedControls);

  /* ---- the dwell, on the two intents that carry one ---- */
  if (intentHoldsStation(segment.intent)) {
    add('Dwell (s)', [number(segment.holdS, { step: '5', min: '0' }, (holdS) => {
      send({ type: 'setSegmentHold', payload: { segmentId: id, holdS } });
    })]);
  }

  /* ---- what this leg is filming ---- */
  add('Subject', [select(
    [{ value: '', label: '— nothing —' }, ...scene.subjects.map((s) => ({ value: s.id, label: s.name }))],
    segment.subjectRef ?? '',
    (value) => send({
      type: 'setSegmentSubject',
      payload: { segmentId: id, subjectRef: value === '' ? null : value },
    }),
  )]);

  /* ---- the camera bag, rebuilt whole on every change ---- */
  const cam = segment.camera;
  const withCamera = (/** @type {Partial<SegmentCamera>} */ patch) => {
    const next = {
      pitchDeg: cam?.pitchDeg ?? null,
      yawOffsetDeg: cam?.yawOffsetDeg ?? null,
      orbit: cam?.orbit ?? null,
      ...patch,
    };
    const empty = next.pitchDeg == null && next.yawOffsetDeg == null && next.orbit == null;
    send({ type: 'setSegmentCamera', payload: { segmentId: id, camera: empty ? null : next } });
  };

  add('Camera pitch (°)', [number(cam?.pitchDeg ?? null, { step: '5' },
    (pitchDeg) => withCamera({ pitchDeg }))]);
  add('Yaw offset (°)', [number(cam?.yawOffsetDeg ?? null, { step: '5' },
    (yawOffsetDeg) => withCamera({ yawOffsetDeg }))]);

  if (segment.intent === 'orbit') {
    /* An orbit is a radius *and* a direction together — the reducer will not take
     * one without the other — so clearing the radius clears the orbit rather than
     * sending a circle with no size. */
    const clockwise = cam?.orbit?.clockwise ?? true;
    add('Orbit radius (m)', [number(cam?.orbit?.radiusM ?? null, { step: '5', min: '0' },
      (radiusM) => withCamera({ orbit: radiusM == null ? null : { radiusM, clockwise } }))]);
    add('Orbit direction', [select(
      [{ value: 'cw', label: 'clockwise' }, { value: 'ccw', label: 'counter-clockwise' }],
      clockwise ? 'cw' : 'ccw',
      (value) => {
        const radiusM = cam?.orbit?.radiusM;
        if (radiusM == null) { say('Give the orbit a radius before choosing which way round it goes.'); return; }
        withCamera({ orbit: { radiusM, clockwise: value === 'cw' } });
      },
    )]);
  }

  /* ---- the mission's one camera profile: a preset, swapped whole ---- */
  add('Camera profile', [select(
    [{ value: '', label: '— none —' }, ...CAMERAS.map((c) => ({ value: c.id, label: c.name }))],
    CAMERAS.find((c) => c.name === scene.cameraProfile?.name)?.id ?? '',
    (value) => {
      if (value === '') { send({ type: 'setCameraProfile', payload: { profile: null } }); return; }
      const preset = CAMERAS.find((c) => c.id === value);
      if (!preset) return;
      /* The catalog `id` is a selection key, not part of the profile shape — and
       * `checkCameraProfile` rejects a bag carrying a key the shape does not
       * name, so it has to come off before the command goes anywhere. */
      const { id: _catalogId, ...profile } = preset;
      send({ type: 'setCameraProfile', payload: { profile } });
    },
  )]);

  renderTemplates(add, { segment, scene, send });
}

/**
 * Shot presets: apply one to this leg, drop one, or keep this leg as a new one.
 *
 * Applying copies `intent`/`holdS`/`camera` onto the segment — never a live
 * reference — so a template removed next month cannot reach back into a leg that
 * already used it. Saving reads the segment's *current* values rather than the
 * controls above, because the controls above are already the segment: every one
 * of them commits on change.
 *
 * @param {(label: string, controls: Element[]) => void} add
 * @param {{ segment: SegmentAnalysis, scene: SceneProjection,
 *   send: (command: { type: string, payload: object }) => void }} ctx
 */
function renderTemplates(add, { segment, scene, send }) {
  const id = segment.segmentId;

  if (scene.templates.length) {
    const pick = select(
      scene.templates.map((t) => ({ value: t.id, label: t.name })),
      scene.templates[0].id,
      () => {},
    );
    add('Shot preset', [
      pick,
      button('Apply', () => send({
        type: 'applySceneTemplate', payload: { templateId: pick.value, segmentId: id },
      })),
      button('Delete', () => send({ type: 'removeSceneTemplate', payload: { id: pick.value } })),
    ]);
  }

  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'card-select';
  name.placeholder = 'Name this shot';
  name.maxLength = 80;
  add('Save as preset', [
    name,
    button('Save', () => {
      const holds = intentHoldsStation(segment.intent);
      send({
        type: 'saveSceneTemplate',
        payload: {
          name: name.value,
          intent: segment.intent,
          holdS: holds ? segment.holdS : null,
          camera: segment.camera ?? null,
        },
      });
    }),
  ]);
}

/* ---------- the three controls everything above is built from ---------- */

/**
 * `.card-select` rather than a class of its own: it is the compact select the
 * rail already uses, and the panel this lands in is a card like any other.
 * @param {{ value: string, label: string }[]} options
 * @param {string} value
 * @param {(value: string) => void} onChange
 * @returns {HTMLSelectElement}
 */
function select(options, value, onChange) {
  const el = document.createElement('select');
  el.className = 'card-select';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    // textContent, never innerHTML: a subject name and a template name are both
    // text a pilot typed.
    opt.textContent = o.label;
    el.appendChild(opt);
  }
  el.value = value;
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

/**
 * A number, or the absence of one. An empty box is `null` — the schema's own
 * "nobody has said" — for every field that is nullable, and the caller decides
 * whether that is legal for the field it asked for.
 * @param {number|null|undefined} value
 * @param {{ step?: string, min?: string }} attrs
 * @param {(value: number|null) => void} onCommit  fires on blur or Enter, never per keystroke
 * @returns {HTMLInputElement}
 */
function number(value, attrs, onCommit) {
  const el = document.createElement('input');
  el.type = 'number';
  el.className = 'card-select';
  el.inputMode = 'decimal';
  if (attrs.step) el.step = attrs.step;
  if (attrs.min) el.min = attrs.min;
  el.value = value == null ? '' : String(value);
  el.addEventListener('change', () => {
    const raw = el.value.trim();
    if (raw === '') { onCommit(null); return; }
    const n = Number(raw);
    onCommit(Number.isFinite(n) ? n : null);
  });
  return el;
}

/**
 * @param {string} label
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function button(label, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'map-btn';
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}
