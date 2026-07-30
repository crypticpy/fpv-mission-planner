// render/controls.js — write `state` onto the control rail, and generate the
// authoring forms behind it. The one render module that also reads controls
// back: populateControls() resets an expert control that just went off screen.
import {
  PAYLOADS, WEATHER, SCENARIOS,
  allDrones, allBatteries, allManufacturers, deleteCustomBattery, deleteCustomManufacturer,
} from '../data.js';
import {
  state, beginner, units, drone, droneBatteries, compatibleBatteries, battery,
  manufacturer, loadoutBattery, packTemp, EXPERT_CRUISE_MODES,
} from '../state.js';
import { GUST_FACTOR_DEFAULT, isColdPack, U } from '../physics.js';
import {
  CRUISE_ALTS_M, CRUISE_ALT_DEFAULT_M, activeWindAt, launchWind,
} from '../windprofile.js';
import { deletePackInstancesFor } from '../packinstances.js';
import { buildForm } from '../forms.js';
import { classById } from '../catalog/classes.js';
import { renderDroneForm } from './droneform.js';
import { renderFlightLog } from './flightlog.js';
import { renderPackInstances, packInstanceSentence } from './packinstances.js';
import { IR_FIELDS, mountBatteryChecks } from './batterychecks.js';
import { f0, compass, surfaceMph, estimatedPhrase } from './format.js';
import { $, fillSelect } from './dom.js';

let deps = null; // injected by app.js: { update }
export function setupControls(d) { deps = d; }

/* ---------- control population ---------- */

function configureNumericInput(input, config, value) {
  input.min = config.min;
  input.max = config.max;
  input.step = config.step;
  input.value = Math.round(value / config.step) * config.step;
}

/**
 * The two sentences under the wind fields: what wind the plan is actually flying,
 * and how much of the gust spread is in it.
 *
 * Separate from populateControls() because these two are the only rail text that
 * has to track a slider or a number field live — every wind edit and every drag
 * of the gust knob moves the figures in them, and update() runs on all of those.
 * Re-running the whole rail (which rebuilds every select) on each keystroke would
 * be the wrong trade.
 */
export function renderWindNotes() {
  const u = units();
  const alt = state.cruiseAltM;
  const spd = (mph) => `${f0(u.speedFromMph(mph))} ${u.speedUnit}`;
  // Which level the figure on the rail is, said out loud (Phase 4 item 9): the
  // same 14 mph means two different missions at 10 m and at 180 m, and until this
  // control existed the answer was always 80 m whether anyone knew it or not.
  const level = activeWindAt(alt);
  const lead = `The plan flies the ${alt} m wind — ${spd(state.env.windMph)} `
    + `from ${state.env.windFromDeg}° (${compass(state.env.windFromDeg)})`
    + (level && level.windMph === state.env.windMph ? ' — forecast for that height. ' : '. ');
  // The launch and the landing happen at 10 m whatever the cruise level is, so
  // that number stays on screen: a measured reading when the forecast gave us
  // one, and otherwise the rule of thumb this line has always printed.
  const surface = launchWind(state.env.windMph);
  const tail = alt === 10
    ? 'That is the surface wind — climb-out, cruise and landing are all in the same air.'
    : surface.measured
      ? `Launch and landing happen in the 10 m wind, ${spd(surface.mph)}.`
      : `At the launch point you’ll feel roughly half of it, about ${spd(surfaceMph(state.env.windMph))}.`;
  $('wind-note').textContent = lead + tail;
  // The gust blend, and the honest caveat on it: the gust figure Open-Meteo
  // publishes is a 10 m reading, while the wind the plan flies is the 80 m one,
  // so the spread being blended is not measured in the air the aircraft is in.
  const gustF = state.gustFactorPct / 100;
  const planningMph = state.env.windMph + gustF * Math.max(0, state.env.gustMph - state.env.windMph);
  $('gustf-val').textContent = `${state.gustFactorPct}%`;
  $('gustf-note').textContent =
    `Planning wind ${f0(u.speedFromMph(planningMph))} ${u.speedUnit} — the average plus `
    + `${state.gustFactorPct}% of the way up to the gusts. 0% plans the average, 100% plans the full gust. `
    + (alt === 10
      ? 'Gusts are measured at 10 m, which is the level this plan is flying — for once the two agree.'
      : `Note the mismatch: gusts are measured at 10 m, near the ground, while the plan flies the ${alt} m `
        + 'wind — so this spread is borrowed from lower air than the drone is in.');
}

/**
 * The pack-temperature control and the sentence under it (Phase 4 item 3).
 *
 * Live like renderWindNotes(), and for the same reason: the air temperature it
 * quotes, the pack it is comparing against, and the chemistry deciding what
 * counts as cold all move without the rail being rebuilt.
 *
 * The honesty about the cold table lands here, next to the knob, whenever cold is
 * in play at either temperature — the rest of the app shows the cold penalty as a
 * smaller radius, and this is the only place that can say which way the figure is
 * wrong before the pilot trusts it.
 */
export function renderPackTempNote() {
  const { overridden, tempF } = packTemp();
  const airF = state.env.tempF;
  $('in-packtemp-on').checked = overridden;
  $('packtemp-row').hidden = !overridden;
  if (overridden) $('in-packtemp').value = Math.round(tempF);
  const chem = battery()?.chem || 'lipo';
  const cold = isColdPack(chem, U.fToC(tempF)) || isColdPack(chem, U.fToC(airF));
  const lead = !overridden
    ? `Pack temperature follows the air — ${f0(airF)}°F. That is the right assumption for packs that rode `
      + 'here in a bag. Tick the box if you preheat them: it is the biggest thing you can do about cold, '
      + 'and until now the plan had no way to hear about it.'
    : `Planning ${f0(tempF)}°F packs in ${f0(airF)}°F air. Capacity, resistance and sag read the pack; air `
      + 'density still reads the air.'
      + (tempF > airF
        ? ' Nothing here models the pack cooling down once it is flying, so insulate it and launch soon.'
        : '');
  const caveat = cold
    ? ' Note what the cold numbers are: a gentle bench discharge of a pack held at temperature. A real pack '
      + 'heats itself up while it works, so this under-states the sag on your first hard pull and over-states '
      + 'what cold costs you over the whole flight.'
    : '';
  $('packtemp-note').textContent = lead + caveat;
}

export function populateControls() {
  const u = units();
  // Beginner mode can never sit on an expert control that is off screen: the
  // thing that would change it back is hidden. Same rule for both.
  if (beginner() && EXPERT_CRUISE_MODES.includes(state.cruiseMode)) state.cruiseMode = 'real';
  if (beginner() && state.parallelPacks) state.parallelPacks = false;
  if (beginner()) state.gustFactorPct = GUST_FACTOR_DEFAULT * 100;
  // Same rule again: a cruise altitude the pilot cannot see is one they cannot put
  // back, so beginner mode plans the level the app has always planned. app.js puts
  // that level's wind back on the rail when the toggle moves.
  if (beginner()) state.cruiseAltM = CRUISE_ALT_DEFAULT_M;
  // Same rule: a pack temperature the pilot cannot see is a pack temperature they
  // cannot put back, so beginner mode always plans the pack at air temperature.
  if (beginner()) state.packTempF = null;
  document.body.dataset.detail = state.detail;
  $('sel-detail').value = state.detail;
  $('sel-units').value = state.units;
  fillSelect($('sel-drone'), allDrones().map(d => ({ value: d.id, label: d.name })), state.droneId);
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
  // The wind at each height the forecast published, on the option itself — like
  // the scenario select's cruise speeds, the number that decides the choice is in
  // front of the pilot before they make it. Bare heights until a live fetch has
  // a profile to put there.
  fillSelect($('sel-cruise-alt'), CRUISE_ALTS_M.map(m => {
    const lvl = activeWindAt(m);
    return {
      value: String(m),
      label: lvl
        ? `${m} m · ${f0(u.speedFromMph(lvl.windMph))} ${u.speedUnit} from ${compass(lvl.windFromDeg)}`
        : `${m} m`,
    };
  }), String(state.cruiseAltM));
  $('in-gustf').value = state.gustFactorPct;
  renderWindNotes();
  renderPackTempNote();
  $('sel-windmode').value = state.env.windMode;
  $('in-reserve').value = state.landFloorPct;
  $('reserve-val').textContent = `${state.landFloorPct}%`;
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
  renderPackInstances();
  renderCustomList();
  renderManufacturerList();
  renderManufacturerDatalist();
  renderFitsDrones();
  renderDroneForm();
  renderFlightLog();
}

// The battery form's "always offer on" checklist is built at boot, before any
// pilot-added airframe exists — so it gets rebuilt here, preserving whatever is
// already ticked. Without this a custom drone could never be pinned in `fits`.
function renderFitsDrones() {
  const host = $('battery-fits-drones');
  const checked = new Set([...host.querySelectorAll('input:checked')].map(el => el.value));
  const legend = host.querySelector('legend');
  host.replaceChildren(legend);
  for (const d of allDrones()) {
    const row = document.createElement('label');
    row.className = 'check-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.name = 'fitsDrones';
    cb.value = d.id;
    cb.defaultChecked = checked.size ? checked.has(d.id) : d.id === state.droneId;
    const text = document.createElement('span');
    text.textContent = d.name;
    row.append(cb, text);
    host.appendChild(row);
  }
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
    del.addEventListener('click', () => {
      deleteCustomBattery(b.id);
      // The physical copies go with the model — a pack instance pointing at a
      // battery that no longer exists is an orphan the fold can never show.
      deletePackInstancesFor(b.id);
      populateControls();
      deps.update();
    });
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
  // Per-airframe honesty (§6.2): a rig assembled from a class template is
  // running the table's guesses, and the plan under it says so rather than
  // reading like the calibrated built-ins.
  const d = drone();
  if (d.calibration) {
    // The switch is on for this airframe, so the plan above is not the catalog's
    // opinion any more — say whose it is, and how many flights bought it.
    const { fields, nFlights } = d.calibration;
    const which = fields.length === 2 ? 'efficiency and drag'
      : fields[0] === 'etaProp' ? 'efficiency' : 'drag';
    host.append(document.createTextNode(
      `${d.name} is flying your own ${which}, fitted from ${nFlights} logged `
      + `flight${nFlights === 1 ? '' : 's'} instead of `
      + `${d.custom ? 'the class template' : 'the catalog’s numbers'}. `
    ));
  } else if (d.custom && d.confidence === 'datasheet') {
    // Datasheet numbers are better than a class guess and still not this rig's
    // own behaviour — the honest middle tier (§6.1).
    host.append(document.createTextNode(
      `${d.name}’s flight numbers are datasheet figures, not measured on this rig — `
      + 'log a flight to calibrate them. '
    ));
  } else if (d.custom && d.confidence !== 'measured') {
    const cls = classById(d.classId);
    host.append(document.createTextNode(
      `${d.name}’s flight numbers are ${cls ? `${cls.label} ` : ''}class estimates, not measured — `
      + 'log a flight to calibrate them. '
    ));
  }
  if (state.parallelPacks) {
    host.append(document.createTextNode(
      `Parallel loadout: two identical packs, ${effective.config}, ${f0(effective.massG)} g including the ${f0(effective.harnessMassG)} g harness allowance. `
    ));
  }
  // Which physical copy of the pack the plan is flying, and whether its own
  // measured resistance is the one in the sag model (render/packinstances.js).
  const packLine = packInstanceSentence(b);
  if (packLine) host.append(document.createTextNode(packLine));
  // A measured physical pack has already replaced the model's resistance, so
  // still calling that field estimated would contradict the sentence above it.
  const estimated = (b.estimated || []).filter(
    k => !(k === 'irPackMilliOhm' && b.packInstance?.measured)
  );
  if (estimated.length) {
    host.append(document.createTextNode(
      `${estimatedPhrase(estimated)} ${estimated.length === 1 ? 'is' : 'are'} estimated; replace with the finished pack’s measured values when available.`
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
  { key: 'brand', label: 'Brand', type: 'text', placeholder: 'Auline', list: 'manufacturer-datalist', id: 'battery-brand' },
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
    { key: 's', label: 'Cells', type: 'number', unit: 'S', required: true, min: 1, max: 12, value: 6 },
    { key: 'p', label: 'Parallel', type: 'number', unit: 'P', required: true, min: 1, max: 8, value: 1 },
    { key: 'mah', label: 'Capacity', type: 'number', unit: 'mAh', required: true, min: 100, max: 30000 },
    { key: 'mass', label: 'Weight', type: 'number', unit: 'g', required: true, min: 10, max: 3000 },
    { key: 'ir', label: 'Pack internal resistance', type: 'number', unit: 'mΩ', min: 1, max: 500, placeholder: '25' },
    { key: 'amps', label: 'Max continuous current', type: 'number', unit: 'A', min: 1, max: 300, placeholder: '35' },
    { key: 'connector', label: 'Connector', type: 'text', placeholder: 'XT60' },
    { key: 'price', label: 'Price', type: 'number', unit: 'USD', min: 0, max: 5000, step: 0.01 },
  ] },
  // Per-cell resistance entry, folded away (§6.1). The stored field stays the
  // pack figure above — this is a way of arriving at it, plus the temperature it
  // was read at. render/batterychecks.js owns the fields and the arithmetic.
  ...IR_FIELDS,
  // Computed compatibility (connector + cell count, via registry.compatible())
  // is the default and the common case — a shared pack no longer has to be
  // entered once per drone. "Pin to specific drones" is an *additional*
  // guarantee, not a narrowing one: registry.compatible() lets an explicit
  // `fits` pin win positively, but any other drone that still matches by
  // connector and cell count keeps seeing the pack too.
  {
    key: 'fitsMode', label: 'Fits', type: 'select', id: 'battery-fits-mode',
    help: 'A pin guarantees those drones always see this pack — it does not hide the pack from '
      + 'other drones that already match by connector and cell count.',
    options: [
      { value: 'any', label: 'Any drone that matches (connector + cell count)' },
      { value: 'specific', label: 'Pin to specific drones (always offered there)' },
    ],
  },
  { key: 'fitsDrones', label: 'Always offer on', type: 'checkboxes', id: 'battery-fits-drones' },
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
    // "Pin to specific drones" starts from a sane default instead of an empty
    // list.
    options: {
      fitsDrones: allDrones().map(d => ({ value: d.id, label: d.name, checked: d.id === state.droneId })),
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

  // The derived cross-checks under the battery form, and the per-cell/whole-pack
  // visibility that goes with them. The descriptor is passed in rather than
  // imported, so batterychecks.js stays a leaf module.
  mountBatteryChecks($('custom-form'), BATTERY_FORM);
}
