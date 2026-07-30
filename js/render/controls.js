// render/controls.js — write `state` onto the control rail, and generate the
// authoring forms behind it. The one render module that also reads controls
// back: populateControls() resets an expert control that just went off screen.
import {
  DRONES, PAYLOADS, WEATHER, SCENARIOS,
  allBatteries, allManufacturers, deleteCustomBattery, deleteCustomManufacturer,
} from '../data.js';
import {
  state, beginner, units, drone, droneBatteries, compatibleBatteries, battery,
  manufacturer, loadoutBattery, EXPERT_CRUISE_MODES,
} from '../state.js';
import { buildForm } from '../forms.js';
import { f0, compass, surfaceMph, estimatedPhrase } from './format.js';
import { $ } from './dom.js';

let deps = null; // injected by app.js: { update }
export function setupControls(d) { deps = d; }

/* ---------- control population ---------- */

export function fillSelect(sel, items, value) {
  sel.replaceChildren();
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.value;
    o.textContent = it.label;
    sel.appendChild(o);
  }
  sel.value = value;
}

function configureNumericInput(input, config, value) {
  input.min = config.min;
  input.max = config.max;
  input.step = config.step;
  input.value = Math.round(value / config.step) * config.step;
}

export function populateControls() {
  const u = units();
  // Beginner mode can never sit on an expert control that is off screen: the
  // thing that would change it back is hidden. Same rule for both.
  if (beginner() && EXPERT_CRUISE_MODES.includes(state.cruiseMode)) state.cruiseMode = 'real';
  if (beginner() && state.parallelPacks) state.parallelPacks = false;
  document.body.dataset.detail = state.detail;
  $('sel-detail').value = state.detail;
  $('sel-units').value = state.units;
  fillSelect($('sel-drone'), DRONES.map(d => ({ value: d.id, label: d.name })), state.droneId);
  const manufacturerIds = new Set(droneBatteries().map(b => b.manufacturerId || 'custom'));
  const availableManufacturers = allManufacturers().filter(m => manufacturerIds.has(m.id));
  if (state.manufacturerId !== 'all' && !manufacturerIds.has(state.manufacturerId)) state.manufacturerId = 'all';
  fillSelect($('sel-manufacturer'), [
    { value: 'all', label: 'All manufacturers' },
    ...availableManufacturers.map(m => ({ value: m.id, label: m.name })),
  ], state.manufacturerId);

  const batts = compatibleBatteries();
  if (!batts.find(b => b.id === state.batteryId)) state.batteryId = batts[0]?.id;
  fillSelect($('sel-battery'), batts.map(b => ({ value: b.id, label: `${b.name} · ${b.massG} g` })), state.batteryId);
  $('in-parallel').checked = state.parallelPacks;
  const configuredBatt = loadoutBattery();
  const parallelSummary = $('parallel-summary');
  parallelSummary.hidden = !state.parallelPacks || !configuredBatt;
  parallelSummary.textContent = state.parallelPacks && configuredBatt
    ? `${configuredBatt.config} effective · ${f0(configuredBatt.capAh * 1000)} mAh · ${f0(configuredBatt.massG)} g batteries + harness`
    : '';
  fillSelect($('sel-payload'), PAYLOADS.map(p => ({ value: p.id, label: p.name })), state.payloadId);
  fillSelect($('sel-weather'), [
    { value: 'live', label: 'Live — current conditions' },
    ...WEATHER.map(w => ({ value: w.id, label: w.name })),
    { value: 'custom', label: 'Custom weather' },
  ], state.weatherId);
  // This dropdown can halve the plan, so the speed it implies is on the option
  // itself — before the pilot picks it, not after. Rebuilt on every drone and
  // unit change, since both move the number.
  fillSelect($('sel-scenario'), SCENARIOS.map(s => ({
    value: s.id,
    label: `${s.name} · ~${f0(u.speedFromMs(drone().cruiseMs * s.speedFactor))} ${u.speedUnit}`,
  })), state.scenarioId);
  $('in-elev').value = state.env.elevFt;
  $('in-temp').value = state.env.tempF;
  $('in-rh').value = state.env.rhPct;
  configureNumericInput($('in-wind'), u.input.wind, u.speedFromMph(state.env.windMph));
  configureNumericInput($('in-gust'), u.input.gust, u.speedFromMph(state.env.gustMph));
  $('wind-label').textContent = `Wind aloft (${u.speedUnit})`;
  $('gust-label').textContent = `Gusts (${u.speedUnit})`;
  $('in-winddir').value = state.env.windFromDeg;
  $('wind-note').textContent =
    `The plan flies the 80 m wind — ${f0(u.speedFromMph(state.env.windMph))} ${u.speedUnit} from ${state.env.windFromDeg}° (${compass(state.env.windFromDeg)}). `
    + `At the launch point you’ll feel roughly half of it, about ${f0(u.speedFromMph(surfaceMph(state.env.windMph)))} ${u.speedUnit}.`;
  $('sel-windmode').value = state.env.windMode;
  $('in-reserve').value = state.reservePct;
  $('reserve-val').textContent = `${state.reservePct}%`;
  fillSelect($('sel-cruise'), [
    { value: 'real', label: 'Realistic — how you’d fly it' },
    ...(beginner() ? [] : [
      { value: 'range', label: 'Theoretical best range' },
      { value: 'manual', label: 'Manual' },
    ]),
  ], state.cruiseMode);
  configureNumericInput($('in-speed'), u.input.manualSpeed, u.speedFromMph(state.manualMph));
  $('speed-val').textContent = `${f0(u.speedFromMph(state.manualMph))} ${u.speedUnit}`;
  $('speed-row').hidden = state.cruiseMode !== 'manual';
  $('in-extra').value = state.extraG;
  renderCustomList();
  renderManufacturerList();
  renderManufacturerDatalist();
}

// The battery form's brand input autocompletes against this — native
// datalist, no JS widget — so it has to stay in step with the registry the
// same way the manufacturer rail select does.
function renderManufacturerDatalist() {
  const host = $('manufacturer-datalist');
  host.replaceChildren();
  for (const m of allManufacturers()) {
    const opt = document.createElement('option');
    opt.value = m.name;
    host.appendChild(opt);
  }
}

function renderCustomList() {
  const host = $('custom-list');
  host.replaceChildren();
  for (const b of allBatteries().filter(b => b.custom)) {
    const row = document.createElement('div');
    row.className = 'custom-row';
    const name = document.createElement('span');
    name.textContent = `${manufacturer(b.manufacturerId)?.name || 'Custom'} · ${b.name}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'remove';
    del.className = 'link-btn';
    del.addEventListener('click', () => { deleteCustomBattery(b.id); populateControls(); deps.update(); });
    row.append(name, del);
    host.appendChild(row);
  }
}

function renderManufacturerList() {
  const host = $('manufacturer-list');
  host.replaceChildren();
  const customBatts = allBatteries().filter(b => b.custom);
  for (const m of allManufacturers().filter(m => m.custom)) {
    const row = document.createElement('div');
    row.className = 'custom-row';
    const name = document.createElement('span');
    const batteryCount = customBatts.filter(b => b.manufacturerId === m.id).length;
    name.textContent = `${m.name}${batteryCount ? ` · ${batteryCount} pack${batteryCount === 1 ? '' : 's'}` : ''}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = batteryCount ? 'in use' : 'remove';
    del.className = 'link-btn';
    del.disabled = batteryCount > 0;
    del.title = batteryCount ? 'Remove this manufacturer’s batteries first.' : '';
    del.addEventListener('click', () => {
      deleteCustomManufacturer(m.id);
      populateControls();
      deps.update();
    });
    row.append(name, del);
    host.appendChild(row);
  }
}

export function renderBatteryNote() {
  const host = $('battery-note');
  host.replaceChildren();
  const b = battery();
  const effective = loadoutBattery(b);
  const m = manufacturer(b.manufacturerId);
  const identity = [m?.name, b.cellMaker && b.cellModel ? `${b.cellMaker} ${b.cellModel}` : b.cellModel]
    .filter(Boolean).join(' · ');
  if (identity) host.append(document.createTextNode(`${identity}. `));
  if (state.parallelPacks) {
    host.append(document.createTextNode(
      `Parallel loadout: two identical packs, ${effective.config}, ${f0(effective.massG)} g including the ${f0(effective.harnessMassG)} g harness allowance. `
    ));
  }
  if (b.estimated?.length) {
    host.append(document.createTextNode(
      `${estimatedPhrase(b.estimated)} ${b.estimated.length === 1 ? 'is' : 'are'} estimated; replace with the finished pack’s measured values when available.`
    ));
  }
  if (m?.url) {
    host.append(document.createTextNode(' '));
    const link = document.createElement('a');
    link.href = m.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Builder source';
    host.appendChild(link);
  }
}

/* ---------- authoring forms ---------- */

// What the pilot types is not what the record stores: the form asks for mAh
// where a battery keeps Ah, and names weight, resistance, current and price
// the short way. These lists are the view; the submit handlers below own the
// mapping from these keys onto a record.
export const BATTERY_FORM = [
  { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Auline 6S 4000' },
  // Free text, not a mandatory pick from the manufacturer registry: the
  // submit handler dedupes it against allManufacturers() (case-insensitive)
  // and auto-creates a custom-builder entry behind the scenes on no match.
  { key: 'brand', label: 'Brand', type: 'text', placeholder: 'Auline', list: 'manufacturer-datalist' },
  { grid: [
    { key: 'cellMaker', label: 'Cell maker', type: 'text', placeholder: 'EVE' },
    { key: 'cellModel', label: 'Cell model', type: 'text', placeholder: '50PL' },
  ] },
  { grid: [
    { key: 'chem', label: 'Chemistry', type: 'select', options: [
      { value: 'liion', label: 'Li-Ion' },
      { value: 'lipo', label: 'LiPo' },
      { value: 'lihv', label: 'LiHV' },
    ] },
    { key: 's', label: 'Cells', type: 'number', unit: 'S', required: true, min: 1, max: 8, value: 6 },
    { key: 'p', label: 'Parallel', type: 'number', unit: 'P', required: true, min: 1, max: 8, value: 1 },
    { key: 'mah', label: 'Capacity', type: 'number', unit: 'mAh', required: true, min: 100, max: 30000 },
    { key: 'mass', label: 'Weight', type: 'number', unit: 'g', required: true, min: 10, max: 3000 },
    { key: 'ir', label: 'Pack internal resistance', type: 'number', unit: 'mΩ', min: 1, max: 500, placeholder: '25' },
    { key: 'amps', label: 'Max continuous current', type: 'number', unit: 'A', min: 1, max: 300, placeholder: '35' },
    { key: 'connector', label: 'Connector', type: 'text', placeholder: 'XT60' },
    { key: 'price', label: 'Price', type: 'number', unit: 'USD', min: 0, max: 5000, step: 0.01 },
  ] },
  // Computed compatibility (connector + cell count, via registry.compatible())
  // is the default and the common case — a shared pack no longer has to be
  // entered once per drone. "Only specific drones" is the pinned-fits escape
  // hatch for a hand-verified odd pairing.
  { key: 'fitsMode', label: 'Fits', type: 'select', id: 'battery-fits-mode', options: [
    { value: 'any', label: 'Any drone that matches (connector + cell count)' },
    { value: 'specific', label: 'Only specific drones' },
  ] },
  { key: 'fitsDrones', label: 'Only these drones', type: 'checkboxes', id: 'battery-fits-drones' },
];

export const MANUFACTURER_FORM = [
  { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Custom pack builder' },
  { key: 'url', label: 'Website', type: 'url', placeholder: 'https://example.com' },
];

// Runs before the first populateControls(), which then keeps the
// manufacturer datalist in step with the registry as packs and builders come
// and go.
export function buildAuthoringForms() {
  // The brand input's autocomplete list isn't part of index.html's markup —
  // built once here, like the forms themselves, and kept in step with the
  // registry by renderManufacturerDatalist() on every populateControls().
  if (!$('manufacturer-datalist')) {
    const dl = document.createElement('datalist');
    dl.id = 'manufacturer-datalist';
    document.body.appendChild(dl);
  }
  buildForm($('custom-form'), BATTERY_FORM, {
    submitLabel: 'Save battery',
    // Pre-checks the drone in the rail right now, so switching "Fits" to
    // "Only specific drones" starts from a sane default instead of an empty
    // list.
    options: {
      fitsDrones: DRONES.map(d => ({ value: d.id, label: d.name, checked: d.id === state.droneId })),
    },
  });
  buildForm($('manufacturer-form'), MANUFACTURER_FORM, { submitLabel: 'Save manufacturer' });

  // The drone checklist only matters in "specific" mode — hidden the rest of
  // the time so the default, common path stays a one-line select.
  const fitsMode = $('battery-fits-mode');
  const fitsDrones = $('battery-fits-drones');
  const syncFitsVisibility = () => { fitsDrones.hidden = fitsMode.value !== 'specific'; };
  syncFitsVisibility();
  fitsMode.addEventListener('change', syncFitsVisibility);
}
