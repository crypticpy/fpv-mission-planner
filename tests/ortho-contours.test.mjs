import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildContours,
  contourIntervalM,
  contourLevels,
} from '../src/presentation/map/scene3d/ortho-contours.js';

/* Contours are drawn in the mesh's own frame, so the assertions below are
 * against buildTerrainMesh's placement: x = col·cell − halfX, y = halfY −
 * row·cell, +Y north, Z at true metres. A contour that disagrees with the mesh
 * about any of those three draws a line hovering beside its own hillside. */

/** A grid shaped like OrthoTerrainGrid, as far as buildContours reads one. */
function grid(rows, cols, cellSizeM, elev) {
  const elevM = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) elevM[r * cols + c] = elev(r, c);
  }
  return { rows, cols, cellSizeM, elevM };
}

/** The segments of a result, as [[x0,y0,z0],[x1,y1,z1]] pairs. */
function segments({ positions, count }) {
  const out = [];
  for (let s = 0; s < count; s++) {
    out.push([
      [positions[s * 6], positions[s * 6 + 1], positions[s * 6 + 2]],
      [positions[s * 6 + 3], positions[s * 6 + 4], positions[s * 6 + 5]],
    ]);
  }
  return out;
}

/* ---------- the interval and the levels ---------- */

test('the interval scales with the relief, and flat ground gets none', () => {
  assert.equal(contourIntervalM(1500, 1505), null);
  assert.equal(contourIntervalM(1500, 1700), 25);
  assert.equal(contourIntervalM(1000, 1800), 50);
  assert.equal(contourIntervalM(500, 2400), 100);
  assert.equal(contourIntervalM(Number.NaN, 1000), null);
});

test('levels sit strictly inside the span, on interval multiples', () => {
  assert.deepEqual(contourLevels(1520, 1610, 25), [1525, 1550, 1575, 1600]);
  // A level equal to the exact min or max is a line through a vertex: excluded.
  assert.deepEqual(contourLevels(1500, 1600, 50), [1550]);
  assert.deepEqual(contourLevels(100, 110, 25), []);
});

/* ---------- marching the cells ---------- */

test('an east-rising plane contours as a straight north-south line', () => {
  // Elevation is 10 m per column: the 5 m contour is the vertical x = −5 line
  // (column 0.5 of a 3-wide grid whose centre column is x = 0).
  const g = grid(3, 3, 10, (r, c) => c * 10);
  const { count, positions } = buildContours(g, [5]);

  assert.equal(count, 2); // one segment per cell row
  for (let s = 0; s < count; s++) {
    assert.ok(Math.abs(positions[s * 6] - -5) < 1e-6);
    assert.ok(Math.abs(positions[s * 6 + 3] - -5) < 1e-6);
    assert.equal(positions[s * 6 + 2], 5);
    assert.equal(positions[s * 6 + 5], 5);
  }
});

test('high ground to the north draws at positive Y — the mesh flip carried over', () => {
  // Row 0 is the northernmost sample and the highest: the contour must sit in
  // the +Y half of the frame, or the lines mirror the terrain they label.
  const g = grid(3, 3, 10, (r) => (2 - r) * 10);
  const segs = segments(buildContours(g, [15]));
  assert.equal(segs.length, 2);
  for (const [a, b] of segs) {
    assert.ok(Math.abs(a[1] - 5) < 1e-6 && Math.abs(b[1] - 5) < 1e-6,
      `expected the 15 m line at y=+5, got ${a[1]}, ${b[1]}`);
  }
});

test('a peak contours as a closed ring of four segments', () => {
  const g = grid(3, 3, 10, (r, c) => (r === 1 && c === 1 ? 100 : 0));
  const segs = segments(buildContours(g, [50]));
  assert.equal(segs.length, 4);
  // Every endpoint is halfway along an edge touching the centre vertex, 5 m out.
  for (const [a, b] of segs) {
    for (const p of [a, b]) {
      assert.ok(Math.abs(p[0]) < 5 + 1e-6 && Math.abs(p[1]) < 5 + 1e-6);
      assert.equal(p[2], 50);
    }
  }
  // And the ring closes: each endpoint appears exactly twice across the soup.
  const seen = new Map();
  for (const [a, b] of segs) {
    for (const p of [a, b]) {
      const key = `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of seen) assert.equal(n, 2, `open ring at ${key}`);
});

test('a cell touching a hole is skipped, as the mesh skips it', () => {
  const g = grid(3, 3, 10, (r, c) => (r === 1 && c === 1 ? 100 : 0));
  g.elevM[0] = Number.NaN; // the north-west corner sample
  const { count } = buildContours(g, [50]);
  assert.equal(count, 3); // the ring loses exactly the one cell with the hole
});

test('a saddle splits into two segments, decided by its centre', () => {
  // Opposite corners high with a high centre: the high diagonal connects, so
  // the lines isolate the two low corners rather than the two high ones.
  const g = grid(2, 2, 10, (r, c) => (r === c ? 100 : 0));
  const segs = segments(buildContours(g, [50]));
  assert.equal(segs.length, 2);
  // Each segment stays inside one corner's quadrant: no segment crosses x = 0.
  for (const [a, b] of segs) {
    assert.ok((a[0] <= 0 && b[0] <= 0) || (a[0] >= 0 && b[0] >= 0),
      `saddle joined the wrong pairs: ${a} → ${b}`);
  }
});

test('levels come back in the soup, one Z per level', () => {
  const g = grid(3, 3, 10, (r, c) => c * 10);
  const result = buildContours(g, [5, 15]);
  assert.deepEqual(result.levels, [5, 15]);
  const zs = new Set(segments(result).flatMap(([a, b]) => [a[2], b[2]]));
  assert.deepEqual([...zs].sort((x, y) => x - y), [5, 15]);
});
