// footprint-panel.js — the footprint as numbers, under the map that draws it.
//
// Five tiles and a chart, and not one figure of their own: every value here is
// read off `snapshot.footprint` and `snapshot.plan`, which is the same pair the
// rings on the map are drawn from. That is the point of the split — the tile
// saying 4.2 km upwind and the ring reaching 4.2 km upwind cannot disagree,
// because they are the same number formatted twice.
//
// It is not a map layer. Nothing here draws on the canvas, it renders whether or
// not the engine has initialised, and it would survive the engine being swapped
// out entirely — so it takes the snapshot directly rather than a frame.

import { legend, lineChart } from '../../charts.js';

/**
 * @typedef {import('../../application/analysis/analysis-contracts.js').MissionFootprint} MissionFootprint
 * @typedef {import('../../application/analysis/analysis-contracts.js').SolvedPlan} SolvedPlan
 * @typedef {import('./map-adapter.js').UnitSet} UnitSet
 */

const $ = (/** @type {string} */ id) => document.getElementById(id);

/** The four cardinals the bearing axis is labelled with; 360 repeats 0. */
const COMPASS = { 0: 'N', 90: 'E', 180: 'S', 270: 'W', 360: 'N' };

const TILES = ['tile-upwind', 'tile-downwind', 'tile-crosswind', 'tile-area', 'tile-aloft'];

/**
 * @param {{ plan: SolvedPlan, footprint: MissionFootprint, units: UnitSet }} view
 */
export function renderFootprintPanel({ plan, footprint, units: u }) {
  const noLift = plan.flight.code === 'no_lift';
  const fmtDist = (/** @type {number} */ km) =>
    `${u.distanceFromKm(km).toFixed(1)} ${u.distanceUnit}`;

  /* The wind axis, rounded to the whole degree the tiles quote. The reaches
   * themselves are not rounded — they were read off the sweep at the exact
   * offset, which is why they can differ slightly from `byCourse[upC]`. */
  const upC = ((Math.round(footprint.windFromDeg) % 360) + 360) % 360;
  const downC = (upC + 180) % 360;

  if (noLift) {
    // Nothing flies, so nothing here is a distance. Say that in every tile
    // rather than printing zeroes that look like measurements.
    for (const id of TILES) setTile(id, '—', 'unavailable · insufficient lift');
  } else {
    setTile('tile-upwind', fmtDist(footprint.upwindKm), `course ${upC}° — into the wind`);
    setTile('tile-downwind', fmtDist(footprint.downwindKm), `course ${downC}° — wind behind`);
    setTile('tile-crosswind', fmtDist(footprint.crosswindKm),
      `course ${(upC + 90) % 360}° / ${(upC + 270) % 360}°`);
    setTile('tile-area', `${u.areaFromKm2(footprint.areaKm2).toFixed(1)} ${u.areaUnit}`,
      'planned-cruise envelope');
    setTile('tile-aloft', `${plan.timeMin.toFixed(1)} min`, 'dashboard planning case');
  }

  /* Range against heading, with the dashboard's own relative-wind case pinned on
   * it: the gap between the two curves is what the chosen cruise costs, and the
   * "planned" marker is where the rest of the app is standing on that trade. */
  const series = [
    {
      name: 'Planned cruise', color: 'var(--ring-planned)',
      pts: Array.from({ length: 361 },
        (_, c) => ({ x: c, y: u.distanceFromKm(footprint.byCourse[c % 360]) })),
    },
    {
      name: 'Theoretical best range', color: 'var(--ring-best)',
      pts: Array.from({ length: 361 },
        (_, c) => ({ x: c, y: u.distanceFromKm(footprint.bestByCourse[c % 360]) })),
    },
  ];
  const markers = [
    { x: upC, y: u.distanceFromKm(footprint.byCourse[upC]), color: 'var(--series-2)', label: 'upwind' },
    {
      x: downC, y: u.distanceFromKm(footprint.byCourse[downC]),
      color: 'var(--series-2)', label: 'downwind', labelBelow: true,
    },
    {
      x: footprint.plannedCourseDeg, y: u.distanceFromKm(plan.radiusKm),
      color: 'var(--series-4)', label: 'planned', labelBelow: true,
    },
  ];

  legend($('legend-bearing'), series);
  lineChart($('chart-bearing'), {
    series, markers, height: 240,
    xTicks: [0, 45, 90, 135, 180, 225, 270, 315, 360],
    xFmt: (/** @type {number} */ c) => COMPASS[c] ?? `${c}°`,
    yFmt: (/** @type {number} */ v) => `${v.toFixed(1)} ${u.distanceUnit}`,
    xLabel: 'outbound course over ground',
    yLabel: u.distanceUnit,
    tipTitle: 'Course',
  });

  const chart = $('chart-bearing');
  chart.classList.toggle('flight-invalid', noLift);
  chart.dataset.flightMessage = noLift ? 'WILL NOT FLY · footprint unavailable' : '';
}

/** @param {string} id @param {string} value @param {string} sub */
function setTile(id, value, sub) {
  const tile = $(id);
  tile.querySelector('.tile-value').textContent = value;
  tile.querySelector('.tile-sub').textContent = sub;
}
