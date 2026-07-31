// synthetic-dem.mjs — ground with a known shape, for tests that must not fetch.
//
// M3's exit gate names seven fixtures — flat, ridge, valley, saddle, pass,
// cliff, missing tile — and asks that terrain, physics, RF, wind and the
// renderer all agree about them. That only works if there is one definition of
// each surface, so this module is it: elevation functions of (lat, lng), the
// corridors that fly across them, and the provider shims that serve them. M3a's
// sampling and classification tests import from here, and M3b's physics gate
// imports the same file rather than inventing a second ridge.
//
// The surfaces are analytic, not sampled. A Gaussian ridge has a maximum
// exactly on its axis, a two-peak col has a saddle point exactly between the
// peaks, and a step function is discontinuous exactly where it says it is — so
// a test can assert *which sample* a feature lands on, not merely that one was
// found somewhere.
//
// Local coordinates are metres east and north of FIXTURE_ORIGIN, on the
// equirectangular approximation. Over the few kilometres these fixtures cover,
// that differs from the great-circle geometry the corridor builder uses by well
// under a metre — three orders of magnitude below the features being detected.

import { destination } from '../../src/domain/geo.js';

/** Somewhere flat and unremarkable: the Hill Country field this app was written for. */
export const FIXTURE_ORIGIN = Object.freeze({ lat: 30.2672, lng: -97.7431 });

const M_PER_DEG_LAT = 111320;

/**
 * Metres east and north of the fixture origin.
 * @param {number} lat
 * @param {number} lng
 * @returns {{ east: number, north: number }}
 */
export function localMetres(lat, lng) {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos(FIXTURE_ORIGIN.lat * Math.PI / 180);
  return {
    east: (lng - FIXTURE_ORIGIN.lng) * mPerDegLng,
    north: (lat - FIXTURE_ORIGIN.lat) * M_PER_DEG_LAT,
  };
}

/**
 * A point `distM` metres from `from` along a bearing. The corridors below are
 * built with the same geo.js the application uses, so a fixture route is the
 * geometry the real code would produce.
 * @param {{ lat: number, lng: number }} from
 * @param {number} bearingDeg
 * @param {number} distM
 * @returns {{ lat: number, lng: number }}
 */
export function pointAt(from, bearingDeg, distM) {
  const [lat, lng] = destination(from.lat, from.lng, bearingDeg, distM / 1000);
  return { lat, lng };
}

/** @typedef {(lat: number, lng: number) => number|null} Dem */

/* ---------- the surfaces ---------- */

/**
 * Ground at one elevation everywhere. The fixture that must produce no features
 * at all: a flat DEM that yields a ridge is a classifier reading its own noise.
 * @param {{ elevM?: number }} [options]
 * @returns {Dem}
 */
export function flatDem(options = {}) {
  const elevM = options.elevM ?? 200;
  return () => elevM;
}

/**
 * A Gaussian ridge, crest running along `axisDeg`. A route crossing it at right
 * angles sees a local maximum on the crest and falling ground either side.
 * @param {{ base?: number, heightM?: number, widthM?: number, axisDeg?: number }} [options]
 * @returns {Dem}
 */
export function ridgeDem(options = {}) {
  const base = options.base ?? 200;
  const heightM = options.heightM ?? 150;
  const widthM = options.widthM ?? 300;
  const axisDeg = options.axisDeg ?? 90;
  return (lat, lng) => {
    const off = acrossAxis(lat, lng, axisDeg);
    return base + heightM * Math.exp(-((off / widthM) ** 2));
  };
}

/**
 * A Gaussian valley — the ridge, inverted.
 * @param {{ base?: number, depthM?: number, widthM?: number, axisDeg?: number }} [options]
 * @returns {Dem}
 */
export function valleyDem(options = {}) {
  const base = options.base ?? 400;
  const depthM = options.depthM ?? 150;
  const widthM = options.widthM ?? 300;
  const axisDeg = options.axisDeg ?? 90;
  return (lat, lng) => {
    const off = acrossAxis(lat, lng, axisDeg);
    return base - depthM * Math.exp(-((off / widthM) ** 2));
  };
}

/**
 * Two peaks with a col between them, the peaks `peakSpacingM` apart along the
 * east axis. The origin sits in the col, which is the point of the fixture: it
 * is a low point along east and a high point along north, so the same surface
 * answers both the saddle question and the pass question depending on which way
 * the route runs across it.
 *
 *   flying east   — through the col along the crest line → a saddle;
 *   flying north  — across the crest through its lowest point → a pass.
 *
 * @param {{ base?: number, heightM?: number, peakSpacingM?: number, sigmaM?: number }} [options]
 * @returns {Dem}
 */
export function saddleDem(options = {}) {
  const base = options.base ?? 200;
  const heightM = options.heightM ?? 150;
  const half = (options.peakSpacingM ?? 1200) / 2;
  const sigma = options.sigmaM ?? 400;
  return (lat, lng) => {
    const { east, north } = localMetres(lat, lng);
    const peak = (/** @type {number} */ centre) =>
      heightM * Math.exp(-(((east - centre) ** 2) + (north ** 2)) / (sigma ** 2));
    return base + peak(half) + peak(-half);
  };
}

/**
 * A step: high ground up to `atEastM`, then a drop of `dropM`. Discontinuous on
 * purpose — a real DEM smears a cliff over a cell, and a classifier that needs
 * the smear to be gentle would never fire on the sharp case.
 * @param {{ base?: number, dropM?: number, atEastM?: number }} [options]
 * @returns {Dem}
 */
export function cliffDem(options = {}) {
  const base = options.base ?? 400;
  const dropM = options.dropM ?? 80;
  const atEastM = options.atEastM ?? 0;
  return (lat, lng) => (localMetres(lat, lng).east > atEastM ? base - dropM : base);
}

/**
 * Any surface with a rectangular hole in it, in local metres. What a DEM tile
 * that was never built looks like from the outside: not zero, not sea level —
 * nothing.
 * @param {Dem} dem
 * @param {{ eastFromM: number, eastToM: number, northFromM?: number, northToM?: number }} hole
 * @returns {Dem}
 */
export function missingTile(dem, hole) {
  const northFrom = hole.northFromM ?? -Infinity;
  const northTo = hole.northToM ?? Infinity;
  return (lat, lng) => {
    const { east, north } = localMetres(lat, lng);
    const inside = east >= hole.eastFromM && east <= hole.eastToM
      && north >= northFrom && north <= northTo;
    return inside ? null : dem(lat, lng);
  };
}

/**
 * Signed distance from the axis line through the origin, in metres: the
 * component of the local offset perpendicular to a crest running along
 * `axisDeg`.
 * @param {number} lat @param {number} lng @param {number} axisDeg
 * @returns {number}
 */
function acrossAxis(lat, lng, axisDeg) {
  const { east, north } = localMetres(lat, lng);
  const rad = axisDeg * Math.PI / 180;
  // The axis direction is (sin, cos) in (east, north); its normal is (cos, -sin).
  return east * Math.cos(rad) - north * Math.sin(rad);
}

/* ---------- the corridor these surfaces are flown across ---------- */

/**
 * A CorridorRequest in exactly the shape analyze.js publishes: launch first,
 * ids of the form `${segmentId}:${step}`, distances measured from launch.
 * Restated here rather than imported because a fixture that called the real
 * builder would need a whole mission document to say "fly north for 2 km".
 *
 * @param {object} spec
 * @param {{ lat: number, lng: number }} spec.from     the launch point
 * @param {number} spec.bearingDeg
 * @param {number} spec.lengthM
 * @param {number} [spec.steps]           samples after the launch one
 * @param {number} [spec.corridorWidthM]
 * @param {string} [spec.segmentId]
 * @param {string} [spec.missionId]
 * @param {string} [spec.revision]
 * @returns {import('../../src/application/analysis/analysis-contracts.js').CorridorRequest}
 */
export function corridorAlong(spec) {
  const steps = spec.steps ?? 12;
  const segmentId = spec.segmentId ?? 'seg_1';
  const spacingM = spec.lengthM / steps;
  const samples = [{
    id: 'launch:0',
    latitude: spec.from.lat,
    longitude: spec.from.lng,
    distanceKm: 0,
    bearingDeg: spec.bearingDeg,
    segmentId,
  }];
  for (let k = 1; k <= steps; k++) {
    const distM = spacingM * k;
    const at = pointAt(spec.from, spec.bearingDeg, distM);
    samples.push({
      id: `${segmentId}:${k}`,
      latitude: at.lat,
      longitude: at.lng,
      distanceKm: distM / 1000,
      bearingDeg: spec.bearingDeg,
      segmentId,
    });
  }
  return Object.freeze({
    missionId: spec.missionId ?? 'mis_fixture',
    revision: spec.revision ?? '2026-07-30T12:00:00.000Z',
    samples,
    spacingM,
    corridorWidthM: spec.corridorWidthM ?? 0,
  });
}

/**
 * A corridor centred on the fixture origin: it starts half its length back
 * along the bearing, so the feature at the origin lands on a station rather
 * than between two.
 * @param {{ bearingDeg: number, lengthM?: number, steps?: number,
 *           corridorWidthM?: number, segmentId?: string }} spec
 */
export function corridorThroughOrigin(spec) {
  const lengthM = spec.lengthM ?? 2400;
  const steps = spec.steps ?? 12;
  return corridorAlong({
    ...spec,
    from: pointAt(FIXTURE_ORIGIN, (spec.bearingDeg + 180) % 360, lengthM / 2),
    lengthM,
    steps,
  });
}

/* ---------- providers over those surfaces ---------- */

const FIXTURE_RETRIEVED_AT = '2026-07-30T12:00:00.000Z';

/**
 * An ElevationProvider backed by a synthetic surface. Records every call, so a
 * test can assert what was asked as well as what came back.
 *
 * @param {Dem} dem
 * @param {{ source?: string, dataset?: string|null, resolutionM?: number|null,
 *           attribution?: string|null, failAll?: boolean, misalign?: boolean,
 *           notes?: string[], retrievedAt?: string }} [options]
 */
export function demProvider(dem, options = {}) {
  /** @type {{ lat: number, lng: number }[][]} */
  const calls = [];
  return {
    source: options.source ?? 'synthetic DEM',
    dataset: options.dataset ?? 'fixture surface',
    resolutionM: options.resolutionM ?? 30,
    attribution: options.attribution ?? null,
    calls,
    async elevations(points) {
      calls.push(points.map((p) => ({ lat: p.lat, lng: p.lng })));
      const values = points.map((p) => (options.failAll ? null : dem(p.lat, p.lng)));
      const elevationsM = options.misalign ? values.slice(1) : values;
      const answered = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).length;
      return {
        elevationsM,
        provenance: {
          source: options.source ?? 'synthetic DEM',
          dataset: options.dataset ?? 'fixture surface',
          resolutionM: options.resolutionM ?? 30,
          attribution: options.attribution ?? null,
          retrievedAt: options.retrievedAt ?? FIXTURE_RETRIEVED_AT,
          requested: points.length,
          answered,
          missing: points.length - answered,
          batches: 1,
          notes: options.notes ?? [],
        },
      };
    },
  };
}

/**
 * A provider that falls over. The sampler must turn this into a stated absence,
 * not an exception that takes the analysis with it.
 * @param {string} [message]
 */
export function failingProvider(message = 'network is down') {
  return {
    source: 'synthetic DEM',
    async elevations() { throw new Error(message); },
  };
}

/**
 * A provider whose `elevations()` rejects with the same `AbortError` shape a
 * cancelled `fetch` throws. What the samplers must turn into plain silence —
 * no note, no exception, the field just answers "not sampled" — rather than
 * the stated-absence-with-a-reason a genuine outage produces (ADR 0012 §3;
 * contrast with failingProvider() above, which is the outage this is not).
 * @param {string} [message]
 */
export function abortingProvider(message = 'The operation was aborted.') {
  return {
    source: 'synthetic DEM',
    async elevations() {
      throw Object.assign(new Error(message), { name: 'AbortError' });
    },
  };
}

/**
 * A `fetch` stand-in that answers Open-Meteo's elevation endpoint from a
 * synthetic surface. This is what lets the real adapter be tested — batching,
 * URL shape, failure handling — with no network anywhere.
 *
 * `failBatches` and `malformedBatches` are zero-based indices of calls that
 * should answer with an HTTP error or a list of the wrong length.
 *
 * @param {Dem} dem
 * @param {{ failBatches?: number[], malformedBatches?: number[], status?: number }} [options]
 */
export function openMeteoFetchStub(dem, options = {}) {
  const failBatches = new Set(options.failBatches ?? []);
  const malformedBatches = new Set(options.malformedBatches ?? []);
  /** @type {string[]} */
  const urls = [];
  /** @type {{ lat: number, lng: number }[][]} */
  const calls = [];

  /** @param {string} url */
  const stub = async (url) => {
    const index = urls.length;
    urls.push(url);
    const query = new URL(url).searchParams;
    const lats = (query.get('latitude') ?? '').split(',').filter(Boolean).map(Number);
    const lngs = (query.get('longitude') ?? '').split(',').filter(Boolean).map(Number);
    const points = lats.map((lat, i) => ({ lat, lng: lngs[i] }));
    calls.push(points);

    if (failBatches.has(index)) {
      return { ok: false, status: options.status ?? 429, async json() { return {}; } };
    }
    const elevation = points.map((p) => dem(p.lat, p.lng));
    if (malformedBatches.has(index)) elevation.pop();
    return { ok: true, status: 200, async json() { return { elevation }; } };
  };
  stub.urls = urls;
  stub.calls = calls;
  return stub;
}
