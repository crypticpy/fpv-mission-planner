// mission-schema.js — MissionDocumentV1: the shape of the one authoritative
// mission record (ADR 0002), the constructor that mints a fresh one, and the
// runtime validator that stands between any untrusted blob and the rest of the
// application.
//
// This file is a frozen contract. Three things follow from that, and they are
// the reason the code below looks the way it does:
//
//   the document is data, not behaviour. Plain objects, structured-clonable end
//     to end (R-OFFLINE F12 — a function or a DOM node anywhere in here makes
//     the record unwritable to IndexedDB). No classes, no getters, no methods
//     hanging off a mission.
//
//   identity is generated, never derived. Missions, waypoints, segments,
//     constraints and subjects all carry a prefixed random id from an injected
//     source, so tests are deterministic and a rename can never renumber a
//     route. An id is minted once and outlives every edit to the thing it
//     names; deleting and re-adding is a new id, deliberately.
//
//   validation has two registers. Errors say the document cannot be trusted to
//     identify itself or hold together — a missing id, a segment pointing at a
//     waypoint that is not there, an intent outside the enum. Warnings say the
//     document is sound but not yet complete enough to analyse — an unresolved
//     altitude, no loadout snapshot, a hold with no duration. Only errors make
//     `ok` false, because refusing to open an otherwise-intact mission over a
//     terrain sample nobody has taken yet is how a field tool loses a pilot's
//     work (ADR 0002: fail safely to "not loaded", never to a half-mission —
//     but a whole mission with holes in it is still a whole mission).
//
// The launch point is a node in the route graph under the reserved id
// `'launch'`, not a waypoint: it is the one position the pilot does not author
// as part of the path, and it has an elevation the waypoints do not. Segments
// therefore chain `launch → wpt₁ → … → wptₙ`, one segment per waypoint, and
// `segments[i].to === waypoints[i].id` is the structural invariant everything
// else here leans on. The flight home is described by `route.returnPolicy`
// rather than materialised as a segment — src/domain/route.js already models the
// return as direct-to-launch, and inventing a segment for it would give the
// pilot a leg they cannot edit.

// scene-schema.js owns the shape of the M7 cinematic bags (ADR 0011 §2) and
// imports nothing; this file wires its checks into validateMission's report so
// its own growth stays wiring rather than a second copy of the shape rules.
import { NAME_MAX_LEN, isValidName, checkCameraShape, checkCameraProfile } from './scene-schema.js';

/** @typedef {'launchRelative'|'agl'|'msl'} AltitudeReference */
/** @typedef {'transit'|'reveal'|'orbit'|'hold'|'pass'|'return'|'approach'} SegmentIntent */
/** @typedef {'cruise'|'fixed'|'maxRange'} SpeedMode */
/** @typedef {'direct'|'retrace'|'none'} ReturnMode */
/** @typedef {'live'|'preset'|'manual'} EnvironmentSource */
/** @typedef {{ [key: string]: unknown }} Bag */

/**
 * A pilot-authored height plus the frame it was authored in, and the single MSL
 * number every calculation is allowed to read (ADR 0003). `resolvedMslM` is
 * `null` whenever the inputs to resolve it are missing — never 0.
 * @typedef {object} Altitude
 * @property {number} authored          metres, in the frame named below
 * @property {AltitudeReference} reference
 * @property {number|null} resolvedMslM metres MSL, or null when unresolved
 */

/** @typedef {{ mode: SpeedMode, targetMs: number|null }} SpeedPolicy */
/** @typedef {{ id: string, latitude: number, longitude: number }} Waypoint */

/**
 * @typedef {object} Segment
 * @property {string} id
 * @property {string} from              a waypoint id, or LAUNCH_NODE
 * @property {string} to                a waypoint id
 * @property {Altitude} altitude
 * @property {SpeedPolicy} speedPolicy
 * @property {SegmentIntent} intent
 * @property {number|null} [holdS]      seconds; hold/orbit only
 * @property {string|null} [subjectRef] a scene subject id
 * @property {SegmentCamera|null} [camera] M7 wave B's validated shot geometry
 * @property {Bag|null} [overrides]     per-segment policy escapes
 */

/** @typedef {{ mode: ReturnMode, altitude: Altitude|null }} ReturnPolicy */
/** @typedef {{ waypoints: Waypoint[], segments: Segment[], returnPolicy: ReturnPolicy }} Route */
/** @typedef {{ latitude: number, longitude: number, elevationMslM: number|null }} Launch */

/**
 * The minimum of an airframe the physics needs with no catalog present, plus
 * enough identity to say which rig this was. Field set derived from what
 * `planMission`/`discAreaM2`/`liftEnvelope` actually read (src/domain/physics.js) and
 * what `calibratedDrone` classes on (src/flightlog.js).
 * @typedef {object} AircraftSnapshot
 * @property {string} sourceId          catalog or pilot-authored record id
 * @property {string} name
 * @property {number} dryMassG
 * @property {number} propDiaIn
 * @property {number} numRotors
 * @property {boolean} ducted
 * @property {number} etaProp
 * @property {number} cdA
 * @property {number} avionicsW
 * @property {number} maxSpeedMs
 * @property {number} cruiseMs
 * @property {number|null} maxThrustGPerRotor
 * @property {Bag|null} propulsion      motor/ESC electrical block, or null
 * @property {number} parallelHarnessMassG
 * @property {number} parallelPackCdA
 * @property {string|null} confidence   provenance of etaProp/cdA
 * @property {boolean} calibrated       true when a flight-log fit was applied
 */

/**
 * The pack as flown: the model's figures with the pack-instance overlay and the
 * parallel-pair arithmetic already applied, because that is what
 * `loadoutBattery()` hands `planMission` and re-deriving it later would need the
 * catalog back.
 * @typedef {object} BatterySnapshot
 * @property {string} sourceId
 * @property {string} name
 * @property {string} chem
 * @property {number} s
 * @property {number} p
 * @property {number} capAh
 * @property {number} massG
 * @property {number} irPackMilliOhm
 * @property {number|null} irTempC
 * @property {number|null} maxContA
 * @property {number} packCount
 * @property {number} extraCdA
 * @property {Bag|null} packInstance    which physical copy, when one was chosen
 */

/**
 * @typedef {object} PayloadSnapshot
 * @property {string} sourceId
 * @property {string} name
 * @property {number} massG
 * @property {number} cdA
 * @property {number} extraG            non-payload ballast carried on the rig
 */

/**
 * How the air was sourced, and the air itself in SI — never in the rail's
 * imperial, so the document reads the same in either unit system. The launch
 * site's own elevation is not repeated here: `launch.elevationMslM` owns it.
 * @typedef {object} EnvironmentReference
 * @property {EnvironmentSource} source
 * @property {string|null} presetId     set when source is 'preset'
 * @property {string|null} capturedAt   ISO instant the values were taken
 * @property {EnvironmentValues|null} values  null until a fetch resolves
 * @property {Bag|null} provenance      ADR 0008 provenance for a live fetch
 */

/**
 * @typedef {object} EnvironmentValues
 * @property {number} temperatureC
 * @property {number} relativeHumidityPct
 * @property {number} windAvgMs
 * @property {number} windGustMs
 * @property {number} windFromDeg       meteorological, degrees from true north
 */

/**
 * @typedef {object} PlanningPolicy
 * @property {{ landFloorPct: number }} reserve  charge the pilot will not land below
 * @property {number} gustFactor        0–1 share of the gust spread planned on
 * @property {number} windLevel         metres AGL the plan flies and samples wind at
 * @property {string} radioBand         src/rf.js LINK_BANDS id
 */

/** @typedef {{ id: string, name: string, latitude: number, longitude: number, elevationMslM: number|null, radiusM: number|null }} Subject */

/**
 * `scene.cameraProfile`'s validated shape (ADR 0011 §2); a small catalog of
 * presets lives in src/catalog/cameras.js, in the same shape.
 * @typedef {object} CameraProfile
 * @property {string} name
 * @property {number} sensorWidthMm
 * @property {number} sensorHeightMm
 * @property {number} focalLengthMm
 * @property {boolean} stabilized
 */

/**
 * `segment.camera`'s validated shape, shared verbatim by `SceneTemplate.camera`
 * (ADR 0011 §2). `orbit` is meaningful only on intent `'orbit'`.
 * @typedef {object} SegmentCamera
 * @property {number|null} pitchDeg
 * @property {number|null} yawOffsetDeg
 * @property {{ radiusM: number, clockwise: boolean }|null} orbit
 */

/**
 * A reusable shot preset stored in the mission. Applying one to a segment
 * copies `intent`/`holdS`/`camera` onto it — no live reference back here.
 * @typedef {object} SceneTemplate
 * @property {string} id
 * @property {string} name
 * @property {SegmentIntent} intent
 * @property {number|null} holdS
 * @property {SegmentCamera|null} camera
 */

/** @typedef {{ subjects: Subject[], cameraProfile: CameraProfile|null, templates: SceneTemplate[] }} Scene */

/**
 * Where this document came from — not the provenance of the evidence inside it,
 * which lives on each snapshot (ADR 0008).
 * @typedef {object} Provenance
 * @property {string} createdBy
 * @property {string|null} appVersion
 * @property {'authored'|'imported'|'duplicated'} origin
 * @property {string|null} sourceFormat when imported, the format it came from
 * @property {string|null} notes
 */

/**
 * @typedef {object} MissionDocumentV1
 * @property {1} schemaVersion
 * @property {string} id
 * @property {string} title
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {Launch} launch
 * @property {AircraftSnapshot|null} aircraftSnapshot
 * @property {BatterySnapshot|null} batterySnapshot
 * @property {PayloadSnapshot|null} payloadSnapshot
 * @property {EnvironmentReference} environmentReference
 * @property {Route} route
 * @property {PlanningPolicy} planningPolicy
 * @property {Scene} scene
 * @property {Provenance} provenance
 */

/** @typedef {{ path: string, code: string, message: string }} ValidationIssue */
/** @typedef {{ ok: boolean, errors: ValidationIssue[], warnings: ValidationIssue[] }} ValidationResult */

export const MISSION_SCHEMA_VERSION = 1;

/** The one node in the route graph that is not a waypoint. */
export const LAUNCH_NODE = 'launch';

/** ADR 0002's id prefixes, by what they name. ADR 0011 §2 adds `template`. */
export const ID_PREFIXES = Object.freeze({
  mission: 'msn', waypoint: 'wpt', segment: 'seg', constraint: 'con', subject: 'sub', template: 'tpl',
});

/** @type {readonly string[]} */
export const ALTITUDE_REFERENCES = Object.freeze(['launchRelative', 'agl', 'msl']);
/** @type {readonly string[]} */
export const SEGMENT_INTENTS = Object.freeze(['transit', 'reveal', 'orbit', 'hold', 'pass', 'return', 'approach']);
/** The intents a dwell time means something for; `holdS` is rejected on all others. */
export const HOLD_INTENTS = Object.freeze(['hold', 'orbit']);
/** @type {readonly string[]} */
export const SPEED_MODES = Object.freeze(['cruise', 'fixed', 'maxRange']);
/** @type {readonly string[]} */
export const RETURN_MODES = Object.freeze(['direct', 'retrace', 'none']);
/** @type {readonly string[]} */
export const ENVIRONMENT_SOURCES = Object.freeze(['live', 'preset', 'manual']);

/* ---------- identity ---------- */

/**
 * The default id source: a prefix and a UUID. Injectable everywhere it is used
 * (`deps.idgen`) so a test can hand out `wpt_1`, `wpt_2` and assert on them.
 *
 * The non-crypto branch is not a security fallback — nothing here is a secret —
 * it is so a document can still be authored in a context without WebCrypto
 * rather than throwing on the first waypoint.
 *
 * @param {string} prefix one of ID_PREFIXES
 * @returns {string}
 */
export function defaultIdgen(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}_${uuid}`;
}

/* ---------- predicates ---------- */

/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** @param {unknown} v @returns {v is string} */
const isStr = (v) => typeof v === 'string' && v.length > 0;
/** @param {unknown} v @returns {v is Bag} */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** @param {unknown} v @returns {v is AltitudeReference} */
export const isAltitudeReference = (v) => typeof v === 'string' && ALTITUDE_REFERENCES.includes(v);
/** @param {unknown} v @returns {v is SegmentIntent} */
export const isSegmentIntent = (v) => typeof v === 'string' && SEGMENT_INTENTS.includes(v);
/** True for the intents that carry a dwell time. @param {string} intent */
export const intentHoldsStation = (intent) => HOLD_INTENTS.includes(/** @type {'hold'|'orbit'} */ (intent));

/* ---------- defaults ---------- */

/**
 * What a new segment flies at until the pilot says otherwise: 80 m above the
 * launch point, which is the level every plan this app has ever made flew
 * (src/windprofile.js CRUISE_ALT_DEFAULT_M). Unresolved on arrival — resolution
 * is src/domain/mission/altitude.js's job and needs a launch elevation.
 * @returns {Altitude}
 */
export const defaultAltitude = () => ({ authored: 80, reference: 'launchRelative', resolvedMslM: null });

/** @returns {SpeedPolicy} */
export const defaultSpeedPolicy = () => ({ mode: 'cruise', targetMs: null });

/** @returns {ReturnPolicy} */
export const defaultReturnPolicy = () => ({ mode: 'direct', altitude: null });

/**
 * The rail's own defaults, restated in domain terms and SI. Duplicated on
 * purpose rather than imported: src/state.js is the control surface, and a
 * domain module that reaches into it would invert the dependency the whole
 * milestone exists to establish. M1b passes the live rail values in explicitly.
 * @returns {PlanningPolicy}
 */
export const defaultPlanningPolicy = () => ({
  reserve: { landFloorPct: 20 }, gustFactor: 0.35, windLevel: 80, radioBand: '5g8',
});

/** @returns {EnvironmentReference} */
export const defaultEnvironmentReference = () => ({
  source: 'manual', presetId: null, capturedAt: null, values: null, provenance: null,
});

/** @returns {Provenance} */
export const defaultProvenance = () => ({
  createdBy: 'fpv-planner', appVersion: null, origin: 'authored', sourceFormat: null, notes: null,
});

/* ---------- snapshot builders ---------- */
//
// Snapshots, not references (ADR 0002): these take a live catalog record and
// keep the fields the model reads, so a later catalog edit cannot reach into a
// saved mission. Anything absent from a source record lands as null rather than
// as a fabricated number — a missing max continuous current is a fact the lift
// envelope already knows how to answer honestly.

/** @param {unknown} v @returns {number|null} */
const numOrNull = (v) => (isNum(v) ? v : null);

/**
 * @param {Bag} record a catalog or pilot-authored drone
 * @param {{ calibrated?: boolean }} [opts]
 * @returns {AircraftSnapshot}
 */
export function aircraftSnapshot(record, { calibrated = false } = {}) {
  return {
    sourceId: String(record.id ?? ''),
    name: String(record.name ?? ''),
    dryMassG: Number(record.dryMassG), propDiaIn: Number(record.propDiaIn),
    numRotors: Number(record.numRotors), ducted: record.ducted === true,
    etaProp: Number(record.etaProp), cdA: Number(record.cdA),
    avionicsW: Number(record.avionicsW), maxSpeedMs: Number(record.maxSpeedMs),
    cruiseMs: Number(record.cruiseMs),
    maxThrustGPerRotor: numOrNull(record.maxThrustGPerRotor),
    propulsion: isObj(record.propulsion) ? structuredClone(record.propulsion) : null,
    parallelHarnessMassG: numOrNull(record.parallelHarnessMassG) ?? 0,
    parallelPackCdA: numOrNull(record.parallelPackCdA) ?? 0,
    confidence: isStr(record.confidence) ? record.confidence : null,
    calibrated,
  };
}

/**
 * @param {Bag} record a pack as `loadoutBattery()` hands it over — instance
 *   overlay and parallel-pair arithmetic already applied
 * @returns {BatterySnapshot}
 */
export function batterySnapshot(record) {
  return {
    sourceId: String(record.id ?? ''), name: String(record.name ?? ''),
    chem: String(record.chem ?? ''), s: Number(record.s), p: numOrNull(record.p) ?? 1,
    capAh: Number(record.capAh), massG: Number(record.massG),
    irPackMilliOhm: Number(record.irPackMilliOhm),
    irTempC: numOrNull(record.irTempC), maxContA: numOrNull(record.maxContA),
    packCount: numOrNull(record.packCount) ?? 1, extraCdA: numOrNull(record.extraCdA) ?? 0,
    packInstance: isObj(record.packInstance) ? structuredClone(record.packInstance) : null,
  };
}

/**
 * @param {Bag} record a payload catalog entry
 * @param {{ extraG?: number }} [opts] ballast the rail carries beside the payload
 * @returns {PayloadSnapshot}
 */
export function payloadSnapshot(record, { extraG = 0 } = {}) {
  return {
    sourceId: String(record.id ?? ''), name: String(record.name ?? ''),
    massG: Number(record.massG), cdA: Number(record.cdA), extraG,
  };
}

/** Required-and-numeric fields per snapshot kind — what the validator insists on. */
const SNAPSHOT_NUMBERS = Object.freeze({
  aircraftSnapshot: ['dryMassG', 'propDiaIn', 'numRotors', 'etaProp', 'cdA', 'avionicsW', 'maxSpeedMs', 'cruiseMs'],
  batterySnapshot: ['s', 'capAh', 'massG', 'irPackMilliOhm', 'packCount'],
  payloadSnapshot: ['massG', 'cdA'],
});

/* ---------- construction ---------- */

/**
 * @typedef {object} MissionDeps
 * @property {(prefix: string) => string} [idgen]
 * @property {() => string} [now] ISO instant; injected so createdAt/updatedAt
 *   are deterministic under test
 */

/**
 * @typedef {object} CreateMissionOptions
 * @property {{ latitude: number, longitude: number, elevationMslM?: number|null }} launch
 * @property {string} [title]
 * @property {AircraftSnapshot|null} [aircraft]
 * @property {BatterySnapshot|null} [battery]
 * @property {PayloadSnapshot|null} [payload]
 * @property {EnvironmentReference} [environmentReference]
 * @property {Partial<PlanningPolicy>} [planningPolicy]
 * @property {ReturnPolicy} [returnPolicy]
 * @property {Partial<Provenance>} [provenance]
 */

/**
 * A fresh, empty, valid mission at a known launch point.
 *
 * `launch` is required and is the one thing this throws over. A mission with no
 * launch point cannot resolve a single launch-relative altitude, and defaulting
 * it to 0/0 would be precisely the "unknown becomes zero" failure ADR 0003
 * exists to forbid — better a TypeError at the call site than a plan for null
 * island.
 *
 * @param {CreateMissionOptions} opts
 * @param {MissionDeps} [deps]
 * @returns {MissionDocumentV1}
 */
export function createMission(opts, deps = {}) {
  const idgen = deps.idgen ?? defaultIdgen;
  const now = deps.now ?? (() => new Date().toISOString());
  const launch = opts?.launch;
  if (!launch || !isNum(launch.latitude) || !isNum(launch.longitude)) {
    throw new TypeError('createMission: launch { latitude, longitude } is required');
  }
  const at = now();
  return {
    schemaVersion: MISSION_SCHEMA_VERSION,
    id: idgen(ID_PREFIXES.mission),
    title: opts.title ?? 'Untitled mission',
    createdAt: at,
    updatedAt: at,
    launch: {
      latitude: launch.latitude,
      longitude: launch.longitude,
      elevationMslM: numOrNull(launch.elevationMslM),
    },
    aircraftSnapshot: opts.aircraft ?? null,
    batterySnapshot: opts.battery ?? null,
    payloadSnapshot: opts.payload ?? null,
    environmentReference: opts.environmentReference ?? defaultEnvironmentReference(),
    route: { waypoints: [], segments: [], returnPolicy: opts.returnPolicy ?? defaultReturnPolicy() },
    planningPolicy: { ...defaultPlanningPolicy(), ...opts.planningPolicy },
    scene: { subjects: [], cameraProfile: null, templates: [] },
    provenance: { ...defaultProvenance(), ...opts.provenance },
  };
}

/* ---------- validation ---------- */

/**
 * Judge an untrusted object against MissionDocumentV1.
 *
 * `errors` are structural: the document cannot be trusted to identify itself or
 * to hold together. `warnings` are completeness: it is intact but not ready for
 * analysis. Only errors clear `ok`. Both carry a dotted path so a caller can
 * point at the field that earned the message, the same way src/schema.js's
 * record validator does for a form.
 *
 * @param {unknown} doc
 * @returns {ValidationResult}
 */
export function validateMission(doc) {
  /** @type {ValidationIssue[]} */ const errors = [];
  /** @type {ValidationIssue[]} */ const warnings = [];
  /** @type {Report} */
  const err = (path, code, message) => { errors.push({ path, code, message }); };
  /** @type {Report} */
  const warn = (path, code, message) => { warnings.push({ path, code, message }); };

  if (!isObj(doc)) {
    err('', 'E-DOC-NOT-OBJECT', 'A mission must be a plain object.');
    return { ok: false, errors, warnings };
  }
  if (doc.schemaVersion !== MISSION_SCHEMA_VERSION) {
    err('schemaVersion', 'E-DOC-VERSION',
      `Expected schemaVersion ${MISSION_SCHEMA_VERSION}, got ${JSON.stringify(doc.schemaVersion)}.`);
  }
  if (!isStr(doc.id)) err('id', 'E-ID-MISSING', 'A mission needs a stable id.');
  else if (!doc.id.startsWith(`${ID_PREFIXES.mission}_`)) {
    warn('id', 'W-ID-PREFIX', `Mission ids are conventionally '${ID_PREFIXES.mission}_'-prefixed.`);
  }
  if (typeof doc.title !== 'string') err('title', 'E-TITLE-TYPE', 'Title must be text.');
  else if (doc.title.trim() === '') warn('title', 'W-TITLE-EMPTY', 'This mission has no title.');

  for (const key of ['createdAt', 'updatedAt']) {
    const v = doc[key];
    if (!isStr(v) || Number.isNaN(Date.parse(v))) {
      err(key, 'E-TIME-INVALID', `${key} must be an ISO instant.`);
    }
  }

  checkLaunch(doc.launch, err, warn);
  checkSnapshots(doc, err, warn);
  checkEnvironment(doc.environmentReference, err, warn);
  const subjectIds = checkScene(doc.scene, err, warn);
  checkRoute(doc.route, subjectIds, err, warn);
  checkPlanningPolicy(doc.planningPolicy, err);
  if (!isObj(doc.provenance)) err('provenance', 'E-PROV-MISSING', 'Provenance block is missing.');

  return { ok: errors.length === 0, errors, warnings };
}

/** @typedef {(path: string, code: string, message: string) => void} Report */

/** @param {unknown} launch @param {Report} err @param {Report} warn */
function checkLaunch(launch, err, warn) {
  if (!isObj(launch)) { err('launch', 'E-LAUNCH-MISSING', 'A mission needs a launch point.'); return; }
  if (!isNum(launch.latitude) || launch.latitude < -90 || launch.latitude > 90) {
    err('launch.latitude', 'E-GEO-RANGE', 'Launch latitude must be a number between -90 and 90.');
  }
  if (!isNum(launch.longitude) || launch.longitude < -180 || launch.longitude > 180) {
    err('launch.longitude', 'E-GEO-RANGE', 'Launch longitude must be a number between -180 and 180.');
  }
  if (launch.elevationMslM === null) {
    warn('launch.elevationMslM', 'W-LAUNCH-ELEV-UNKNOWN',
      'Launch elevation is unknown, so launch-relative altitudes cannot resolve.');
  } else if (!isNum(launch.elevationMslM)) {
    err('launch.elevationMslM', 'E-LAUNCH-ELEV-TYPE', 'Launch elevation must be a number of metres MSL, or null.');
  }
}

/** @param {Bag} doc @param {Report} err @param {Report} warn */
function checkSnapshots(doc, err, warn) {
  for (const [key, numbers] of Object.entries(SNAPSHOT_NUMBERS)) {
    const snap = doc[key];
    if (snap === null || snap === undefined) {
      warn(key, 'W-LOADOUT-MISSING', `No ${key.replace('Snapshot', '')} is attached to this mission.`);
      continue;
    }
    if (!isObj(snap)) { err(key, 'E-SNAPSHOT-TYPE', `${key} must be an embedded copy, not a reference.`); continue; }
    for (const field of numbers) {
      if (!isNum(snap[field])) {
        err(`${key}.${field}`, 'E-SNAPSHOT-FIELD', `${key}.${field} must be a number.`);
      }
    }
  }
}

/** @param {unknown} envRef @param {Report} err @param {Report} warn */
function checkEnvironment(envRef, err, warn) {
  if (!isObj(envRef)) {
    err('environmentReference', 'E-ENV-MISSING', 'Environment reference block is missing.');
    return;
  }
  if (typeof envRef.source !== 'string' || !ENVIRONMENT_SOURCES.includes(envRef.source)) {
    err('environmentReference.source', 'E-ENV-SOURCE',
      `Environment source must be one of ${ENVIRONMENT_SOURCES.join(', ')}.`);
  }
  if (envRef.source === 'preset' && !isStr(envRef.presetId)) {
    err('environmentReference.presetId', 'E-ENV-PRESET', 'A preset environment must name its preset.');
  }
  const values = envRef.values;
  if (values === null || values === undefined) {
    warn('environmentReference.values', 'W-ENV-UNRESOLVED', 'No weather values are attached yet.');
    return;
  }
  if (!isObj(values)) { err('environmentReference.values', 'E-ENV-VALUES', 'Weather values must be an object.'); return; }
  for (const field of ['temperatureC', 'relativeHumidityPct', 'windAvgMs', 'windGustMs', 'windFromDeg']) {
    if (!isNum(values[field])) {
      err(`environmentReference.values.${field}`, 'E-ENV-VALUE-TYPE', `${field} must be a number (SI).`);
    }
  }
}

/**
 * @param {unknown} scene @param {Report} err @param {Report} warn
 * @returns {Set<string>} the subject ids segments may point at
 */
function checkScene(scene, err, warn) {
  /** @type {Set<string>} */ const ids = new Set();
  if (!isObj(scene)) { err('scene', 'E-SCENE-MISSING', 'Scene block is missing.'); return ids; }
  if (!Array.isArray(scene.subjects)) {
    err('scene.subjects', 'E-SCENE-SUBJECTS', 'scene.subjects must be a list.');
    return ids;
  }
  scene.subjects.forEach((s, i) => {
    const path = `scene.subjects[${i}]`;
    if (!isObj(s)) { err(path, 'E-SUBJECT-TYPE', 'A subject must be an object.'); return; }
    if (!isStr(s.id)) { err(`${path}.id`, 'E-ID-MISSING', 'A subject needs a stable id.'); return; }
    if (ids.has(s.id)) err(`${path}.id`, 'E-ID-DUPLICATE', `Duplicate subject id '${s.id}'.`);
    ids.add(s.id);
    if (!isNum(s.latitude) || !isNum(s.longitude)) {
      err(path, 'E-GEO-RANGE', 'A subject needs a finite latitude and longitude.');
    }
    if (!isValidName(s.name)) {
      err(`${path}.name`, 'E-SUBJECT-NAME', `Subject name must be non-empty text of at most ${NAME_MAX_LEN} characters.`);
    }
    if (s.elevationMslM !== null && s.elevationMslM !== undefined && !isNum(s.elevationMslM)) {
      err(`${path}.elevationMslM`, 'E-SUBJECT-ELEVATION', 'Subject elevation must be a number of metres MSL, or null.');
    }
    if (s.radiusM !== null && s.radiusM !== undefined && !isNum(s.radiusM)) {
      err(`${path}.radiusM`, 'E-SUBJECT-RADIUS', 'Subject radius must be a number of metres, or null.');
    }
  });

  checkCameraProfile(scene.cameraProfile, 'scene.cameraProfile', err);

  // Missing entirely (an old, pre-M7 document) reads as [] — only a present,
  // non-list value is a structural error.
  if (scene.templates !== undefined) {
    if (!Array.isArray(scene.templates)) {
      err('scene.templates', 'E-TPL-LIST', 'scene.templates must be a list.');
    } else {
      /** @type {Set<string>} */ const tplIds = new Set();
      scene.templates.forEach((t, i) => {
        const path = `scene.templates[${i}]`;
        if (!isObj(t)) { err(path, 'E-TPL-TYPE', 'A template must be an object.'); return; }
        if (!isStr(t.id)) err(`${path}.id`, 'E-ID-MISSING', 'A template needs a stable id.');
        else if (tplIds.has(t.id)) err(`${path}.id`, 'E-ID-DUPLICATE', `Duplicate template id '${t.id}'.`);
        else tplIds.add(t.id);

        if (!isValidName(t.name)) {
          err(`${path}.name`, 'E-TPL-NAME', `Template name must be non-empty text of at most ${NAME_MAX_LEN} characters.`);
        }

        if (!isSegmentIntent(t.intent)) {
          err(`${path}.intent`, 'E-TPL-INTENT', `Intent must be one of ${SEGMENT_INTENTS.join(', ')}.`);
        } else if (intentHoldsStation(t.intent)) {
          if (t.holdS === null || t.holdS === undefined) {
            warn(`${path}.holdS`, 'W-TPL-HOLD-UNKNOWN', `A '${t.intent}' template has no dwell time yet.`);
          } else if (!isNum(t.holdS) || t.holdS < 0) {
            err(`${path}.holdS`, 'E-TPL-HOLD', 'Dwell time must be a non-negative number of seconds.');
          }
        } else if (t.holdS !== null && t.holdS !== undefined) {
          err(`${path}.holdS`, 'E-TPL-HOLD', `A '${t.intent}' template cannot carry a dwell time.`);
        }

        checkCameraShape(t.camera, t.intent, `${path}.camera`, 'E-TPL-CAMERA', err);
      });
    }
  }

  return ids;
}

/** @param {unknown} policy @param {Report} err */
function checkPlanningPolicy(policy, err) {
  if (!isObj(policy)) { err('planningPolicy', 'E-POLICY-MISSING', 'Planning policy block is missing.'); return; }
  const reserve = policy.reserve;
  if (!isObj(reserve) || !isNum(reserve.landFloorPct) || reserve.landFloorPct < 0 || reserve.landFloorPct > 100) {
    err('planningPolicy.reserve.landFloorPct', 'E-POLICY-RESERVE',
      'The pack-care floor must be a percentage between 0 and 100.');
  }
  if (!isNum(policy.gustFactor) || policy.gustFactor < 0 || policy.gustFactor > 1) {
    err('planningPolicy.gustFactor', 'E-POLICY-GUST', 'Gust factor must be a fraction between 0 and 1.');
  }
  if (!isNum(policy.windLevel) || policy.windLevel <= 0) {
    err('planningPolicy.windLevel', 'E-POLICY-WINDLEVEL', 'Wind level must be a positive height in metres AGL.');
  }
  if (!isStr(policy.radioBand)) {
    err('planningPolicy.radioBand', 'E-POLICY-BAND', 'A radio band id is required.');
  }
}

/**
 * The route, and the chain invariant everything else leans on:
 * `segments[i].to === waypoints[i].id`, with `segments[i].from` the node before
 * it — the launch node for the first leg, the previous waypoint after that.
 *
 * @param {unknown} route @param {Set<string>} subjectIds @param {Report} err @param {Report} warn
 */
function checkRoute(route, subjectIds, err, warn) {
  if (!isObj(route)) { err('route', 'E-ROUTE-MISSING', 'Route block is missing.'); return; }
  const waypoints = route.waypoints;
  const segments = route.segments;
  if (!Array.isArray(waypoints)) { err('route.waypoints', 'E-ROUTE-WAYPOINTS', 'route.waypoints must be a list.'); return; }
  if (!Array.isArray(segments)) { err('route.segments', 'E-ROUTE-SEGMENTS', 'route.segments must be a list.'); return; }

  /** @type {Set<string>} */ const wpIds = new Set();
  waypoints.forEach((w, i) => {
    const path = `route.waypoints[${i}]`;
    if (!isObj(w)) { err(path, 'E-WAYPOINT-TYPE', 'A waypoint must be an object.'); return; }
    if (!isStr(w.id)) { err(`${path}.id`, 'E-ID-MISSING', 'A waypoint needs a stable id.'); return; }
    if (w.id === LAUNCH_NODE) err(`${path}.id`, 'E-ID-RESERVED', `'${LAUNCH_NODE}' is the reserved launch node id.`);
    if (wpIds.has(w.id)) err(`${path}.id`, 'E-ID-DUPLICATE', `Duplicate waypoint id '${w.id}'.`);
    wpIds.add(w.id);
    if (!isNum(w.latitude) || w.latitude < -90 || w.latitude > 90
      || !isNum(w.longitude) || w.longitude < -180 || w.longitude > 180) {
      err(path, 'E-GEO-RANGE', 'A waypoint needs a latitude in -90..90 and a longitude in -180..180.');
    }
  });

  if (segments.length !== waypoints.length) {
    err('route.segments', 'E-SEG-CHAIN',
      `The route has ${waypoints.length} waypoint(s) but ${segments.length} segment(s); one segment ends at each waypoint.`);
  }

  /** @type {Set<string>} */ const segIds = new Set();
  segments.forEach((s, i) => {
    const path = `route.segments[${i}]`;
    if (!isObj(s)) { err(path, 'E-SEGMENT-TYPE', 'A segment must be an object.'); return; }
    if (!isStr(s.id)) err(`${path}.id`, 'E-ID-MISSING', 'A segment needs a stable id.');
    else if (segIds.has(s.id)) err(`${path}.id`, 'E-ID-DUPLICATE', `Duplicate segment id '${s.id}'.`);
    else segIds.add(s.id);

    const expectedFrom = i === 0 ? LAUNCH_NODE : /** @type {Bag} */ (waypoints[i - 1])?.id;
    const expectedTo = /** @type {Bag} */ (waypoints[i])?.id;
    if (typeof s.from !== 'string' || (s.from !== LAUNCH_NODE && !wpIds.has(s.from))) {
      err(`${path}.from`, 'E-SEG-REF', `Segment starts at '${String(s.from)}', which is not a node on this route.`);
    } else if (expectedFrom !== undefined && s.from !== expectedFrom) {
      err(`${path}.from`, 'E-SEG-CHAIN', `Segment ${i} should start at '${String(expectedFrom)}'.`);
    }
    if (typeof s.to !== 'string' || !wpIds.has(s.to)) {
      err(`${path}.to`, 'E-SEG-REF', `Segment ends at '${String(s.to)}', which is not a waypoint on this route.`);
    } else if (expectedTo !== undefined && s.to !== expectedTo) {
      err(`${path}.to`, 'E-SEG-CHAIN', `Segment ${i} should end at waypoint '${String(expectedTo)}'.`);
    }

    checkAltitude(s.altitude, `${path}.altitude`, err, warn);
    checkSpeedPolicy(s.speedPolicy, `${path}.speedPolicy`, err);

    if (!isSegmentIntent(s.intent)) {
      err(`${path}.intent`, 'E-SEG-INTENT', `Intent must be one of ${SEGMENT_INTENTS.join(', ')}.`);
    } else if (intentHoldsStation(s.intent)) {
      if (s.holdS === null || s.holdS === undefined) {
        warn(`${path}.holdS`, 'W-SEG-HOLD-UNKNOWN', `A '${s.intent}' segment has no dwell time yet.`);
      } else if (!isNum(s.holdS) || s.holdS < 0) {
        err(`${path}.holdS`, 'E-SEG-HOLD', 'Dwell time must be a non-negative number of seconds.');
      }
    } else if (s.holdS !== null && s.holdS !== undefined) {
      err(`${path}.holdS`, 'E-SEG-HOLD', `A '${s.intent}' segment cannot carry a dwell time.`);
    }

    if (s.subjectRef !== null && s.subjectRef !== undefined) {
      if (!isStr(s.subjectRef) || !subjectIds.has(s.subjectRef)) {
        err(`${path}.subjectRef`, 'E-SEG-SUBJECT',
          `Segment points at subject '${String(s.subjectRef)}', which is not in the scene.`);
      }
    }
    checkCameraShape(s.camera, s.intent, `${path}.camera`, 'E-SEG-CAMERA', err);
    if (s.overrides !== null && s.overrides !== undefined && !isObj(s.overrides)) {
      err(`${path}.overrides`, 'E-SEG-BAG', 'overrides must be an object or null.');
    }
  });

  const rp = route.returnPolicy;
  if (!isObj(rp)) { err('route.returnPolicy', 'E-RETURN-MISSING', 'Return policy is missing.'); return; }
  if (typeof rp.mode !== 'string' || !RETURN_MODES.includes(rp.mode)) {
    err('route.returnPolicy.mode', 'E-RETURN-MODE', `Return mode must be one of ${RETURN_MODES.join(', ')}.`);
  }
  if (rp.altitude !== null && rp.altitude !== undefined) {
    checkAltitude(rp.altitude, 'route.returnPolicy.altitude', err, warn);
  }
}

/** @param {unknown} alt @param {string} path @param {Report} err @param {Report} warn */
function checkAltitude(alt, path, err, warn) {
  if (!isObj(alt)) { err(path, 'E-ALT-MISSING', 'An altitude block is required.'); return; }
  if (!isNum(alt.authored)) err(`${path}.authored`, 'E-ALT-AUTHORED', 'Authored altitude must be a number of metres.');
  if (!isAltitudeReference(alt.reference)) {
    err(`${path}.reference`, 'E-ALT-REFERENCE', `Altitude reference must be one of ${ALTITUDE_REFERENCES.join(', ')}.`);
  }
  if (alt.resolvedMslM === null || alt.resolvedMslM === undefined) {
    warn(`${path}.resolvedMslM`, 'W-ALT-UNRESOLVED', 'This altitude has not been resolved to metres MSL.');
  } else if (!isNum(alt.resolvedMslM)) {
    err(`${path}.resolvedMslM`, 'E-ALT-RESOLVED', 'Resolved altitude must be a number of metres MSL, or null.');
  }
}

/** @param {unknown} policy @param {string} path @param {Report} err */
function checkSpeedPolicy(policy, path, err) {
  if (!isObj(policy)) { err(path, 'E-SPEED-MISSING', 'A speed policy is required.'); return; }
  if (typeof policy.mode !== 'string' || !SPEED_MODES.includes(policy.mode)) {
    err(`${path}.mode`, 'E-SPEED-MODE', `Speed mode must be one of ${SPEED_MODES.join(', ')}.`);
    return;
  }
  if (policy.mode === 'fixed') {
    if (!isNum(policy.targetMs) || policy.targetMs <= 0) {
      err(`${path}.targetMs`, 'E-SPEED-TARGET', 'A fixed-speed segment needs a positive target in m/s.');
    }
  } else if (policy.targetMs !== null && policy.targetMs !== undefined && !isNum(policy.targetMs)) {
    err(`${path}.targetMs`, 'E-SPEED-TARGET', 'Target speed must be a number of m/s, or null.');
  }
}
