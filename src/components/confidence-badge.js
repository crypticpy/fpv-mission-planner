// components/confidence-badge.js — the ConfidenceBadge of the round-2 design
// system (M15, E-01/E-04): one chip that says where an airframe model's
// numbers come from and, when the pilot's own flights exist to measure it
// against, how close it has been. Renders confidence.modelConfidence()'s bag;
// all the honesty rules live there, none here.
//
// The word is the badge. The percentage and its meter appear only when the
// model has earned one (pct is null until logged cruise legs exist), and the
// meter is decorative — the same figure is always printed beside it, so the
// chip survives the round-2 rule that verdicts are never carried by color or
// geometry alone.
import { icon } from './icons.js';

/** @typedef {import('../confidence.js').ModelConfidence} ModelConfidence */

const WORDS = {
  measured: 'Measured',
  datasheet: 'Datasheet',
  estimated: 'Estimated',
  catalog: 'Catalog',
};

const GLYPHS = {
  measured: 'shield-check',
  datasheet: 'layers',
  estimated: 'circle-question',
  catalog: 'layers',
};

/**
 * @param {HTMLElement} host
 * @param {ModelConfidence|null} m  null (no drone) clears the mount
 */
export function renderConfidenceBadge(host, m) {
  // Own only the confbadge class family — mounts keep their layout classes
  // across renders, the data-freshness pattern.
  const kept = [...host.classList].filter((c) => !c.startsWith('confbadge'));
  if (!m) {
    host.className = kept.join(' ');
    host.removeAttribute('data-provenance');
    host.removeAttribute('title');
    host.replaceChildren();
    return;
  }
  host.className = [...kept, 'confbadge', `confbadge-${m.provenance}`].join(' ');
  host.dataset.provenance = m.provenance;
  const word = document.createElement('span');
  word.className = 'confbadge-word';
  word.textContent = WORDS[m.provenance] ?? m.provenance;
  const children = [icon(GLYPHS[m.provenance] ?? 'circle-question', 'confbadge-glyph'), word];
  if (m.pct != null) {
    const pct = document.createElement('span');
    pct.className = 'confbadge-pct';
    pct.textContent = `${m.pct}%`;
    const meter = document.createElement('span');
    meter.className = 'confbadge-meter';
    meter.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('span');
    fill.className = 'confbadge-fill';
    fill.style.width = `${m.pct}%`;
    meter.appendChild(fill);
    children.push(pct, meter);
    host.title = `Cruise economy within ${100 - m.pct}% of ${m.driftN} logged cruise ${m.driftN === 1 ? 'leg' : 'legs'}`;
  } else {
    host.title = m.nFlights > 0
      ? `${m.nFlights} logged ${m.nFlights === 1 ? 'flight' : 'flights'} — no accepted cruise legs yet, so no percentage`
      : 'No logged flights yet — the percentage appears once cruise legs exist to measure against';
  }
  host.replaceChildren(...children);
}
