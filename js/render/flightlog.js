// render/flightlog.js — "log a flight" (§6.2). The 30-second form off the OSD
// and the charger, the solve it shows you straight away, the logbook list, and
// the calibration status line with the one switch that applies a fit.
//
// The three things this file is careful about:
//   - Tier-1 entry is fast. Kind, pack, time, mAh back in — four controls, and
//     the cruise-only fields are not on screen for a hover test. Conditions and
//     the timestamp are prefilled and folded away.
//   - The solve is shown at save time, refusal included. A flight the model
//     cannot believe still gets stored (it happened) and still says why it is
//     out of the fit, because "check the pack capacity and the landed %" is the
//     sentence that fixes the pilot's data.
//   - Nothing is ever applied silently. The status line is the only place a fit
//     turns into a plan, and when the 'default' tier switches itself on the line
//     says so in words.
import {
  fitForDrone, appliedState, setCalibrationApplied, clearCalibrationApplied,
  logsForDrone, saveFlightLog, deleteFlightLog, newLogId, solveLog,
} from '../flightlog.js';
import { classForDrone } from '../catalog/classes.js';
import { allBatteries, compatibleBatteries } from '../registry.js';
import { state, beginner, units, catalogDrone, payload } from '../state.js';
import { U } from '../physics.js';
import { fetchArchiveEnv, launchPoint } from '../weather.js';
import { buildForm, readForm } from '../forms.js';
import { f0, f1, mmss } from './format.js';
import { $ } from './dom.js';

let deps = null; // injected by app.js: { update, populateControls }
export function setupFlightLog(d) { deps = d; }

const etaFmt = (v) => v.toFixed(2);
const cdaFmt = (v) => v.toFixed(3);
const FIELD_FMT = { etaProp: etaFmt, cdA: cdaFmt };
const FIELD_LABEL = { etaProp: 'etaProp', cdA: 'cdA' };
const FIELD_SYMBOL = { etaProp: 'η', cdA: 'CdA' };
const FIELD_UNIT = { etaProp: '', cdA: ' m²' };

/* ---------- the descriptor ---------- */

// Speeds, distances and winds are asked for in whatever system the rail is in,
// so the form is rebuilt when that changes (units() is read at build time).
// Temperature and elevation stay °F and ft, matching the Weather rail's own
// inputs — state.env is imperial-canonical and this form prefills from it.
function flightLogFields(u) {
  return [
    { key: 'kind', label: 'Kind of flight', type: 'select', id: 'flightlog-kind', options: [
      { value: 'hover', label: 'Hover test — pins efficiency' },
      { value: 'cruise', label: 'Cruise leg — pins drag' },
    ], help: 'Fly the hover test first: with no airspeed the drag term drops out, so it solves '
      + 'efficiency on its own. A cruise leg then solves drag against that.' },
    { key: 'batteryId', label: 'Pack', type: 'select', id: 'flightlog-pack', options: [] },
    { key: 'time', label: 'Flight time', type: 'text', required: true, id: 'flightlog-time',
      placeholder: '7:20', pattern: '\\s*\\d{1,3}([:.]\\d{1,2})?\\s*',
      help: 'The armed timer off the OSD — m:ss. A decimal like 7.33 works too.' },
    { grid: [
      { key: 'mahIn', label: 'Charger put back', type: 'number', unit: 'mAh',
        min: 0, max: 60000, step: 1, id: 'flightlog-mah',
        help: 'The better number: a charger measures what the OSD estimates.' },
      { key: 'landedSocPct', label: 'Or landed at', type: 'number', unit: '%',
        min: 0, max: 100, step: 1, id: 'flightlog-soc',
        help: 'Use this if the pack isn’t charged yet. Either one is enough.' },
    ] },
    { id: 'flightlog-cruise', grid: [
      { key: 'distance', label: 'Distance flown', type: 'number', unit: u.distanceUnit,
        min: 0.01, max: 300, step: 0.01, id: 'flightlog-distance',
        help: 'Ground track over the whole leg. Average speed is worked out from this and the time.' },
      { key: 'avgSpeed', label: 'Or average speed', type: 'number', unit: u.speedUnit,
        min: 1, max: 200, step: 1, id: 'flightlog-speed' },
      { key: 'wind', label: 'Wind', type: 'number', unit: u.speedUnit,
        min: 0, max: 120, step: 1, id: 'flightlog-wind' },
      { key: 'windRelation', label: 'Flown', type: 'select', id: 'flightlog-windrel', options: [
        { value: 'mixed', label: 'Out and back — cancels' },
        { value: 'head', label: 'Into the wind' },
        { value: 'tail', label: 'Downwind' },
        { value: 'cross', label: 'Across the wind' },
      ] },
    ] },
    { details: { summary: 'Conditions and when — prefilled, correct anything', fields: [
      { grid: [
        { key: 'temp', label: 'Air temp', type: 'number', unit: '°F', min: -60, max: 140, step: 1,
          id: 'flightlog-temp' },
        { key: 'elev', label: 'Elevation', type: 'number', unit: 'ft', min: -1500, max: 30000, step: 50,
          id: 'flightlog-elev' },
        { key: 'date', label: 'Date', type: 'date', id: 'flightlog-date' },
        { key: 'clock', label: 'Time of day', type: 'time', id: 'flightlog-clock' },
      ] },
      { key: 'notes', label: 'Notes', type: 'text', id: 'flightlog-notes',
        placeholder: 'new props, cold pack…' },
    ] } },
  ];
}

let fields = null;        // the descriptor the form on screen was built from
let builtForUnits = null; // …and which unit system that was

/* ---------- control access ---------- */

const form = () => $('flightlog-form');
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

function setNote(id, msg) {
  const el = $(id);
  el.textContent = msg || '';
  el.hidden = !msg;
}

/* ---------- reading the form ---------- */

/**
 * The OSD's armed timer, in minutes. `7:20` and `7.33` both mean the same
 * flight; the native pattern on the input has already refused anything else.
 */
export function parseFlightTime(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = /^(\d{1,3})(?::(\d{1,2}))?$/.exec(s);
  if (m) {
    const sec = m[2] === undefined ? 0 : Number(m[2]);
    if (sec > 59) return null;
    const mins = Number(m[1]) + sec / 60;
    // A zero-length flight is not a flight — 0:00 is a timer nobody armed.
    return mins > 0 ? mins : null;
  }
  const dec = Number(s);
  return Number.isFinite(dec) && dec > 0 ? dec : null;
}

/** Form values → a stored flight, or null when it isn't one yet. */
function recordFromForm(v, droneId) {
  const u = units();
  const minutes = parseFlightTime(v.time);
  if (minutes === null) return null;
  const p = payload();
  const distanceKm = Number.isFinite(v.distance) ? u.distanceToKm(v.distance) : null;
  // Distance beats a typed average speed: it is the number a GPS track actually
  // reports, and dividing it by the flight time is exact.
  const avgSpeedMs = distanceKm !== null
    ? (distanceKm * 1000) / (minutes * 60)
    : (Number.isFinite(v.avgSpeed) ? u.speedToMph(v.avgSpeed) * 0.44704 : null);
  const at = v.date ? `${v.date}T${v.clock || '12:00'}` : null;
  return {
    id: newLogId(),
    droneId,
    batteryId: v.batteryId,
    kind: v.kind,
    minutes,
    mahIn: Number.isFinite(v.mahIn) ? v.mahIn : null,
    landedSocPct: Number.isFinite(v.landedSocPct) ? v.landedSocPct : null,
    // The loadout in the rail right now, snapshotted: a camera's weight moves
    // the hover solve and its drag area has to come off a cruise fit.
    payloadG: p.massG,
    payloadCdA: p.cdA,
    extraG: state.extraG,
    avgSpeedMs,
    distanceKm,
    windMs: Number.isFinite(v.wind) ? U.mphToMs(u.speedToMph(v.wind)) : 0,
    windRelation: v.windRelation || 'mixed',
    tempC: Number.isFinite(v.temp) ? U.fToC(v.temp) : U.fToC(state.env.tempF),
    elevM: Number.isFinite(v.elev) ? U.ftToM(v.elev) : U.ftToM(state.env.elevFt),
    rhPct: state.env.rhPct,
    at,
    notes: v.notes || '',
  };
}

/* ---------- saving ---------- */

function onSubmit(e) {
  e.preventDefault();
  const v = readForm(e.target, fields);
  const d = catalogDrone();
  const log = recordFromForm(v, d.id);
  // Native validation has the required/pattern/min/max cases; these two are
  // cross-field rules the platform can't express, so they answer in the same
  // status line the solve uses.
  if (!log) {
    setNote('flightlog-result', 'Type the flight time as m:ss — 7:20 off the OSD’s armed timer.');
    return;
  }
  if (log.mahIn === null && log.landedSocPct === null) {
    setNote('flightlog-result', 'One charge reading is enough, but there has to be one: '
      + 'what the charger put back in, or what the OSD said you landed on.');
    return;
  }
  if (log.kind === 'cruise' && !(log.avgSpeedMs > 0)) {
    setNote('flightlog-result', 'A cruise leg needs the distance you covered or the average speed you '
      + 'held — that is the airspeed the drag solve inverts at.');
    return;
  }
  // Solved against the fit as it stands, so a cruise leg is judged against the
  // efficiency the hover tests have already established.
  const before = fitForDrone(d);
  const solved = solveLog(log, d, before.etaProp ? before.etaProp.value : null);
  log.solved = { field: solved.field, value: solved.value, ok: solved.ok, reason: solved.reason || null };
  const stored = saveFlightLog(log);
  if (!stored) {
    setNote('flightlog-result', 'That flight couldn’t be stored — check the time, the pack and the '
      + 'charge reading.');
    return;
  }

  const after = fitForDrone(d);
  setNote('flightlog-result', solveSentence(solved, d, after));
  e.target.reset();
  syncKind();
  syncConditions();
  deps.populateControls();
  deps.update();
}

/** What the pilot is told the moment a flight lands in the logbook. */
function solveSentence(solved, d, fit) {
  const cls = classForDrone(d);
  if (!solved.ok) {
    return `Logged, but left out of the fit — ${solved.reason}`;
  }
  const fmt = FIELD_FMT[solved.field] || f1;
  const range = cls?.ranges?.[solved.field];
  const head = `This flight implies ${FIELD_SYMBOL[solved.field]} ${fmt(solved.value)}`
    + (range ? `, inside the ${fmt(range[0])}–${fmt(range[1])} a ${cls.label} is expected in` : '')
    + '.';
  const n = fit.nFlights;
  return `${head} ${n} flight${n === 1 ? '' : 's'} now in the fit for ${d.name}.`;
}

/* ---------- historical wind prefill ---------- */

let prefillSeq = 0;
let prefillTimer = 0;

/**
 * Fill wind and temperature in from Open-Meteo's archive for the hour the pilot
 * says they flew (§6.2: "don't make anyone remember"). Visibly and editably —
 * the fields are ordinary inputs afterwards — and never blocking: the archive is
 * about a day behind, the launch point may be the default one, and a trailhead
 * has no network. Every one of those just leaves the fields alone and says why.
 */
function queuePrefill() {
  clearTimeout(prefillTimer);
  prefillTimer = setTimeout(runPrefill, 400);
}

async function runPrefill() {
  const date = ctrl('date')?.value;
  const clock = ctrl('clock')?.value;
  if (!date || !clock) return;
  const seq = ++prefillSeq;
  const pt = launchPoint();
  setNote('flightlog-prefill', 'Looking up the weather you flew in…');
  try {
    const wx = await fetchArchiveEnv(pt, `${date}T${clock}`);
    if (seq !== prefillSeq) return; // a later date/time supersedes this answer
    const u = units();
    setValue('temp', wx.tempF);
    if (Number.isFinite(wx.windMph)) setValue('wind', Math.round(u.speedFromMph(wx.windMph)));
    if (Number.isFinite(wx.elevM)) setValue('elev', Math.round(U.mToFt(wx.elevM)));
    const dir = Number.isFinite(wx.windFromDeg) ? ` from ${wx.windFromDeg}°` : '';
    setNote('flightlog-prefill',
      `Archive at ${pt.lat.toFixed(3)}, ${pt.lng.toFixed(3)}: `
      + `${f0(u.speedFromMph(wx.windMph))} ${u.speedUnit}${dir} at 100 m, ${wx.tempF}°F. `
      + 'Filled in above — say how the leg sat in that wind, and correct anything you remember better.');
  } catch (err) {
    if (seq !== prefillSeq) return;
    setNote('flightlog-prefill', `No archived weather for that hour (${err.message}) — `
      + 'the archive runs about a day behind. Type the wind and temp you flew in.');
  }
}

/* ---------- the calibration status line ---------- */

// What the number being replaced actually is, per airframe. A built-in's is the
// catalog's own calibration; a pilot-authored rig is running its class template
// until it says otherwise (§6.1's confidence field).
function baseLabel(d) {
  if (!d.custom) return 'catalog';
  return d.confidence === 'measured' ? 'as you entered it' : 'class default';
}

function fitLine(field, base, part, d) {
  const fmt = FIELD_FMT[field];
  const unit = FIELD_UNIT[field];
  const n = part.n;
  return `${FIELD_LABEL[field]} ${fmt(base)}${unit} (${baseLabel(d)}) → ${fmt(part.value)}${unit}`
    + ` (yours, ${n} flight${n === 1 ? '' : 's'}, ±${fmt(part.band)})`;
}

/**
 * The §6.2 line: what the catalog says, what the pilot's flights say, and a
 * switch. Hidden entirely until there is a fit to talk about — an airframe with
 * an empty logbook has nothing to be honest about.
 */
export function renderCalibrationLine() {
  const host = $('calib-line');
  host.replaceChildren();
  const d = catalogDrone();
  const fit = fitForDrone(d);
  if (fit.tier === 'none' && !fit.nLogs) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  for (const field of ['etaProp', 'cdA']) {
    if (!fit[field]) continue;
    const row = document.createElement('p');
    row.className = 'calib-fit';
    row.textContent = fitLine(field, d[field], fit[field], d);
    host.appendChild(row);
  }

  const applied = appliedState(fit);
  const row = document.createElement('label');
  row.className = 'check-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = 'calib-apply';
  cb.checked = applied.on;
  cb.disabled = !applied.usable;
  const text = document.createElement('span');
  text.textContent = 'Fly my numbers instead of the catalog’s';
  row.append(cb, text);
  cb.addEventListener('change', () => {
    setCalibrationApplied(d.id, cb.checked);
    deps.populateControls();
    deps.update();
  });
  host.appendChild(row);

  const note = document.createElement('p');
  note.className = 'rail-note calib-note';
  note.textContent = tierNote(fit, applied);
  host.appendChild(note);
}

function tierNote(fit, applied) {
  const parts = [];
  if (fit.tier === 'none') {
    parts.push(fit.nLogs === 1
      ? 'That flight is logged, but nothing in it could be solved — see the reason under it.'
      : `${fit.nLogs} flights logged, none of them solvable — see the reasons under them.`);
  } else if (fit.tier === 'show') {
    const need = 3 - fit.nFlights;
    parts.push(`Log ${need} more flight${need === 1 ? '' : 's'} to use this — `
      + 'one flight is a data point, not a calibration.');
  } else if (fit.tier === 'offer' && !fit.speedSpreadOk) {
    parts.push(fit.etaProp && !fit.cdA
      ? 'Log a cruise leg to separate drag from efficiency — five flights across two speeds turn this on by itself.'
      : 'Five flights across two speeds turn this on by itself.');
  }
  if (applied.announced) {
    parts.push('Five flights across two speeds earned it, so it is applied now — '
      + 'switch it off above if you disagree.');
  }
  if (fit.cdA && !fit.etaPinned) {
    parts.push('The drag fit is leaning on the catalog’s efficiency, not yours — a hover test pins that first.');
  }
  if (fit.nRefused) {
    parts.push(`${fit.nRefused} logged flight${fit.nRefused === 1 ? '' : 's'} `
      + `${fit.nRefused === 1 ? 'is' : 'are'} out of the fit — the model can’t believe `
      + `${fit.nRefused === 1 ? 'it' : 'them'}.`);
  }
  return parts.join(' ');
}

/* ---------- the logbook list ---------- */

function logRowText(entry, u) {
  const l = entry.log;
  const pack = allBatteries().find(b => b.id === l.batteryId);
  const bits = [
    l.kind === 'hover' ? 'Hover' : 'Cruise',
    mmss(l.minutes),
    pack ? (pack.short || pack.name) : 'pack removed',
  ];
  if (l.mahIn !== null) bits.push(`${f0(l.mahIn)} mAh back`);
  else bits.push(`landed ${f0(l.landedSocPct)}%`);
  if (l.kind === 'cruise' && Number.isFinite(l.avgSpeedMs)) {
    bits.push(`${f0(u.speedFromMs(l.avgSpeedMs))} ${u.speedUnit} avg`);
  }
  if (l.at) bits.push(l.at.slice(0, 10));
  const fmt = FIELD_FMT[entry.field] || f1;
  bits.push(entry.ok
    ? `→ ${FIELD_SYMBOL[entry.field]} ${fmt(entry.value)}`
    : '→ out of the fit');
  return bits.join(' · ');
}

function renderLogList() {
  const host = $('flightlog-list');
  host.replaceChildren();
  const d = catalogDrone();
  const fit = fitForDrone(d);
  const u = units();
  for (const entry of fit.solves) {
    const row = document.createElement('div');
    row.className = 'custom-row';
    const name = document.createElement('span');
    name.textContent = logRowText(entry, u);
    if (!entry.ok) {
      name.className = 'calib-refused';
      // The whole physical reason, on the row that earned it — that sentence is
      // what tells the pilot which number to go re-measure.
      name.title = entry.reason || '';
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'remove';
    del.className = 'link-btn';
    del.addEventListener('click', () => {
      deleteFlightLog(entry.log.id);
      // An emptied logbook forgets the decision too, so a rig logged again later
      // starts from the gate rather than from a switch nobody remembers setting.
      if (!logsForDrone(d.id).length) clearCalibrationApplied(d.id);
      setNote('flightlog-result', '');
      deps.populateControls();
      deps.update();
    });
    row.append(name, del);
    host.appendChild(row);
  }
  for (const entry of fit.solves) {
    if (entry.ok || !entry.reason) continue;
    const why = document.createElement('p');
    why.className = 'rail-note calib-why';
    why.textContent = entry.reason;
    host.appendChild(why);
  }
}

/* ---------- kind and condition sync ---------- */

// A hover test has no leg and no wind to speak of, so those fields are off
// screen rather than sitting there asking to be ignored.
function syncKind() {
  const cruise = $('flightlog-cruise');
  if (cruise) cruise.hidden = ctrl('kind')?.value !== 'cruise';
}

// Prefilled from the Weather rail, and re-stamped as that changes — but only
// while the pilot hasn't typed their own number in. Once they have, the value
// stops matching what we last stamped and is left alone.
let stamped = { temp: null, elev: null };
function syncConditions() {
  for (const [key, v] of [['temp', Math.round(state.env.tempF)], ['elev', Math.round(state.env.elevFt)]]) {
    const el = ctrl(key);
    if (!el) continue;
    if (el.value === '' || el.value === String(stamped[key])) setValue(key, v);
    stamped[key] = v;
  }
}

/* ---------- setup and refresh ---------- */

function packOptions(d) {
  const fits = compatibleBatteries(d);
  const list = fits.length ? fits : allBatteries();
  return list.map(b => ({ value: b.id, label: `${b.name} · ${f0(b.massG)} g` }));
}

function build() {
  const u = units();
  fields = flightLogFields(u);
  builtForUnits = state.units;
  const el = form();
  buildForm(el, fields, {
    submitLabel: 'Log this flight',
    options: { batteryId: packOptions(catalogDrone()) },
  });
  el.addEventListener('change', onEdit);
  el.addEventListener('input', onEdit);
  el.addEventListener('submit', onSubmit);
  setValue('batteryId', state.batteryId);
  syncKind();
  syncConditions();
}

function onEdit(e) {
  const key = e.target?.name;
  if (key === 'kind') syncKind();
  if (key === 'date' || key === 'clock') queuePrefill();
}

/** Built once at boot, like the other two authoring forms. */
export function buildFlightLogForm() {
  build();
}

/**
 * Keep the section in step with the rail: the pack roster for the airframe now
 * selected, the conditions prefill, the logbook, and the status line. Called
 * from populateControls() on every state change — and it rebuilds the form
 * outright when the unit system changes, since half its labels name a unit.
 */
export function renderFlightLog() {
  if (builtForUnits !== state.units) build();
  const d = catalogDrone();
  const sel = ctrl('batteryId');
  if (sel) {
    const items = packOptions(d);
    const keep = sel.value;
    sel.replaceChildren();
    for (const it of items) {
      const o = document.createElement('option');
      o.value = it.value;
      o.textContent = it.label;
      sel.appendChild(o);
    }
    sel.value = items.some(i => i.value === keep) ? keep
      : (items.some(i => i.value === state.batteryId) ? state.batteryId : (items[0]?.value ?? ''));
  }
  syncKind();
  syncConditions();
  renderLogList();
  renderCalibrationLine();
  // Nothing in here is reachable in beginner mode (the section and the status
  // line both carry .full-only), but an applied fit still flies — the pilot's
  // decision doesn't evaporate because they hid the physics.
  if (beginner()) setNote('flightlog-prefill', '');
}
