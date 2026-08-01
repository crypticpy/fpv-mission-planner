// ortho-contours.js — contour lines for the orthographic terrain, with no
// engine in it.
//
// The interaction contract's terrain row names contours beside exaggeration
// (ASSET-MANIFEST, "Orthographic 3D interaction contract"), and they earn the
// place: a shaded mesh says where the ridges are, contours say how much ridge —
// the difference between a slope a dive recovers over and one it does not.
//
// Marching squares over the same lattice the mesh is built from, in the same
// frame: a contour vertex uses `buildTerrainMesh`'s own placement
// (`x = col·cell − halfX`, `y = halfY − row·cell`, Z unexaggerated) so the same
// model matrix that slides and stretches the mesh carries the lines with it.
// Lines drawn in any other frame would slide off their own hillside the moment
// the exaggeration slider moved.
//
// The output is a segment soup rather than stitched polylines, because the
// consumer is an instanced line layer that wants exactly that — stitching would
// be work spent producing a shape the renderer immediately takes apart.

/**
 * The slice of ortho-terrain.js's `OrthoTerrainGrid` this module reads.
 *
 * Declared structurally rather than type-imported, because even a JSDoc import
 * of ortho-terrain.js would pull deck.gl's typings into the ratchet's program
 * (tsconfig.json documents the measured blast radius) — and these four fields
 * are the whole contract anyway. Any richer grid satisfies it by shape.
 *
 * @typedef {object} ContourGrid
 * @property {number} rows
 * @property {number} cols
 * @property {number} cellSizeM  metres between samples, uniform both ways
 * @property {Float32Array} elevM  row-major, NaN where no tile decoded
 */

/**
 * A run of contour line segments at known levels.
 *
 * `positions` holds segments as consecutive [x0,y0,z0, x1,y1,z1] pairs in the
 * mesh's own frame, Z at the contour's level in true metres — exaggeration
 * belongs to the model matrix, here as everywhere.
 *
 * @typedef {object} OrthoContours
 * @property {Float32Array} positions
 * @property {number} count        segments, = positions.length / 6
 * @property {number[]} levels
 */

/**
 * The contour interval a relief deserves.
 *
 * Chosen from the span of the loaded grid rather than fixed, because the same
 * spacing that reads as texture over a 2,000 m massif is forty unreadable rings
 * over a river bluff. Null on ground too flat to contour — a line every metre
 * of a floodplain is noise wearing the costume of information.
 *
 * @param {number} minM @param {number} maxM
 * @returns {number|null}
 */
export function contourIntervalM(minM, maxM) {
  const relief = maxM - minM;
  if (!Number.isFinite(relief) || relief < 10) return null;
  if (relief > 1200) return 100;
  if (relief > 400) return 50;
  return 25;
}

/**
 * Every contour level strictly inside the grid's span.
 *
 * Strictly: a level equal to the exact minimum or maximum would be a line
 * through a single vertex, which marching squares degenerates on and a reader
 * learns nothing from.
 *
 * @param {number} minM @param {number} maxM @param {number} intervalM
 * @returns {number[]}
 */
export function contourLevels(minM, maxM, intervalM) {
  const levels = [];
  for (let z = Math.ceil(minM / intervalM) * intervalM; z < maxM; z += intervalM) {
    if (z > minM) levels.push(z);
  }
  return levels;
}

/**
 * March one cell at one level, appending 0, 1 or 2 segments.
 *
 * The classic 16 cases by corner sign, with the crossing points placed by
 * linear interpolation along the cell edges — the same linearity `groundAt`'s
 * bilinear patch has along those edges, so a contour point queried back through
 * the height field reads its own level. The two saddle cases are disambiguated
 * by the cell's centre average, which keeps adjacent cells' choices consistent
 * because they share the edges, not the centres.
 *
 * @param {number[]} out  flat [x,y] pairs are appended per segment endpoint
 * @param {number} level
 * @param {number} x0 @param {number} y0  north-west corner, mesh frame
 * @param {number} cell
 * @param {number} nw @param {number} ne @param {number} sw @param {number} se
 */
function marchCell(out, level, x0, y0, cell, nw, ne, sw, se) {
  /* Corner bits in marching-squares order. Note the mesh frame: y0 is the
   * northern edge and the southern edge is y0 - cell, because +Y is north. */
  const code = (nw >= level ? 8 : 0) | (ne >= level ? 4 : 0)
    | (se >= level ? 2 : 0) | (sw >= level ? 1 : 0);
  if (code === 0 || code === 15) return;

  const t = (/** @type {number} */ a, /** @type {number} */ b) => (level - a) / (b - a);
  // The four edge crossings, computed lazily by case below.
  const top = () => [x0 + cell * t(nw, ne), y0];
  const bottom = () => [x0 + cell * t(sw, se), y0 - cell];
  const left = () => [x0, y0 - cell * t(nw, sw)];
  const right = () => [x0 + cell, y0 - cell * t(ne, se)];

  const push = (/** @type {number[]} */ a, /** @type {number[]} */ b) => {
    out.push(a[0], a[1], b[0], b[1]);
  };

  switch (code) {
    case 1: case 14: push(left(), bottom()); break;
    case 2: case 13: push(bottom(), right()); break;
    case 3: case 12: push(left(), right()); break;
    case 4: case 11: push(top(), right()); break;
    case 6: case 9: push(top(), bottom()); break;
    case 7: case 8: push(left(), top()); break;
    case 5: case 10: {
      // The saddle: opposite corners high. The centre decides which pairs join.
      const centreHigh = (nw + ne + sw + se) / 4 >= level;
      if ((code === 5) === centreHigh) {
        push(left(), top());
        push(bottom(), right());
      } else {
        push(left(), bottom());
        push(top(), right());
      }
      break;
    }
    default: break;
  }
}

/**
 * The contour lines of a terrain grid, in the mesh's own frame.
 *
 * Cells with any absent corner are skipped outright — the mesh drops those
 * triangles too (holes stay holes, ADR 0008), and a contour drawn across ground
 * the surface refuses to draw would claim knowledge nothing has.
 *
 * @param {ContourGrid} grid
 * @param {number[]} levels
 * @returns {OrthoContours}
 */
export function buildContours(grid, levels) {
  const { rows, cols, cellSizeM, elevM } = grid;
  const halfX = ((cols - 1) * cellSizeM) / 2;
  const halfY = ((rows - 1) * cellSizeM) / 2;

  /** @type {number[]} */
  const flat = [];
  /** @type {number[]} */
  const segLevels = [];

  for (const level of levels) {
    const before = flat.length;
    for (let row = 0; row < rows - 1; row++) {
      const y0 = halfY - row * cellSizeM;
      for (let col = 0; col < cols - 1; col++) {
        const i = row * cols + col;
        const nw = elevM[i];
        const ne = elevM[i + 1];
        const sw = elevM[i + cols];
        const se = elevM[i + cols + 1];
        if (!Number.isFinite(nw) || !Number.isFinite(ne)
          || !Number.isFinite(sw) || !Number.isFinite(se)) continue;
        marchCell(flat, level, col * cellSizeM - halfX, y0, cellSizeM, nw, ne, sw, se);
      }
    }
    for (let n = (flat.length - before) / 4; n > 0; n--) segLevels.push(level);
  }

  const count = flat.length / 4;
  const positions = new Float32Array(count * 6);
  for (let s = 0; s < count; s++) {
    positions[s * 6] = flat[s * 4];
    positions[s * 6 + 1] = flat[s * 4 + 1];
    positions[s * 6 + 2] = segLevels[s];
    positions[s * 6 + 3] = flat[s * 4 + 2];
    positions[s * 6 + 4] = flat[s * 4 + 3];
    positions[s * 6 + 5] = segLevels[s];
  }

  return { positions, count, levels };
}
