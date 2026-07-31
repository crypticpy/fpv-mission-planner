// sample-corridor.js — a CorridorRequest in, a TerrainField out.
//
// M2 froze the question: analyze.js publishes a CorridorRequest on every
// snapshot, with launch-first samples carrying ids of the form `seg_1:4`. This
// module answers it. It is the only place in the app that turns "here is the
// route" into "here is the ground under it", and everything downstream — M3b's
// clearance and climb physics, M5's advisories, the 3D scene, the brief — reads
// the field it returns rather than sampling for itself.
//
// What it does not do is decide anything about flight. There is no clearance
// here, no altitude, no verdict: a field is a description of ground. Keeping the
// two apart is what lets the terrain fixtures be synthetic surfaces with no
// mission attached, and what stops a second copy of the clearance rule from
// growing in the sampling layer.
//
// The shape of the seam, for M3b: `createTerrainSampler(deps)` returns one
// async function of one argument, `(corridor) => Promise<TerrainField>`. That is
// deliberately the narrowest thing that can be handed to the pipeline as a port,
// and it holds no module state — the cache is an object the host constructs and
// owns, so two missions cannot share one by accident and a test gets a clean one
// per case.
//
// Three behaviours are load-bearing:
//
//   *Ids come from the corridor, never from here.* A station keeps its own id;
//     lateral samples derive theirs from it. The exit gate's "identical sample
//     identifiers" rule is satisfied by construction rather than by convention.
//
//   *A gap stays a gap.* A sample nobody could answer carries a null elevation
//     and a 'missing' source, and no neighbour is interpolated into it. The
//     field's provenance counts the holes and says whether coverage is complete,
//     partial or empty, because a consumer that must not present unknown
//     clearance as clear needs to be told, not left to infer.
//
//   *A provider that falls over is a stated absence.* A rejected fetch, a
//     malformed answer, a port that is simply not wired up: all three produce a
//     field with null elevations and a note saying so. None of them produce an
//     exception, because an analysis that cannot see the ground still has to be
//     able to say the rest of what it knows.

import { destination, distanceKm, wrapBearing } from '../../domain/geo.js';
import {
  DEFAULT_FEATURE_THRESHOLDS, detectFeatures, gradientAt,
} from '../../domain/terrain/terrain-features.js';
import { elevationKey, lateralSampleId } from './terrain-contracts.js';

/**
 * @typedef {import('../analysis/analysis-contracts.js').CorridorRequest} CorridorRequest
 * @typedef {import('../../domain/terrain/terrain-features.js').FeatureThresholds} FeatureThresholds
 * @typedef {import('../../domain/terrain/terrain-features.js').TerrainStation} TerrainStation
 * @typedef {import('./terrain-contracts.js').CorridorTrack} CorridorTrack
 * @typedef {import('./terrain-contracts.js').ElevationPoint} ElevationPoint
 * @typedef {import('./terrain-contracts.js').ElevationProvider} ElevationProvider
 * @typedef {import('./terrain-contracts.js').SampleSource} SampleSource
 * @typedef {import('./terrain-contracts.js').TerrainCoverage} TerrainCoverage
 * @typedef {import('./terrain-contracts.js').TerrainField} TerrainField
 * @typedef {import('./terrain-contracts.js').TerrainFieldProvenance} TerrainFieldProvenance
 * @typedef {import('./terrain-contracts.js').TerrainSample} TerrainSample
 * @typedef {import('./elevation-cache.js').ElevationCache} ElevationCache
 */

/**
 * What the sampler is given. Everything impure arrives here (ADR 0007): the
 * provider, the cache it should consult, and the clock.
 *
 * `crossTrackOffsetM` is the escape hatch for a corridor that states no width.
 * M2's CorridorRequest carries `corridorWidthM: 0` — an honest statement that
 * the analysis has not looked either side of the line — and a corridor that
 * *does* state a width always wins. But cross-track evidence is the only thing
 * that separates a pass from a ridge, so the host is allowed to ask for it
 * without editing a frozen contract. Whatever is used ends up in the field's
 * provenance, so the field never claims a width it did not sample.
 *
 * @typedef {object} TerrainSamplerDeps
 * @property {ElevationProvider|null} [provider]
 * @property {ElevationCache|null} [cache]
 * @property {Partial<FeatureThresholds>} [thresholds]
 * @property {number} [crossTrackOffsetM]
 * @property {() => string} [now]  ISO instant; injected for deterministic tests
 * @property {AbortSignal} [signal]  cancels an in-flight provider call (ADR 0012 §3)
 */

/** @typedef {(corridor: CorridorRequest, signal?: AbortSignal) => Promise<TerrainField>} CorridorTerrainSampler */

/**
 * The seam M3b wires into the pipeline: deps in, one function out. `signal`
 * (ADR 0012 §3, additive) is the host's per-call cancellation — a superseded
 * sample aborts the request rather than merely discarding an answer nobody
 * asked for any more.
 * @param {TerrainSamplerDeps} deps
 * @returns {CorridorTerrainSampler}
 */
export function createTerrainSampler(deps = {}) {
  return (corridor, signal) => sampleCorridor(corridor, { ...deps, signal });
}

/** One planned point, before anything is known about the ground under it. */
/**
 * @typedef {object} PlannedPoint
 * @property {string} id
 * @property {string} stationId
 * @property {CorridorTrack} track
 * @property {number} lat
 * @property {number} lng
 * @property {number} distanceKm
 * @property {number} bearingDeg
 * @property {string|null} segmentId
 */

/**
 * Every point this field needs, in field order: each station immediately
 * followed by its own lateral samples, so a reader walking `samples` walks the
 * route.
 *
 * @param {CorridorRequest} corridor
 * @param {number} offsetM
 * @returns {PlannedPoint[]}
 */
function planPoints(corridor, offsetM) {
  /** @type {PlannedPoint[]} */
  const points = [];
  for (const sample of corridor.samples) {
    const base = {
      stationId: sample.id,
      distanceKm: sample.distanceKm,
      bearingDeg: sample.bearingDeg,
      segmentId: sample.segmentId ?? null,
    };
    points.push({ ...base, id: sample.id, track: 'centre', lat: sample.latitude, lng: sample.longitude });
    if (offsetM > 0) {
      const offKm = offsetM / 1000;
      const [leftLat, leftLng] = destination(
        sample.latitude, sample.longitude, wrapBearing(sample.bearingDeg - 90), offKm);
      const [rightLat, rightLng] = destination(
        sample.latitude, sample.longitude, wrapBearing(sample.bearingDeg + 90), offKm);
      points.push({
        ...base, id: lateralSampleId(sample.id, 'left'), track: 'left', lat: leftLat, lng: leftLng,
      });
      points.push({
        ...base, id: lateralSampleId(sample.id, 'right'), track: 'right', lat: rightLat, lng: rightLng,
      });
    }
  }
  return points;
}

/**
 * Answer one corridor.
 *
 * @param {CorridorRequest} corridor
 * @param {TerrainSamplerDeps} [deps]
 * @returns {Promise<TerrainField>}
 */
export async function sampleCorridor(corridor, deps = {}) {
  if (!corridor || !Array.isArray(corridor.samples)) {
    throw new TypeError('sampleCorridor: corridor must be a CorridorRequest with samples');
  }
  const provider = deps.provider ?? null;
  const cache = deps.cache ?? null;
  const now = deps.now ?? (() => new Date().toISOString());
  const thresholds = { ...DEFAULT_FEATURE_THRESHOLDS, ...deps.thresholds };
  const offsetM = corridor.corridorWidthM > 0
    ? corridor.corridorWidthM
    : (Number.isFinite(deps.crossTrackOffsetM) ? Number(deps.crossTrackOffsetM) : 0);

  const points = planPoints(corridor, offsetM > 0 ? offsetM : 0);
  /** @type {(number|null)[]} */
  const elevations = new Array(points.length).fill(null);
  /** @type {SampleSource[]} */
  const sources = new Array(points.length).fill('missing');
  /** @type {string[]} */
  const notes = [];

  /* One entry per distinct place, because a corridor asks about the same metre
   * of ground more than once: the launch sample and the first station of a
   * zero-length leg are the same point, and a route that doubles back crosses
   * its own stations. Asking twice would spend a batch on an answer we already
   * have. */
  /** @type {Map<string, number[]>} */
  const byKey = new Map();
  points.forEach((point, i) => {
    const key = elevationKey(point);
    const seen = byKey.get(key);
    if (seen) seen.push(i);
    else byKey.set(key, [i]);
  });

  /** @type {{ key: string, point: ElevationPoint, at: number[] }[]} */
  const wanted = [];
  let cacheHits = 0;
  for (const [key, at] of byKey) {
    const point = { lat: points[at[0]].lat, lng: points[at[0]].lng };
    const hit = cache ? cache.get(point) : null;
    if (typeof hit === 'number' && Number.isFinite(hit)) {
      cacheHits++;
      for (const i of at) { elevations[i] = hit; sources[i] = 'cache'; }
    } else {
      wanted.push({ key, point, at });
    }
  }

  let fetched = 0;
  /** @type {import('./terrain-contracts.js').ElevationProvenance|null} */
  let answerProvenance = null;

  if (wanted.length > 0 && !provider) {
    notes.push('No elevation provider is wired up, so no ground was sampled for this route.');
  } else if (wanted.length > 0 && provider) {
    try {
      const answer = await provider.elevations(wanted.map((w) => w.point), { signal: deps.signal });
      const values = answer && Array.isArray(answer.elevationsM) ? answer.elevationsM : null;
      answerProvenance = answer?.provenance ?? null;
      if (!values || values.length !== wanted.length) {
        // The port's one hard promise is index alignment. An answer that broke
        // it cannot be read at all — a shifted profile puts a ridge where there
        // is none — so the whole batch becomes a stated absence.
        notes.push('The elevation provider answered with a list that does not match the points it was '
          + 'asked about, so none of it was used.');
      } else {
        wanted.forEach((want, i) => {
          const value = values[i];
          if (typeof value !== 'number' || !Number.isFinite(value)) return;
          fetched++;
          if (cache) cache.set(want.point, value);
          for (const at of want.at) { elevations[at] = value; sources[at] = 'provider'; }
        });
      }
      for (const note of answerProvenance?.notes ?? []) notes.push(note);
    } catch (err) {
      // Silence, not failure (ADR 0012 §3): a cancelled request is not a
      // provider outage, and the port itself already keeps an AbortError from
      // reaching here in the ordinary case — this is the backstop for a
      // provider implementation that throws one directly. Anything else is a
      // provider with no answer; taking the analysis down with it would lose
      // the energy, wind and route findings too, all of which are still true.
      if (!isAbortError(err)) notes.push(`The elevation provider failed: ${errorText(err)}`);
    }
  }

  /* Stations, in corridor order, carrying whatever was found beside them. The
   * domain classifier reads these and nothing else. */
  /** @type {TerrainStation[]} */
  const stations = [];
  /** @type {Map<string, number>} */
  const stationAt = new Map();
  points.forEach((point, i) => {
    if (point.track !== 'centre') return;
    stationAt.set(point.stationId, stations.length);
    stations.push({
      id: point.id,
      distanceKm: point.distanceKm,
      bearingDeg: point.bearingDeg,
      groundMslM: elevations[i],
      leftMslM: null,
      rightMslM: null,
      lateralOffsetM: offsetM > 0 ? offsetM : 0,
    });
  });
  points.forEach((point, i) => {
    if (point.track === 'centre') return;
    const at = stationAt.get(point.stationId);
    if (at === undefined) return;
    if (point.track === 'left') stations[at].leftMslM = elevations[i];
    else stations[at].rightMslM = elevations[i];
  });

  const features = detectFeatures(stations, thresholds);

  /** @type {TerrainSample[]} */
  const samples = points.map((point, i) => {
    const at = point.track === 'centre' ? stationAt.get(point.stationId) : undefined;
    const gradient = at === undefined
      ? { slopeDeg: null, aspectDeg: null, basis: null }
      : gradientAt(stations, at);
    return Object.freeze({
      id: point.id,
      stationId: point.stationId,
      track: point.track,
      lat: point.lat,
      lng: point.lng,
      distanceKm: point.distanceKm,
      bearingDeg: point.bearingDeg,
      segmentId: point.segmentId,
      groundMslM: elevations[i],
      slopeDeg: gradient.slopeDeg,
      aspectDeg: gradient.aspectDeg,
      gradientBasis: gradient.basis,
      source: sources[i],
    });
  });

  /** @type {Record<string, TerrainSample>} */
  const byId = {};
  for (const sample of samples) byId[sample.id] = sample;

  const missing = samples.filter((s) => s.groundMslM == null).length;
  /** @type {TerrainCoverage} */
  const coverage = samples.length === 0 || missing === samples.length
    ? 'empty'
    : (missing === 0 ? 'complete' : 'partial');

  const provenance = /** @type {TerrainFieldProvenance} */ (Object.freeze({
    source: answerProvenance?.source ?? provider?.source ?? null,
    dataset: answerProvenance?.dataset ?? provider?.dataset ?? null,
    resolutionM: answerProvenance?.resolutionM ?? provider?.resolutionM ?? null,
    attribution: answerProvenance?.attribution ?? provider?.attribution ?? null,
    retrievedAt: answerProvenance?.retrievedAt ?? (fetched > 0 ? now() : null),
    spacingM: corridor.spacingM,
    corridorWidthM: offsetM > 0 ? offsetM : 0,
    requested: byKey.size,
    cacheHits,
    fetched,
    missing,
    coverage,
    notes: Object.freeze(notes.slice()),
  }));

  return Object.freeze({
    missionId: corridor.missionId,
    revision: corridor.revision,
    samples: Object.freeze(samples),
    byId: Object.freeze(byId),
    features: Object.freeze(features),
    launchGroundMslM: stations.length > 0 ? stations[0].groundMslM : null,
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

/**
 * A point-wise ground sampler over a field, in the shape ADR 0003's altitude
 * module already takes: `(latitude, longitude) => number|null`.
 *
 * This is how an `agl` altitude becomes a metres-MSL figure. It answers only
 * from stations the corridor actually sampled and only within `toleranceM` of
 * one — a waypoint the field never looked at comes back null, which
 * resolveMissionAltitudes() turns into an honest 'missing-terrain-sample'
 * rather than a height above ground nobody measured.
 *
 * Nearest-station, not interpolated: the stations are tens to hundreds of
 * metres apart on a DEM tens of metres coarse, and a blended figure would read
 * as more precise than the data behind it.
 *
 * @param {TerrainField|null} field
 * @param {{ toleranceM?: number }} [options]
 * @returns {(latitude: number, longitude: number) => number|null}
 */
export function nearestGroundSampler(field, options = {}) {
  const toleranceKm = (Number.isFinite(options.toleranceM) ? Number(options.toleranceM) : 250) / 1000;
  const known = (field?.samples ?? []).filter((s) => s.track === 'centre' && s.groundMslM != null);
  return (latitude, longitude) => {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const at = { lat: latitude, lng: longitude };
    /** @type {number|null} */
    let best = null;
    let bestKm = Infinity;
    for (const sample of known) {
      const km = distanceKm(at, { lat: sample.lat, lng: sample.lng });
      if (km < bestKm) { bestKm = km; best = sample.groundMslM; }
    }
    return bestKm <= toleranceKm ? best : null;
  };
}
