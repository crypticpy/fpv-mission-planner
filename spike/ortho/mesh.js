// Option B, second half: turn the grid into something deck.gl will draw.
//
// Two shapes, because the choice between them is a dependency decision:
//
//   buildMesh()     -> an indexed triangle mesh for SimpleMeshLayer
//                      (@deck.gl/mesh-layers — a NEW dependency for this repo).
//                      One draw call, per-vertex normals, per-vertex colours.
//
//   buildQuads()    -> the same surface as SolidPolygonLayer binary input
//                      (@deck.gl/layers — already a dependency). No new package,
//                      but every quad is a polygon that has to be tesselated and
//                      the layer has no notion of a normal, so the surface can
//                      only be flat-shaded from its own colours.
//
// Both are built from the same Float32Array, so a frame-time comparison between
// them is a comparison of the two renderers and not of two different mountains.

import { HALF_SPAN_M, terrainColor } from './scene.mjs';

/**
 * @typedef {import('./dem.js').Grid} Grid
 */

/**
 * An indexed triangle mesh in local metres, Z = metres MSL * exaggeration.
 *
 * Normals are computed from the height field analytically rather than by
 * accumulating face normals: the grid is regular, so the surface gradient is two
 * central differences and one normalise per vertex, which is both exact and an
 * order of magnitude less work than the general case. Lighting is the only thing
 * that makes a single-colour mesh read as terrain at all, so this is not
 * optional polish.
 *
 * @param {Grid} grid
 * @param {{ exaggeration?: number }} [opts]
 */
export function buildMesh(grid, { exaggeration = 1 } = {}) {
  const t0 = performance.now();
  const { n, heights, spacingM } = grid;
  const count = n * n;

  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);

  const dz = spacingM / exaggeration; // gradient denominator in exaggerated Z

  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const i = iy * n + ix;
      const h = heights[i];
      positions[i * 3] = -HALF_SPAN_M + ix * spacingM;
      positions[i * 3 + 1] = -HALF_SPAN_M + iy * spacingM;
      positions[i * 3 + 2] = h * exaggeration;

      // Central differences, clamped at the edges.
      const xl = heights[iy * n + Math.max(0, ix - 1)];
      const xr = heights[iy * n + Math.min(n - 1, ix + 1)];
      const yd = heights[Math.max(0, iy - 1) * n + ix];
      const yu = heights[Math.min(n - 1, iy + 1) * n + ix];
      const spanX = (ix === 0 || ix === n - 1 ? 1 : 2) * dz;
      const spanY = (iy === 0 || iy === n - 1 ? 1 : 2) * dz;
      const gx = -(xr - xl) / spanX;
      const gy = -(yu - yd) / spanY;
      const len = Math.hypot(gx, gy, 1);
      normals[i * 3] = gx / len;
      normals[i * 3 + 1] = gy / len;
      normals[i * 3 + 2] = 1 / len;

      const [r, g, b] = terrainColor(h);
      colors[i * 4] = r;
      colors[i * 4 + 1] = g;
      colors[i * 4 + 2] = b;
      colors[i * 4 + 3] = 255;
    }
  }

  // Uint32 unconditionally: a 512-sample grid is 262,144 vertices, well past
  // what Uint16 addresses, and WebGL2 has no trouble with 32-bit indices. A
  // silent overflow here would draw a plausible-looking wrong mountain.
  const indices = new Uint32Array((n - 1) * (n - 1) * 6);
  let at = 0;
  for (let iy = 0; iy < n - 1; iy++) {
    for (let ix = 0; ix < n - 1; ix++) {
      const a = iy * n + ix;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // Counter-clockwise seen from +Z, so front faces point at the sky.
      indices[at++] = a; indices[at++] = b; indices[at++] = d;
      indices[at++] = a; indices[at++] = d; indices[at++] = c;
    }
  }

  return {
    mesh: {
      attributes: {
        POSITION: { value: positions, size: 3 },
        NORMAL: { value: normals, size: 3 },
        COLOR_0: { value: colors, size: 4, normalized: true },
      },
      indices: { value: indices, size: 1 },
    },
    vertexCount: count,
    triangleCount: indices.length / 3,
    buildMs: performance.now() - t0,
  };
}

/**
 * The same surface as SolidPolygonLayer binary input — the zero-new-dependency
 * route.
 *
 * `_normalize: false` is what makes this survivable: without it the layer
 * normalises every polygon on the CPU, which for (n-1)^2 quads is the dominant
 * cost by a wide margin. With it, deck reads the flat position buffer and the
 * per-polygon start indices directly.
 *
 * @param {Grid} grid
 * @param {{ exaggeration?: number }} [opts]
 */
export function buildQuads(grid, { exaggeration = 1 } = {}) {
  const t0 = performance.now();
  const { n, heights, spacingM } = grid;
  const quads = (n - 1) * (n - 1);

  const positions = new Float64Array(quads * 4 * 3);
  const startIndices = new Uint32Array(quads + 1);
  const fillColors = new Uint8Array(quads * 4 * 4);

  const xy = (i) => -HALF_SPAN_M + i * spacingM;

  let vAt = 0;
  for (let iy = 0; iy < n - 1; iy++) {
    for (let ix = 0; ix < n - 1; ix++) {
      const q = iy * (n - 1) + ix;
      startIndices[q] = q * 4;
      const corners = [
        [ix, iy], [ix + 1, iy], [ix + 1, iy + 1], [ix, iy + 1],
      ];
      // One colour per quad, taken from its south-west corner: SolidPolygonLayer
      // has no normals, so the only thing that can make the surface legible is
      // the colour ramp itself.
      const [r, g, b] = terrainColorOf(heights[iy * n + ix]);
      for (const [cx, cy] of corners) {
        positions[vAt * 3] = xy(cx);
        positions[vAt * 3 + 1] = xy(cy);
        positions[vAt * 3 + 2] = heights[cy * n + cx] * exaggeration;
        fillColors[vAt * 4] = r;
        fillColors[vAt * 4 + 1] = g;
        fillColors[vAt * 4 + 2] = b;
        fillColors[vAt * 4 + 3] = 255;
        vAt++;
      }
    }
  }
  startIndices[quads] = quads * 4;

  return {
    data: {
      length: quads,
      startIndices,
      attributes: {
        getPolygon: { value: positions, size: 3 },
        getFillColor: { value: fillColors, size: 4 },
      },
    },
    vertexCount: quads * 4,
    triangleCount: quads * 2,
    buildMs: performance.now() - t0,
  };
}

/** Memoised ramp lookup — buildQuads calls it (n-1)^2 times. */
const RAMP_CACHE = new Map();
function terrainColorOf(elevM) {
  const key = Math.round(elevM / 5) * 5;
  let c = RAMP_CACHE.get(key);
  if (!c) {
    c = terrainColor(key);
    RAMP_CACHE.set(key, c);
  }
  return c;
}
