// advisory-panel.js — the key to the zones, and the record behind them.
//
// The layer draws coloured cells. This is the other half of that: what the
// colours mean, what was fed in, how old it is, whether it holds together across
// the forecast's own uncertainty, and — at length — what it does not say.
//
// Two things are deliberate about where the words sit.
//
//   *The caveat is never behind a click.* The fold holds the provenance and the
//     limitations list; the line above it, always visible whenever a zone is on
//     screen, says the one thing a pilot must not miss — this is a relative
//     forcing proxy, not a forecast of vertical velocity, and it cannot locate a
//     rotor.
//
//   *The limitations are the producer's, verbatim.* They arrive on
//     `provenance.limitations` precisely so no surface retypes them into
//     something softer (ADR 0008). This file lists them; it does not summarise
//     them.
//
// Like footprint-panel.js and segment-inspector.js this is not a map layer — it
// draws no overlays and renders whether or not an engine has initialised — so it
// takes the advisory block directly rather than a frame.

import { ADVISORY_CLASS_STYLE } from './layers/advisory-layer.js';

/**
 * @typedef {import('../../application/analysis/analysis-contracts.js').AdvisoryField} AdvisoryField
 * @typedef {import('../../domain/wind/terrain-forcing.js').ForcingClassId} ForcingClassId
 */

/** @typedef {{ label: string, value: string, note?: string }} FactRow */
/** @typedef {{ classId: ForcingClassId, label: string, note: string, count: number }} LegendRow */
/** @typedef {{ classId: ForcingClassId, counts: ForcingClassId[], label: string, note: string }} LegendSpec */

const $ = (/** @type {string} */ id) => document.getElementById(id);

/**
 * The legend, in display order, worst first.
 *
 * `ridge` and `gap` are one row: they share a colour because they share
 * W-WIND-ACCEL, and two rows under one swatch would invite the pilot to read a
 * distinction the model never drew. `classId` names the swatch's colour and is
 * the first of the classes counted into the row.
 */
const LEGEND = Object.freeze(/** @type {readonly LegendSpec[]} */ ([
  Object.freeze({
    classId: 'lee', counts: ['lee'],
    label: 'Lee slope',
    note: 'modelled flow driven down the ground — the setting sink belongs to',
  }),
  Object.freeze({
    classId: 'ridge', counts: ['ridge', 'gap'],
    label: 'Crest or gap',
    note: 'ground that stands above its surroundings or squeezes the flow — more wind than the '
      + 'forecast figure, by an amount nothing here models',
  }),
  Object.freeze({
    classId: 'uplift', counts: ['uplift'],
    label: 'Windward slope',
    note: 'relative uplift potential — a modelled tendency, not lift you can plan on',
  }),
  Object.freeze({
    classId: 'unknown', counts: ['unknown'],
    label: 'No elevation',
    note: 'nothing could be classified here — missing data, never clear air',
  }),
]));

/**
 * What the legend has to say about this field: the classes that actually occur,
 * with the cells behind each.
 *
 * A class with no cells is left out rather than shown at zero — a legend is a
 * key to what is on screen, and a key to marks that are not there is noise.
 *
 * @param {AdvisoryField|null|undefined} advisories
 * @returns {LegendRow[]}
 */
export function legendRows(advisories) {
  const byClass = advisories?.forcing?.meta?.counts?.byClass;
  if (!byClass) return [];
  /** @type {LegendRow[]} */
  const rows = [];
  for (const row of LEGEND) {
    const count = row.counts.reduce((n, id) => n + (byClass[id] ?? 0), 0);
    if (count > 0) rows.push({ classId: row.classId, label: row.label, note: row.note, count });
  }
  return rows;
}

/**
 * The provenance, as label/value rows in the order a pilot would ask them: what
 * wind, what sky, what ground, how old, how settled.
 *
 * Every branch that returns a word instead of a number is deliberate. A null in
 * this block means "nothing supplied this", which is not zero and not a default,
 * so it is said in words.
 *
 * @param {AdvisoryField} advisories
 * @param {number} now  epoch ms, injected so the row is testable
 * @returns {FactRow[]}
 */
export function advisoryFacts(advisories, now) {
  const p = advisories.provenance;
  /** @type {FactRow[]} */
  const rows = [];

  const wind = p.wind;
  rows.push({
    label: 'Wind it ran on',
    value: wind ? `${Math.round(wind.windMph)} mph from ${Math.round(wind.windFromDeg)}°` : 'none recorded',
    note: wind
      ? `${wind.source} · ${wind.levelM == null ? 'no height recorded for that figure' : `read at ${Math.round(wind.levelM)} m AGL`} · one wind for the whole area`
      : undefined,
  });

  rows.push({
    label: 'Sounding',
    value: p.soundingLevels > 0 ? `${p.soundingLevels} pressure levels` : 'none — no regime could be read',
    note: soundingNote(p.soundingStale, p.soundingOffsetKm),
  });

  rows.push(regimeRow(advisories));

  rows.push({
    label: 'Grid',
    value: p.rows != null && p.cols != null && p.cellSizeM != null
      ? `${p.rows} × ${p.cols} cells at ${Math.round(p.cellSizeM)} m`
      : 'not recorded',
    note: p.unknownCells > 0
      ? `${p.unknownCells} with no elevation to classify — drawn as missing`
      : 'every cell had an elevation behind it',
  });

  rows.push({
    label: 'Elevation data',
    value: p.gridDataset ?? p.gridSource ?? 'not recorded',
    note: [p.gridAttribution, p.coverage ? `coverage: ${p.coverage}` : null, 'bare earth: no trees, buildings or towers']
      .filter(Boolean).join(' · '),
  });

  rows.push({ label: 'Retrieved', value: ageText(p.retrievedAt, now) });
  rows.push(sensitivityRow(advisories));
  return rows;
}

/**
 * The regime, and the wind it was measured through. Reported as its own row
 * because it is the second baseline and answers a different question from the
 * cells: not "where is the ground forcing the air" but "can this air climb the
 * ground at all".
 * @param {AdvisoryField} advisories
 * @returns {FactRow}
 */
function regimeRow(advisories) {
  const regime = advisories.regime;
  if (!regime) return { label: 'Stability regime', value: 'not established' };
  const fr = regime.froude == null ? '—' : regime.froude.toFixed(2);
  const band = regime.band?.regimes ?? [];
  return {
    label: 'Stability regime',
    value: `${regime.regime} · Fr = ${fr}`,
    note: band.length > 1
      ? `the sensitivity envelope spans ${band.join(', ')} — the forecast is not sharp enough to settle it`
      : 'one bulk number for the whole area; it cannot say where the flow splits',
  };
}

/**
 * How much of the classification survives the forecast's own uncertainty, said
 * against the bound the baseline was validated to.
 * @param {AdvisoryField} advisories
 * @returns {FactRow}
 */
function sensitivityRow(advisories) {
  const changed = advisories.provenance.changedFraction;
  const bound = advisories.provenance.sensitivityBound;
  if (changed == null) {
    return {
      label: 'Sensitivity',
      value: 'not measured',
      note: 'nothing was classifiable, so there was nothing to perturb',
    };
  }
  return {
    label: 'Sensitivity',
    value: `${pct(changed)} of classified cells change class`,
    note: changed > bound
      ? `past the ${pct(bound)} this baseline was validated to — read the zones as a broad area of `
        + 'uncertainty rather than as lines'
      : `within the ${pct(bound)} this baseline was validated to, across ±20° and ±30% of wind`,
  };
}

/**
 * @param {boolean} stale
 * @param {number|null} offsetKm
 * @returns {string}
 */
function soundingNote(stale, offsetKm) {
  if (!stale) return 'fetched for this launch point';
  return offsetKm != null && offsetKm >= 0.1
    ? `fetched ${offsetKm.toFixed(1)} km from this launch — it describes the air over there`
    : 'fetched for a different launch point — it describes the air over there';
}

/**
 * How old the elevation answer is, in the coarsest unit that still says
 * something. An absent timestamp is stated, never rendered as fresh.
 *
 * @param {string|null|undefined} iso
 * @param {number} now  epoch ms
 * @returns {string}
 */
export function ageText(iso, now) {
  if (!iso) return 'not recorded';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'not recorded';
  const minutes = Math.floor((now - at) / 60000);
  // A clock a few seconds behind the provider's is not evidence of anything.
  if (minutes <= 0) return 'just now';
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** @param {number} frac @returns {string} */
const pct = (frac) => `${Math.round(frac * 100)}%`;

/* ---------- the DOM half ---------- */

/**
 * The map's key to the zone colours. Called on every map render pass; the
 * legend follows the toggle — it is a key to marks, and there is nothing to
 * key when the zones are off. Split from the card (M10): the legend belongs to
 * the canvas drawing the zones, the explanation card lives in Analyze now.
 *
 * @param {object} view
 * @param {AdvisoryField|null|undefined} view.advisories
 * @param {boolean} view.visible  whether the zones layer is drawing
 */
export function renderAdvisoryLegend({ advisories, visible }) {
  const ready = advisories?.status === 'ready' && !!advisories.forcing;
  fillLegend(ready && visible ? legendRows(advisories) : []);
}

/**
 * The explanation card, up whenever the advisory is ready: what was computed
 * and what it cannot say are true whether or not the zones layer is drawing.
 *
 * @param {object} view
 * @param {AdvisoryField|null|undefined} view.advisories
 * @param {number} [view.now]     epoch ms; injected only by tests
 */
export function renderAdvisoryCard({ advisories, now = Date.now() }) {
  const ready = advisories?.status === 'ready' && !!advisories.forcing;
  const card = $('advisory-card');
  if (!card) return;
  if (!ready || !advisories) { card.hidden = true; return; }
  card.hidden = false;

  fillFacts(advisoryFacts(advisories, now));
  fillList('advisory-limits', advisories.provenance.limitations);

  const notes = $('advisory-notes');
  if (notes) {
    const text = advisories.provenance.notes.join(' · ');
    notes.textContent = text;
    notes.hidden = !text;
  }
}

/** @param {LegendRow[]} rows */
function fillLegend(rows) {
  const host = $('advisory-legend');
  if (!host) return;
  host.replaceChildren();
  host.hidden = rows.length === 0;
  if (!rows.length) return;

  for (const row of rows) {
    const item = document.createElement('span');
    item.className = 'viz-legend-item';
    item.dataset.severity = ADVISORY_CLASS_STYLE[row.classId].severity;
    const key = document.createElement('span');
    key.className = `viz-legend-key advisory-key advisory-key-${row.classId}`;
    const label = document.createElement('span');
    label.textContent = `${row.label} · ${row.count}`;
    label.title = row.note;
    item.append(key, label);
    host.appendChild(item);
  }

  /* The class that is deliberately not a swatch. Unshaded ground inside the
   * boundary was classified and came back low — which is the absence of a
   * modelled signal, not a clearance, and this is the sentence that keeps the
   * empty space from being read as one (ADR 0008). */
  const rest = document.createElement('span');
  rest.className = 'viz-legend-item advisory-legend-rest';
  rest.textContent = 'Unshaded inside the outline: low relative forcing — that is not a safety claim.';
  host.appendChild(rest);
}

/** @param {FactRow[]} rows */
function fillFacts(rows) {
  const host = $('advisory-facts');
  if (!host) return;
  host.replaceChildren();
  for (const row of rows) {
    const dt = document.createElement('dt');
    dt.textContent = row.label;
    const dd = document.createElement('dd');
    dd.textContent = row.value;
    if (row.note) {
      const note = document.createElement('span');
      note.className = 'segment-note';
      note.textContent = row.note;
      dd.appendChild(note);
    }
    host.append(dt, dd);
  }
}

/** @param {string} id @param {readonly string[]} items */
function fillList(id, items) {
  const host = $(id);
  if (!host) return;
  host.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    host.appendChild(li);
  }
}
