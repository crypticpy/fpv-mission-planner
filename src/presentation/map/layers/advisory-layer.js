// advisory-layer.js — the mountain-flow zones, as an area wash under everything.
//
// M5's first three waves computed the finding: a sampled elevation grid around
// the route, a terrain-forcing class for every cell of it, a stability regime,
// and the provenance that dates and bounds all three. They arrive whole on
// `snapshot.advisories`. This file turns cell centres into polygons and classes
// into colours and does nothing else — if a number here did not come off the
// snapshot, it is a bug.
//
// Three rules hold the picture to what the model actually said.
//
//   *Only a finding is shaded.* The hazard and advisory classes take a fill;
//     `low` takes none, and the sampled area gets a single boundary outline
//     instead. A carpet of green over everything the model shrugged at would
//     read as a clearance, and low modelled forcing is not a clearance — it is
//     the absence of a signal in a proxy that models very little (ADR 0008).
//
//   *Missing data is drawn, and drawn differently.* An `unknown` cell had no
//     elevation to classify. It is filled in the rail's unknown grey and
//     outlined dashed, so it can be mistaken for neither a hazard nor clear air.
//
//   *Nothing is drawn unless the advisory is ready.* 'pending' and 'unavailable'
//     draw nothing at all — the warning rail already says which and why, and a
//     partly drawn field would be this layer claiming a coverage it does not
//     have.
//
// The colours are ADR 0008's severity taxonomy, reached through the same custom
// properties the warning rail uses, so a cell and the constraint that counts it
// can never come out different colours on one screen.

import { destination } from '../../../domain/geo.js';

/**
 * @typedef {import('../map-adapter.js').LatLng} LatLng
 * @typedef {import('../map-adapter.js').MapAdapter} MapAdapter
 * @typedef {import('../map-adapter.js').MapFrame} MapFrame
 * @typedef {import('../map-adapter.js').MapLayer} MapLayer
 * @typedef {import('../map-adapter.js').ShapeOverlay} ShapeOverlay
 * @typedef {import('../map-adapter.js').ShapeStyle} ShapeStyle
 * @typedef {import('../../../application/analysis/analysis-contracts.js').AdvisoryField} AdvisoryField
 * @typedef {import('../../../application/terrain/terrain-contracts.js').AdvisoryGrid} AdvisoryGrid
 * @typedef {import('../../../domain/wind/terrain-forcing.js').ForcingClassId} ForcingClassId
 * @typedef {import('../../../domain/wind/terrain-forcing.js').ForcingSeverity} ForcingSeverity
 */

/**
 * How one class is drawn, and nothing about what it means.
 *
 * `cssVar` is the theme token, which is what the 2D engine is handed. `rgb` is
 * the same colour as literal channels, for the one consumer that cannot read a
 * custom property: deck.gl in the 3D scene resolves the token at runtime and
 * falls back to these, exactly as scene-layers.js does for every other colour.
 *
 * @typedef {object} AdvisoryCellStyle
 * @property {ForcingSeverity} severity   ADR 0008's, mirrored from the domain
 * @property {string} cssVar
 * @property {[number, number, number]} rgb
 * @property {boolean} fill        whether the class is shaded at all
 * @property {number} fillOpacity
 * @property {boolean} dashed      a dashed outline: this cell is missing data
 */

/**
 * classId → how it is drawn.
 *
 * The severities mirror `CLASS_SEVERITY` in src/domain/wind/terrain-forcing.js —
 * the domain module a map layer may not import (ADR 0004). The mirror is
 * asserted in tests/advisory-layer.test.mjs so the two cannot drift apart, which
 * is the same guarantee ADVISORY_CLASS_CODE gives the brief.
 */
export const ADVISORY_CLASS_STYLE = Object.freeze(/** @type {Record<ForcingClassId, AdvisoryCellStyle>} */ ({
  lee: Object.freeze({
    severity: 'warning', cssVar: '--status-serious', rgb: [255, 135, 95],
    fill: true, fillOpacity: 0.34, dashed: false,
  }),
  /* One colour for both, because they are one finding: ridge and gap share
   * W-WIND-ACCEL, and two shades of the same warning would invite the pilot to
   * read a difference the model never claimed. */
  ridge: Object.freeze({
    severity: 'caution', cssVar: '--status-warning', rgb: [241, 189, 69],
    fill: true, fillOpacity: 0.30, dashed: false,
  }),
  gap: Object.freeze({
    severity: 'caution', cssVar: '--status-warning', rgb: [241, 189, 69],
    fill: true, fillOpacity: 0.30, dashed: false,
  }),
  uplift: Object.freeze({
    severity: 'advisory', cssVar: '--accent', rgb: [73, 166, 255],
    fill: true, fillOpacity: 0.26, dashed: false,
  }),
  /* Grey rather than a hazard colour, dashed rather than solid. The adapter has
   * no hatch primitive and this layer will not grow one into the contract for a
   * single drawing (ADR 0004): a dash is the smallest mark that says "this is
   * not a measurement" in both engines. */
  unknown: Object.freeze({
    severity: 'unknown', cssVar: '--muted', rgb: [137, 148, 156],
    fill: true, fillOpacity: 0.30, dashed: true,
  }),
  /* Never shaded — see the header. The token is recorded because the legend
   * still names the class, and it should name it in the rail's colour. */
  low: Object.freeze({
    severity: 'low-forcing', cssVar: '--status-good', rgb: [53, 208, 127],
    fill: false, fillOpacity: 0, dashed: false,
  }),
}));

/**
 * The boundary of the area that was analysed. Thin, unfilled and in the marker
 * colour rather than any severity colour: it is not a finding, it is the edge of
 * where the finding applies — and without it a field of quiet ground is
 * indistinguishable from an advisory that never ran.
 * @type {ShapeStyle}
 */
const EXTENT = {
  color: 'var(--marker-border)', weight: 1, opacity: 0.4, fill: false,
  className: 'advisory-extent',
};

/** @typedef {{ index: number, classId: ForcingClassId, lat: number, lng: number,
 *              elevM: number|null, corners: LatLng[] }} AdvisoryFill */
/** @typedef {{ fills: AdvisoryFill[], outline: LatLng[] }} AdvisoryZones */

/** @typedef {MapLayer} AdvisoryLayer */

/* ---------- the pure half: what gets drawn, and where ---------- */

/**
 * Everything the two engines draw for one advisory, or null when there is
 * nothing to draw.
 *
 * Null is the whole of the "render only when ready" rule, in one place both
 * engines call: a status short of 'ready', an absent grid or field, or a grid
 * whose cell count disagrees with its own rows × cols — which would mean the
 * row-major indexing below is addressing cells that are not the ones the classes
 * belong to. A grid that cannot describe itself is not drawable.
 *
 * @param {AdvisoryField|null|undefined} advisories
 * @returns {AdvisoryZones|null}
 */
export function advisoryZones(advisories) {
  const grid = advisories?.grid;
  const forcing = advisories?.forcing;
  if (advisories?.status !== 'ready' || !grid || !forcing) return null;

  const expected = grid.rows * grid.cols;
  if (expected < 1 || grid.cells.length !== expected || forcing.cells.length !== expected) {
    return null;
  }

  /** @type {AdvisoryFill[]} */
  const fills = [];
  for (let i = 0; i < expected; i++) {
    const classId = forcing.cells[i].classId;
    if (!ADVISORY_CLASS_STYLE[classId]?.fill) continue;
    const cell = grid.cells[i];
    fills.push({
      index: i,
      classId,
      lat: cell.lat,
      lng: cell.lng,
      elevM: cell.elevM,
      corners: cellCorners(cell, grid.cellSizeM),
    });
  }
  return { fills, outline: gridOutline(grid) };
}

/**
 * The four corners of one cell, from the centre the sampler placed.
 *
 * Open rather than closed — every engine here closes a polygon itself — and in
 * NW, NE, SE, SW order, which is the winding a filled quad wants in both.
 *
 * @param {LatLng} centre
 * @param {number} cellSizeM
 * @returns {LatLng[]}
 */
export function cellCorners(centre, cellSizeM) {
  const half = Math.abs(cellSizeM) / 2;
  return [
    offset(centre, half, -half),
    offset(centre, half, half),
    offset(centre, -half, half),
    offset(centre, -half, -half),
  ];
}

/**
 * The outer edge of the sampled grid: the NW corner of the first cell, the NE of
 * the last in its row, and so on round. Derived from the corner cells rather
 * than from a bounding box, so the outline is exactly the union of what was
 * classified — grid.cells are centres, and a box around centres would be half a
 * cell short on every side.
 *
 * @param {AdvisoryGrid} grid
 * @returns {LatLng[]}
 */
export function gridOutline(grid) {
  const { rows, cols, cellSizeM, cells } = grid;
  return [
    cellCorners(cells[0], cellSizeM)[0],
    cellCorners(cells[cols - 1], cellSizeM)[1],
    cellCorners(cells[rows * cols - 1], cellSizeM)[2],
    cellCorners(cells[(rows - 1) * cols], cellSizeM)[3],
  ];
}

/**
 * `northM` metres north (negative is south) and `eastM` metres east of a point.
 *
 * Two destination() calls in that order rather than one vector move, because
 * that is how src/application/terrain/sample-grid.js placed the cell centres in
 * the first place — corners derived the same way land on the seam between
 * neighbours instead of a few centimetres off it.
 *
 * @param {LatLng} from
 * @param {number} northM
 * @param {number} eastM
 * @returns {LatLng}
 */
function offset(from, northM, eastM) {
  const [midLat, midLng] = destination(
    from.lat, from.lng, northM >= 0 ? 0 : 180, Math.abs(northM) / 1000);
  const [lat, lng] = destination(
    midLat, midLng, eastM >= 0 ? 90 : 270, Math.abs(eastM) / 1000);
  return { lat, lng };
}

/**
 * The style one filled cell is drawn with.
 * @param {ForcingClassId} classId
 * @returns {ShapeStyle}
 */
function cellStyle(classId) {
  const style = ADVISORY_CLASS_STYLE[classId];
  const color = `var(${style.cssVar})`;
  return {
    color,
    weight: style.dashed ? 1.2 : 1,
    opacity: style.dashed ? 0.95 : 0.5,
    ...(style.dashed ? { dashArray: '3 4' } : null),
    fill: true,
    fillColor: color,
    fillOpacity: style.fillOpacity,
    className: `advisory-cell advisory-cell-${classId}`,
  };
}

/* ---------- the layer ---------- */

/**
 * The zones layer. Visibility rides on the frame beside `routeMode`, because it
 * is the same kind of thing — a view preference both engines have to agree
 * about, so a toggle cannot leave 3D showing what 2D just hid.
 *
 * @returns {AdvisoryLayer}
 */
export function createAdvisoryLayer() {
  /** @type {ShapeOverlay[]} */
  let drawn = [];
  /* What the overlays on screen were drawn from. A grid is up to 576 cells and a
   * render pass runs on every keystroke in the rail; the advisory block is
   * frozen and rebuilt per analysis pass, so identity is an exact answer to "is
   * this the same field" and costs one comparison instead of 576 polygons. */
  /** @type {unknown} */
  let painted = null;

  const clear = () => {
    for (const s of drawn) s.remove();
    drawn = [];
    painted = null;
  };

  return {
    id: 'advisory',

    render(frame, adapter) {
      const advisories = frame.snapshot.advisories;
      const visible = frame.advisoryVisible !== false;
      const zones = visible ? advisoryZones(advisories) : null;
      // Hidden clears and forgets, so returning here is always a redraw of a
      // field that is genuinely new rather than a toggle that turned off.
      if (!zones) { clear(); return; }
      if (painted === advisories.forcing) return;

      clear();
      for (const fill of zones.fills) {
        drawn.push(adapter.polygon(fill.corners, cellStyle(fill.classId)));
      }
      // Last, so the edge of the analysed area stays legible over the cells it
      // encloses rather than under them.
      drawn.push(adapter.polygon(zones.outline, EXTENT));
      painted = advisories.forcing;
    },

    dispose() {
      clear();
    },
  };
}
