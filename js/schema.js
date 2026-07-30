// schema.js — field descriptors for the two records a pilot can author: a
// battery pack and (next) a drone. One list per record type, consumed three
// ways: to generate the form, to validate what comes back, and to move a
// record in and out of the flat string map a form actually speaks.
//
// A descriptor is `{ key, label, type, unit?, required?, min?, max?, step?,
// options?, help? }`. Types:
//   text | number | select | checkbox | url | tags | group
// `tags` is a comma-separated list of short strings (connectors, fits pins).
// `group` nests a `fields` array one level — the drone's propulsion and power
// blocks — and its children address as `group.child` in the flat map.

import { CLASSES } from './catalog/classes.js';

export const BATTERY_FIELDS = [
  { key: 'id', label: 'Record id', type: 'text', required: true,
    help: 'Stable key. Reusing a catalog id overrides that pack with yours.' },
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'short', label: 'Short label', type: 'text',
    help: 'Compact name for charts and tables. Defaults to the first 14 characters of the name.' },
  { key: 'chem', label: 'Chemistry', type: 'select', required: true, options: [
    { value: 'liion', label: 'Li-Ion' },
    { value: 'lipo', label: 'LiPo' },
    { value: 'lihv', label: 'LiHV' },
  ] },
  { key: 's', label: 'Cells in series', type: 'number', unit: 'S', required: true, min: 1, max: 12, step: 1 },
  { key: 'p', label: 'Cells in parallel', type: 'number', unit: 'P', required: true, min: 1, max: 8, step: 1 },
  { key: 'capAh', label: 'Capacity', type: 'number', unit: 'Ah', required: true, min: 0.1, max: 30, step: 0.1 },
  { key: 'massG', label: 'Pack weight', type: 'number', unit: 'g', required: true, min: 10, max: 3000, step: 1,
    help: 'Weighed, not the label claim — vendor figures on cheap packs are routinely wrong by 30%.' },
  { key: 'irPackMilliOhm', label: 'Pack internal resistance', type: 'number', unit: 'mΩ',
    required: true, min: 1, max: 500, step: 1,
    help: 'Fresh-pack planning number at room temperature. Bump it as the pack ages.' },
  { key: 'maxContA', label: 'Max continuous current', type: 'number', unit: 'A', min: 1, max: 300, step: 1,
    help: 'True continuous, not the burst number on the label. Leave blank to let pack sag set the limit.' },
  { key: 'connector', label: 'Connector', type: 'text', required: true,
    help: 'Matched against the drone’s accepted connectors — spelling matters (XT60, XT30).' },
  { key: 'fits', label: 'Pinned to drones', type: 'tags',
    help: 'Optional override: any drone id listed here counts as compatible no matter what the numbers say.' },
  { key: 'manufacturerId', label: 'Pack builder', type: 'select', required: true, options: [],
    help: 'Filled from the manufacturer registry at form-build time.' },
  { key: 'cellMaker', label: 'Cell maker', type: 'text' },
  { key: 'cellModel', label: 'Cell model', type: 'text' },
  { key: 'config', label: 'Configuration', type: 'text',
    help: 'Defaults to <S>S<P>P.' },
  { key: 'estimated', label: 'Estimated fields', type: 'tags',
    help: 'Field keys you guessed rather than measured. The UI says so wherever this pack is shown.' },
  { key: 'priceUsd', label: 'Price', type: 'number', unit: 'USD', min: 0, max: 5000, step: 0.01 },
];

const PROPULSION_FIELDS = [
  { key: 'motorMaxW', label: 'Motor max power', type: 'number', unit: 'W', required: true, min: 1, max: 5000, step: 1,
    help: 'Per motor, not for the whole aircraft.' },
  { key: 'motorMaxA', label: 'Motor max current', type: 'number', unit: 'A', required: true, min: 1, max: 200, step: 0.01 },
  { key: 'escMaxA', label: 'ESC max current', type: 'number', unit: 'A', required: true, min: 1, max: 200, step: 1 },
  { key: 'confidence', label: 'Confidence', type: 'select', options: [
    { value: 'estimated', label: 'Estimated' },
    { value: 'measured', label: 'Measured' },
  ], help: 'Anything not off a thrust stand is estimated, and is labeled that way in the UI.' },
  { key: 'sourceLabel', label: 'Source', type: 'text' },
  { key: 'sourceUrl', label: 'Source link', type: 'url' },
];

const POWER_FIELDS = [
  { key: 'connectors', label: 'Accepted connectors', type: 'tags', required: true,
    help: 'Everything you can physically plug in — usually one, sometimes a pigtail adapter too.' },
  { key: 'sMin', label: 'Minimum cells', type: 'number', unit: 'S', required: true, min: 1, max: 12, step: 1 },
  { key: 'sMax', label: 'Maximum cells', type: 'number', unit: 'S', required: true, min: 1, max: 12, step: 1 },
  { key: 'maxPackMassG', label: 'Heaviest pack it can carry', type: 'number', unit: 'g', min: 10, max: 5000, step: 1,
    help: 'A mounting limit — how much the strap and frame will hold. Leave blank for unbounded; '
      + 'whether the rig can lift it is the lift envelope’s job, not this field’s.' },
];

export const DRONE_FIELDS = [
  { key: 'id', label: 'Record id', type: 'text', required: true,
    help: 'Stable key. Reusing a catalog id overrides that airframe with yours.' },
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'short', label: 'Short label', type: 'text' },
  { key: 'tag', label: 'One-line tag', type: 'text', help: 'e.g. 7.5" long range · 6S · XT60' },
  { key: 'classId', label: 'Airframe class', type: 'select',
    options: CLASSES.map(c => ({ value: c.id, label: c.label })),
    help: 'Which class template the physics fields came from. Set on a pilot-added rig; '
      + 'the calibrated built-ins anchor the table rather than reading from it.' },
  { key: 'dryMassG', label: 'Dry weight, no pack', type: 'number', unit: 'g', required: true, min: 50, max: 25000, step: 1,
    help: 'Weighed with props, camera mount and receiver on, battery off.' },
  { key: 'propDiaIn', label: 'Prop diameter', type: 'number', unit: 'in', required: true, min: 1, max: 30, step: 0.01 },
  { key: 'numRotors', label: 'Rotors', type: 'number', required: true, min: 3, max: 8, step: 1 },
  { key: 'ducted', label: 'Ducted', type: 'checkbox',
    help: 'Cinewhoop ducts change both the disc model and the drag.' },
  { key: 's', label: 'Nominal cells', type: 'number', unit: 'S', required: true, min: 1, max: 12, step: 1 },
  { key: 'connector', label: 'Connector', type: 'text', required: true },
  { key: 'etaProp', label: 'Propulsive efficiency', type: 'number', required: true, min: 0.1, max: 0.9, step: 0.01,
    help: 'Calibrated against your own logged flights, not a datasheet. Start at 0.55 for a freestyle 7", 0.37 for a 3" duct.' },
  { key: 'cdA', label: 'Drag area', type: 'number', unit: 'm²', required: true, min: 0.001, max: 0.5, step: 0.001 },
  { key: 'avionicsW', label: 'Avionics draw', type: 'number', unit: 'W', required: true, min: 0, max: 100, step: 1,
    help: 'VTX, air unit, FC, GPS, receiver — everything that burns power without turning a prop.' },
  { key: 'maxSpeedMs', label: 'Top speed', type: 'number', unit: 'm/s', required: true, min: 1, max: 80, step: 0.1 },
  { key: 'cruiseMs', label: 'Realistic cruise', type: 'number', unit: 'm/s', required: true, min: 1, max: 60, step: 0.1,
    help: 'How fast you actually fly it, not how fast it goes.' },
  { key: 'motor', label: 'Motor', type: 'text' },
  { key: 'confidence', label: 'Airframe numbers', type: 'select', options: [
    { value: 'estimated', label: 'Estimated' },
    { value: 'measured', label: 'Measured' },
  ], help: 'Where etaProp/cdA came from. Class defaults are estimated until a logged flight calibrates them.' },
  // Not required: nobody who builds their own rig owns a thrust stand, and
  // liftEnvelope() answers a missing block with its honest `unknown` code
  // rather than a fabricated ceiling. Present means complete.
  { key: 'propulsion', label: 'Electrical limits', type: 'group', fields: PROPULSION_FIELDS },
  { key: 'power', label: 'Battery mounting', type: 'group', fields: POWER_FIELDS,
    help: 'What packs will physically go on this rig. Omitted means "exactly its own connector and cell count".' },
  { key: 'parallelHarnessMassG', label: 'Parallel harness allowance', type: 'number', unit: 'g', min: 0, max: 200, step: 1 },
  { key: 'parallelPackCdA', label: 'Second-pack drag area', type: 'number', unit: 'm²', min: 0, max: 0.1, step: 0.001 },
  { key: 'wheelbaseMm', label: 'Wheelbase', type: 'number', unit: 'mm', min: 30, max: 2000, step: 1 },
];

/* ---------- validate ---------- */

const isBlank = (v) => v == null || v === '';

function checkField(f, value, path, errors) {
  const key = path + f.key;
  if (f.type === 'group') {
    if (isBlank(value)) {
      if (f.required) errors.push({ key, msg: `${f.label} is required` });
      return;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push({ key, msg: `${f.label} must be a group of fields` });
      return;
    }
    for (const sub of f.fields) checkField(sub, value[sub.key], `${key}.`, errors);
    return;
  }
  if (f.type === 'tags') {
    if (!Array.isArray(value)) {
      if (f.required || !isBlank(value)) errors.push({ key, msg: `${f.label} must be a list` });
      return;
    }
    if (f.required && value.length === 0) errors.push({ key, msg: `${f.label} is required` });
    if (value.some(v => typeof v !== 'string' || v === '')) {
      errors.push({ key, msg: `${f.label} must be a list of non-empty names` });
    }
    return;
  }
  if (f.type === 'checkbox') {
    if (typeof value !== 'boolean' && !isBlank(value)) {
      errors.push({ key, msg: `${f.label} must be yes or no` });
    }
    return;
  }
  if (isBlank(value)) {
    if (f.required) errors.push({ key, msg: `${f.label} is required` });
    return;
  }
  if (f.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push({ key, msg: `${f.label} must be a number` });
      return;
    }
    if (f.min != null && value < f.min) {
      errors.push({ key, msg: `${f.label} must be at least ${f.min}${f.unit ? ' ' + f.unit : ''}` });
    }
    if (f.max != null && value > f.max) {
      errors.push({ key, msg: `${f.label} must be at most ${f.max}${f.unit ? ' ' + f.unit : ''}` });
    }
    return;
  }
  if (typeof value !== 'string') {
    errors.push({ key, msg: `${f.label} must be text` });
    return;
  }
  if (f.type === 'select' && f.options?.length && !f.options.some(o => o.value === value)) {
    errors.push({ key, msg: `${f.label} is not one of the available choices` });
  }
  if (f.type === 'url' && !/^https?:\/\//i.test(value)) {
    errors.push({ key, msg: `${f.label} must start with http:// or https://` });
  }
}

/**
 * Judge `record` against `fields`. Errors carry the dotted key so a form can
 * put each message on the input that earned it.
 */
export function validate(record, fields) {
  const errors = [];
  const rec = record && typeof record === 'object' ? record : {};
  for (const f of fields) checkField(f, rec[f.key], '', errors);
  return { ok: errors.length === 0, errors };
}

/* ---------- serialize / parse ---------- */

// A form speaks one flat map of strings, so that is the wire format. Keys a
// record does not carry are omitted rather than emitted blank, which is what
// makes parse(serialize(record)) give the record back rather than a version
// with every optional field spelled out as null.

function serializeField(f, value, path, out) {
  const key = path + f.key;
  if (value === undefined) return;
  if (f.type === 'group') {
    if (value === null) { out[key] = ''; return; }
    for (const sub of f.fields) serializeField(sub, value[sub.key], `${key}.`, out);
    return;
  }
  if (value === null) { out[key] = ''; return; }
  if (f.type === 'tags') out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  else if (f.type === 'checkbox') out[key] = value === true ? 'true' : 'false';
  else out[key] = String(value);
}

/** Record → flat `{ 'group.child': string }` map, ready to fill a form. */
export function serialize(record, fields) {
  const out = {};
  const rec = record && typeof record === 'object' ? record : {};
  for (const f of fields) serializeField(f, rec[f.key], '', out);
  return out;
}

function parseValue(f, raw) {
  if (f.type === 'tags') {
    if (Array.isArray(raw)) return raw;
    return String(raw).split(',').map(s => s.trim()).filter(Boolean);
  }
  if (f.type === 'checkbox') return raw === true || raw === 'true' || raw === 'on';
  if (isBlank(raw)) return null;
  if (f.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    return Number.isFinite(n) ? n : NaN;
  }
  return typeof raw === 'string' ? raw.trim() : String(raw);
}

function parseField(f, raw, path, out) {
  const key = path + f.key;
  if (f.type === 'group') {
    if (raw[key] === '') { out[f.key] = null; return; }
    const present = f.fields.some(sub => `${key}.${sub.key}` in raw);
    if (!present) return;
    const group = {};
    for (const sub of f.fields) parseField(sub, raw, `${key}.`, group);
    out[f.key] = group;
    return;
  }
  if (!(key in raw)) return;
  out[f.key] = parseValue(f, raw[key]);
}

/**
 * Flat map → record. Lenient by design: blanks come back as null and an
 * unparseable number as NaN, so `validate` is the single place that judges.
 * `parse(serialize(r), fields)` is `r` for any record that validates.
 */
export function parse(raw, fields) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const f of fields) parseField(f, src, '', out);
  return out;
}
