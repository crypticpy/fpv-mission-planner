// forms.js — build a form out of a descriptor list, and read one back typed.
// Generic on purpose: it knows descriptor shapes, never what the records mean.
//
// A form descriptor is a schema.js field descriptor plus three view-only
// extras — `placeholder`, `value` (prefill) and `id` (when app code needs to
// find the control again later) — and a `{ grid: [...] }` entry wraps a run of
// fields in the two-column `.form-grid` box. Validation stays the browser's
// job: required/min/max/step ride on the inputs as native attributes, so the
// pilot gets the platform's own error bubbles before submit ever fires.

import { parse } from './schema.js';

const flatten = (fields) => fields.flatMap(f => (f.grid ? f.grid : [f]));

const labelText = (f) => (f.unit ? `${f.label} (${f.unit})` : f.label);

function control(f, options) {
  if (f.type === 'select') {
    const sel = document.createElement('select');
    for (const o of options ?? f.options ?? []) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    return sel;
  }
  const input = document.createElement('input');
  if (f.type === 'number' || f.type === 'url' || f.type === 'checkbox') input.type = f.type;
  if (f.type === 'number') {
    if (f.min != null) input.min = f.min;
    if (f.max != null) input.max = f.max;
    if (f.step != null) input.step = f.step;
  }
  if (f.placeholder) input.placeholder = f.placeholder;
  return input;
}

function field(f, opts) {
  const el = control(f, opts.options?.[f.key]);
  el.name = f.key;
  if (f.id) el.id = f.id;
  if (f.required) el.required = true;
  // A prefill has to be the input's *attribute*, not just its current value:
  // that is what form.reset() puts back after a save.
  if (f.value !== undefined) {
    if (el.tagName === 'INPUT') el.setAttribute('value', f.value);
    else el.value = f.value;
  }

  const label = document.createElement('label');
  if (f.type === 'checkbox') {
    // The rail's own checkbox shape: box first, text in a span beside it.
    label.className = 'check-row';
    const text = document.createElement('span');
    text.textContent = labelText(f);
    label.append(el, text);
  } else {
    label.append(`${labelText(f)} `, el);
  }
  return label;
}

/**
 * Fill an existing `<form>` from `fields`, replacing whatever it held.
 * `opts.options` supplies select choices at build time as
 * `{ [key]: [{ value, label }] }`; `opts.submitLabel` names the button.
 */
export function buildForm(formEl, fields, opts = {}) {
  formEl.replaceChildren();
  for (const entry of fields) {
    if (entry.grid) {
      const box = document.createElement('div');
      box.className = 'form-grid';
      for (const f of entry.grid) box.appendChild(field(f, opts));
      formEl.appendChild(box);
      continue;
    }
    formEl.appendChild(field(entry, opts));
  }
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = opts.submitLabel ?? 'Save';
  formEl.appendChild(submit);
}

/**
 * Read a form built from `fields` back as typed values — numbers as numbers,
 * blanks as null, tags as arrays. Coercion is schema.parse's, so a form and a
 * stored record come out of their respective wire formats the same way.
 */
export function readForm(formEl, fields) {
  const flat = flatten(fields);
  const raw = {};
  for (const f of flat) {
    const el = formEl.elements.namedItem(f.key);
    if (!el) continue;
    raw[f.key] = f.type === 'checkbox' ? el.checked : el.value;
  }
  return parse(raw, flat);
}
