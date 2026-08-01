// render/calibration.js — the two places the logbook argues its case (§6.2):
// the status line under the drone select, and the drift chart under the logbook.
//
// Carved out of render/flightlog.js, which owns the form and the list. The split
// is by subject rather than by screen position: everything here is about what
// the flights say about the airframe and whether to fly it, and none of it reads
// or writes the form.
//
//   - The status line is the only place a fit turns into a plan. It shows what
//     the catalog says, what the pilot's flights say, and one switch — and when
//     the 'default' tier switches itself on, it says so in words.
//   - The drift chart is the argument a bare number can't make: the model's own
//     historical error, per logged cruise leg, computed against whichever record
//     is flying right now. Applying the fit visibly pulls the two lines together,
//     which is the honest way to earn the switch.
import {
  fitForDrone, appliedState, setCalibrationApplied,
} from '../flightlog.js';
import { driftPoints, driftSummary } from '../drift.js';
import { modelConfidence } from '../confidence.js';
import { renderConfidenceBadge } from '../components/confidence-badge.js';
import { allBatteries } from '../registry.js';
import { beginner, units, catalogDrone, drone } from '../state.js';
import { lineChart, legend } from '../charts.js';
import { f0, f1 } from './format.js';
import { $ } from './dom.js';

let deps = null; // injected by app.js: { update, populateControls }
export function setupCalibration(d) {
  deps = d;
  $('drift-toggle').addEventListener('click', () => {
    driftView = driftView === 'economy' ? 'residual' : 'economy';
    renderDriftChart();
  });
}

// The vocabulary for the two fitted fields, shared with render/flightlog.js's
// logbook rows — the same number has to read the same way in both places.
export const FIELD_FMT = { etaProp: (v) => v.toFixed(2), cdA: (v) => v.toFixed(3) };
export const FIELD_SYMBOL = { etaProp: 'η', cdA: 'CdA' };
const FIELD_LABEL = { etaProp: 'etaProp', cdA: 'cdA' };
const FIELD_UNIT = { etaProp: '', cdA: ' m²' };

/* ---------- the calibration status line ---------- */

// What the number being replaced actually is, per airframe. A built-in's is the
// catalog's own calibration; a pilot-authored rig is running its class template
// until it says otherwise (§6.1's confidence field).
function baseLabel(d) {
  if (!d.custom) return 'catalog';
  if (d.confidence === 'measured') return 'as you entered it';
  // A datasheet figure the pilot typed in is still theirs, and still not their
  // own flying — which is exactly what the fit on the right of the arrow is.
  if (d.confidence === 'datasheet') return 'datasheet';
  return 'class default';
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

/* ---------- the model-confidence card (E-04) ---------- */

/**
 * The Calibration page's headline: the same badge the E-01 aircraft cards
 * wear, with the sentence behind it — whose numbers are flying, how they have
 * scored against the logged cruise legs, and (when a fit exists) what the
 * catalog's error and the fit's error each look like over the same flights.
 * The before/after is computed by running driftPoints twice against the same
 * solves, so the two percentages are the same measurement of two records —
 * never an invented improvement figure.
 */
export function renderCalibrationConfidence() {
  const d = catalogDrone();
  const fit = fitForDrone(d);
  const packs = allBatteries();
  // Scored against the record the planner is flying — the badge here must
  // agree with the one the E-01 card for this airframe wears.
  const drift = driftSummary(driftPoints({ drone: drone(), solves: fit.solves, batteries: packs }));
  const m = modelConfidence({ drone: drone(), fit, drift });
  renderConfidenceBadge($('calib-conf-badge'), m);
  $('calib-conf-line').textContent = confidenceSentence(m, d, drift);

  const impact = $('calib-conf-impact');
  const fitted = (fit.etaProp || fit.cdA)
    ? {
        ...d,
        ...(fit.etaProp && { etaProp: fit.etaProp.value }),
        ...(fit.cdA && { cdA: fit.cdA.value }),
      }
    : null;
  const base = fitted
    ? driftSummary(driftPoints({ drone: d, solves: fit.solves, batteries: packs }))
    : null;
  const after = fitted
    ? driftSummary(driftPoints({ drone: fitted, solves: fit.solves, batteries: packs }))
    : null;
  if (!base || base.absPct == null || !after || after.absPct == null) {
    impact.hidden = true;
    impact.textContent = '';
    return;
  }
  impact.hidden = false;
  const applied = appliedState(fit);
  const legs = `${base.n} cruise leg${base.n === 1 ? '' : 's'}`;
  impact.textContent = `Over the same ${legs}: the catalog record is off by about ±${f1(base.absPct)}%, `
    + `your fit by ±${f1(after.absPct)}%. `
    + (applied.on
      ? 'Your numbers are the ones flying. Switching back is the same checkbox on the Aircraft page — nothing is overwritten.'
      : applied.usable
        ? 'Flip “Fly my numbers” on the Aircraft page to fly the right-hand error. Non-destructive — the catalog record stays.'
        : 'Not flyable yet — the note under the logbook says what the fit still needs.');
}

/** One sentence: whose numbers are flying, and how they have scored. */
function confidenceSentence(m, d, drift) {
  if (!m) return '';
  const opener = m.provenance === 'measured'
    ? `Flying your own numbers — a fit from ${m.nFlights} logged flight${m.nFlights === 1 ? '' : 's'}.`
    : m.provenance === 'datasheet'
      ? 'Flying the datasheet numbers you entered for this rig.'
      : m.provenance === 'estimated'
        ? 'Flying a class-template estimate — the least anchored kind of record.'
        : `Flying the catalog record for the ${d.name}.`;
  const scored = drift && drift.absPct != null
    ? ` Over ${drift.n} logged cruise leg${drift.n === 1 ? '' : 's'} it has been `
      + (drift.absPct < 2 ? 'inside 2%' : `within about ±${f0(drift.absPct)}%`)
      + ' of what the flights actually burned.'
    : ' No scored cruise legs yet — log one and this badge earns a percentage.';
  return opener + scored;
}

/* ---------- the drift chart ---------- */

// Which of §6.2's two views is on screen — the module's only state, and private.
// No reset door: the view is the pilot's choice about a chart, not a fact about a
// drone, so it deliberately survives a drone change and an emptied logbook.
let driftView = 'economy';

const ACTUAL_COLOR = 'var(--series-2)';
const MODEL_COLOR = 'var(--series-1)';

/**
 * Actual vs predicted economy per logged cruise leg, and the residual-vs-speed
 * reading of the same points behind a toggle.
 *
 * Only up while there is at least one usable cruise leg: a hover test has no
 * ground track and therefore no Wh/km, and an airframe whose logbook is all
 * hovers has nothing to plot (its η fit is already on the status line).
 * `drone()` — the record the planner is flying — is what the prediction is
 * computed against, so flipping the apply switch visibly moves the model line
 * onto the pilot's flights.
 */
export function renderDriftChart() {
  const panel = $('drift-panel');
  // Beginner mode hides the panel outright; a chart drawn into a display:none
  // container measures nothing and freezes at a fallback width, so skip it.
  if (beginner()) {
    panel.hidden = true;
    return;
  }
  const fit = fitForDrone(catalogDrone());
  const packs = allBatteries();
  const pts = driftPoints({ drone: drone(), solves: fit.solves, batteries: packs });
  if (!pts.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const u = units();
  const x = (p) => u.speedFromMs(p.airspeedMs);
  const burn = (whPerKm) => u.burnFromWhPerKm(whPerKm);
  const yFmt = (v) => f1(v);
  const residual = driftView === 'residual';

  $('drift-toggle').textContent = residual ? 'show actual vs model' : 'show residual vs speed';

  const series = residual
    ? [
        // The zero line first, so the series colors below stay stable between
        // the two views.
        { name: 'model exact', color: 'var(--baseline)', dash: '6 5', pts: [
          { x: Math.min(...pts.map(x)), y: 0 },
          { x: Math.max(...pts.map(x)), y: 0 },
        ] },
        { name: 'flight − model', color: ACTUAL_COLOR,
          pts: pts.map(p => ({ x: x(p), y: burn(p.residualWhPerKm) })) },
      ]
    : [
        { name: 'the model', color: MODEL_COLOR,
          pts: pts.map(p => ({ x: x(p), y: burn(p.predictedWhPerKm) })) },
        { name: 'your flights', color: ACTUAL_COLOR,
          pts: pts.map(p => ({ x: x(p), y: burn(p.actualWhPerKm) })) },
      ];
  // One dot per flight in every series: a single logged leg draws no visible
  // line, and the points are the data here — the line between them is only a
  // reading aid.
  const markers = series
    .filter(s => s.name !== 'model exact')
    .flatMap(s => s.pts.map(p => ({ ...p, color: s.color })));
  const lows = series.flatMap(s => s.pts.map(p => p.y));
  lineChart($('chart-drift'), {
    series, markers, height: 210,
    yMin: Math.min(0, ...lows) * 1.15,
    xLabel: `airspeed flown (${u.speedUnit})`,
    yLabel: residual ? `± ${u.burnUnit}` : u.burnUnit,
    xFmt: (v) => f0(v), yFmt,
    tipTitle: 'airspeed',
    // One logged leg has no x-range to tick sensibly — niceTicks would print the
    // same speed six times across the axis.
    xTicks: pts.length === 1 ? [x(pts[0])] : undefined,
  });
  legend($('legend-drift'), series);
  $('drift-note').textContent = driftNote(driftSummary(pts), fit, residual, u);
}

/**
 * One sentence of what the chart shows, in percent rather than Wh/km: "6% more
 * than the model said" is a number a pilot can act on. The invitation to flip
 * the switch is only offered when there is a fit that has earned it — otherwise
 * the honest advice is to go fly more.
 */
function driftNote(sum, fit, residual, u) {
  if (!sum) return '';
  const parts = [];
  const n = `${sum.n} cruise leg${sum.n === 1 ? '' : 's'}`;
  // Same unit system the axis label is drawn in (u.burnUnit): a metric pilot
  // reading "per mile" under a Wh/km axis would be reading someone else's units.
  const perDistance = u.burnUnit.endsWith('/km') ? 'per kilometer' : 'per mile';
  if (sum.signedPct == null) {
    parts.push(`${n} plotted.`);
  } else {
    const off = Math.abs(sum.signedPct);
    parts.push(off < 2
      ? `${n} plotted, and the model is inside 2% of what they burned.`
      : `${n} plotted: they burned about ${f0(off)}% ${sum.signedPct > 0 ? 'more' : 'less'} `
        + `energy ${perDistance} than the model predicted at those speeds.`);
  }
  if (residual) {
    parts.push('Above the line the flight burned more than the model said; below it, less.');
  }
  const applied = appliedState(fit);
  if (!applied.on && applied.usable && Math.abs(sum.signedPct ?? 0) >= 2) {
    parts.push('Switch your own numbers on above and the model line moves onto your flights.');
  }
  const held = fit.solves.filter(s => s.log?.kind === 'cruise' && !s.ok).length;
  if (held) {
    parts.push(`${held} cruise leg${held === 1 ? '' : 's'} ${held === 1 ? 'is' : 'are'} out of the fit `
      + `and not plotted.`);
  }
  return parts.join(' ');
}
