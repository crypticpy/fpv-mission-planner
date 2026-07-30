// forms.js — build a form out of a descriptor list, and read one back typed.
// Generic on purpose: it knows descriptor shapes, never what the records mean.
//
// A form descriptor is a schema.js field descriptor plus six view-only
// extras — `placeholder`, `value` (prefill), `id` (when app code needs to
// find the control again later), `list` (a `<datalist>` id for native
// autocomplete on a text input), `help` (a line under the control) and `tag`
// (a small provenance chip beside it, addressable later as
// `[data-tag-for="key"]` so a caller can show or hide it as the field's
// provenance changes). Two structural entries: `{ grid: [...] }` wraps a run of
// fields in the two-column `.form-grid` box, and `{ details: { summary, fields } }`
// folds a run away behind a `<summary>` — an Advanced fold is one line of
// descriptor, and the fields inside read back like any other.
// Validation stays the browser's job: required/min/max/step ride on the inputs
// as native attributes, so the pilot gets the platform's own error bubbles
// before submit ever fires.
//
// One type beyond schema.js's own: `checkboxes` — a multi-select rendered as a
// `<fieldset>` of `.check-row` boxes, one per `options` entry (each may carry
// `checked` to seed it), all sharing `f.key` as their `name`. readForm() below
// collects the checked subset back into an array the same way `tags` would.

import { parse } from './schema.js';

const flatten = (fields) => fields.flatMap(f => (
  f.grid ? flatten(f.grid)
    : f.details ? flatten(f.details.fields)
    : [f]
));

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
  if (f.type === 'checkboxes') {
    const fs = document.createElement('fieldset');
    fs.className = 'checkbox-list';
    for (const o of options ?? f.options ?? []) {
      const row = document.createElement('label');
      row.className = 'check-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.name = f.key;
      cb.value = o.value;
      // defaultChecked (not just `.checked`) so the box survives form.reset() —
      // same reasoning as the prefill-as-attribute note on text inputs below.
      cb.defaultChecked = !!o.checked;
      const text = document.createElement('span');
      text.textContent = o.label;
      row.append(cb, text);
      fs.appendChild(row);
    }
    return fs;
  }
  const input = document.createElement('input');
  if (f.type === 'number' || f.type === 'url' || f.type === 'checkbox') input.type = f.type;
  if (f.type === 'number') {
    if (f.min != null) input.min = f.min;
    if (f.max != null) input.max = f.max;
    if (f.step != null) input.step = f.step;
  }
  if (f.placeholder) input.placeholder = f.placeholder;
  if (f.list) input.setAttribute('list', f.list);
  return input;
}

// `tag` is a provenance chip ("class default"), `help` the sentence under the
// control. The chip carries data-tag-for so app code can flip it as the field
// stops being a default and starts being the pilot's own number.
function annotate(label, f) {
  if (f.tag) {
    const tag = document.createElement('span');
    tag.className = 'field-tag';
    tag.dataset.tagFor = f.key;
    tag.textContent = f.tag;
    label.appendChild(tag);
  }
  if (f.help) {
    const help = document.createElement('span');
    help.className = 'field-help';
    help.textContent = f.help;
    label.appendChild(help);
  }
}

function field(f, opts) {
  const el = control(f, opts.options?.[f.key]);
  if (f.type === 'checkboxes') {
    // Not a single control: the individual checkboxes already carry `name`,
    // and a `<label>` wrapping a `<fieldset>` isn't the right a11y shape.
    if (f.id) el.id = f.id;
    const legend = document.createElement('legend');
    legend.textContent = labelText(f);
    el.prepend(legend);
    return el;
  }
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
  annotate(label, f);
  return label;
}

// One run of descriptor entries → the elements they render as. Recursive, so a
// grid inside a fold (or a fold inside a fold) needs no special case.
function section(fields, opts) {
  const out = [];
  for (const entry of fields) {
    if (entry.grid) {
      const box = document.createElement('div');
      box.className = 'form-grid';
      for (const f of entry.grid) box.appendChild(field(f, opts));
      out.push(box);
      continue;
    }
    if (entry.details) {
      const fold = document.createElement('details');
      fold.className = 'form-fold';
      if (entry.id) fold.id = entry.id;
      const summary = document.createElement('summary');
      summary.textContent = entry.details.summary;
      fold.appendChild(summary);
      for (const el of section(entry.details.fields, opts)) fold.appendChild(el);
      out.push(fold);
      continue;
    }
    out.push(field(entry, opts));
  }
  return out;
}

/**
 * Fill an existing `<form>` from `fields`, replacing whatever it held.
 * `opts.options` supplies select choices at build time as
 * `{ [key]: [{ value, label }] }`; `opts.submitLabel` names the button.
 */
export function buildForm(formEl, fields, opts = {}) {
  formEl.replaceChildren();
  for (const el of section(fields, opts)) formEl.appendChild(el);
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
  const multi = {};
  for (const f of flat) {
    if (f.type === 'checkboxes') {
      multi[f.key] = [...formEl.querySelectorAll(`input[type="checkbox"][name="${f.key}"]:checked`)]
        .map(el => el.value);
      continue;
    }
    const el = formEl.elements.namedItem(f.key);
    if (!el) continue;
    raw[f.key] = f.type === 'checkbox' ? el.checked : el.value;
  }
  // schema.parse only ever sees keys `raw` actually has, so the `checkboxes`
  // entries in `flat` are silently skipped there and merged back in as-is.
  return { ...parse(raw, flat), ...multi };
}
