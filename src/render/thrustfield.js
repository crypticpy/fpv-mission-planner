// render/thrustfield.js — the pasted thrust table in the drone form's Advanced
// fold (§6.1: "an optional pasted thrust table that overrides the momentum-theory
// lift ceiling, the model's shakiest inversion").
//
// Its own module rather than another forty lines of render/droneform.js, which is
// already at the size guideline. The seam is clean: this file owns two descriptor
// entries, the sentence under them, and nothing else.
//
// Two fields, not one, on purpose:
//   - the paste box is scratch. Nothing stores it; §7.4 rules out keeping the
//     curve, and a table the pilot pasted once is not a fact about the airframe.
//   - the number beside it is the record. It fills in from the paste, can be
//     typed straight in by anyone who already knows it, and can be cleared to
//     take the override back off — which a paste-only field could never do.
//
// Every parse failure is a sentence and nothing more. Saving is never blocked on
// it: a rig with a table we couldn't read is exactly as flyable as one without.
import { parseThrustTable } from '../thrust.js';
import { $ } from './dom.js';

const NOTE_ID = 'drone-thrust-note';

export const THRUST_FIELDS = [
  { key: 'thrustTable', label: 'Paste a thrust table', type: 'textarea', rows: 4,
    id: 'drone-thrust-table',
    placeholder: 'Throttle  Thrust (g)  Amps\n50%  420  8.1\n75%  690  15.4\n100%  980  24.2',
    help: 'Straight out of the bench sheet or the vendor’s page — one row per throttle step, '
      + 'any spacing. Only the peak thrust is kept, and it replaces the estimated lift ceiling.' },
  { key: 'maxThrustGPerRotor', label: 'Max thrust per motor', type: 'number', unit: 'g',
    min: 5, max: 100000, step: 1, id: 'drone-thrust-max',
    help: 'Filled in from the paste above. Clear it to go back to the estimate.' },
];

/**
 * Put the feedback line under the paste box. Called once, after buildForm() has
 * built the fold — the form is generated, so there is nowhere in index.html to
 * declare this and still have it sit beside the field it talks about.
 */
export function mountThrustField(formEl) {
  if ($(NOTE_ID)) return;
  const box = formEl.querySelector(`#${THRUST_FIELDS[0].id}`)?.closest('label');
  if (!box) return;
  const note = document.createElement('p');
  note.id = NOTE_ID;
  note.className = 'rail-note thrust-note';
  note.setAttribute('role', 'status');
  note.hidden = true;
  box.insertAdjacentElement('afterend', note);
}

function setNote(msg) {
  const el = $(NOTE_ID);
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
}

/**
 * React to an edit in the drone form. Only the paste box does anything: it is
 * read, and what was understood — or what to fix — lands in the note. A good
 * parse writes the peak into the number field beside it (as the attribute too,
 * so a save's form.reset() doesn't drop it).
 *
 * Returns true when the record's thrust figure changed, so the caller knows the
 * live readout is now out of date.
 */
export function syncThrustField(formEl, key) {
  if (key !== 'thrustTable') return false;
  const raw = formEl.elements.namedItem('thrustTable')?.value ?? '';
  if (!raw.trim()) {
    setNote('');
    return false;
  }
  const res = parseThrustTable(raw);
  setNote(res.message);
  if (!res.ok) return false;
  const el = formEl.elements.namedItem('maxThrustGPerRotor');
  if (!el) return false;
  const g = String(Math.round(res.maxThrustG));
  if (el.value === g) return false;
  el.setAttribute('value', g);
  el.value = g;
  return true;
}

/**
 * Take the field back to empty: the scratch paste, the number it derived, and the
 * sentence about it. Called after a save and before a clone loads someone else's
 * numbers over the top — form.reset() alone would put the derived figure back
 * (that is what the attribute write above is for) and leave the next rig starting
 * life with the last one's measured ceiling.
 */
export function resetThrustField(formEl) {
  setNote('');
  const box = formEl?.elements?.namedItem('thrustTable');
  if (box) box.value = '';
  const num = formEl?.elements?.namedItem('maxThrustGPerRotor');
  if (num) {
    num.removeAttribute('value');
    num.value = '';
  }
}
