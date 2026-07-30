// altitude.js — the one conversion site (ADR 0003).
//
// Three frames are in play the moment a pilot types a height: `launchRelative`
// (metres above the launch point, what a pilot means by "80 metres"), `agl`
// (metres above the terrain under that point, what an obstacle clearance
// means), and `msl` (metres above sea level, what a DEM, an exchange format,
// and every calculation in this app speak). Every consumer converting on its
// own is how altitude bugs are made, so nothing else in the codebase is allowed
// to do this arithmetic.
//
// The rule that shapes every function below: **an unresolved altitude is null,
// never 0.** A terrain sample we do not have is not sea level, and a launch
// elevation nobody has entered is not the shoreline. `resolved: false` plus a
// reason travels outward and becomes a blocking unknown in analysis (ADR 0008),
// which is the honest answer — a plan drawn at "0 m MSL" through a 400 m ridge
// is worse than no plan.
//
// The authored figure is never overwritten. `authored` and `reference` are the
// pilot's words and stay exactly as typed; resolution only ever fills or clears
// `resolvedMslM` beside them, so the display can keep speaking the pilot's
// frame while the model reads MSL.
//
// Where an `agl` segment is sampled: at its destination waypoint. A leg crosses
// terrain the whole way, and the honest treatment of the ground *between* two
// waypoints is a corridor sample set — that is M3's job, and it will consume
// this same module rather than replace it. Until then the arrival point is the
// defensible single sample: it is where the aircraft is actually at that height
// when the leg ends, and it is the point the pilot was looking at when they
// typed the number.

import { ALTITUDE_REFERENCES, LAUNCH_NODE } from './mission-schema.js';

/** @typedef {import('./mission-schema.js').Altitude} Altitude */
/** @typedef {import('./mission-schema.js').MissionDocumentV1} MissionDocumentV1 */
/** @typedef {import('./mission-schema.js').Segment} Segment */
/** @typedef {import('./mission-schema.js').Waypoint} Waypoint */

/**
 * Why an altitude could not be turned into metres MSL.
 * @typedef {'no-altitude'|'bad-authored'|'unknown-reference'|'missing-launch-elevation'|'missing-terrain-sample'} UnresolvedReason
 */

/** @typedef {{ resolvedMslM: number|null, resolved: boolean, reason?: UnresolvedReason }} AltitudeResolution */

/**
 * A terrain sampler answers "how high is the ground here, in metres MSL" and is
 * allowed — expected — to answer `null` where it has no data.
 * @typedef {(latitude: number, longitude: number) => number|null|undefined} TerrainSampler
 */

/** What each frame is called where a pilot reads it. */
export const ALTITUDE_REFERENCE_LABELS = Object.freeze({
  launchRelative: 'above launch', agl: 'AGL', msl: 'MSL',
});

/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * One altitude, resolved against what is known about this point.
 *
 * `launchElevMslM` is the launch site's elevation; `terrainElevMslM` is the
 * ground elevation under the point this altitude applies at. Either may be
 * missing, and a frame that needs the one it does not have comes back
 * unresolved rather than approximated.
 *
 * @param {unknown} altitude an Altitude, or anything claiming to be one
 * @param {{ launchElevMslM?: number|null, terrainElevMslM?: number|null }} [context]
 * @returns {AltitudeResolution}
 */
export function resolveAltitude(altitude, context = {}) {
  /** @param {UnresolvedReason} reason @returns {AltitudeResolution} */
  const unresolved = (reason) => ({ resolvedMslM: null, resolved: false, reason });

  if (typeof altitude !== 'object' || altitude === null) return unresolved('no-altitude');
  const alt = /** @type {{ authored?: unknown, reference?: unknown }} */ (altitude);
  if (!isNum(alt.authored)) return unresolved('bad-authored');
  if (typeof alt.reference !== 'string' || !ALTITUDE_REFERENCES.includes(alt.reference)) {
    return unresolved('unknown-reference');
  }

  if (alt.reference === 'msl') {
    return { resolvedMslM: alt.authored, resolved: true };
  }
  if (alt.reference === 'launchRelative') {
    if (!isNum(context.launchElevMslM)) return unresolved('missing-launch-elevation');
    return { resolvedMslM: context.launchElevMslM + alt.authored, resolved: true };
  }
  // agl
  if (!isNum(context.terrainElevMslM)) return unresolved('missing-terrain-sample');
  return { resolvedMslM: context.terrainElevMslM + alt.authored, resolved: true };
}

/**
 * @typedef {object} UnresolvedAltitude
 * @property {string} segmentId          or 'returnPolicy' for the flight home
 * @property {string} path               dotted path into the document
 * @property {string} reference          the frame it was authored in
 * @property {UnresolvedReason} reason
 */

/**
 * @typedef {object} MissionAltitudeResolution
 * @property {MissionDocumentV1} doc     a new document; the input is untouched
 * @property {number} resolvedCount      altitudes now carrying a metres-MSL figure
 * @property {UnresolvedAltitude[]} unresolved  every one that still cannot resolve
 */

/**
 * Re-resolve every altitude-bearing field in a mission against the launch
 * elevation it carries and whatever terrain the sampler knows.
 *
 * Always returns a new document (segments that did not change are shared by
 * reference), and always *clears* a `resolvedMslM` it can no longer justify —
 * a stale MSL figure left over from a terrain snapshot that has since moved is
 * exactly the silent-wrong-answer this module exists to prevent.
 *
 * The sampler is called at most once per distinct waypoint, and a sampler that
 * throws is treated as a sampler that answered "I don't know": a DEM provider
 * failing mid-resolution must degrade this mission to unresolved, not take the
 * caller down with it.
 *
 * @param {MissionDocumentV1} doc
 * @param {TerrainSampler|null} [terrainSampler]
 * @returns {MissionAltitudeResolution}
 */
export function resolveMissionAltitudes(doc, terrainSampler = null) {
  const launchElevMslM = doc.launch?.elevationMslM ?? null;
  /** @type {UnresolvedAltitude[]} */ const unresolved = [];
  let resolvedCount = 0;

  /** @type {Map<string, number|null>} */ const terrainCache = new Map();
  /** @param {string} key @param {number} latitude @param {number} longitude */
  const terrainAt = (key, latitude, longitude) => {
    if (terrainCache.has(key)) return terrainCache.get(key) ?? null;
    let elev = null;
    if (terrainSampler) {
      try {
        const sample = terrainSampler(latitude, longitude);
        elev = isNum(sample) ? sample : null;
      } catch {
        elev = null; // a provider that fell over is a provider with no answer
      }
    }
    terrainCache.set(key, elev);
    return elev;
  };

  /** @type {Map<string, Waypoint>} */ const byId = new Map();
  for (const w of doc.route.waypoints) byId.set(w.id, w);

  /**
   * @param {Altitude} altitude
   * @param {{ id: string, path: string, latitude: number, longitude: number, key: string }} at
   * @returns {Altitude}
   */
  const applyAt = (altitude, at) => {
    const needsTerrain = altitude?.reference === 'agl';
    const verdict = resolveAltitude(altitude, {
      launchElevMslM,
      terrainElevMslM: needsTerrain ? terrainAt(at.key, at.latitude, at.longitude) : null,
    });
    if (verdict.resolved) resolvedCount++;
    else {
      unresolved.push({
        segmentId: at.id,
        path: at.path,
        reference: typeof altitude?.reference === 'string' ? altitude.reference : 'unknown',
        reason: verdict.reason ?? 'no-altitude',
      });
    }
    // Same figure, same object: structural sharing keeps a no-op resolution
    // from inventing garbage for the diffing an undo stack will want.
    if (altitude && altitude.resolvedMslM === verdict.resolvedMslM) return altitude;
    return { ...altitude, resolvedMslM: verdict.resolvedMslM };
  };

  const segments = doc.route.segments.map((seg, i) => {
    const target = byId.get(seg.to);
    const latitude = target?.latitude ?? doc.launch.latitude;
    const longitude = target?.longitude ?? doc.launch.longitude;
    const altitude = applyAt(seg.altitude, {
      id: seg.id,
      path: `route.segments[${i}].altitude`,
      latitude, longitude,
      key: target ? seg.to : LAUNCH_NODE,
    });
    return altitude === seg.altitude ? seg : { ...seg, altitude };
  });

  const rp = doc.route.returnPolicy;
  const returnAltitude = rp.altitude
    ? applyAt(rp.altitude, {
      id: 'returnPolicy',
      path: 'route.returnPolicy.altitude',
      latitude: doc.launch.latitude, longitude: doc.launch.longitude,
      key: LAUNCH_NODE,
    })
    : null;

  return {
    doc: {
      ...doc,
      route: {
        ...doc.route,
        segments,
        returnPolicy: returnAltitude === rp.altitude ? rp : { ...rp, altitude: returnAltitude },
      },
    },
    resolvedCount,
    unresolved,
  };
}

/**
 * The altitude as the pilot authored it, in the frame they authored it in —
 * metres, because the document is SI; the presentation layer converts to feet
 * from `altitude.authored` when the rail is imperial. Never shows the resolved
 * MSL figure: that number is the model's, and quoting it back at a pilot who
 * typed "80 above launch" is how a frame gets mistaken for another.
 *
 * @param {unknown} altitude
 * @returns {string}
 */
export function displayAltitude(altitude) {
  if (typeof altitude !== 'object' || altitude === null) return 'no altitude';
  const alt = /** @type {{ authored?: unknown, reference?: unknown }} */ (altitude);
  if (!isNum(alt.authored)) return 'no altitude';
  const label = typeof alt.reference === 'string'
    ? /** @type {Record<string, string>} */ (ALTITUDE_REFERENCE_LABELS)[alt.reference]
    : undefined;
  const rounded = Math.round(alt.authored * 10) / 10;
  return label ? `${rounded} m ${label}` : `${rounded} m`;
}
