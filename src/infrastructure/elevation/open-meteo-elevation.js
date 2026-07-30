// open-meteo-elevation.js — the ElevationProvider port, answered by Open-Meteo.
//
// This is the only file in the app that knows the elevation endpoint's URL, its
// batch limit, or the shape of its payload (ADR 0007). Swapping to a tiled DEM,
// a USGS service or an offline store is a second file implementing the same
// port and one line in the composition root; nothing above this changes.
//
// The port's promise, restated because everything here exists to keep it:
//
//   *One answer per point, in the order asked.* Open-Meteo returns a bare
//     `{ elevation: [...] }` with no coordinates in it, so alignment is
//     positional and unverifiable from the payload. A response whose length does
//     not match the batch is therefore unusable rather than partly usable — an
//     off-by-one profile draws a ridge where the ground is flat, which is worse
//     than no profile at all.
//
//   *A failure is nulls and a note, never a throw.* A rate limit, a dead
//     network, a 500, a batch of nulls: each of those is a hole in the data, and
//     a hole is something the field above can state. The one exception is a
//     caller handing over something that is not a list of points, which is a
//     programming error and is thrown as a TypeError.
//
// Batches are sent one after another rather than in parallel. The endpoint is
// keyless and free, four sequential calls cover the longest corridor this app
// can request, and a burst of parallel requests from every open tab is exactly
// how a keyless service starts rate-limiting.
//
// Attribution: Open-Meteo publishes under CC BY 4.0 and the DEM behind this
// endpoint is Copernicus. The line travels with the data (ADR 0007 wants the
// licence requirement in provenance) and M3b is what puts it on screen.

/** The endpoint. Coordinates go in as comma-joined lists. */
export const OPEN_METEO_ELEVATION_URL = 'https://api.open-meteo.com/v1/elevation';

/** The documented ceiling on one request: 100 coordinates. */
export const ELEVATION_BATCH_MAX = 100;

/** Who this is, in the words the UI and the provenance block use. */
export const OPEN_METEO_SOURCE = 'Open-Meteo elevation API';

/**
 * The DEM behind the endpoint, as Open-Meteo documents it. The payload itself
 * names nothing — it is an array of numbers — so this is the provider's
 * statement carried through, not something read off the wire. If Open-Meteo
 * changes what it serves, this constant is the thing that has to change with it.
 */
export const OPEN_METEO_DATASET = 'Copernicus DEM GLO-90';

/** GLO-90's ground resolution, metres. What "sampling resolution" means here. */
export const OPEN_METEO_RESOLUTION_M = 90;

/** The licence line this data travels under. */
export const OPEN_METEO_ATTRIBUTION = 'Elevation data by Open-Meteo.com (CC BY 4.0), '
  + 'derived from the Copernicus DEM';

/** @typedef {{ lat: number, lng: number }} ElevationPoint */

/**
 * The port's provenance block. Structurally the ElevationProvenance typedef in
 * src/application/terrain/terrain-contracts.js — restated rather than imported,
 * because infrastructure does not reach up into the application layer for a
 * type. A contract test wires this adapter into the sampler, which is what keeps
 * the two honest.
 *
 * @typedef {object} ElevationProvenance
 * @property {string} source
 * @property {string|null} dataset
 * @property {number|null} resolutionM
 * @property {string|null} attribution
 * @property {string} retrievedAt
 * @property {number} requested
 * @property {number} answered
 * @property {number} missing
 * @property {number} batches
 * @property {readonly string[]} notes
 */

/** @typedef {{ elevationsM: (number|null)[], provenance: ElevationProvenance }} ElevationAnswer */

/**
 * @typedef {object} OpenMeteoElevationOptions
 * @property {typeof fetch} [fetch]  injected so tests never touch the network
 * @property {() => string} [now]    ISO instant; injected for deterministic tests
 * @property {number} [batchSize]    clamped to ELEVATION_BATCH_MAX
 */

/**
 * @param {OpenMeteoElevationOptions} [options]
 */
export function createOpenMeteoElevationProvider(options = {}) {
  const doFetch = options.fetch
    ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const now = options.now ?? (() => new Date().toISOString());
  const batchSize = Number.isFinite(options.batchSize) && Number(options.batchSize) > 0
    ? Math.min(Math.floor(Number(options.batchSize)), ELEVATION_BATCH_MAX)
    : ELEVATION_BATCH_MAX;

  return {
    source: OPEN_METEO_SOURCE,
    dataset: OPEN_METEO_DATASET,
    resolutionM: OPEN_METEO_RESOLUTION_M,
    attribution: OPEN_METEO_ATTRIBUTION,

    /**
     * @param {readonly ElevationPoint[]} points
     * @returns {Promise<ElevationAnswer>}
     */
    async elevations(points) {
      if (!Array.isArray(points)) {
        throw new TypeError('elevations: points must be an array of { lat, lng }');
      }
      const retrievedAt = now();
      /** @type {(number|null)[]} */
      const out = new Array(points.length).fill(null);
      /** @type {string[]} */
      const notes = [];
      let batches = 0;
      let answered = 0;

      if (points.length === 0) {
        return answer(out, notes, { retrievedAt, batches, answered, requested: 0 });
      }
      if (!doFetch) {
        notes.push('No fetch implementation is available, so no elevation was requested.');
        return answer(out, notes, { retrievedAt, batches, answered, requested: points.length });
      }

      const total = Math.ceil(points.length / batchSize);
      for (let start = 0; start < points.length; start += batchSize) {
        const chunk = points.slice(start, start + batchSize);
        batches++;
        const label = `batch ${batches} of ${total}`;
        let values = null;
        try {
          values = await requestBatch(doFetch, chunk, label, notes);
        } catch (err) {
          notes.push(`${label}: the elevation request failed (${errorText(err)}); `
            + `${chunk.length} point(s) have no ground.`);
        }
        if (!values) continue;
        for (let i = 0; i < chunk.length; i++) {
          const value = values[i];
          if (typeof value === 'number' && Number.isFinite(value)) {
            out[start + i] = value;
            answered++;
          }
        }
      }

      const missing = points.length - answered;
      if (missing > 0 && notes.length === 0) {
        // Every batch came back well formed and some points still have no
        // ground: the DEM has a hole there (ocean, a tile that was never
        // built). Saying so is the difference between "we did not ask" and
        // "nobody knows".
        notes.push(`${missing} point(s) came back without an elevation; the DEM has no value there.`);
      }
      return answer(out, notes, { retrievedAt, batches, answered, requested: points.length });
    },
  };
}

/**
 * One request. Returns the raw elevation list, or null when the batch produced
 * nothing usable — with the reason already pushed onto `notes`.
 *
 * @param {typeof fetch} doFetch
 * @param {readonly ElevationPoint[]} chunk
 * @param {string} label
 * @param {string[]} notes
 * @returns {Promise<unknown[]|null>}
 */
async function requestBatch(doFetch, chunk, label, notes) {
  const lat = chunk.map((p) => p.lat.toFixed(4)).join(',');
  const lng = chunk.map((p) => p.lng.toFixed(4)).join(',');
  const res = await doFetch(`${OPEN_METEO_ELEVATION_URL}?latitude=${lat}&longitude=${lng}`);
  if (!res || !res.ok) {
    notes.push(`${label}: the elevation service answered HTTP ${res?.status ?? 'nothing'}; `
      + `${chunk.length} point(s) have no ground.`);
    return null;
  }
  const data = await res.json();
  const elevation = data && /** @type {{ elevation?: unknown }} */ (data).elevation;
  if (!Array.isArray(elevation) || elevation.length !== chunk.length) {
    // Network input, and the one check that cannot be skipped: with no
    // coordinates in the payload, a length mismatch means the positions no
    // longer identify the points that were asked about.
    notes.push(`${label}: the elevation service answered with ${describe(elevation)} for `
      + `${chunk.length} point(s), so none of that batch was used.`);
    return null;
  }
  return elevation;
}

/**
 * @param {(number|null)[]} elevationsM
 * @param {string[]} notes
 * @param {{ retrievedAt: string, batches: number, answered: number, requested: number }} counts
 * @returns {ElevationAnswer}
 */
function answer(elevationsM, notes, counts) {
  return {
    elevationsM,
    provenance: Object.freeze({
      source: OPEN_METEO_SOURCE,
      dataset: OPEN_METEO_DATASET,
      resolutionM: OPEN_METEO_RESOLUTION_M,
      attribution: OPEN_METEO_ATTRIBUTION,
      retrievedAt: counts.retrievedAt,
      requested: counts.requested,
      answered: counts.answered,
      missing: counts.requested - counts.answered,
      batches: counts.batches,
      notes: Object.freeze(notes.slice()),
    }),
  };
}

/** @param {unknown} value @returns {string} */
function describe(value) {
  if (Array.isArray(value)) return `${value.length} elevation(s)`;
  if (value === undefined) return 'no elevation list';
  return `${typeof value} where an elevation list belongs`;
}

/** @param {unknown} err @returns {string} */
function errorText(err) {
  if (err instanceof Error && err.message) return err.message;
  return typeof err === 'string' && err ? err : 'no reason given';
}
