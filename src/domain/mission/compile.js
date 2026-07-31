// compile.js — CompiledMission: the one frame-resolved view every adapter reads
// (ADR 0010 §1).
//
// A mission document says what the pilot authored; an exchange format asks for
// something else. GPX wants metres MSL, an INAV mission wants metres above the
// launch point, an obstacle clearance wants AGL, and a `.plan` wants a speed in
// m/s for a leg the pilot described as "cruise". Every adapter answering those
// questions on its own is six copies of the same arithmetic, five of which are
// subtly wrong. So the arithmetic happens once, here, and an adapter picks the
// field its format speaks.
//
// Three rules shape the output:
//
//   every frame is precomputed, and an unresolvable frame is null. Not 0, not
//     the authored figure reinterpreted, not the nearest thing to hand
//     (ADR 0003). A null is an adapter's cue to name a loss or refuse the
//     export; a fabricated number is how a plan drawn at sea level goes through
//     a ridge. Each null is paired with an `issues[]` entry saying what was
//     missing, so the reason survives to the UI.
//
//   the return leg is never materialised. `returnPolicy` travels declarative,
//     exactly as the document holds it — an adapter maps it to an RTL command,
//     to geometry, or to a named loss. Inventing a leg here would hand every
//     adapter a leg the pilot cannot edit and cannot see (ADR 0002).
//
//   the concept inventory is derived, not declared. `inventory` says which of
//     ADR 0010's seven concepts this mission actually uses; `deriveLosses` in
//     infrastructure/export/ turns that against an adapter's support table into
//     `semanticLosses` without any adapter author remembering to write one. A
//     concept nobody declared support for degrades honestly by default.
//
// This is domain code and pure: same document plus same sampler, same output,
// and the input document is never touched. The terrain sampler is injected
// rather than imported for the same reason — a compile that fetched would be an
// application concern, and infrastructure adapters may import domain but not
// application (ADR 0009).

import { convertAltitude } from './altitude.js';
import { ALTITUDE_REFERENCES, SPEED_MODES, intentHoldsStation } from './mission-schema.js';

/** @typedef {import('./mission-schema.js').MissionDocumentV1} MissionDocumentV1 */
/** @typedef {import('./mission-schema.js').Altitude} Altitude */
/** @typedef {import('./mission-schema.js').AltitudeReference} AltitudeReference */
/** @typedef {import('./mission-schema.js').AircraftSnapshot} AircraftSnapshot */
/** @typedef {import('./mission-schema.js').SegmentIntent} SegmentIntent */
/** @typedef {import('./mission-schema.js').SpeedMode} SpeedMode */
/** @typedef {import('./mission-schema.js').SpeedPolicy} SpeedPolicy */
/** @typedef {import('./mission-schema.js').ReturnMode} ReturnMode */
/** @typedef {import('./mission-schema.js').Bag} Bag */
/** @typedef {import('./altitude.js').TerrainSampler} TerrainSampler */

/**
 * One authored height with every frame worked out. A `null` frame is a frame
 * the inputs could not support, and `issues[]` carries the reason.
 * @typedef {object} CompiledAltitude
 * @property {number} authored            metres, as the pilot typed it
 * @property {AltitudeReference} reference the frame they typed it in
 * @property {number|null} amslM          metres above mean sea level
 * @property {number|null} launchRelM     metres above the launch point
 * @property {number|null} aglM           metres above the ground beneath it
 */

/**
 * @typedef {object} CompiledPoint
 * @property {string} id                  the waypoint id it derives from
 * @property {number} latitude
 * @property {number} longitude
 * @property {CompiledAltitude} altitude  the arriving segment's height
 */

/** @typedef {{ mode: SpeedMode, ms: number|null }} CompiledSpeed */

/**
 * @typedef {object} CompiledLeg
 * @property {string} id                  the segment id it derives from
 * @property {string} fromId              a waypoint id, or 'launch'
 * @property {string} toId                a waypoint id
 * @property {SegmentIntent} intent
 * @property {CompiledSpeed} speed
 * @property {number|null} holdS
 * @property {string|null} subjectRef
 * @property {Bag|null} camera            M7 owns the shape; carried verbatim
 */

/** @typedef {'geometry'|'altitude-reference'|'speed'|'hold'|'camera-intent'|'return-policy'|'reserve'} Concept */
/** @typedef {{ concept: Concept, detail: string }} InventoryEntry */
/** @typedef {{ code: string, path: string, message: string }} CompileIssue */
/** @typedef {{ id: string, name: string, latitude: number, longitude: number, elevationMslM: number|null, radiusM: number|null }} CompiledSubject */

/**
 * @typedef {object} CompiledMission
 * @property {string} missionId
 * @property {string} title
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {{ latitude: number, longitude: number, elevationMslM: number|null }} home
 * @property {CompiledPoint[]} points     one per waypoint, in route order
 * @property {CompiledLeg[]} legs         one per segment, in route order
 * @property {{ mode: ReturnMode, altitude: CompiledAltitude|null }} returnPolicy
 * @property {{ landFloorPct: number }} reserve
 * @property {{ subjects: CompiledSubject[] }} scene
 * @property {InventoryEntry[]} inventory
 * @property {CompileIssue[]} issues
 */

/**
 * ADR 0010 §2's frozen vocabulary, in the order an inventory reports them.
 * A concept an adapter's support table does not mention is `unsupported` —
 * which is what makes a new concept degrade every existing adapter honestly
 * instead of silently.
 * @type {readonly Concept[]}
 */
export const CONCEPTS = Object.freeze([
  'geometry', 'altitude-reference', 'speed', 'hold', 'camera-intent', 'return-policy', 'reserve',
]);

/** The intents that frame something, whether or not a subject was attached. */
const CAMERA_INTENTS = Object.freeze(['reveal', 'orbit', 'pass']);

/** Which CompiledAltitude field carries which frame. */
const FRAMES = /** @type {const} */ ([
  ['amslM', 'msl'], ['launchRelM', 'launchRelative'], ['aglM', 'agl'],
]);

/** How each frame reads in a sentence a pilot sees. */
const REFERENCE_WORDS = Object.freeze({ launchRelative: 'launch-relative', agl: 'AGL', msl: 'MSL' });

/** How each return mode reads in a sentence a pilot sees. */
const RETURN_WORDS = Object.freeze({ direct: 'direct return to launch', retrace: 'return retracing the route' });

/** Why a frame or a speed came back empty, in the words the issue carries. */
const UNRESOLVED_WORDS = Object.freeze({
  'no-altitude': 'there is no altitude here',
  'bad-authored': 'the authored height is not a number',
  'unknown-reference': 'the authored frame is not one this app knows',
  'missing-launch-elevation': 'the launch elevation is unknown',
  'missing-terrain-sample': 'no terrain sample covers this point',
});

/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** @param {number} n @param {string} noun */
const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * The members of `order` that appear in `values`, in `order`'s order — so an
 * inventory detail reads the same for the same mission every time rather than
 * in whatever sequence the route happens to be in.
 * @param {readonly string[]} order
 * @param {readonly (string|null|undefined)[]} values
 * @returns {string[]}
 */
const distinct = (order, values) => order.filter((o) => values.includes(o));

/**
 * A terrain reader over an injected sampler: one call per distinct point, and a
 * sampler that throws is a sampler with no answer. Same treatment as
 * `resolveMissionAltitudes` — a DEM provider falling over mid-compile degrades
 * this mission to unresolved rather than taking the export down with it.
 *
 * @param {TerrainSampler|null} sampler
 * @returns {(key: string, latitude: number, longitude: number) => number|null}
 */
function terrainReader(sampler) {
  /** @type {Map<string, number|null>} */ const cache = new Map();
  return (key, latitude, longitude) => {
    const hit = cache.get(key);
    if (hit !== undefined || cache.has(key)) return hit ?? null;
    let elevation = null;
    if (sampler) {
      try {
        const sample = sampler(latitude, longitude);
        elevation = isNum(sample) ? sample : null;
      } catch {
        elevation = null; // a provider that fell over is a provider with no answer
      }
    }
    cache.set(key, elevation);
    return elevation;
  };
}

/**
 * One altitude in all three frames. Every frame is asked for, including the one
 * it was authored in — the conversion is free there and it keeps adapters from
 * having to special-case "my format's frame happens to be the authored frame".
 *
 * @param {Altitude} altitude
 * @param {{ launchElevMslM: number|null, terrainElevMslM: number|null, path: string }} at
 * @param {CompileIssue[]} issues  appended to in place
 * @returns {CompiledAltitude}
 */
function compileAltitude(altitude, at, issues) {
  /** @type {CompiledAltitude} */
  const compiled = {
    authored: altitude.authored,
    reference: altitude.reference,
    amslM: null, launchRelM: null, aglM: null,
  };
  for (const [field, frame] of FRAMES) {
    const converted = convertAltitude({
      value: altitude.authored,
      from: altitude.reference,
      to: frame,
      launchElevMslM: at.launchElevMslM,
      terrainElevMslM: at.terrainElevMslM,
    });
    if (converted.resolved) {
      compiled[field] = converted.value;
      continue;
    }
    const reason = converted.reason ?? 'no-altitude';
    issues.push({
      code: 'C-ALT-UNRESOLVED',
      path: `${at.path}.${field}`,
      message: `No ${frame} figure for this altitude: ${/** @type {Record<string, string>} */ (UNRESOLVED_WORDS)[reason]}.`,
    });
  }
  return compiled;
}

/**
 * A leg's speed in m/s where the policy can produce one.
 *
 * `fixed` is the pilot's own number. `cruise` is the aircraft's, which needs an
 * aircraft snapshot. `maxRange` is the speed that maximises still-air distance
 * and is a physics sweep away — the compiler will not guess at it, so it lands
 * null and an adapter that must emit a number approximates with cruise and says
 * so in a loss entry.
 *
 * @param {SpeedPolicy} policy
 * @param {AircraftSnapshot|null} aircraft
 * @param {string} path
 * @param {CompileIssue[]} issues  appended to in place
 * @returns {CompiledSpeed}
 */
function compileSpeed(policy, aircraft, path, issues) {
  const mode = policy.mode;
  const cruiseMs = aircraft ? aircraft.cruiseMs : null;
  const ms = mode === 'fixed' ? (isNum(policy.targetMs) ? policy.targetMs : null)
    : mode === 'cruise' ? (isNum(cruiseMs) ? cruiseMs : null)
      : null;
  if (ms === null) {
    const why = mode === 'maxRange'
      ? 'a max-range speed comes from the physics sweep, not from the document'
      : mode === 'cruise' ? 'no aircraft snapshot is attached to this mission'
        : 'this fixed-speed leg carries no target speed';
    issues.push({
      code: 'C-SPEED-UNRESOLVED',
      path,
      message: `No speed for a '${mode}' leg: ${why}.`,
    });
  }
  return { mode, ms };
}

/**
 * Which of ADR 0010's concepts this mission uses, in CONCEPTS order.
 *
 * The presence rules are the contract; the `detail` beside each is a short
 * human fragment that ends up in a loss entry ("hold — 2 hold segments —
 * dropped"), so it names the thing that would be lost rather than restating
 * the concept.
 *
 * @param {MissionDocumentV1} doc
 * @returns {InventoryEntry[]}
 */
function deriveInventory(doc) {
  const { waypoints, segments, returnPolicy } = doc.route;
  /** @type {InventoryEntry[]} */ const inventory = [];
  /** @param {Concept} concept @param {string} detail */
  const add = (concept, detail) => { inventory.push({ concept, detail }); };

  if (waypoints.length > 0) add('geometry', `${plural(waypoints.length, 'waypoint')} from launch`);

  if (segments.length > 0) {
    const references = distinct(ALTITUDE_REFERENCES, [
      ...segments.map((s) => s.altitude?.reference),
      returnPolicy.altitude?.reference,
    ]).map((r) => /** @type {Record<string, string>} */ (REFERENCE_WORDS)[r]);
    add('altitude-reference', `altitudes authored ${references.join(', ')}`);

    const modes = distinct(SPEED_MODES, segments.map((s) => s.speedPolicy?.mode));
    add('speed', `${modes.join(', ')} speed ${modes.length === 1 ? 'policy' : 'policies'}`);
  }

  const holds = segments.filter((s) => intentHoldsStation(s.intent) || isNum(s.holdS));
  if (holds.length > 0) add('hold', plural(holds.length, 'hold segment'));

  const framed = segments.filter((s) => s.camera != null || s.subjectRef != null
    || CAMERA_INTENTS.includes(s.intent));
  if (framed.length > 0) add('camera-intent', plural(framed.length, 'camera-directed segment'));

  if (returnPolicy.mode !== 'none') {
    add('return-policy', /** @type {Record<string, string>} */ (RETURN_WORDS)[returnPolicy.mode]);
  }

  add('reserve', `${doc.planningPolicy.reserve.landFloorPct}% land floor`);
  return inventory;
}

/**
 * A mission document as every adapter reads it.
 *
 * The document must be one `validateMission` accepts: the route chain invariant
 * (`segments[i].to === waypoints[i].id`, one segment per waypoint) is what pairs
 * a point with the altitude of the leg arriving at it, and a document that
 * breaks it has no compiled form to speak of. Import paths validate first
 * (ADR 0010 §4), so this stays a derivation rather than a second validator.
 *
 * The sampler is asked once per distinct point, at the arrival waypoint of each
 * leg — the same sample site `altitude.js` documents, for the same reason.
 *
 * @param {MissionDocumentV1} doc
 * @param {{ terrainSampler?: TerrainSampler|null }} [options]
 * @returns {CompiledMission}
 */
export function compileMission(doc, { terrainSampler = null } = {}) {
  /** @type {CompileIssue[]} */ const issues = [];
  const launchElevMslM = doc.launch.elevationMslM;
  const groundAt = terrainReader(terrainSampler);

  const points = doc.route.waypoints.map((waypoint, i) => {
    const segment = doc.route.segments[i];
    return {
      id: waypoint.id,
      latitude: waypoint.latitude,
      longitude: waypoint.longitude,
      altitude: compileAltitude(segment.altitude, {
        launchElevMslM,
        terrainElevMslM: groundAt(waypoint.id, waypoint.latitude, waypoint.longitude),
        path: `route.segments[${i}].altitude`,
      }, issues),
    };
  });

  const legs = doc.route.segments.map((segment, i) => ({
    id: segment.id,
    fromId: segment.from,
    toId: segment.to,
    intent: segment.intent,
    speed: compileSpeed(segment.speedPolicy, doc.aircraftSnapshot,
      `route.segments[${i}].speedPolicy`, issues),
    holdS: segment.holdS ?? null,
    subjectRef: segment.subjectRef ?? null,
    camera: segment.camera ?? null,
  }));

  const rp = doc.route.returnPolicy;
  const returnAltitude = rp.altitude
    ? compileAltitude(rp.altitude, {
      launchElevMslM,
      // The flight home ends over the launch point, so that is the ground it is
      // measured against.
      terrainElevMslM: groundAt('launch', doc.launch.latitude, doc.launch.longitude),
      path: 'route.returnPolicy.altitude',
    }, issues)
    : null;

  return {
    missionId: doc.id,
    title: doc.title,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    home: {
      latitude: doc.launch.latitude,
      longitude: doc.launch.longitude,
      elevationMslM: launchElevMslM,
    },
    points,
    legs,
    // Declarative on purpose: the compiler never materialises a return leg.
    returnPolicy: { mode: rp.mode, altitude: returnAltitude },
    reserve: { landFloorPct: doc.planningPolicy.reserve.landFloorPct },
    // Field by field rather than by spread: a subject that arrived from an
    // import carries only what this shape names.
    scene: {
      subjects: doc.scene.subjects.map((s) => ({
        id: s.id,
        name: s.name,
        latitude: s.latitude,
        longitude: s.longitude,
        elevationMslM: s.elevationMslM ?? null,
        radiusM: s.radiusM ?? null,
      })),
    },
    inventory: deriveInventory(doc),
    issues,
  };
}
