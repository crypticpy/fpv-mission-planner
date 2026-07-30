// render/packinstances.js — "which physical pack" (§5 Phase 3: per-pack
// instances). The fold under the battery selector: pick the copy of this pack
// model that is actually on the rig, add and edit copies, and see what choosing
// one does to the plan.
//
// Its own module rather than more of render/controls.js, on the same seam
// render/thrustfield.js took: this file owns the fold, its form, its list, and
// the sentence the provenance footnote asks it for. The persistence and the
// overlay live in js/packinstances.js and know nothing about the DOM.
//
// What the fold deliberately does not do:
//   - It does not derate capacity by cycle count. Cycles are shown, and a tired
//     pack gets a sentence, but the model is not handed a curve nobody has
//     anchored data for (§5 asks for the bookkeeping, not a new model).
//   - It does not ask which pack a *logged flight* was flown on. A flight log
//     records the pack model, and the fit reads the model's numbers; splitting
//     the logbook per physical pack is a bigger change than this wave.
import {
  instancesForBattery, savePackInstance, deletePackInstance,
  newInstanceId, selectedInstanceId, setSelectedInstance, highCycleCount,
} from '../packinstances.js';
import { catalogBattery } from '../state.js';
import { CHEMISTRY } from '../physics.js';
import { buildForm, readForm } from '../forms.js';
import { f0, f1 } from './format.js';
import { $, fillSelect } from './dom.js';

let deps = null; // injected by app.js: { update, populateControls }
export function setupPackInstances(d) { deps = d; }

// Which instance the form is rewriting, or null when it is adding one. Cycle
// counts are the field that gets edited most — a pack that was at 84 cycles in
// March is at 120 by July — so editing is the common path, not an extra.
let editingId = null;

/* ---------- the descriptor ---------- */

// `step: 'any'` on both measurements on purpose: a charger reports 23.4 mΩ and a
// pack sits at 18.5 °C, and a step the entered value doesn't land on is a native
// validation refusal at submit time with nothing on screen to explain it.
export const INSTANCE_FORM = [
  { grid: [
    { key: 'label', label: 'This pack', type: 'text', required: true,
      id: 'pack-instance-label', placeholder: 'Pack #2' },
    { key: 'cycles', label: 'Charge cycles', type: 'number', min: 0, max: 5000, step: 1,
      id: 'pack-instance-cycles', placeholder: '84',
      help: 'Bookkeeping — nothing in the model reads it. It is how you know which pack to retire.' },
    { key: 'ir', label: 'Measured pack IR', type: 'number', unit: 'mΩ',
      min: 0.5, max: 500, step: 'any', id: 'pack-instance-ir',
      help: 'What your charger reports for the whole pack. This one does change the plan: it '
        + 'replaces the model’s resistance in the sag model.' },
    { key: 'tempC', label: 'Measured at', type: 'number', unit: '°C', min: -20, max: 60, step: 'any',
      id: 'pack-instance-temp',
      help: 'The pack’s temperature when you read it. Provenance, not an input — resistance rises '
        + 'as a pack cools, and the model has its own temperature curve.' },
  ] },
];

/* ---------- control access ---------- */

const form = () => $('pack-instance-form');
const ctrl = (key) => form()?.elements.namedItem(key) || null;

function setValue(key, v) {
  const el = ctrl(key);
  if (!el) return;
  const s = v == null ? '' : String(v);
  // The attribute as well as the property, so a post-save form.reset() puts back
  // what we meant (same reasoning as forms.js's prefills).
  if (el.tagName === 'INPUT') el.setAttribute('value', s);
  el.value = s;
}

function setNote(msg) {
  const el = $('pack-instance-note');
  el.textContent = msg || '';
  el.hidden = !msg;
}

function clearForm() {
  editingId = null;
  const el = form();
  for (const key of ['label', 'cycles', 'ir', 'tempC']) {
    const input = ctrl(key);
    if (input) input.removeAttribute('value');
  }
  el.reset();
}

/* ---------- the sentences ---------- */

const irPhrase = (mOhm) => `${f1(mOhm)} mΩ`;

/**
 * What a tired pack is worth saying, given the chemistry it is. Soft, and never
 * a number the model then acts on: the honest claim is "expect less than the
 * label", not a derated capacity we made up.
 */
function cyclePhrase(batt, cycleCount) {
  if (!highCycleCount(batt.chem, cycleCount)) return '';
  return `${f0(cycleCount)} cycles is a lot for a ${CHEMISTRY[batt.chem].label} pack — `
    + 'expect less than the capacity on the label, and re-measure its resistance.';
}

/**
 * The provenance sentence for the footnote under the plan, or '' when the plan is
 * flying the model as recorded. Read by render/controls.js's renderBatteryNote()
 * so the pack half of the footnote reads in one voice.
 */
export function packInstanceSentence(batt) {
  const pi = batt?.packInstance;
  if (!pi) return '';
  const cycles = Number.isFinite(pi.cycleCount) ? `, ${f0(pi.cycleCount)} cycles` : '';
  const at = Number.isFinite(pi.irTempC) ? ` at ${f0(pi.irTempC)} °C` : '';
  const head = `Flying ${pi.label}${cycles}. `;
  const body = pi.measured
    ? `Pack IR measured, ${irPhrase(pi.irPackMilliOhm)}${at}, in place of the `
      + `${irPhrase(pi.specIrPackMilliOhm)} on record for this model. `
    : `No measured resistance for this one, so the plan uses the ${irPhrase(pi.specIrPackMilliOhm)} `
      + 'on record. ';
  const tired = cyclePhrase(batt, pi.cycleCount);
  return head + body + (tired ? `${tired} ` : '');
}

/* ---------- the fold ---------- */

const instanceLabel = (inst) => [
  inst.label,
  Number.isFinite(inst.cycleCount) ? `${f0(inst.cycleCount)} cycles` : null,
  Number.isFinite(inst.irPackMilliOhm) ? irPhrase(inst.irPackMilliOhm) : 'no IR measured',
].filter(Boolean).join(' · ');

function renderList(batt) {
  const host = $('pack-instance-list');
  host.replaceChildren();
  for (const inst of instancesForBattery(batt.id)) {
    const row = document.createElement('div');
    row.className = 'custom-row';
    const name = document.createElement('span');
    name.textContent = instanceLabel(inst);
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'edit';
    edit.className = 'link-btn';
    edit.addEventListener('click', () => {
      editingId = inst.id;
      setValue('label', inst.label);
      setValue('cycles', inst.cycleCount);
      setValue('ir', inst.irPackMilliOhm);
      setValue('tempC', inst.irTempC);
      setNote(`Editing ${inst.label} — save to update it.`);
      ctrl('cycles')?.focus();
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'remove';
    del.className = 'link-btn';
    del.addEventListener('click', () => {
      deletePackInstance(inst.id);
      if (editingId === inst.id) clearForm();
      setNote(`Removed ${inst.label}. ${selectedInstanceId(batt.id) ? '' : 'Back on the catalog spec.'}`);
      deps.populateControls();
      deps.update();
    });
    row.append(name, edit, del);
    host.appendChild(row);
  }
}

/**
 * Keep the fold in step with the rail: the roster for the pack now selected, the
 * list, and the line under them. Called from populateControls().
 */
let notedFor = null; // which pack the line under the fold is talking about

export function renderPackInstances() {
  const batt = catalogBattery();
  const fold = $('pack-instance-fold');
  // No pack fits this rig at all — the NO PACK verdict is already saying so, and
  // there is nothing here to describe a physical copy of.
  fold.hidden = !batt;
  if (!batt) return;
  // The rail moved to another pack: whatever we last said was about the old one,
  // and a half-typed edit belongs to it too.
  if (notedFor !== batt.id) {
    if (notedFor !== null) { clearForm(); setNote(''); }
    notedFor = batt.id;
  }
  const list = instancesForBattery(batt.id);
  const selected = selectedInstanceId(batt.id);
  fillSelect($('sel-pack-instance'), [
    { value: '', label: `Catalog spec — ${irPhrase(batt.irPackMilliOhm)} as recorded` },
    ...list.map(i => ({ value: i.id, label: instanceLabel(i) })),
  ], list.some(i => i.id === selected) ? selected : '');
  renderList(batt);
  if (!list.length) {
    setNote(`Own more than one ${batt.short || batt.name}? Add each one here and the plan can fly `
      + 'the pack you actually strapped on, with its own measured resistance.');
  }
}

/* ---------- events ---------- */

function onSubmit(e) {
  e.preventDefault();
  const batt = catalogBattery();
  if (!batt) return;
  const v = readForm(e.target, INSTANCE_FORM);
  const label = (v.label || '').trim();
  if (!label) return;
  const rec = savePackInstance({
    id: editingId || newInstanceId(),
    batteryId: batt.id,
    label,
    cycleCount: v.cycles,
    irPackMilliOhm: v.ir,
    irTempC: v.tempC,
  });
  if (!rec) {
    setNote('That needs a name at least — “Pack #2” is enough to tell two of them apart.');
    return;
  }
  const updating = !!editingId;
  // Describing the pack you are holding means you are flying it: select it, and
  // say so in the same breath. The select above and the footnote under the plan
  // both name it afterwards, so nothing here is silent.
  setSelectedInstance(batt.id, rec.id);
  clearForm();
  setNote(`${updating ? 'Updated' : 'Saved'} ${rec.label} — now planning on it. `
    + (Number.isFinite(rec.irPackMilliOhm)
      ? `Its measured ${irPhrase(rec.irPackMilliOhm)} replaces the ${irPhrase(batt.irPackMilliOhm)} on record.`
      : 'Add its measured resistance when you have it and the plan will use that instead.'));
  deps.populateControls();
  deps.update();
}

function onSelect(e) {
  const batt = catalogBattery();
  if (!batt) return;
  setSelectedInstance(batt.id, e.target.value || null);
  clearForm();
  setNote('');
  deps.populateControls();
  deps.update();
}

/** Built once at boot, like the other authoring forms. */
export function buildPackInstanceForm() {
  buildForm(form(), INSTANCE_FORM, { submitLabel: 'Save this pack' });
  form().addEventListener('submit', onSubmit);
  $('sel-pack-instance').addEventListener('change', onSelect);
}
