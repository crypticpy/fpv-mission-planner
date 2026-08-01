// components/mission-card.js — one mission in the Library's list (L-01): a
// route thumbnail, the title with an origin badge, the loadout and the stats,
// and the row's actions. Pure DOM over a model, the same contract
// recovery-entry.js draws under: the caller decides every word and what the
// buttons do; this module only draws them, so the list and any future "recent
// missions" surface share one card instead of growing two.

/** The badge word for where a document came from — always a word, never colour alone. */
const ORIGIN_BADGE = Object.freeze({
  authored: 'SAVED',
  imported: 'IMPORTED',
  duplicated: 'COPY',
});

const SVG_NS = 'http://www.w3.org/2000/svg';
const THUMB_W = 64;
const THUMB_H = 48;
const THUMB_PAD = 6;

/**
 * The route as a little map: the path normalized into the thumbnail box —
 * longitude scaled by cos(mid-latitude) so a route that is round on the ground
 * is round in the thumbnail — with a dot at the launch point. Decorative
 * (aria-hidden): every fact it shows is in the card's own text.
 * @param {[number, number][]} path  [lat, lng] tuples, launch first
 * @returns {SVGSVGElement}
 */
function routeThumb(path) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'mission-thumb');
  svg.setAttribute('viewBox', `0 0 ${THUMB_W} ${THUMB_H}`);
  svg.setAttribute('aria-hidden', 'true');
  if (!path.length) return svg;

  const lats = path.map((p) => p[0]);
  const lngs = path.map((p) => p[1]);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const kx = Math.max(0.01, Math.cos(midLat * Math.PI / 180));
  const xs = lngs.map((lng) => lng * kx);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...lats) - Math.min(...lats);
  // One scale for both axes keeps the route's shape; a degenerate span (a
  // single point, or all points on one meridian) falls back to centring.
  const span = Math.max(spanX, spanY);
  const scale = span > 0
    ? Math.min((THUMB_W - 2 * THUMB_PAD) / (spanX || span), (THUMB_H - 2 * THUMB_PAD) / (spanY || span))
    : 0;
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...lats) + Math.max(...lats)) / 2;
  const px = (i) => THUMB_W / 2 + (xs[i] - cx) * scale;
  const py = (i) => THUMB_H / 2 - (lats[i] - cy) * scale; // north is up

  if (path.length > 1) {
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('class', 'mission-thumb-route');
    line.setAttribute('points', path.map((_, i) => `${px(i).toFixed(1)},${py(i).toFixed(1)}`).join(' '));
    svg.appendChild(line);
  }
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('class', 'mission-thumb-launch');
  dot.setAttribute('cx', px(0).toFixed(1));
  dot.setAttribute('cy', py(0).toFixed(1));
  dot.setAttribute('r', '2.5');
  svg.appendChild(dot);
  return svg;
}

/**
 * @typedef {object} MissionCardAction
 * @property {string} label
 * @property {(btn: HTMLButtonElement) => void} act  handed its own button so a
 *   two-step action can re-word itself ("delete — sure?") without a re-render
 *   that would drop keyboard focus mid-confirmation
 * @property {boolean} [primary]  drawn as a solid button rather than a link
 */

/**
 * @typedef {object} MissionCardModel
 * @property {string} title
 * @property {'authored'|'imported'|'duplicated'} origin
 * @property {boolean} [open]     the mission on screen — gains aria-current
 * @property {[number, number][]} path  [lat, lng] tuples for the thumbnail
 * @property {string} [loadout]   one muted line — the rig this was planned
 *   with; omitted entirely for a document that carries no loadout snapshot
 * @property {string} stats       one muted line — distance, waypoints, age
 * @property {MissionCardAction[]} actions
 */

/**
 * @param {MissionCardModel} model
 * @returns {HTMLElement}
 */
export function missionCard(model) {
  const row = document.createElement('div');
  row.className = 'spot-row mission-card';
  row.dataset.origin = model.origin;
  if (model.open) row.setAttribute('aria-current', 'true');

  const text = document.createElement('div');
  text.className = 'spot-text';
  const head = document.createElement('span');
  head.className = 'recovery-head';
  const name = document.createElement('span');
  name.className = 'spot-name';
  name.textContent = model.title;
  const badge = document.createElement('span');
  badge.className = 'recovery-badge';
  badge.textContent = ORIGIN_BADGE[model.origin] ?? String(model.origin).toUpperCase();
  head.append(name, badge);
  text.append(head);
  if (model.loadout) {
    const loadout = document.createElement('span');
    loadout.className = 'spot-meta';
    loadout.textContent = model.loadout;
    text.append(loadout);
  }
  const stats = document.createElement('span');
  stats.className = 'spot-meta';
  stats.textContent = model.stats;
  text.append(stats);

  const actions = document.createElement('div');
  actions.className = 'spot-actions';
  for (const a of model.actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = a.primary ? 'map-btn' : 'link-btn';
    btn.textContent = a.label;
    btn.addEventListener('click', () => { a.act(btn); });
    actions.appendChild(btn);
  }

  row.append(routeThumb(model.path), text, actions);
  return row;
}
