// render/batterychecks.js — the battery form's derived cross-checks (§6.1:
// "compute and show derived cross-checks … pack Wh/g, implied C-rating"), and
// the per-cell resistance entry that goes with them ("per-cell IR at a stated
// temperature").
//
// Its own module on the same seam render/thrustfield.js took: it owns two
// descriptor runs, the readout under the form, and the arithmetic behind both.
// render/controls.js keeps the battery form; this file keeps what the form says
// back while you type.
//
// Two rules from §6.1, and where each one is:
//   - Soft warnings, never a block. A pack claiming 0.4 Wh/g is a typo and gets
//     a sentence saying so; it still saves, because people build strange packs
//     and the model still runs on one.
//   - The stored field stays pack-level. `irPackMilliOhm` is what physics.js
//     reads, so per-cell entry is an *entry mode*: it computes the pack figure
//     live and that is what gets stored. `irTempC` rides along as provenance —
//     pack-temperature modeling is Phase 4, and this number is not an input.

import { CHEMISTRY } from '../domain/physics.js';
import { readForm } from '../forms.js';
import { f0, f1 } from './format.js';
import { $ } from './dom.js';

/* ---------- the arithmetic ---------- */

// Where a real pack's energy density lands, pack-level (cells, wire, wrap and
// connector all included). The packs in the catalog run 0.12 Wh/g for a small
// high-rate LiPo to 0.31 for a 21700 Li-Ion long-range build, so these bounds
// sit outside every honest pack we ship and still catch the mistake the README
// documents finding in a storefront listing: a capacity or a weight off by a
// factor, which reads as 0.4+ Wh/g or as 0.03.
export const WH_PER_G_RANGE = [0.08, 0.33];

// Above this, an "amps" figure is the burst number off the label rather than a
// continuous rating — the highest continuous figure in the catalog is ~64C, and
// that is already a derated high-rate LiHV.
const MAX_PLAUSIBLE_C = 120;

// The pack `ir` field's own max (schema and form agree on 500). A computed sum
// above it is almost always a whole-pack reading typed into the per-cell box.
const MAX_PACK_IR = 500;

/** Pack resistance from a per-cell reading: cells in series add, parallel groups divide. */
export function packIrFromCells(irCellMilliOhm, s, p) {
  if (!(irCellMilliOhm > 0) || !(s > 0)) return null;
  const groups = p > 0 ? p : 1;
  return Math.round((irCellMilliOhm * s / groups) * 10) / 10;
}

/**
 * Every derived figure the battery form can compute from what has been typed so
 * far, plus the soft warnings they earn. Returns null until capacity, weight and
 * cell count are all on the form — a Wh/g figure computed from two of the three
 * would be arithmetic about a pack nobody described.
 *
 * `nominalV` is the chemistry's own nominal cell voltage, so the Wh figure here
 * is on exactly the same basis as the energy tile's (physics.js CHEMISTRY).
 */
export function packCrossChecks({ chem, s, p, capAh, massG, maxContA, irCellMilliOhm } = {}) {
  const cells = Number.isFinite(s) && s > 0 ? s : null;
  const groups = Number.isFinite(p) && p > 0 ? p : 1;
  const ah = Number.isFinite(capAh) && capAh > 0 ? capAh : null;
  const g = Number.isFinite(massG) && massG > 0 ? massG : null;
  if (!cells || !ah || !g) return null;
  const vNom = (CHEMISTRY[chem] || CHEMISTRY.lipo).vNom;
  const packWh = vNom * cells * ah;
  const whPerG = packWh / g;
  const impliedC = Number.isFinite(maxContA) && maxContA > 0 ? maxContA / ah : null;
  const packIrMilliOhm = packIrFromCells(irCellMilliOhm, cells, groups);
  const warnings = [];
  const [lo, hi] = WH_PER_G_RANGE;
  if (whPerG > hi) {
    warnings.push(`${f1(packWh)} Wh in ${f0(g)} g is ${whPerG.toFixed(3)} Wh/g — no cell chemistry `
      + `on the market does that. Check the capacity and the weight (real packs run `
      + `${lo}–${hi} Wh/g).`);
  } else if (whPerG < lo) {
    warnings.push(`${whPerG.toFixed(3)} Wh/g is heavier than any real pack of this capacity — `
      + `check the weight and the mAh (real packs run ${lo}–${hi} Wh/g).`);
  }
  if (impliedC != null && impliedC > MAX_PLAUSIBLE_C) {
    warnings.push(`${f0(maxContA)} A on ${f1(ah)} Ah implies ${f0(impliedC)}C continuous — that is a `
      + 'burst figure. Enter the true continuous current, or leave it blank and let pack sag set the limit.');
  }
  if (packIrMilliOhm != null && packIrMilliOhm > MAX_PACK_IR) {
    warnings.push(`${f1(irCellMilliOhm)} mΩ × ${cells}S ÷ ${groups}P works out to ${f1(packIrMilliOhm)} mΩ `
      + '— that reads like a whole-pack figure typed as one cell. Switch to Whole pack, or check the '
      + 'charger’s per-cell screen. Until then the save falls back to a typical figure.');
  }
  return { packWh, whPerG, impliedC, vNom, cells, groups, packIrMilliOhm, warnings };
}

/* ---------- the per-cell entry fields ---------- */

// Appended to BATTERY_FORM by render/controls.js. The mode select is what makes
// the two IR fields unambiguous: exactly one of them is on screen, and the one
// that is, is the one the save reads.
export const IR_FIELDS = [
  // The `id` sits on the entry, not inside `details` — that is where forms.js
  // reads it from when it stamps the fold.
  { id: 'battery-ir-fold', details: { summary: 'Internal resistance — measured per cell?', fields: [
    { key: 'irMode', label: 'How you measured it', type: 'select', id: 'battery-ir-mode', options: [
      { value: 'pack', label: 'Whole pack — one reading for the pack' },
      { value: 'cell', label: 'Per cell — the charger’s per-cell figures' },
    ] },
    { grid: [
      { key: 'irCell', label: 'Per-cell IR', type: 'number', unit: 'mΩ',
        min: 0.2, max: 200, step: 'any', id: 'battery-ir-cell',
        help: 'One cell’s resistance. × cells in series ÷ parallel groups is the pack figure the '
          + 'plan uses, and it is worked out below as you type.' },
      { key: 'irTempC', label: 'Measured at', type: 'number', unit: '°C',
        min: -20, max: 60, step: 'any', id: 'battery-ir-temp',
        help: 'The pack’s temperature when you read it — resistance climbs as a pack cools. '
          + 'Recorded with the pack; the model has its own temperature curve and does not read it.' },
    ] },
  ] } },
];

/**
 * The pack-level resistance a submit should store, in mΩ, or null when the form
 * says nothing about it. Per-cell mode computes it here rather than trusting the
 * live write below: a paste followed immediately by Enter must not store the
 * figure from before the keystroke.
 */
export function resolvePackIr(v) {
  if (v.irMode === 'cell') {
    const computed = packIrFromCells(v.irCell, v.s, v.p);
    // An implausible sum is refused rather than stored: 500 is the schema's own
    // cap, and a figure past it would fail the very validate() gate our exports
    // are read back through. The readout has already warned about it.
    if (computed != null && computed >= 1 && computed <= MAX_PACK_IR) return computed;
    if (computed != null) return null;
  }
  return Number.isFinite(v.ir) ? v.ir : null;
}

/* ---------- the readout ---------- */

let fields = null; // the descriptor the form on screen was built from
let formEl = null;

const modeSelect = () => formEl?.elements.namedItem('irMode') || null;

// Exactly one of the two entry paths on screen at a time. The pack input lives in
// the main grid, so it is hidden by its own label; the per-cell pair lives inside
// the fold and is hidden as a run.
function syncIrMode() {
  const cell = modeSelect()?.value === 'cell';
  const packLabel = formEl?.elements.namedItem('ir')?.closest('label');
  if (packLabel) packLabel.hidden = cell;
  // Only the per-cell figure is mode-bound. The temperature it was read at
  // applies to a whole-pack reading just the same, so it stays on screen.
  const cellLabel = formEl?.querySelector('#battery-ir-cell')?.closest('label');
  if (cellLabel) cellLabel.hidden = !cell;
}

/** The live cross-check line, and the soft warnings under it. */
export function renderBatteryChecks() {
  if (!formEl || !fields) return;
  const v = readForm(formEl, fields);
  const checks = $('battery-checks');
  const warn = $('battery-warn');
  const cellMode = v.irMode === 'cell';
  const c = packCrossChecks({
    chem: v.chem,
    s: v.s,
    p: v.p,
    capAh: Number.isFinite(v.mah) ? v.mah / 1000 : null,
    massG: v.mass,
    maxContA: v.amps,
    irCellMilliOhm: cellMode ? v.irCell : null,
  });
  if (!c) {
    checks.textContent = 'Cells, capacity and weight — this line works out the pack’s Wh/g and what '
      + 'its current limit implies as you type.';
    warn.hidden = true;
    warn.textContent = '';
    return;
  }
  // In per-cell mode the pack figure is derived, so it is shown as the sum it is:
  // the pilot can check our arithmetic against their charger before saving.
  if (cellMode && c.packIrMilliOhm != null) {
    const el = formEl.elements.namedItem('ir');
    // Property only — a post-save form.reset() must not hand the next pack this
    // one's resistance as its default — and only a value the field itself
    // accepts: an out-of-range figure parked in the hidden input would make the
    // browser refuse the submit with nothing on screen saying why.
    if (el) el.value = c.packIrMilliOhm >= 1 && c.packIrMilliOhm <= MAX_PACK_IR ? String(c.packIrMilliOhm) : '';
  }
  checks.textContent = [
    `${c.cells}S${c.groups}P · ${f1(c.packWh)} Wh at ${c.vNom} V/cell`,
    `${c.whPerG.toFixed(3)} Wh/g`,
    c.impliedC != null ? `implies ${f0(c.impliedC)}C continuous` : null,
    cellMode && c.packIrMilliOhm != null
      ? `${f1(v.irCell)} mΩ × ${c.cells}S ÷ ${c.groups}P = ${f1(c.packIrMilliOhm)} mΩ pack`
      : null,
  ].filter(Boolean).join(' · ');
  warn.textContent = c.warnings.join(' ');
  warn.hidden = c.warnings.length === 0;
}

// Same 150 ms the drone form's live line uses: cheap per keystroke, still reads
// as live.
let timer = 0;
function queueReadout() {
  clearTimeout(timer);
  timer = setTimeout(renderBatteryChecks, 150);
}

/**
 * Wire the readout and the entry-mode visibility onto a built battery form.
 * Called once, from buildAuthoringForms(), with the descriptor the form was
 * generated from — passed in rather than imported, so this module stays a leaf.
 */
export function mountBatteryChecks(el, formFields) {
  formEl = el;
  fields = formFields;
  syncIrMode();
  el.addEventListener('change', (e) => {
    if (e.target?.name === 'irMode') syncIrMode();
    queueReadout();
  });
  el.addEventListener('input', queueReadout);
  renderBatteryChecks();
}

/** After a save: form.reset() puts the mode back, so put the visibility back too. */
export function resetBatteryChecks() {
  syncIrMode();
  renderBatteryChecks();
}
