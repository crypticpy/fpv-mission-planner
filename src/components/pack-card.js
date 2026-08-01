// components/pack-card.js — one physical pack in the battery-instance library
// (E-02): the pack's own name, the model it is a copy of, the numbers the pilot
// has recorded for it, and the Fly action. Pure DOM over a model, the
// mission-card contract: the caller decides every word and what Fly does.
//
// The chip in the head answers one question — which resistance the plan flies
// if this card is chosen: the pilot's own measurement, or the figure on record
// for the model. There is no health percentage anywhere on the card, on
// purpose: cycles and a measured IR are facts; a health score would be a
// derating model nobody has anchored data for (see src/packinstances.js).
/**
 * @typedef {object} PackCardModel
 * @property {string} label     the pack's own name ('Pack #2', 'Catalog spec')
 * @property {string} model     the model line ('6S Li-Ion · 5,000 mAh')
 * @property {string} stats     one muted line — cycles, IR, measured-at temp
 * @property {string} warn      a caution sentence, or '' for none
 * @property {boolean} measured this choice flies a measured resistance
 * @property {boolean} planned  the pack the plan is flying — gains
 *   aria-current and a badge word instead of a button
 * @property {() => void} onFly
 */

/**
 * @param {PackCardModel} model
 * @returns {HTMLElement}
 */
export function packCard(model) {
  const card = document.createElement('article');
  card.className = 'accard';
  if (model.planned) card.setAttribute('aria-current', 'true');

  const head = document.createElement('div');
  head.className = 'accard-head';
  const label = document.createElement('span');
  label.className = 'accard-name';
  label.textContent = model.label;
  const chip = document.createElement('span');
  chip.className = model.measured ? 'packcard-chip measured' : 'packcard-chip';
  chip.textContent = model.measured ? 'Measured' : 'Spec';
  head.append(label, chip);

  const line = document.createElement('p');
  line.className = 'accard-tag';
  line.textContent = model.model;
  const stats = document.createElement('p');
  stats.className = 'accard-specs';
  stats.textContent = model.stats;

  card.append(head, line, stats);
  if (model.warn) {
    const warn = document.createElement('p');
    warn.className = 'packcard-warn';
    warn.textContent = model.warn;
    card.append(warn);
  }

  const foot = document.createElement('div');
  foot.className = 'accard-foot';
  if (model.planned) {
    const on = document.createElement('span');
    on.className = 'accard-flying';
    on.textContent = 'IN THE PLAN';
    foot.append(on);
  } else {
    const fly = document.createElement('button');
    fly.type = 'button';
    fly.className = 'map-btn';
    fly.textContent = 'Fly';
    fly.setAttribute('aria-label', `Fly ${model.label}`);
    fly.addEventListener('click', () => { model.onFly(); });
    foot.append(fly);
  }
  card.append(foot);
  return card;
}
