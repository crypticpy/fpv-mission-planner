// conditions-card.js — 3D-05's mission-conditions card, and the template row
// under it.
//
// The card answers "what is this air, and what does my machine have in hand
// against it" before a single gate is placed, so everything on it is a reading
// of numbers other passes already own: the launch elevation off the analysis
// inputs, density altitude and the lift/power margins off the plan, the wind
// rungs off the wind panel's own ladder model (handed in through the host's
// deps — one voice for wind, never a second derivation), and the amber line
// off the constraint list's own sentence. Nothing here computes; where a
// source has no figure the row is omitted or says so, and the mockup's
// thermal card is absent because no thermal model exists to read.
//
// Like advisory-panel.js this is not a map layer — the model half is pure
// functions over the snapshot, the DOM half fills two static hosts.

import { f0, ratio, liftSource } from '../../render/format.js';

/**
 * @typedef {import('../../application/analysis/analysis-contracts.js').AnalysisSnapshot} AnalysisSnapshot
 * @typedef {{ label: string, value: string, note?: string }} FactRow
 * @typedef {{ rows: { label: string, wind: string|null }[], shear: string|null, noLadder: string|null }} WindLadder
 * @typedef {{ id: string, label: string, hint: string, blocked: string|null }} TemplateChip
 */

const $ = (/** @type {string} */ id) => document.getElementById(id);

/* The constraint codes with a claim to this card's warning line, most severe
 * first. One line, first match: the card is a summary, and the full list is a
 * tab away in Review. */
const WIND_ADVISORY_CODES = ['W-WIND-LEE', 'W-WIND-ACCEL', 'W-WIND-REGIME'];

/**
 * The card's fact rows, in the order a pilot standing at the launch would ask
 * them: where am I, what is the air pretending to be, what am I flying, what
 * does it have in hand.
 *
 * The power-margin row exists only when the loadout states an electrical
 * ceiling — hover draw against a limit nobody stated is not a margin, and the
 * row is omitted rather than defaulted (ADR 0008).
 *
 * @param {AnalysisSnapshot} snapshot
 * @param {string|null} aircraftName
 * @param {import('../../domain/units.js').UnitSystem} u
 * @returns {FactRow[]}
 */
export function conditionsFacts(snapshot, aircraftName, u) {
  const plan = snapshot.plan;
  const elevM = snapshot.inputs.env?.elevM;
  /** @type {FactRow[]} */
  const rows = [];

  rows.push({
    label: 'Launch elevation',
    value: Number.isFinite(elevM) ? `${f0(u.altFromM(/** @type {number} */ (elevM)))} ${u.altUnit} MSL` : 'not set',
  });
  rows.push({
    label: 'Density altitude',
    value: plan && Number.isFinite(plan.densityAltM)
      ? `${f0(u.altFromM(plan.densityAltM))} ${u.altUnit}`
      : '—',
    note: 'what the air behaves like, not where you stand',
  });
  if (aircraftName) rows.push({ label: 'Aircraft', value: aircraftName });

  const flight = plan?.flight ?? null;
  rows.push({
    label: 'Lift margin',
    value: ratio(flight?.thrustToWeight),
    note: flight ? `thrust to weight, ${liftSource(flight)}` : undefined,
  });

  const maxW = flight?.maxElectricalW;
  const hoverW = plan?.hover?.pW;
  if (Number.isFinite(maxW) && /** @type {number} */ (maxW) > 0 && Number.isFinite(hoverW)) {
    const frac = 1 - /** @type {number} */ (hoverW) / /** @type {number} */ (maxW);
    rows.push({
      label: 'Power margin',
      value: `${f0(frac * 100)}%`,
      note: 'hover draw against the loadout’s stated electrical ceiling',
    });
  }
  return rows;
}

/**
 * The one warning line: the first wind constraint with a claim to this card,
 * in the producer's own sentence — never a paraphrase, never an invented
 * "shear above ridge" (ADR 0008).
 * @param {{ code: string, severity: string, text: string }[]|undefined} constraints
 * @returns {{ text: string, severity: string }|null}
 */
export function windAdvisory(constraints) {
  for (const code of WIND_ADVISORY_CODES) {
    const hit = constraints?.find((c) => c.code === code);
    if (hit) return { text: hit.text, severity: hit.severity };
  }
  return null;
}

/* ---------- the DOM half ---------- */

/**
 * The 3D-05 card. Called on every map render pass; visibility is the host's
 * call (3D mode, no leg inspector open), made where the mode lives.
 *
 * @param {object} view
 * @param {AnalysisSnapshot} view.snapshot
 * @param {WindLadder|null} view.ladder     the wind panel's own ladder model
 * @param {string|null} view.aircraftName
 * @param {import('../../domain/units.js').UnitSystem} view.units
 * @param {boolean} view.visible
 */
export function renderConditionsCard({ snapshot, ladder, aircraftName, units, visible }) {
  const card = $('conditions-card');
  if (!card) return;
  if (!visible || !snapshot.plan) { card.hidden = true; return; }
  card.hidden = false;

  const head = document.createElement('div');
  head.className = 'card-head';
  const title = document.createElement('h3');
  title.textContent = 'Mission conditions';
  head.appendChild(title);

  const facts = document.createElement('dl');
  facts.className = 'segment-facts';
  for (const row of conditionsFacts(snapshot, aircraftName, units)) {
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
    facts.append(dt, dd);
  }

  card.replaceChildren(head, facts, windBlock(ladder));

  const advisory = windAdvisory(snapshot.constraints);
  if (advisory) {
    const line = document.createElement('p');
    line.className = 'conditions-advisory';
    line.dataset.severity = advisory.severity;
    line.textContent = advisory.text;
    card.appendChild(line);
  }
}

/**
 * The wind rungs, borrowed voice and all. An absent ladder is said in the
 * panel's own words for the same absence, not silently skipped.
 * @param {WindLadder|null} ladder
 * @returns {HTMLElement}
 */
function windBlock(ladder) {
  const block = document.createElement('div');
  block.className = 'conditions-wind';
  const sub = document.createElement('h4');
  sub.textContent = 'Wind profile';
  block.appendChild(sub);

  if (!ladder || ladder.noLadder || !ladder.rows.length) {
    const p = document.createElement('p');
    p.className = 'conditions-nowind';
    p.textContent = ladder?.noLadder ?? 'No wind profile yet.';
    block.appendChild(p);
    return block;
  }

  const list = document.createElement('dl');
  list.className = 'conditions-rungs';
  for (const row of ladder.rows) {
    const dt = document.createElement('dt');
    dt.textContent = row.label;
    const dd = document.createElement('dd');
    dd.textContent = row.wind ?? 'no reading';
    list.append(dt, dd);
  }
  block.appendChild(list);

  if (ladder.shear) {
    const shear = document.createElement('p');
    shear.className = 'conditions-shear';
    shear.textContent = ladder.shear;
    block.appendChild(shear);
  }
  return block;
}

/**
 * The template chips along the bottom of the 3D view. A blocked template is a
 * disabled chip wearing its reason, not a missing one — the row is also the
 * catalogue of what the planner can sketch.
 *
 * @param {object} view
 * @param {TemplateChip[]} view.templates
 * @param {boolean} view.visible
 * @param {(id: string) => void} view.onApply
 */
export function renderRouteTemplates({ templates, visible, onApply }) {
  const host = $('route-templates');
  if (!host) return;
  host.hidden = !visible || templates.length === 0;
  if (host.hidden) { host.replaceChildren(); return; }

  host.replaceChildren(...templates.map((t) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'filter-chip route-template-chip';
    chip.textContent = t.label;
    chip.title = t.blocked ?? t.hint;
    chip.disabled = t.blocked !== null;
    if (!chip.disabled) chip.addEventListener('click', () => onApply(t.id));
    return chip;
  }));
}
