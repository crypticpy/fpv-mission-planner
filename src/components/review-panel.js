// components/review-panel.js — Review mode's resolve-and-confirm panel
// (M10 wave D, P-05/T-04).
//
// The one verdict already sits above every Plan mode (#verdict, persistent
// chrome), so this panel does not draw a second one — two verdicts on one
// screen is the disagreement the design forbids. What Review adds is the half
// the passive warning stack cannot carry: each finding's evidence (what it
// read, what it assumed, what it cannot see) and its fix link — the specific
// editor or control that moves it, from the fix-linking engine. app.js hides
// the passive stack while Review is open; the same rows twice would say the
// stack and this list might disagree, and they never can: same constraints,
// same severity sort, same row tones.
//
// Same shape as the other M10 panels: a pure model off the snapshot, a render
// that draws only the model, actions handed back to the caller as descriptors.

import { units } from '../state.js';
import { f0, f1 } from '../render/format.js';
import { SEVERITY_RANK } from '../application/analysis/analysis-contracts.js';
import { fixFor } from '../application/analysis/fix-links.js';

/** @typedef {import('../application/analysis/fix-links.js').FixAction} FixAction */

/**
 * @typedef {object} ReviewFix
 * @property {string} id
 * @property {string} code
 * @property {string} severity
 * @property {string} text
 * @property {{inputs: readonly string[], baseline: string, limitations: readonly string[]}|null} explanation
 * @property {Readonly<FixAction>|null} action
 */

/**
 * @typedef {object} ReviewRecoveryLine
 * @property {string} label
 * @property {string} value
 * @property {boolean} stated  false when the plan simply has not said, which is
 *   drawn as an absence rather than a default
 * @property {Readonly<FixAction>|null} action
 */

/**
 * @typedef {object} ReviewModel
 * @property {'no-plan'|'ready'} state
 * @property {ReviewFix[]} fixes
 * @property {{lines: string[], action: Readonly<FixAction>}|null} reserve
 * @property {ReviewRecoveryLine[]|null} recovery  null when the mission carries
 *   no dive at all; a dive with nothing authored still returns three unstated
 *   rows, because an empty recovery plan is the finding
 */

const rank = (/** @type {{severity: string}} */ c) =>
  SEVERITY_RANK[c.severity] ?? SEVERITY_RANK.unknown;

/**
 * The panel, off the snapshot alone: every constraint the analysis holds,
 * worst first in ADR 0008's order, each carrying its evidence verbatim and the
 * fix the engine links it to — null when there is no honest one. Plus P-05's
 * final-reserve confirmation, said in words rather than a slider position, and
 * M16's recovery read-back when the mission carries a dive.
 * @param {any} snapshot
 * @param {import('../presentation/map/map-adapter.js').DiveProjection|null} [dive]
 * @returns {ReviewModel}
 */
export function reviewModelFrom(snapshot, dive = null) {
  const r = snapshot?.plan;
  if (!r) return { state: 'no-plan', fixes: [], reserve: null, recovery: null };
  const u = units();

  const fixes = [...(snapshot.constraints ?? [])]
    .sort((a, b) => rank(a) - rank(b))
    .map((c) => ({
      id: c.id, code: c.code, severity: c.severity, text: c.text,
      explanation: c.explanation ?? null, action: fixFor(c),
    }));

  const e = r.energy;
  const lines = [
    `Don’t land below ${f0(e.landFloorPct)}% — ${f1(e.reserveWh)} Wh stays in the pack.`,
  ];
  if (e.holdsHeadwindMs != null && r.legs.home) {
    const holds = `${f0(u.speedFromMs(e.holdsHeadwindMs))} ${u.speedUnit}`;
    lines.push(e.reserveBinds === 'getHome'
      ? `Getting home is what caps this mission: ${f1(e.getHomeWh)} Wh at the turnaround beats a ${holds} headwind back.`
      : `The ${f0(e.landFloorPct)}% floor is what caps this mission; the reserve still holds a ${holds} headwind home.`);
  }
  const reserve = {
    lines,
    action: Object.freeze(
      /** @type {FixAction} */ ({ kind: 'conditions', control: 'reserve', label: 'Adjust the reserve' })),
  };

  return { state: 'ready', fixes, reserve, recovery: recoveryLines(dive, u) };
}

/**
 * The way out, read back before launch (M16, 3D-08).
 *
 * Three questions a mountain dive has to answer and the rest of the app never
 * asks: how high the aircraft climbs on a lost link, where it puts down if it
 * cannot come home, and which gate the pilot breaks the run off at. Each is
 * authored — nothing derives them — so an unstated one is printed as unstated
 * with the control that states it beside it. Defaulting any of the three would
 * be this panel telling a pilot they have a recovery plan they do not have.
 *
 * @param {import('../presentation/map/map-adapter.js').DiveProjection|null} dive
 * @param {ReturnType<typeof units>} u
 * @returns {ReviewRecoveryLine[]|null}
 */
function recoveryLines(dive, u) {
  if (!dive) return null;
  /* All three land on the recovery panel, and 'contingency' is what map-view
     calls it: none of the three is a *leg*, so there is no leg inspector to
     open, and a fix link that opened one would leave the pilot on a panel with
     no control for the thing they clicked. */
  const tune = Object.freeze(
    /** @type {FixAction} */ ({ kind: 'dive', gate: 'contingency', label: 'Open the recovery plan' }));

  const rth = dive.rthAltitudeMslM;
  const bailout = dive.bailout;
  const abort = (dive.gates ?? []).find((g) => g.kind === 'abort') ?? null;

  return [
    {
      label: 'Lost-link altitude',
      value: rth == null
        ? 'not stated'
        : `climb to ${f0(u.altFromM(rth))} ${u.altUnit} MSL`,
      stated: rth != null,
      action: tune,
    },
    {
      label: 'Bailout landing',
      value: bailout
        ? bailout.name + (bailout.elevationMslM == null
          ? ' — elevation not surveyed'
          : ` — ${f0(u.altFromM(bailout.elevationMslM))} ${u.altUnit} MSL`)
        : 'no site chosen',
      stated: !!bailout,
      action: tune,
    },
    {
      label: 'Abort gate',
      value: abort
        ? `break off at ${f0(u.altFromM(abort.altitudeMslM))} ${u.altUnit} MSL`
        : 'no gate set',
      stated: !!abort,
      action: tune,
    },
  ];
}

/* ---------- render ---------- */

/**
 * One evidence disclosure: the constraint's own explanation, in the ADR 0008
 * shape — what it read, what it assumed, what it cannot see.
 * @param {ReviewFix['explanation']} ex
 */
function evidence(ex) {
  const det = document.createElement('details');
  det.className = 'fix-evidence';
  const sum = document.createElement('summary');
  sum.textContent = 'Evidence';
  det.appendChild(sum);
  const add = (/** @type {string} */ label, /** @type {string} */ text) => {
    if (!text) return;
    const p = document.createElement('p');
    const b = document.createElement('span');
    b.className = 'fix-evidence-label';
    b.textContent = label;
    p.append(b, ` ${text}`);
    det.appendChild(p);
  };
  add('Read from:', (ex.inputs ?? []).join(', '));
  add('Baseline:', ex.baseline);
  add('Cannot see:', (ex.limitations ?? []).join(', '));
  return det;
}

/**
 * @param {ReviewFix} fx
 * @param {(a: Readonly<FixAction>) => void} onAction
 */
function fixRow(fx, onAction) {
  const row = document.createElement('div');
  row.className = `warn warn-${fx.severity} fixrow`;
  row.setAttribute('role', 'listitem');
  row.dataset.code = fx.code;
  row.dataset.severity = fx.severity;
  const level = document.createElement('span');
  level.className = 'warn-level';
  level.textContent = fx.severity;
  const body = document.createElement('div');
  body.className = 'fixrow-body';
  const text = document.createElement('p');
  text.className = 'fixrow-text';
  text.textContent = fx.text;
  body.appendChild(text);
  if (fx.explanation) body.appendChild(evidence(fx.explanation));
  row.append(level, body);
  if (fx.action) {
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'fix-go';
    go.textContent = fx.action.label;
    go.addEventListener('click', () => onAction(fx.action));
    row.appendChild(go);
  }
  return row;
}

/**
 * @param {HTMLElement} host
 * @param {ReviewModel} m
 * @param {{ onAction?: (a: Readonly<FixAction>) => void }} [opts]
 */
export function renderReviewPanel(host, m, opts = {}) {
  const onAction = opts.onAction ?? (() => {});
  host.replaceChildren();
  // app.js only reaches Review's render with a plan in hand, and the CSS
  // data-plan="none" rule blanks the whole panel besides — the guard keeps a
  // direct render honest rather than crashing on a missing plan.
  if (m.state !== 'ready') return;

  const fixes = document.createElement('section');
  fixes.className = 'card review-fixes';
  const fTitle = document.createElement('h3');
  fTitle.textContent = 'Findings';
  const fSub = document.createElement('p');
  fSub.className = 'card-sub';
  fixes.append(fTitle, fSub);
  if (m.fixes.length === 0) {
    fSub.textContent = 'Every check came back clean.';
  } else {
    fSub.textContent = 'Worst first. Each link lands on the control that moves it.';
    const list = document.createElement('div');
    list.className = 'fixlist';
    list.setAttribute('role', 'list');
    for (const fx of m.fixes) list.appendChild(fixRow(fx, onAction));
    fixes.appendChild(list);
  }

  const reserve = document.createElement('section');
  reserve.className = 'card review-reserve';
  const rTitle = document.createElement('h3');
  rTitle.textContent = 'Final reserve';
  reserve.appendChild(rTitle);
  for (const line of m.reserve.lines) {
    const p = document.createElement('p');
    p.className = 'review-reserve-line';
    p.textContent = line;
    reserve.appendChild(p);
  }
  const adjust = document.createElement('button');
  adjust.type = 'button';
  adjust.className = 'fix-go';
  adjust.textContent = m.reserve.action.label;
  adjust.addEventListener('click', () => onAction(m.reserve.action));
  reserve.appendChild(adjust);

  host.append(fixes, reserve);
  if (m.recovery) host.appendChild(recoveryCard(m.recovery, onAction));
}

/**
 * The recovery read-back. Only built when a dive exists — for every other
 * mission there is no lost-link altitude to state, and a card of three "not
 * stated" rows on a park flight would train the pilot to scroll past it on the
 * one flight where it matters.
 *
 * @param {ReviewRecoveryLine[]} lines
 * @param {(a: Readonly<FixAction>) => void} onAction
 */
function recoveryCard(lines, onAction) {
  const card = document.createElement('section');
  card.className = 'card review-recovery';
  card.id = 'review-recovery';
  const title = document.createElement('h3');
  title.textContent = 'Recovery plan';
  const sub = document.createElement('p');
  sub.className = 'card-sub';
  sub.textContent = 'The dive’s way out. Every line is authored — nothing here is derived.';
  card.append(title, sub);

  const list = document.createElement('dl');
  list.className = 'recovery-lines';
  for (const line of lines) {
    const dt = document.createElement('dt');
    dt.textContent = line.label;
    const dd = document.createElement('dd');
    dd.dataset.stated = String(line.stated);
    dd.textContent = line.value;
    if (!line.stated && line.action) {
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'fix-go recovery-go';
      go.textContent = line.action.label;
      go.addEventListener('click', () => onAction(/** @type {Readonly<FixAction>} */ (line.action)));
      dd.appendChild(go);
    }
    list.append(dt, dd);
  }
  card.appendChild(list);
  return card;
}
