// components/mission-summary.js — the MissionSummary of the round-2 design
// system: the four numbers a pilot walks to the field with — distance out,
// duration, when to turn for home, and what the pack lands with — plus the
// reserve headline. M9 mounts it at the top of Field, so the day-of screen
// opens with the plan the pilot just made; the brief and export surfaces can
// reuse the same model as they are reworked.
import { icon } from './icons.js';
import { units } from '../state.js';
import { f0, f1, mmss, article } from '../render/format.js';
import { legTimes } from '../render/dashboard.js';

/**
 * @typedef {object} MissionSummaryModel
 * @property {{label: string, value: string}[]} cells  always four, dashes when unanswerable
 * @property {string|null} reserve  the get-home headline, null when no leg closes
 */

/**
 * Read the summary straight off the plan the render pass already drew. Every
 * figure here is the dashboard's own — same formatters, same legTimes — so
 * Field and Plan cannot show a pilot two different missions.
 * @param {any} r  snapshot.plan
 * @returns {MissionSummaryModel}
 */
export function summaryModelFrom(r) {
  const u = units();
  const noLift = r.flight.code === 'no_lift';
  const flies = !noLift && r.radiusKm > 0;
  const times = flies ? legTimes(r) : null;
  const end = r.timeline.at(-1);
  const soc = flies && end && isFinite(end.soc) ? end.soc : null;
  const cells = [
    { label: 'Distance out', value: flies ? `${f1(u.distanceFromKm(r.radiusKm))} ${u.distanceUnit}` : '—' },
    { label: 'Duration', value: flies ? mmss(r.timeMin) : '—' },
    { label: 'Turn home', value: times ? mmss(times.outMin) : '—' },
    { label: 'Landing', value: soc != null ? `~${f0(soc)}%` : '—' },
  ];
  let reserve = null;
  if (flies && r.energy.holdsHeadwindMs != null && r.legs.home) {
    const holds = f0(u.speedFromMs(r.energy.holdsHeadwindMs));
    reserve = `Reserve holds to ${article(holds)} ${holds} ${u.speedUnit} headwind`
      + ` · ${f1(r.energy.reserveWh)} Wh held back`;
  }
  return { cells, reserve };
}

function ensure(host) {
  if (host.firstChild) return;
  const title = document.createElement('p');
  title.className = 'msummary-title';
  title.textContent = 'Current mission';
  const grid = document.createElement('div');
  grid.className = 'msummary-grid';
  for (let i = 0; i < 4; i++) {
    const cell = document.createElement('div');
    cell.className = 'msummary-cell';
    const label = document.createElement('p');
    label.className = 'msummary-label';
    const value = document.createElement('p');
    value.className = 'msummary-value';
    cell.append(label, value);
    grid.appendChild(cell);
  }
  const reserve = document.createElement('p');
  reserve.className = 'msummary-reserve';
  host.append(title, grid, reserve);
}

/**
 * @param {HTMLElement} host
 * @param {MissionSummaryModel} m
 */
export function renderMissionSummary(host, m) {
  ensure(host);
  host.className = 'msummary card';
  const cells = host.querySelectorAll('.msummary-cell');
  m.cells.forEach((c, i) => {
    cells[i].querySelector('.msummary-label').textContent = c.label;
    cells[i].querySelector('.msummary-value').textContent = c.value;
  });
  const reserve = host.querySelector('.msummary-reserve');
  reserve.hidden = !m.reserve;
  if (m.reserve) {
    const text = document.createElement('span');
    text.textContent = m.reserve;
    reserve.replaceChildren(icon('shield-check', 'msummary-glyph'), text);
  } else {
    reserve.replaceChildren();
  }
}
