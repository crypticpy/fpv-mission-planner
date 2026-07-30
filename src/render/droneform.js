// render/droneform.js — add-your-own-drone (§6.1). The form, its class-template
// prefills, the derived cross-checks, and the custom-rig list with its delete
// links. Owns no state beyond which fields the pilot has typed in.
//
// The three rules the design pass settled on, and what each one is here:
//   - Zero required physics fields. Required: name, class, dry mass, prop
//     diameter, rotor count, cell count. Everything else arrives from the class
//     template wearing a "class default" chip, and re-arrives when the class
//     changes — until the pilot types in that field, after which it is theirs.
//   - Soft validation, hard cross-checks. Nothing here blocks a save on a class
//     range (people build weird things); the readout under the form computes
//     disc loading, W/kg, implied hover throttle, and says plainly when a value
//     is unusual for the class.
//   - Live effect while typing. One line — "with GNB 850: hover ~6:12" — from
//     the same powerAtSpeed/dischargeSim pair the planner uses. Debounced at
//     150 ms and deliberately *not* a planMission sweep: a hover estimate
//     teaches the physics for a keystroke's worth of work.
import { CLASSES, classById } from '../catalog/classes.js';
import {
  allDrones, allBatteries, saveCustomDrone, deleteCustomDrone, compatibleBatteries,
} from '../registry.js';
import { state, battery, payload, packTemp } from '../state.js';
import { airDensity, discAreaM2, powerAtSpeed, dischargeSim, U } from '../physics.js';
import { buildForm, readForm } from '../forms.js';
import { CONFIDENCE_OPTIONS, normalizeConfidence } from '../schema.js';
import { THRUST_FIELDS, mountThrustField, syncThrustField, resetThrustField } from './thrustfield.js';
import { f0, f1, mmss, ratio } from './format.js';
import { $, fillSelect } from './dom.js';

let deps = null; // injected by app.js: { update, populateControls }
export function setupDroneForm(d) { deps = d; }

// The class this form opens on: the commonest self-built rig, and the one whose
// numbers a pilot is most likely to already have an opinion about.
const DEFAULT_CLASS = 'freestyle5';

// Short on purpose: the chip rides beside a label in a two-column grid, and the
// sentence it stands for ("log a flight to calibrate") is told once, on the class
// select that fills all of these in.
const CLASS_TAG = 'class default';

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

/* ---------- what a class template fills in ---------- */

const anchorDrone = (cls) => (cls.anchoredBy ? allDrones().find(d => d.id === cls.anchoredBy) : null);

/**
 * The cell count to open with. An anchored class hands over its real airframe's
 * count; otherwise 6S clamped into the class's range, which is where the market
 * has settled for everything from a 4" to a cinelifter (and lands on 4S for the
 * 1–4S whoops, which is also right).
 */
function nominalS(cls) {
  const anchor = anchorDrone(cls);
  if (anchor) return anchor.s;
  return Math.min(Math.max(6, cls.sMin), cls.sMax);
}

/**
 * Connector convention, not physics — which is why it wears the same "class
 * default" chip as everything else and is one text field away from being
 * corrected. Anchored classes answer from their real airframe; otherwise it is
 * the size split every vendor uses: XT30 up to a 3" duct, XT60 above it.
 */
function classConnector(cls) {
  const anchor = anchorDrone(cls);
  if (anchor) return anchor.connector;
  return cls.propDiaIn <= 3.2 ? 'XT30' : 'XT60';
}

// Form key → the class template's answer for it. Everything in here re-prefills
// on a class change and carries the provenance chip.
const FROM_CLASS = {
  propDia: (c) => c.propDiaIn,
  rotors: (c) => c.numRotors,
  s: nominalS,
  connector: classConnector,
  etaProp: (c) => c.etaProp,
  cdA: (c) => c.cdA,
  avionicsW: (c) => c.avionicsW,
  maxSpeed: (c) => c.maxSpeedMs,
  cruise: (c) => c.cruiseMs,
};

// Fields the pilot has typed in. A class change leaves these alone — the whole
// point of the chip is that it disappears when the number stops being a guess.
const dirty = new Set();

/* ---------- the descriptor ---------- */

// Form keys are the pilot's vocabulary, not the record's; recordFromForm() below
// owns the mapping onto a drone record the same way the battery form's handler
// does. Required is exactly §6.1's list.
export const DRONE_FORM = [
  { key: 'cloneFrom', label: 'Start from', type: 'select', id: 'drone-clone', options: [],
    help: 'Copies an existing rig in — “like a Cinelog30, but…”. The name stays yours.' },
  { key: 'name', label: 'Name', type: 'text', required: true, id: 'drone-name', placeholder: 'My 5" freestyle' },
  { key: 'classId', label: 'Class', type: 'select', required: true, id: 'drone-class', options: [],
    help: 'Fills in every flight number for you. Anything marked “class default” is the table’s '
      + 'estimate — log a flight to calibrate it, or type over it now.' },
  { key: 'dryMass', label: 'Dry weight', type: 'number', unit: 'g', required: true,
    min: 15, max: 25000, step: 1, id: 'drone-drymass',
    help: 'No pack, no camera — props, mount and receiver on, battery off. Weighed, not the listing’s claim.' },
  { details: { summary: 'Weighed it with the pack installed?', fields: [
    { key: 'weighPack', label: 'Pack it was weighed with', type: 'select', id: 'drone-weigh-pack', options: [] },
    { key: 'weighTotal', label: 'Measured total', type: 'number', unit: 'g', min: 20, max: 30000, step: 1,
      id: 'drone-weigh-total',
      help: 'Everything on the scale at once. Dry weight above fills in as total minus that pack.' },
  ] } },
  { grid: [
    { key: 'propDia', label: 'Prop diameter', type: 'number', unit: 'in', required: true,
      min: 1, max: 30, step: 0.01, id: 'drone-propdia', tag: CLASS_TAG },
    { key: 'rotors', label: 'Rotors', type: 'number', required: true, min: 3, max: 8, step: 1,
      id: 'drone-rotors', tag: CLASS_TAG },
    { key: 's', label: 'Cells', type: 'number', unit: 'S', required: true, min: 1, max: 12, step: 1,
      id: 'drone-s', tag: CLASS_TAG },
    { key: 'connector', label: 'Connector', type: 'text', id: 'drone-connector',
      list: 'connector-datalist', tag: CLASS_TAG },
  ] },
  { details: { summary: 'Advanced — the numbers the class guesses for you', fields: [
    { grid: [
      { key: 'etaProp', label: 'Propulsive efficiency', type: 'number', min: 0.1, max: 0.9, step: 0.01,
        id: 'drone-eta', tag: CLASS_TAG },
      { key: 'cdA', label: 'Drag area', type: 'number', unit: 'm²', min: 0.001, max: 0.5, step: 0.001,
        id: 'drone-cda', tag: CLASS_TAG },
      { key: 'avionicsW', label: 'Avionics draw', type: 'number', unit: 'W', min: 0, max: 100, step: 1,
        id: 'drone-avionics', tag: CLASS_TAG },
      { key: 'maxSpeed', label: 'Top speed', type: 'number', unit: 'm/s', min: 1, max: 80, step: 0.1,
        id: 'drone-maxspeed', tag: CLASS_TAG },
      { key: 'cruise', label: 'Realistic cruise', type: 'number', unit: 'm/s', min: 1, max: 60, step: 0.1,
        id: 'drone-cruise', tag: CLASS_TAG },
    ] },
    // Same vocabulary the catalog's propulsion blocks use (schema.js's three
    // tiers), for the same reason: the UI says which of the three a rig's numbers
    // are, wherever they are shown.
    { key: 'confidence', label: 'Where these numbers came from', type: 'select', id: 'drone-confidence',
      options: CONFIDENCE_OPTIONS },
    // The escape hatch for the lift ceiling — see render/thrustfield.js.
    ...THRUST_FIELDS,
  ] } },
];

/* ---------- control access ---------- */

const form = () => $('drone-form');
const ctrl = (key) => form()?.elements.namedItem(key) || null;

function setValue(key, v) {
  const el = ctrl(key);
  if (!el) return;
  const s = v == null ? '' : String(v);
  // The attribute, not just the property: that is what form.reset() puts back
  // after a save (same reasoning as forms.js's prefills).
  if (el.tagName === 'INPUT') el.setAttribute('value', s);
  el.value = s;
}

function setTag(key, on) {
  const tag = form()?.querySelector(`[data-tag-for="${key}"]`);
  if (tag) tag.hidden = !on;
}

function setNote(msg) {
  const el = $('drone-note');
  el.textContent = msg || '';
  el.hidden = !msg;
}

/** Re-prefill every class-owned field the pilot has not typed in, chips and all. */
function applyClassDefaults(classId) {
  const cls = classById(classId);
  if (!cls) return;
  for (const [key, from] of Object.entries(FROM_CLASS)) {
    const own = dirty.has(key);
    if (!own) setValue(key, from(cls));
    setTag(key, !own);
  }
}

/* ---------- clone-and-edit ---------- */

/**
 * Which class an existing record belongs to, when it doesn't say. Prop diameter
 * inside a class's sanity range decides it, ducts break the tie — that is
 * exactly the pair of facts that separates a 3" cinewhoop from a 4" freestyle.
 */
function inferClass(d) {
  const inRange = CLASSES.filter(c => {
    const [lo, hi] = c.ranges.propDiaIn;
    return d.propDiaIn >= lo && d.propDiaIn <= hi;
  });
  const pool = inRange.length ? inRange : CLASSES;
  const ducted = pool.filter(c => !!c.ducted === !!d.ducted);
  return (ducted.length ? ducted : pool)
    .reduce((a, c) => (Math.abs(c.propDiaIn - d.propDiaIn) < Math.abs(a.propDiaIn - d.propDiaIn) ? c : a));
}

function applyClone(id) {
  const src = allDrones().find(d => d.id === id);
  if (!src) return;
  const cls = classById(src.classId) || inferClass(src);
  dirty.clear();
  // The paste box describes whatever rig was in the form a moment ago, not this
  // one — clear it before the clone's own figure lands below.
  resetThrustField(form());
  setValue('classId', cls.id);
  applyClassDefaults(cls.id);
  const from = {
    propDia: src.propDiaIn, rotors: src.numRotors, s: src.s, connector: src.connector,
    etaProp: src.etaProp, cdA: src.cdA, avionicsW: src.avionicsW,
    maxSpeed: src.maxSpeedMs, cruise: src.cruiseMs,
  };
  for (const [key, v] of Object.entries(from)) {
    setValue(key, v);
    // A value that disagrees with the class default is the source record's own
    // measurement, not a guess — so it loses the chip and survives a class change.
    if (String(v) !== String(FROM_CLASS[key](cls))) { dirty.add(key); setTag(key, false); }
  }
  setValue('dryMass', src.dryMassG);
  setValue('maxThrustGPerRotor', src.maxThrustGPerRotor ?? '');
  setValue('confidence', normalizeConfidence(src.confidence || src.propulsion?.confidence));
  setValue('name', '');
  ctrl('name')?.focus();
}

/* ---------- weigh-ready-to-fly helper ---------- */

// Beginners weigh the rig with the battery in, because that is how it sits on
// the scale. Subtract the pack they named rather than telling them they measured
// the wrong thing.
function applyWeighHelper() {
  const pack = allBatteries().find(b => b.id === ctrl('weighPack')?.value);
  const total = Number(ctrl('weighTotal')?.value);
  if (!pack || !Number.isFinite(total) || !(total > pack.massG)) return;
  // Property only, not the attribute setValue() would also write: this is a
  // live scratch computation from the weigh-in fields, not a record being
  // edited, so a post-save form.reset() must not bring this rig's dry mass
  // back as the default for the next blank form.
  const el = ctrl('dryMass');
  if (el) el.value = String(Math.round(total - pack.massG));
}

/* ---------- form values → a drone record ---------- */

/**
 * The record planMission will read. Every field the pilot left alone comes from
 * the class template, so what comes out of here is always complete — which is
 * what registry.loadCustomDrones()'s gate is checking on the way back in.
 *
 * `power` collapses to exactly the cell count entered: a rig that takes a range
 * of packs is a claim the form never asked the pilot to make.
 */
export function recordFromForm(v) {
  const cls = classById(v.classId) || classById(DEFAULT_CLASS);
  const num = (x, fb) => (Number.isFinite(x) ? x : fb);
  const name = (v.name || '').trim();
  const src = v.cloneFrom ? allDrones().find(d => d.id === v.cloneFrom) : null;
  const s = num(v.s, nominalS(cls));
  const connector = (v.connector || '').trim() || classConnector(cls);
  const propDiaIn = num(v.propDia, cls.propDiaIn);
  const confidence = normalizeConfidence(v.confidence);
  const rec = {
    id: `custom-drone-${slug(name) || 'unnamed'}`,
    name,
    short: name.slice(0, 14),
    tag: `${cls.label} · ${s}S · ${connector}`,
    classId: cls.id,
    dryMassG: num(v.dryMass, cls.ranges.dryMassG[0]),
    propDiaIn,
    numRotors: num(v.rotors, cls.numRotors),
    ducted: !!cls.ducted,
    s,
    connector,
    power: { connectors: [connector], sMin: s, sMax: s, maxPackMassG: null },
    etaProp: num(v.etaProp, cls.etaProp),
    cdA: num(v.cdA, cls.cdA),
    avionicsW: num(v.avionicsW, cls.avionicsW),
    maxSpeedMs: num(v.maxSpeed, cls.maxSpeedMs),
    cruiseMs: num(v.cruise, cls.cruiseMs),
    // Per-airframe honesty (§6.2): this is what the UI reads to decide whether a
    // rig is running class estimates or the pilot's own measurements.
    confidence,
    custom: true,
  };
  // Motor and ESC limits only ever come from a cloned record — the form does not
  // ask, because a pilot has no way to know them. Absent means liftEnvelope()
  // says `unknown` instead of inventing a ceiling.
  if (src?.propulsion) rec.propulsion = { ...src.propulsion, confidence };
  if (src?.motor) rec.motor = src.motor;
  // A measured ceiling, when there is one. On the form rather than carried
  // silently off the clone source, so clearing the field really does take the
  // override back off.
  if (Number.isFinite(v.maxThrustGPerRotor)) rec.maxThrustGPerRotor = v.maxThrustGPerRotor;
  if (Number.isFinite(src?.parallelHarnessMassG)) rec.parallelHarnessMassG = src.parallelHarnessMassG;
  if (Number.isFinite(src?.parallelPackCdA)) rec.parallelPackCdA = src.parallelPackCdA;
  return rec;
}

/* ---------- cross-checks and the live line ---------- */

/** The pack the readout flies: the one in the rail if this rig takes it, else the first that fits. */
function readoutPack(rec) {
  const fits = compatibleBatteries(rec);
  if (!fits.length) return null;
  const selected = battery();
  return fits.find(b => b.id === selected?.id) || fits[0];
}

function crossChecks(rec) {
  const pack = readoutPack(rec);
  if (!pack) return null;
  const tempC = U.fToC(state.env.tempF);
  const { rho } = airDensity(U.ftToM(state.env.elevFt), tempC, state.env.rhPct);
  // Air for the density, the pack's own temperature for the discharge — the same
  // split planMission makes, so this readout agrees with the plan above it.
  const packTempC = packTemp().tempC;
  const p = payload();
  const massKg = (rec.dryMassG + pack.massG + p.massG + (state.extraG || 0)) / 1000;
  const areaM2 = discAreaM2(rec);
  const pHover = powerAtSpeed({
    massKg, rho, areaM2, cdA: rec.cdA + (p.cdA || 0), etaProp: rec.etaProp, avionicsW: rec.avionicsW,
  }, 0);
  // The hover readout is a hover, so the pack-care floor is the only reserve that
  // applies — there is no turnaround to hold get-home energy for. Same clamp
  // planMission uses on `landFloorPct`.
  const reserve = Math.min(Math.max(state.landFloorPct, 0), 60) / 100;
  const motorW = rec.propulsion?.motorMaxW ? rec.propulsion.motorMaxW * rec.numRotors : null;
  // A pasted bench figure answers the lift question outright, so the readout
  // quotes it while the pilot is still typing — that is the number they came to
  // the fold for.
  const benchG = Number.isFinite(rec.maxThrustGPerRotor)
    ? rec.maxThrustGPerRotor * rec.numRotors : null;
  return {
    pack,
    massKg,
    hoverMin: pHover > 0 ? dischargeSim(pack, packTempC, pHover).deliveredWh * (1 - reserve) / pHover * 60 : 0,
    discLoadingGcm2: (massKg * 1000) / (areaM2 * 1e4),
    wPerKg: pHover / massKg,
    throttlePct: motorW ? (pHover / motorW) * 100 : null,
    benchTwr: benchG ? benchG / (massKg * 1000) : null,
  };
}

// Class-range checks, in the order a pilot would re-measure them. Range keys are
// the record's own keys, so the class table stays the single source of truth.
const RANGE_CHECKS = [
  ['dryMassG', 'dry weight', ' g', f0],
  ['propDiaIn', 'prop diameter', '″', f1],
  ['cruiseMs', 'cruise speed', ' m/s', f1],
  ['maxSpeedMs', 'top speed', ' m/s', f1],
  ['etaProp', 'propulsive efficiency', '', (v) => v.toFixed(2)],
  ['cdA', 'drag area', ' m²', (v) => v.toFixed(3)],
  ['avionicsW', 'avionics draw', ' W', f0],
];

/** Warn, never block (§6.1): people build weird things, and the model still runs. */
function rangeWarnings(rec) {
  const cls = classById(rec.classId);
  if (!cls) return [];
  const out = [];
  for (const [key, label, unit, fmt] of RANGE_CHECKS) {
    const range = cls.ranges[key];
    const v = rec[key];
    if (!range || !Number.isFinite(v)) continue;
    const [lo, hi] = range;
    if (v >= lo && v <= hi) continue;
    out.push(`${fmt(v)}${unit} ${label} is unusual for a ${cls.label} `
      + `(${fmt(lo)}–${fmt(hi)}${unit}) — double-check it.`);
  }
  if (Number.isFinite(rec.s) && (rec.s < cls.sMin || rec.s > cls.sMax)) {
    out.push(`${rec.s}S is unusual for a ${cls.label} (${cls.sMin}–${cls.sMax}S) — double-check it.`);
  }
  return out;
}

function renderReadout() {
  const v = readForm(form(), DRONE_FORM);
  const rec = recordFromForm(v);
  const live = $('drone-live');
  const checks = $('drone-checks');
  const warn = $('drone-warn');
  // Dry weight is the one number nothing can guess, so until it is on the form
  // this line asks for it rather than quoting a hover time for a mass the pilot
  // never typed.
  if (!Number.isFinite(v.dryMass)) {
    live.textContent = 'Pick a class and weigh the rig — this line will say what it would fly like.';
    checks.textContent = '';
    warn.hidden = true;
    return;
  }
  const c = crossChecks(rec);
  if (!c) {
    // The same hole the NO PACK verdict answers, said early enough to fix.
    live.textContent = `No pack in your list fits a ${rec.s}S ${rec.connector} rig — `
      + 'add one above and this rig will plan.';
    checks.textContent = '';
  } else {
    live.textContent = `With ${c.pack.short || c.pack.name}: hover ~${mmss(c.hoverMin)} `
      + `at ${f0(c.massKg * 1000)} g all-up.`;
    checks.textContent = [
      `${c.discLoadingGcm2.toFixed(2)} g/cm² disc loading`,
      `${f0(c.wPerKg)} W/kg hovering`,
      c.throttlePct != null
        ? `hover ~${f0(c.throttlePct)}% of the motors' rating`
        : null,
      c.benchTwr != null
        ? `${ratio(c.benchTwr)} thrust-to-weight off your table`
        : c.throttlePct == null
          ? 'no motor limits on record — the lift ceiling stays unmodeled'
          : null,
    ].filter(Boolean).join(' · ');
  }
  const lines = rangeWarnings(rec);
  warn.textContent = lines.join(' ');
  warn.hidden = lines.length === 0;
}

// Same debounce the resize handler uses: enough to keep a keystroke cheap,
// short enough that the line reads as live.
let readoutTimer = 0;
function queueReadout() {
  clearTimeout(readoutTimer);
  readoutTimer = setTimeout(renderReadout, 150);
}

/* ---------- events ---------- */

function onEdit(e) {
  const key = e.target?.name;
  if (key === 'classId') applyClassDefaults(e.target.value);
  else if (key === 'cloneFrom') { if (e.target.value) applyClone(e.target.value); }
  else if (key === 'weighPack' || key === 'weighTotal') applyWeighHelper();
  else if (key === 'thrustTable') syncThrustField(form(), key);
  else if (key && key in FROM_CLASS) { dirty.add(key); setTag(key, false); }
  queueReadout();
}

function onSubmit(e) {
  e.preventDefault();
  const v = readForm(e.target, DRONE_FORM);
  if (!(v.name || '').trim()) return;
  const rec = recordFromForm(v);
  // Same id = same rig: saveCustomDrone upserts, so say which happened (the
  // saved-spots form set this precedent).
  const replacing = allDrones().some(d => d.id === rec.id);
  saveCustomDrone(rec);
  state.droneId = rec.id;
  // populateControls() below re-picks the pack and clears a manufacturer filter
  // that no longer has anything in it, so nothing else needs fixing here.
  e.target.reset();
  dirty.clear();
  resetThrustField(e.target);
  setValue('cloneFrom', '');
  setValue('classId', rec.classId); // reset() would drop back to the first class
  applyClassDefaults(rec.classId);
  setNote(`${replacing ? 'Updated' : 'Saved'} “${rec.name}” — ${rec.tag}.`);
  deps.populateControls();
  deps.update();
  queueReadout();
}

/* ---------- lists and option refresh ---------- */

const cloneOptions = () => [
  { value: '', label: 'Blank — start from the class' },
  ...allDrones().map(d => ({ value: d.id, label: d.name })),
];

const packOptions = () => [
  { value: '', label: 'Pick the pack you weighed' },
  ...allBatteries().map(b => ({ value: b.id, label: `${b.name} · ${f0(b.massG)} g` })),
];

function refreshSelect(key, items) {
  const sel = ctrl(key);
  if (!sel) return;
  const keep = sel.value;
  fillSelect(sel, items, items.some(i => i.value === keep) ? keep : (items[0]?.value ?? ''));
}

// Native autocomplete for the connector field: every connector the registry has
// ever seen, so "XT60" is a pick rather than a spelling test — the string is
// matched exactly by registry.compatible().
function renderConnectorDatalist() {
  const host = $('connector-datalist');
  host.replaceChildren();
  const seen = new Set([
    ...allBatteries().map(b => b.connector),
    ...allDrones().flatMap(d => [d.connector, ...(d.power?.connectors || [])]),
  ].filter(Boolean));
  for (const c of seen) {
    const opt = document.createElement('option');
    opt.value = c;
    host.appendChild(opt);
  }
}

function renderDroneList() {
  const host = $('drone-list');
  host.replaceChildren();
  for (const d of allDrones().filter(x => x.custom)) {
    const row = document.createElement('div');
    row.className = 'custom-row';
    const name = document.createElement('span');
    const cls = classById(d.classId);
    name.textContent = `${d.name}${cls ? ` · ${cls.label}` : ''}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'remove';
    del.className = 'link-btn';
    del.addEventListener('click', () => {
      deleteCustomDrone(d.id);
      // Deleting the rig you're planning with can't leave the rail pointing at
      // nothing: fall back to the first built-in and let populateControls()
      // re-pick a pack for it.
      if (state.droneId === d.id) state.droneId = allDrones()[0].id;
      setNote(`Removed “${d.name}”.`);
      deps.populateControls();
      deps.update();
    });
    row.append(name, del);
    host.appendChild(row);
  }
}

/* ---------- setup ---------- */

/** Built once at boot, like the battery form. */
export function buildDroneForm() {
  if (!$('connector-datalist')) {
    const dl = document.createElement('datalist');
    dl.id = 'connector-datalist';
    document.body.appendChild(dl);
  }
  const el = form();
  buildForm(el, DRONE_FORM, {
    submitLabel: 'Save drone',
    options: {
      cloneFrom: cloneOptions(),
      // The tag carries the S range and whether it's ducted, so the choice is
      // made on what the airframe *is* rather than on a bare size.
      classId: CLASSES.map(c => ({ value: c.id, label: c.tag })),
      weighPack: packOptions(),
    },
  });
  mountThrustField(el);
  setValue('classId', DEFAULT_CLASS);
  applyClassDefaults(DEFAULT_CLASS);
  el.addEventListener('input', onEdit);
  el.addEventListener('change', onEdit);
  el.addEventListener('submit', onSubmit);
  renderConnectorDatalist();
  renderReadout();
}

/**
 * Keep the form's registry-backed parts in step: the clone roster, the pack list
 * the weigh helper subtracts from, the connector suggestions, and the custom-rig
 * list. Called from populateControls() on every state change.
 */
export function renderDroneForm() {
  refreshSelect('cloneFrom', cloneOptions());
  refreshSelect('weighPack', packOptions());
  renderConnectorDatalist();
  renderDroneList();
  renderReadout();
}
