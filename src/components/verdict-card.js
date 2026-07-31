// components/verdict-card.js — the VerdictCard of the round-2 design system:
// GO / CAUTION / NO-GO / UNKNOWN, with the consequence and the next action on
// the card. Pure DOM over a model — the synthesis that decides the level lives
// with the analysis surfaces (render/dashboard.js verdict()); this module only
// draws what it is handed, which is what lets any future surface (brief,
// field screen, export) show the same verdict without re-deciding it.
import { icon } from './icons.js';

/**
 * The fourth state is the design's addition to the app's original three:
 * UNKNOWN is the card saying it *cannot answer* — no pack fits, no data — as
 * distinct from NO-GO, which is an answer. Gray and questioning rather than
 * red and alarmed, same as the warning stack's `unknown` severity.
 */
const LEVEL_ICON = {
  go: 'shield-check', caution: 'bailout', nogo: 'octagon-x', unknown: 'circle-question',
};

/**
 * @typedef {object} VerdictModel
 * @property {'go'|'caution'|'nogo'|'unknown'} level
 * @property {string} label    the badge word — GO, CAUTION, DON'T FLY, NO PACK
 * @property {string} why      the binding constraint, worst first
 * @property {string|null} fix the lever that moves it; hidden when empty
 * @property {string} margins  the chip line of supporting figures
 */

/** Build the card's skeleton once; renders only retext it. The child ids are
 *  kept from the pre-component markup — the browser specs and the brief's
 *  cross-checks name the badge and the why by id, and those names are the
 *  contract, not the DOM shape behind them. */
function ensure(host) {
  if (host.firstChild) return;
  const head = document.createElement('p');
  head.className = 'verdict-head';
  const glyph = document.createElement('span');
  glyph.className = 'verdict-icon';
  const badge = document.createElement('span');
  badge.id = 'verdict-badge';
  badge.className = 'verdict-badge';
  const why = document.createElement('span');
  why.id = 'verdict-why';
  why.className = 'verdict-why';
  head.append(glyph, badge, why);
  const fix = document.createElement('p');
  fix.id = 'verdict-fix';
  fix.className = 'verdict-fix';
  const margins = document.createElement('p');
  margins.id = 'verdict-margins';
  margins.className = 'verdict-margins';
  host.append(head, fix, margins);
}

/**
 * @param {HTMLElement} host
 * @param {VerdictModel} v
 */
export function renderVerdictCard(host, v) {
  ensure(host);
  host.className = `verdict verdict-${v.level}`;
  host.querySelector('.verdict-icon')
    .replaceChildren(icon(LEVEL_ICON[v.level] ?? 'circle-question', 'verdict-glyph'));
  host.querySelector('#verdict-badge').textContent = v.label;
  host.querySelector('#verdict-why').textContent = v.why;
  const fix = host.querySelector('#verdict-fix');
  fix.textContent = v.fix || '';
  fix.hidden = !v.fix;
  host.querySelector('#verdict-margins').textContent = v.margins;
}
