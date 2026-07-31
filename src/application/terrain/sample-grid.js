// sample-grid.js — an area around the mission in, a sampled AdvisoryGrid out.
//
// M3's sample-corridor.js answers "what is the ground under the route" as a
// line. M5's terrain-forcing baseline needs more than that: w* = V·∇h wants
// the ground upwind and downwind of the route too, so the domain layer can see
// a gradient rather than a single along-track slope. This module is where a
// mission's points become that area — a rectangle of cells wide enough to hold
// the mission with room either side, sampled from the same ElevationProvider
// port sample-corridor.js already uses.
//
// Two functions, deliberately not one:
//
//   *gridRequestFor(points, opts)* is pure geometry. Bounding box, padding,
//     cell size, cell centres — arithmetic that never touches the network and
//     is exactly reproducible from the same points, which is what lets a test
//     assert an exact centre rather than "somewhere near".
//
//   *createGridSampler(deps)* is the impure half, in the same shape M3b's
//     `createTerrainSampler(deps)` already takes: the provider and the cache
//     arrive as dependencies, deps in and one `(request) => Promise<...>`
//     function out, no module state. Two missions cannot share a sampler by
//     accident, and a test gets a clean one per case.
//
// Sizing is a frozen rule, not a knob: cells never go finer than 120 m,
// because Copernicus GLO-90 (the DEM behind the app's only elevation provider
// today) is a 90 m product and a finer cell would read as more precise than
// the ground actually is. And a grid never grows past 24×24 (576 cells) — a
// batch-of-100 provider call away from being an accidental denial-of-service
// against a free, keyless API on a route long enough to want a wide corridor.
//
// A batch limit of its own, not reused from open-meteo-elevation.js: ADR
// 0009's layering has application import domain and application only, never
// infrastructure, so the number below is restated rather than imported — the
// same choice open-meteo-elevation.js's own ElevationProvenance typedef makes
// for the same reason, in the other direction.
//
// The same three behaviours sample-corridor.js is built around hold here too:
// a cell nobody could answer stays null rather than becoming sea level or an
// interpolated guess; a provider that throws produces a stated absence, never
// an exception; and the attribution a field carries is read off the provider
// or its answer, never a second copy of the licence string kept in this file.

import { destination, distanceKm } from '../../domain/geo.js';
import { elevationKey } from './terrain-contracts.js';

/**
 * @typedef {import('./terrain-contracts.js').AdvisoryGrid} AdvisoryGrid
 * @typedef {import('./terrain-contracts.js').AdvisoryGridCellRequest} AdvisoryGridCellRequest
 * @typedef {import('./terrain-contracts.js').AdvisoryGridField} AdvisoryGridField
 * @typedef {import('./terrain-contracts.js').AdvisoryGridProvenance} AdvisoryGridProvenance
 * @typedef {import('./terrain-contracts.js').AdvisoryGridRequest} AdvisoryGridRequest
 * @typedef {import('./terrain-contracts.js').ElevationPoint} ElevationPoint
 * @typedef {import('./terrain-contracts.js').ElevationProvider} ElevationProvider
 * @typedef {import('./elevation-cache.js').ElevationCache} ElevationCache
 */

/* ---------- sizing rules ---------- */

/** Never oversample Copernicus GLO-90's own 90 m ground resolution. */
export const GRID_MIN_CELL_SIZE_M = 120;

/** 24×24 — the cap on either axis, so the grid can never exceed 576 cells. */
export const GRID_MAX_DIM = 24;

/** 24 × 24. Stated for readers of the contract; enforced structurally above. */
export const GRID_MAX_CELLS = GRID_MAX_DIM * GRID_MAX_DIM;

/** A mission smaller than 4 km across still gets a 2 km pad on every side. */
export const GRID_MIN_PADDING_M = 1000;

/**
 * The batch ceiling this module chunks provider calls to. Equal to
 * ELEVATION_BATCH_MAX in src/infrastructure/elevation/open-meteo-elevation.js
 * today (restated, not imported — see the file header). A grid can ask for up
 * to GRID_MAX_CELLS points in one request; nothing requires the provider
 * behind `deps.provider` to chunk that itself, so this module does.
 */
export const GRID_BATCH_MAX = 100;

/* ---------- gridRequestFor: pure geometry ---------- */

/**
 * @typedef {object} GridRequestOptions
 * @property {number} [paddingM]  overrides the default
 *   max(GRID_MIN_PADDING_M, 25% of the larger span) rule. Meant for a caller
 *   that already knows how far the wind can carry an effect past the route;
 *   the default is the honest "we don't know, so pad generously" answer.
 */

/**
 * The bounding box of `points`, padded and quantised into a grid whose cells
 * never go finer than GRID_MIN_CELL_SIZE_M and never number more than
 * GRID_MAX_CELLS. Pure: same points in, same rows/cols/cellSizeM/cells out,
 * every time — the property the exit gate's "identical sample identifiers"
 * spirit extends to here as "identical cell centres".
 *
 * `points` is launch-plus-waypoints, in the { lat, lng } shape every provider
 * adapter and geo.js call in this codebase already speaks (not the mission
 * document's own `latitude`/`longitude` field names — the caller that reads
 * the document is expected to have already made that translation, the same
 * one sample-corridor.js's planPoints() makes for a CorridorRequest).
 *
 * @param {readonly ElevationPoint[]} points
 * @param {GridRequestOptions} [opts]
 * @returns {AdvisoryGridRequest}
 */
export function gridRequestFor(points, opts = {}) {
  const pts = Array.isArray(points)
    ? points.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng))
    : [];
  if (pts.length === 0) {
    throw new TypeError('gridRequestFor: points must be a non-empty array of { lat, lng }');
  }

  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  // The average of the extremes, not of every point: a grid centred on the
  // bounding box holds every point with symmetric padding on both sides,
  // where a centroid would not.
  const center = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };

  // Spans measured along a single meridian/parallel through the centre, so
  // each is a distance in one direction rather than a diagonal that conflates
  // the two.
  const nsSpanM = distanceKm({ lat: minLat, lng: center.lng }, { lat: maxLat, lng: center.lng }) * 1000;
  const ewSpanM = distanceKm({ lat: center.lat, lng: minLng }, { lat: center.lat, lng: maxLng }) * 1000;

  const paddingM = Number.isFinite(opts.paddingM)
    ? Math.max(0, Number(opts.paddingM))
    : Math.max(GRID_MIN_PADDING_M, 0.25 * Math.max(nsSpanM, ewSpanM));

  const paddedNsSpanM = nsSpanM + 2 * paddingM;
  const paddedEwSpanM = ewSpanM + 2 * paddingM;

  // Square cells: the smallest size that still keeps both axes within
  // GRID_MAX_DIM, floored at GRID_MIN_CELL_SIZE_M so a small mission never
  // oversamples the DEM just because its own footprint is small.
  const cellSizeM = Math.max(
    GRID_MIN_CELL_SIZE_M,
    paddedNsSpanM / GRID_MAX_DIM,
    paddedEwSpanM / GRID_MAX_DIM,
  );
  const rows = clamp(Math.ceil(paddedNsSpanM / cellSizeM), 1, GRID_MAX_DIM);
  const cols = clamp(Math.ceil(paddedEwSpanM / cellSizeM), 1, GRID_MAX_DIM);

  /** @type {AdvisoryGridCellRequest[]} */
  const cells = [];
  for (let row = 0; row < rows; row++) {
    // Row 0 is northernmost: the offset from centre is largest and positive
    // (north) at row 0, falling to largest and negative (south) at the last row.
    const northOffsetM = ((rows - 1) / 2 - row) * cellSizeM;
    for (let col = 0; col < cols; col++) {
      // Col 0 is westernmost: negative (west) at col 0, rising to positive
      // (east) at the last column.
      const eastOffsetM = (col - (cols - 1) / 2) * cellSizeM;
      cells.push(offsetPoint(center, northOffsetM, eastOffsetM));
    }
  }

  return Object.freeze({ rows, cols, cellSizeM, cells: Object.freeze(cells) });
}

/**
 * `center` moved `northM` metres north (negative is south) and then `eastM`
 * metres east (negative is west). Two destination() calls rather than a
 * single vector move: geo.js only ever moves along one bearing at a time, and
 * over the tens of kilometres this grid can span that composition is exact
 * enough — the same sphere sample-corridor.js's lateral offsets already trust.
 *
 * @param {{ lat: number, lng: number }} center
 * @param {number} northM
 * @param {number} eastM
 * @returns {{ lat: number, lng: number }}
 */
function offsetPoint(center, northM, eastM) {
  const [midLat, midLng] = destination(center.lat, center.lng, northM >= 0 ? 0 : 180, Math.abs(northM) / 1000);
  const [lat, lng] = destination(midLat, midLng, eastM >= 0 ? 90 : 270, Math.abs(eastM) / 1000);
  return { lat, lng };
}

/** @param {number} n @param {number} lo @param {number} hi @returns {number} */
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/* ---------- createGridSampler: the impure half ---------- */

/**
 * What the sampler is given — the same two ports sample-corridor.js takes,
 * because this is the same ElevationProvider answering a different shape of
 * question.
 * @typedef {object} GridSamplerDeps
 * @property {ElevationProvider|null} [provider]
 * @property {ElevationCache|null} [cache]
 * @property {() => string} [now]  ISO instant; injected for deterministic tests
 * @property {AbortSignal} [signal]  cancels an in-flight provider call (ADR 0012 §3)
 */

/** @typedef {(request: AdvisoryGridRequest, signal?: AbortSignal) => Promise<AdvisoryGridField>} GridSampler */

/**
 * The seam a host wires into the pipeline: deps in, one function out. `signal`
 * (ADR 0012 §3, additive) mirrors sample-corridor.js's own — a superseded
 * grid sample aborts its request rather than merely discarding the answer.
 * @param {GridSamplerDeps} deps
 * @returns {GridSampler}
 */
export function createGridSampler(deps = {}) {
  return (request, signal) => sampleGrid(request, { ...deps, signal });
}

/**
 * Answer one grid request. Never throws for anything the network or a
 * provider can do to it — a rejected batch, a malformed answer, no provider
 * at all — because the rest of an advisory that cannot see some of the ground
 * is still worth showing. The one exception is a caller handing over
 * something that is not an AdvisoryGridRequest, which is a programming error.
 *
 * @param {AdvisoryGridRequest} request
 * @param {GridSamplerDeps} [deps]
 * @returns {Promise<AdvisoryGridField>}
 */
export async function sampleGrid(request, deps = {}) {
  if (!request || !Array.isArray(request.cells) || !Number.isFinite(request.rows)
    || !Number.isFinite(request.cols) || !Number.isFinite(request.cellSizeM)) {
    throw new TypeError('sampleGrid: request must be an AdvisoryGridRequest with rows, cols, '
      + 'cellSizeM and cells');
  }
  const provider = deps.provider ?? null;
  const cache = deps.cache ?? null;
  const now = deps.now ?? (() => new Date().toISOString());

  const points = request.cells;
  /** @type {(number|null)[]} */
  const elevations = new Array(points.length).fill(null);
  /** @type {string[]} */
  const notes = [];

  // One entry per distinct place: a small mission's padded box can still put
  // two cells within a metre of one another after quantisation, and asking
  // twice would spend a batch slot on an answer already in hand.
  /** @type {Map<string, number[]>} */
  const byKey = new Map();
  points.forEach((point, i) => {
    const key = elevationKey(point);
    const seen = byKey.get(key);
    if (seen) seen.push(i);
    else byKey.set(key, [i]);
  });

  /** @type {{ point: { lat: number, lng: number }, at: number[] }[]} */
  const wanted = [];
  let cacheHits = 0;
  for (const [, at] of byKey) {
    const point = { lat: points[at[0]].lat, lng: points[at[0]].lng };
    const hit = cache ? cache.get(point) : null;
    if (typeof hit === 'number' && Number.isFinite(hit)) {
      cacheHits++;
      for (const i of at) elevations[i] = hit;
    } else {
      wanted.push({ point, at });
    }
  }

  let fetched = 0;
  /** @type {string|null} */
  let source = null;
  /** @type {string|null} */
  let dataset = null;
  /** @type {number|null} */
  let resolutionM = null;
  /** @type {string|null} */
  let attribution = null;
  /** @type {string|null} */
  let retrievedAt = null;

  if (wanted.length > 0 && !provider) {
    notes.push('No elevation provider is wired up, so no ground was sampled for this grid.');
  } else if (wanted.length > 0 && provider) {
    // Chunked, sequentially — same reasoning open-meteo-elevation.js's own
    // batching gives: a keyless, free endpoint stays usable when nothing hits
    // it with every point in one shot or a burst of parallel calls.
    for (let start = 0; start < wanted.length; start += GRID_BATCH_MAX) {
      // Cancelled: stop asking rather than finish a batch nobody wants any
      // more (ADR 0012 §3) — the cells left over answer "not sampled".
      if (deps.signal?.aborted) break;
      const chunk = wanted.slice(start, start + GRID_BATCH_MAX);
      try {
        const answer = await provider.elevations(chunk.map((w) => w.point), { signal: deps.signal });
        const values = answer && Array.isArray(answer.elevationsM) ? answer.elevationsM : null;
        const prov = answer?.provenance ?? null;
        if (prov) {
          source = prov.source ?? source;
          dataset = prov.dataset ?? dataset;
          resolutionM = prov.resolutionM ?? resolutionM;
          attribution = prov.attribution ?? attribution;
          retrievedAt = prov.retrievedAt ?? retrievedAt;
          for (const note of prov.notes ?? []) notes.push(note);
        }
        if (!values || values.length !== chunk.length) {
          // Same alignment rule sample-corridor.js enforces: with no
          // coordinates in the answer, a length mismatch means the values no
          // longer identify the cells they came back for.
          notes.push(`a batch of ${chunk.length} cell(s) came back with an elevation list that does not `
            + 'match what was asked, so none of it was used.');
        } else {
          chunk.forEach((want, i) => {
            const value = values[i];
            if (typeof value !== 'number' || !Number.isFinite(value)) return;
            fetched++;
            if (cache) cache.set(want.point, value);
            for (const at of want.at) elevations[at] = value;
          });
        }
      } catch (err) {
        // Silence, not failure (ADR 0012 §3): a cancelled batch is not a
        // provider outage, and stopping here (rather than pressing on to the
        // next chunk) is what "the caller has moved on" actually means.
        if (isAbortError(err)) break;
        notes.push(`a batch of ${chunk.length} cell(s) failed: ${errorText(err)}.`);
      }
    }
  }

  source = source ?? provider?.source ?? null;
  dataset = dataset ?? provider?.dataset ?? null;
  resolutionM = resolutionM ?? provider?.resolutionM ?? null;
  attribution = attribution ?? provider?.attribution ?? null;
  retrievedAt = retrievedAt ?? (fetched > 0 ? now() : null);

  /** @type {import('./terrain-contracts.js').AdvisoryGridCell[]} */
  const cells = points.map((point, i) => Object.freeze({
    lat: point.lat,
    lng: point.lng,
    elevM: elevations[i],
  }));

  const missing = cells.filter((c) => c.elevM == null).length;
  /** @type {import('./terrain-contracts.js').TerrainCoverage} */
  const coverage = cells.length === 0 || missing === cells.length
    ? 'empty'
    : (missing === 0 ? 'complete' : 'partial');

  /** @type {AdvisoryGridProvenance} */
  const provenance = Object.freeze({
    source, dataset, resolutionM, attribution, retrievedAt,
    requested: byKey.size,
    cacheHits,
    fetched,
    missing,
    coverage,
    notes: Object.freeze(notes.slice()),
  });

  return Object.freeze({
    grid: /** @type {AdvisoryGrid} */ (Object.freeze({
      rows: request.rows,
      cols: request.cols,
      cellSizeM: request.cellSizeM,
      cells: Object.freeze(cells),
    })),
    provenance,
  });
}

/** @param {unknown} err @returns {string} */
function errorText(err) {
  if (err instanceof Error && err.message) return err.message;
  return typeof err === 'string' && err ? err : 'no reason given';
}

/** True for the error a cancelled fetch/provider call throws. @param {unknown} err @returns {boolean} */
function isAbortError(err) {
  return !!err && typeof err === 'object' && /** @type {{ name?: unknown }} */ (err).name === 'AbortError';
}
