// components/aircraft-card.js — one airframe in the Aircraft library (E-01): the
// name with its ConfidenceBadge, the class tag, one spec line, and the Use
// action. Pure DOM over a model, the mission-card contract: the caller decides
// every word and what Use does; this module only draws them. The badge is the
// point of the card — where this model's numbers come from, and how close they
// have been, is on every airframe before the pilot commits to one.
import { renderConfidenceBadge } from './confidence-badge.js';

/**
 * @typedef {object} AircraftCardModel
 * @property {string} name
 * @property {string} tag       the class line ('7.5" long range · 6S · XT60')
 * @property {string} specs     one muted line — mass, cruise, top speed
 * @property {import('../confidence.js').ModelConfidence|null} confidence
 * @property {boolean} flying   the airframe on the rail — gains aria-current
 *   and a badge word instead of a button
 * @property {() => void} onUse
 */

/**
 * @param {AircraftCardModel} model
 * @returns {HTMLElement}
 */
export function aircraftCard(model) {
  const card = document.createElement('article');
  card.className = 'accard';
  if (model.flying) card.setAttribute('aria-current', 'true');

  const head = document.createElement('div');
  head.className = 'accard-head';
  const name = document.createElement('span');
  name.className = 'accard-name';
  name.textContent = model.name;
  const conf = document.createElement('span');
  renderConfidenceBadge(conf, model.confidence);
  head.append(name, conf);

  const tag = document.createElement('p');
  tag.className = 'accard-tag';
  tag.textContent = model.tag;
  const specs = document.createElement('p');
  specs.className = 'accard-specs';
  specs.textContent = model.specs;

  const foot = document.createElement('div');
  foot.className = 'accard-foot';
  if (model.flying) {
    // A word, not a disabled button: there is nothing to press on the card
    // that is already on the rail.
    const on = document.createElement('span');
    on.className = 'accard-flying';
    on.textContent = 'ON THE RAIL';
    foot.append(on);
  } else {
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'map-btn';
    use.textContent = 'Use';
    use.setAttribute('aria-label', `Use ${model.name}`);
    use.addEventListener('click', () => { model.onUse(); });
    foot.append(use);
  }

  card.append(head, tag, specs, foot);
  return card;
}
