// terrain-contracts.js — the vocabulary M3's terrain work is stated in.
//
// Same job analysis-contracts.js does for the snapshot: nothing here computes,
// nothing here fetches, and every shape below is what one layer promises
// another. Three of them matter.
//
//   *The elevation port.* One method, `elevations(points)`, answering per-point
//     `number|null` and a provenance block. A provider that cannot answer a
//     point says null for that point; it does not throw, and it does not shorten
//     the array. Index alignment is the contract — an answer that slid by one
//     would draw a ridge in the wrong place, which is the failure src/terrain.js
//     already guards against and the reason its check is repeated in the adapter.
//
//   *The terrain field.* What a corridor's worth of ground looks like once it
//     has been sampled: one record per sample, keyed by the corridor's own ids,
//     plus the features those records add up to and the provenance that says how
//     much of it is real. Frozen, so a renderer cannot patch a clearance in
//     place the way the old plan object was patched.
//
//   *The lateral ids.* A corridor sample is a station; when the corridor asks
//     for width, the ground either side of that station is sampled too. Those
//     lateral points are the *same station* seen sideways, so their ids are
//     derived from it — `seg_1:4~L` — and never issued from a second scheme. The
//     exit gate says terrain, physics, RF, wind and the renderer must use
//     identical sample identifiers; two id schemes for one place is how that
//     stops being true.
//
// Absence is a value here too. `groundMslM` is null where nothing answered,
// `slopeDeg` is null where a gradient could not be spanned, and coverage says
// 'partial' out loud rather than letting a caller infer it from a count.

/** @typedef {import('../../domain/terrain/terrain-features.js').TerrainFeature} TerrainFeature */
/** @typedef {import('../../domain/terrain/terrain-features.js').FeatureThresholds} FeatureThresholds */

/* ---------- the elevation port ---------- */

/**
 * One point a provider is asked about. `lat`/`lng` rather than the corridor's
 * `latitude`/`longitude`: this is the geo.js LatLng shape, which is what every
 * provider adapter and every map call in this codebase already speaks.
 * @typedef {{ lat: number, lng: number }} ElevationPoint
 */

/**
 * What a provider says about the request as a whole. Counts, not adjectives:
 * `requested` is what it was asked, `answered` is what came back as a number,
 * and `missing` is the difference — a figure the field carries all the way to
 * the provenance block a pilot can read.
 *
 * `notes` is where a failed batch goes. A partial failure is a fact about the
 * data, not an exception: three of four batches answering is a usable field
 * with a stated hole in it, and throwing would throw away the three.
 *
 * @typedef {object} ElevationProvenance
 * @property {string} source              who answered, in the words the UI will use
 * @property {string|null} dataset        the DEM behind it, when the provider names one
 * @property {number|null} resolutionM    the DEM's own ground resolution
 * @property {string|null} attribution    the licence line the provider requires
 * @property {string} retrievedAt         ISO instant of the request
 * @property {number} requested
 * @property {number} answered
 * @property {number} missing
 * @property {number} batches             how many calls it took
 * @property {readonly string[]} notes
 */

/**
 * @typedef {object} ElevationAnswer
 * @property {readonly (number|null)[]} elevationsM  index-aligned with the request
 * @property {ElevationProvenance} provenance
 */

/**
 * The port. Implemented by src/infrastructure/elevation/open-meteo-elevation.js
 * today; a swap (R-DEM's outcome) is one new file implementing this and one
 * line in the composition root.
 *
 * The four optional properties are the adapter's *constants* — who it is, what
 * DEM it reads, how coarse that DEM is, and the licence line it owes. They sit
 * on the port rather than only on an answer because a field served entirely
 * from cache still has to be able to say where its ground came from, and an
 * attribution that disappears on a cache hit is an attribution that is not
 * being made.
 *
 * @typedef {object} ElevationProvider
 * @property {(points: readonly ElevationPoint[], options?: { signal?: AbortSignal }) => Promise<ElevationAnswer>} elevations
 * @property {string} [source]
 * @property {string|null} [dataset]
 * @property {number|null} [resolutionM]
 * @property {string|null} [attribution]
 */

/* ---------- lateral ids ---------- */

/** Left of the course, 90° off the station's own bearing. */
export const LATERAL_LEFT_SUFFIX = '~L';

/** Right of the course. */
export const LATERAL_RIGHT_SUFFIX = '~R';

/** @typedef {'centre'|'left'|'right'} CorridorTrack */

/**
 * The id of one lateral sample, derived from the station it belongs to.
 * @param {string} stationId
 * @param {CorridorTrack} track
 * @returns {string}
 */
export function lateralSampleId(stationId, track) {
  if (track === 'left') return `${stationId}${LATERAL_LEFT_SUFFIX}`;
  if (track === 'right') return `${stationId}${LATERAL_RIGHT_SUFFIX}`;
  return stationId;
}

/**
 * The station a sample id belongs to, and which side of it. The inverse of
 * `lateralSampleId`, so a constraint anchored to `seg_1:4~R` can be reported
 * against the station a pilot recognises.
 * @param {string} sampleId
 * @returns {{ stationId: string, track: CorridorTrack }}
 */
export function stationOf(sampleId) {
  if (sampleId.endsWith(LATERAL_LEFT_SUFFIX)) {
    return { stationId: sampleId.slice(0, -LATERAL_LEFT_SUFFIX.length), track: 'left' };
  }
  if (sampleId.endsWith(LATERAL_RIGHT_SUFFIX)) {
    return { stationId: sampleId.slice(0, -LATERAL_RIGHT_SUFFIX.length), track: 'right' };
  }
  return { stationId: sampleId, track: 'centre' };
}

/* ---------- the field ---------- */

/**
 * Where one sample's elevation came from. 'missing' is not an error state — it
 * is a sample nobody could answer, and it is why `groundMslM` is null.
 * @typedef {'provider'|'cache'|'missing'} SampleSource
 */

/**
 * One sample of ground.
 *
 * `id` is the corridor's own id for a centreline station, or that id plus a
 * lateral suffix. `stationId` is always the centreline id, so grouping a
 * station's three samples never needs string surgery at the call site.
 *
 * @typedef {object} TerrainSample
 * @property {string} id
 * @property {string} stationId
 * @property {CorridorTrack} track
 * @property {number} lat
 * @property {number} lng
 * @property {number} distanceKm      along the corridor, from launch
 * @property {number} bearingDeg
 * @property {string|null} segmentId
 * @property {number|null} groundMslM
 * @property {number|null} slopeDeg   null on lateral samples: they are the
 *   evidence a station's gradient is built from, not stations of their own
 * @property {number|null} aspectDeg
 * @property {'along-track'|'cross-track'|null} gradientBasis
 * @property {SampleSource} source
 */

/**
 * How much of the corridor the field actually describes. 'empty' is the shape a
 * missing provider, a dead network or a total DEM hole produces, and it is
 * distinct from 'partial' precisely so a consumer can refuse to say anything at
 * all rather than reason from one surviving sample.
 * @typedef {'complete'|'partial'|'empty'} TerrainCoverage
 */

/**
 * @typedef {object} TerrainFieldProvenance
 * @property {string|null} source        the provider's own name, or null when none ran
 * @property {string|null} dataset
 * @property {number|null} resolutionM
 * @property {string|null} attribution
 * @property {string|null} retrievedAt
 * @property {number} spacingM           the corridor's along-track step
 * @property {number} corridorWidthM     the half-width sampled either side
 * @property {number} requested          distinct points the field needed
 * @property {number} cacheHits
 * @property {number} fetched            points a provider answered with a number
 * @property {number} missing            samples with no elevation at all
 * @property {TerrainCoverage} coverage
 * @property {readonly string[]} notes
 */

/**
 * The ground under one mission, as one immutable record.
 *
 * `revision` is the corridor's revision carried through untouched — an opaque
 * freshness token, compared and never parsed, so a landed field can be checked
 * against the mission that asked for it.
 *
 * @typedef {object} TerrainField
 * @property {string} missionId
 * @property {string} revision
 * @property {readonly TerrainSample[]} samples   launch first, corridor order,
 *   each station immediately followed by its own lateral samples
 * @property {Readonly<Record<string, TerrainSample>>} byId
 * @property {readonly TerrainFeature[]} features
 * @property {number|null} launchGroundMslM
 * @property {TerrainFieldProvenance} provenance
 */

/* ---------- the advisory grid (M5 wave 2) ---------- */
//
// A corridor is one line through the air; the terrain-forcing baseline needs
// an area — w* = V·∇h wants ground on both sides of the route, not just under
// it. These three typedefs are that area's vocabulary, restated at the same
// level of care as the field above rather than folded into it, because a grid
// cell is not a corridor sample: it has no station id, no along-track distance,
// no slope of its own — sample-grid.js's contribution to M5 is elevation and
// provenance, and gridwards-only.

/**
 * One cell of the advisory grid, before it has been sampled: just where it is.
 * @typedef {object} AdvisoryGridCellRequest
 * @property {number} lat
 * @property {number} lng
 */

/**
 * The pure geometry gridRequestFor() produces: row-major, row 0 northernmost,
 * col 0 westernmost — the same convention AdvisoryGrid below carries through
 * once it is sampled, so a consumer never has to ask which one it is holding.
 * @typedef {object} AdvisoryGridRequest
 * @property {number} rows
 * @property {number} cols
 * @property {number} cellSizeM
 * @property {readonly AdvisoryGridCellRequest[]} cells
 */

/**
 * One sampled cell. `elevM` is null exactly where nobody could answer for that
 * point — the same absence-is-a-value rule `TerrainSample.groundMslM` follows,
 * not sea level and not an interpolated neighbour.
 * @typedef {object} AdvisoryGridCell
 * @property {number} lat
 * @property {number} lng
 * @property {number|null} elevM
 */

/**
 * Row-major; index = row*cols + col, row 0 northernmost, col 0 westernmost —
 * frozen once sampled, the way TerrainField is.
 * @typedef {object} AdvisoryGrid
 * @property {number} rows
 * @property {number} cols
 * @property {number} cellSizeM
 * @property {readonly AdvisoryGridCell[]} cells
 */

/**
 * The grid's provenance, structurally parallel to TerrainFieldProvenance: same
 * fields, same meaning, because it is answering the same question — how much
 * of this ground is real, and who said so — over a different set of points.
 * No `spacingM`/`corridorWidthM`: those describe a line, and this is an area.
 * @typedef {object} AdvisoryGridProvenance
 * @property {string|null} source
 * @property {string|null} dataset
 * @property {number|null} resolutionM
 * @property {string|null} attribution
 * @property {string|null} retrievedAt
 * @property {number} requested
 * @property {number} cacheHits
 * @property {number} fetched
 * @property {number} missing
 * @property {TerrainCoverage} coverage
 * @property {readonly string[]} notes
 */

/**
 * What createGridSampler()'s returned function resolves to: the sampled grid,
 * and the provenance that says how much of it is real.
 * @typedef {object} AdvisoryGridField
 * @property {AdvisoryGrid} grid
 * @property {AdvisoryGridProvenance} provenance
 */

/* ---------- cache keys ---------- */

/**
 * Coordinates rounded to four decimals — about 11 m of latitude, comfortably
 * finer than any DEM behind this port and the same precision src/terrain.js
 * already sends to Open-Meteo. Rounding here is what makes a cache hit possible
 * at all: a launch point dragged by a metre would otherwise miss every entry.
 *
 * Rounding before formatting rather than leaning on toFixed's own rounding: it
 * keeps the key and the coordinate the adapter sends derived from one operation,
 * so a cached answer and a fetched one are answers about the same place.
 *
 * @param {ElevationPoint} point
 * @returns {string}
 */
export function elevationKey(point) {
  const lat = Math.round(point.lat * 1e4) / 1e4;
  const lng = Math.round(point.lng * 1e4) / 1e4;
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}
