// components/system-state.js — the system-state framework of the round-2
// design system: one card shape for every "the app can't show you data here"
// moment — loading / empty / partial / offline / stale / permission-denied /
// recoverable-error — so those states read as designed surfaces rather than
// seven ad-hoc apologies. A dashed icon tile, an uppercase title, one line of
// body, at most one action.
import { icon } from './icons.js';

/**
 * partial and recoverable-error share the bailout triangle deliberately: both
 * are "something is wrong with what you'd otherwise trust here", which is the
 * same alert the warning stack wears. loading has no glyph — it renders the
 * animated dots instead, because a static icon that means "wait" reads as
 * "broken" the moment it sits still too long.
 */
const KIND_ICON = {
  empty: 'box-plus',
  partial: 'bailout',
  offline: 'cloud-off',
  stale: 'clock',
  'permission-denied': 'location-off',
  'recoverable-error': 'bailout',
  loading: null,
};

/**
 * @typedef {object} SystemStateSpec
 * @property {keyof typeof KIND_ICON} kind
 * @property {string} title  short and uppercase-styled by CSS — 'NO MISSION YET'
 * @property {string} body   one line of why, in the pilot's words
 * @property {{label: string, onClick: () => void}} [action]
 */

/**
 * Draw a system state into a host, or clear it. Unlike the other components
 * this one rebuilds rather than retexts: the states are rare, mutually
 * exclusive, and cheap, and a skeleton for seven variants would out-weigh all
 * of them.
 * @param {HTMLElement} host
 * @param {SystemStateSpec|null} spec  null hides the host and empties it
 */
export function renderSystemState(host, spec) {
  host.hidden = !spec;
  if (!spec) {
    host.replaceChildren();
    host.className = '';
    return;
  }
  host.className = `sysstate sysstate-${spec.kind}`;
  const tile = document.createElement('div');
  tile.className = 'sysstate-tile';
  if (spec.kind === 'loading') {
    const dots = document.createElement('div');
    dots.className = 'sysstate-dots';
    dots.append(...[0, 1, 2].map(() => document.createElement('span')));
    tile.appendChild(dots);
  } else {
    tile.appendChild(icon(KIND_ICON[spec.kind] ?? 'circle-question', 'sysstate-glyph'));
  }
  const title = document.createElement('p');
  title.className = 'sysstate-title';
  title.textContent = spec.title;
  const body = document.createElement('p');
  body.className = 'sysstate-body';
  body.textContent = spec.body;
  host.replaceChildren(tile, title, body);
  if (spec.action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'map-btn sysstate-action';
    btn.textContent = spec.action.label;
    btn.addEventListener('click', spec.action.onClick);
    host.appendChild(btn);
  }
}
