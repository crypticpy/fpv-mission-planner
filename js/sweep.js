// sweep.js — the map footprint's heading sweep: where to put the rays, and how
// to read a radius back out from between them. Pure geometry over a sampler
// function, so it knows nothing about Leaflet, physics, or the DOM — map.js
// hands it `alpha => radiusKm` and gets sample angles back.
//
// Why adaptive (Phase 4 item 10): the footprint is the out-and-back turnaround
// envelope, and it has a cliff in it. As the course swings from downwind to
// upwind, the return leg's headwind grows until no cruise speed makes headway
// against it, and the radius drops to zero over a fraction of a degree. Sampling
// every 5° and interpolating linearly draws a gentle ramp across that cliff and
// hands the pilot reach that does not exist. Refining only where adjacent rays
// disagree costs nothing in calm air (a circle has no cliff) and buys the edge
// where it matters.

/** Base half-sweep spacing, in degrees off the wind axis. 0…180 inclusive. */
export const SWEEP_STEP_DEG = 5;

/**
 * Refinement gate: bisect an interval whose endpoints disagree by more than this
 * share of the larger of the two. 0.2 is well above the curvature of a smooth
 * footprint at 5° spacing and well below a collapse.
 */
export const REFINE_REL = 0.2;

/** Bisections per interval. 3 → 5°/8 = 0.625°, half the polygon's 1° grid. */
export const REFINE_MAX_DEPTH = 3;

/** Hard budget of extra rays per sweep. The sweep runs on every update pass. */
export const REFINE_MAX_RAYS = 20;

/**
 * Ignore disagreement between two radii this small however relative it looks:
 * 50 m is under one map pixel at any zoom the footprint is legible at, and a
 * pinched fan would otherwise spend the whole budget on rounding noise.
 */
export const REFINE_MIN_KM = 0.05;

/** Offset of an absolute course from the wind axis, folded into 0…180. */
export function alphaOffAxis(courseDeg, windFromDeg) {
  const off = (((courseDeg - windFromDeg) % 360) + 360) % 360;
  return off > 180 ? 360 - off : off;
}

const norm360 = (d) => ((d % 360) + 360) % 360;

// How sharply two adjacent rays disagree, relative to the longer of them.
function badness(r0, r1) {
  const scale = Math.max(r0, r1);
  if (!(scale > REFINE_MIN_KM)) return 0;
  return Math.abs(r1 - r0) / scale;
}

function insertSorted(angles, radii, a, r) {
  let lo = 0, hi = angles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (angles[mid] < a) lo = mid + 1; else hi = mid;
  }
  angles.splice(lo, 0, a);
  radii.splice(lo, 0, r);
}

/**
 * Sample the half-sweep 0…180° off the wind axis, refining across sharp
 * transitions. `sample(alphaDeg)` returns a radius in km.
 *
 * The base grid goes down first, then every interval that fails the smoothness
 * gate is queued and the budget is spent sharpest-first — so a footprint with
 * one collapse sector puts every extra ray inside it instead of dribbling them
 * around the circle. Returns `{ angles, radii, extraRays }` with `angles`
 * ascending; the other half of the circle is this one mirrored, because the wind
 * decomposition depends only on cos and |sin| of the offset.
 */
export function adaptiveHalfSweep(sample, {
  stepDeg = SWEEP_STEP_DEG,
  relThreshold = REFINE_REL,
  maxDepth = REFINE_MAX_DEPTH,
  maxRays = REFINE_MAX_RAYS,
} = {}) {
  const angles = [];
  const radii = [];
  for (let a = 0; a <= 180 + 1e-9; a += stepDeg) {
    angles.push(Math.min(a, 180));
    radii.push(sample(Math.min(a, 180)));
  }

  const pending = [];
  const consider = (lo, rLo, hi, rHi, depth) => {
    if (depth >= maxDepth) return;
    const b = badness(rLo, rHi);
    if (b > relThreshold) pending.push({ lo, rLo, hi, rHi, depth, b });
  };
  for (let i = 0; i < angles.length - 1; i++) {
    consider(angles[i], radii[i], angles[i + 1], radii[i + 1], 0);
  }

  let extraRays = 0;
  while (extraRays < maxRays && pending.length) {
    // Sharpest disagreement first. The queue is tens of entries at most, so a
    // linear pick is cheaper than maintaining a heap.
    let k = 0;
    for (let i = 1; i < pending.length; i++) if (pending[i].b > pending[k].b) k = i;
    const it = pending.splice(k, 1)[0];
    const mid = (it.lo + it.hi) / 2;
    const rMid = sample(mid);
    extraRays++;
    insertSorted(angles, radii, mid, rMid);
    consider(it.lo, it.rLo, mid, rMid, it.depth + 1);
    consider(mid, rMid, it.hi, it.rHi, it.depth + 1);
  }

  return { angles, radii, extraRays };
}

/**
 * Radius at an arbitrary offset from the wind axis, linearly interpolated
 * between the two rays bracketing it. Exact at every sampled angle.
 */
export function radiusAtAlpha({ angles, radii }, alphaDeg) {
  const a = Math.min(180, Math.max(0, alphaDeg));
  let lo = 0, hi = angles.length - 1;
  if (a <= angles[lo]) return radii[lo];
  if (a >= angles[hi]) return radii[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (angles[mid] <= a) lo = mid; else hi = mid;
  }
  const span = angles[hi] - angles[lo];
  const t = span > 0 ? (a - angles[lo]) / span : 0;
  return radii[lo] * (1 - t) + radii[hi] * t;
}

/**
 * Expand a half-sweep to the whole circle, twice over:
 *
 *   `byCourse[0…359]` — per-degree radii, what the tiles, the range-vs-heading
 *     chart and anything asking "how far on course 210°" read.
 *   `courses` / `radii` — the polygon's own vertex list: the same degree grid
 *     plus every refined ray, mirrored to both sides of the wind axis. Without
 *     this the sub-degree refinement would be resampled straight back onto the
 *     1° grid and the cliff would stay 1° wide.
 */
export function fullCircle(samples, windFromDeg) {
  const byCourse = new Array(360);
  for (let c = 0; c < 360; c++) byCourse[c] = radiusAtAlpha(samples, alphaOffAxis(c, windFromDeg));

  const set = new Set();
  for (let c = 0; c < 360; c++) set.add(c);
  for (const a of samples.angles) {
    // Base rays land on the degree grid already; only the refined ones are new.
    if (Number.isInteger(a) && Number.isInteger(windFromDeg)) continue;
    set.add(norm360(windFromDeg + a));
    set.add(norm360(windFromDeg - a));
  }
  const courses = [...set].sort((x, y) => x - y);
  return { byCourse, courses, radii: courses.map(c => radiusAtAlpha(samples, alphaOffAxis(c, windFromDeg))) };
}

/**
 * Area of the polygon drawn through `(courses, radii)`, in km². Polar shoelace,
 * ½ Σ rᵢ·rᵢ₊₁·sin Δθᵢ — exact for the sampled polygon at any spacing, and
 * zero-radius wedges contribute nothing (the right answer for a pinched fan).
 */
export function polarAreaKm2(courses, radii) {
  let s = 0;
  const n = courses.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const d = (((courses[j] - courses[i]) % 360) + 360) % 360;
    s += radii[i] * radii[j] * Math.sin(d * Math.PI / 180);
  }
  return 0.5 * s;
}
