// mission-reducer.js — the only way a mission document changes (ADR 0002).
//
// `(document, command) → new document`. Pure: no storage, no fetch, no clock of
// its own (`deps.now` supplies the instant), no id source of its own
// (`deps.idgen` supplies identity). The input document is never mutated —
// unchanged branches are shared by reference, so an undo stack can hold every
// version of a route without holding N copies of the loadout snapshots.
//
// Two rules make the whole file predictable:
//
//   **a rejected command changes nothing.** Unknown type, malformed payload, a
//     waypoint id that isn't on this route, an intent outside the enum — every
//     one of them returns the *same document object* the caller passed in
//     (`result === doc` is a legitimate test for "nothing happened") and
//     reports a warning through `deps.onWarning`. Throwing was the alternative;
//     it would mean a mistyped field in the segment inspector takes down the
//     planner, and a field tool does not get to do that.
//
//   **the reducer never hands back an invalid document.** Every candidate is
//     run past `validateMission` before it is returned, and a command that
//     would introduce a *new* structural error is rejected with that error's
//     own code and message. Errors the document already carried are not held
//     against the command — a document that arrived broken can still be edited
//     back into shape, which matters because the alternative is a mission a
//     pilot cannot fix.
//
// Warnings travel by sink rather than by return value because the signature is
// a frozen contract: `missionReduce` returns a document, full stop, so no
// caller ever has to unwrap `{ doc, warnings }` to get at their mission. The
// sink is injected like the clock and the id source:
//
//     const warnings = [];
//     const next = missionReduce(doc, cmd, { now, idgen, onWarning: w => warnings.push(w) });
//
// A command is `{ type, payload }`. The launch point is not a waypoint (see
// mission-schema.js): segments chain `launch → wpt₁ → … → wptₙ`, one per
// waypoint, and `segments[i].to === waypoints[i].id` is the invariant every
// handler here preserves and the validator re-checks on the way out.

import {
  ID_PREFIXES, LAUNCH_NODE, SEGMENT_INTENTS, SPEED_MODES, RETURN_MODES, ENVIRONMENT_SOURCES,
  defaultAltitude, defaultIdgen, defaultSpeedPolicy,
  isAltitudeReference, isSegmentIntent, intentHoldsStation, validateMission,
} from './mission-schema.js';
// The M7 wave B cinematic-bag commands (ADR 0011 §2) are filed separately —
// this reducer crossed its own modularity note's ~700-line mark once they
// were added inline. `Rejection`/`reject` are imported rather than defined
// twice: `missionReduce`'s catch below needs the one class identity every
// handler's rejection is an instance of, native or scene alike.
import { Rejection, reject, SCENE_HANDLERS } from './scene-commands.js';
// The M16 dive-plan commands (`scene.dive`), filed the same way.
import { DIVE_HANDLERS } from './dive-commands.js';

/** @typedef {import('./mission-schema.js').MissionDocumentV1} MissionDocumentV1 */
/** @typedef {import('./mission-schema.js').Altitude} Altitude */
/** @typedef {import('./mission-schema.js').Segment} Segment */
/** @typedef {import('./mission-schema.js').Waypoint} Waypoint */
/** @typedef {import('./mission-schema.js').SpeedPolicy} SpeedPolicy */
/** @typedef {{ [key: string]: unknown }} Bag */

/**
 * What the reducer says when it declines to do something.
 * @typedef {object} MissionWarning
 * @property {string} code     W-CMD-UNKNOWN | W-CMD-MALFORMED | W-CMD-REJECTED
 * @property {string} command  the command type, or '' when there wasn't one
 * @property {string|null} path dotted path into the document, when one applies
 * @property {string} message
 */

/**
 * @typedef {object} ReducerDeps
 * @property {(prefix: string) => string} [idgen]
 * @property {() => string} [now] ISO instant stamped onto updatedAt
 * @property {(warning: MissionWarning) => void} [onWarning]
 */

/** @typedef {{ type?: unknown, payload?: unknown }} MissionCommand */

/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** @param {unknown} v @returns {v is string} */
const isStr = (v) => typeof v === 'string' && v.length > 0;
/** @param {unknown} v @returns {v is Bag} */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} lat @param {unknown} lon */
const isLatLon = (lat, lon) => isNum(lat) && lat >= -90 && lat <= 90 && isNum(lon) && lon >= -180 && lon <= 180;

/**
 * Every command type this reducer answers to. Exported so the UI layer and the
 * tests read from the same list rather than from a comment.
 * @type {readonly string[]}
 */
export const MISSION_COMMANDS = Object.freeze([
  'setTitle', 'setLaunch',
  'addWaypoint', 'moveWaypoint', 'removeWaypoint',
  'setSegmentAltitude', 'setSegmentSpeed', 'setSegmentIntent',
  'setReturnPolicy', 'setPlanningPolicy',
  'snapshotLoadout', 'setEnvironmentReference',
  // ADR 0011 §2 (M7 wave B) — the cinematic bags' own commands.
  'addSubject', 'moveSubject', 'removeSubject',
  'setSegmentCamera', 'setSegmentSubject', 'setSegmentHold',
  'setCameraProfile', 'saveSceneTemplate', 'applySceneTemplate', 'removeSceneTemplate',
  // M16 — the mountain-dive plan's own commands.
  'setDiveGate', 'removeDiveGate', 'setDiveBailout', 'setDiveRthAltitude', 'setDiveProfile',
]);

/* ---------- handlers ---------- */
//
// A handler receives the document and its payload and returns the next
// document *without* touching `updatedAt` — the stamp is applied centrally so
// no handler can forget it. To decline, a handler calls `reject()`.

/** @typedef {{ idgen: (prefix: string) => string }} HandlerCtx */
/** @typedef {(doc: MissionDocumentV1, payload: Bag, ctx: HandlerCtx) => MissionDocumentV1} Handler */

/**
 * Clearing a resolved altitude is how this file says "the ground under this
 * changed" — the MSL figure is dropped so altitude.js re-derives it, rather
 * than left in place to quietly describe a point the aircraft no longer flies
 * over (ADR 0003).
 *
 * @param {Segment} seg
 * @param {(reference: string) => boolean} matches
 * @returns {Segment}
 */
function unresolveIf(seg, matches) {
  if (seg.altitude?.resolvedMslM == null || !matches(seg.altitude.reference)) return seg;
  return { ...seg, altitude: { ...seg.altitude, resolvedMslM: null } };
}

/** @param {MissionDocumentV1} doc @param {Segment[]} segments @param {Waypoint[]} [waypoints] */
const withRoute = (doc, segments, waypoints = doc.route.waypoints) =>
  ({ ...doc, route: { ...doc.route, waypoints, segments } });

/** @param {unknown} v @returns {SpeedPolicy} */
function readSpeedPolicy(v) {
  if (!isObj(v)) reject('A speed policy must be an object.', 'speedPolicy');
  const mode = /** @type {Bag} */ (v).mode;
  if (typeof mode !== 'string' || !SPEED_MODES.includes(mode)) {
    reject(`Speed mode must be one of ${SPEED_MODES.join(', ')}.`, 'speedPolicy.mode');
  }
  const targetMs = /** @type {Bag} */ (v).targetMs;
  if (mode === 'fixed' && (!isNum(targetMs) || targetMs <= 0)) {
    reject('A fixed-speed segment needs a positive target speed in m/s.', 'speedPolicy.targetMs');
  }
  return {
    mode: /** @type {SpeedPolicy['mode']} */ (mode),
    targetMs: isNum(targetMs) ? targetMs : null,
  };
}

/** @param {unknown} v @param {string} path @returns {Altitude} */
function readAltitude(v, path) {
  if (!isObj(v)) reject('An altitude must be an object.', path);
  const alt = /** @type {Bag} */ (v);
  if (!isNum(alt.authored)) reject('Authored altitude must be a number of metres.', `${path}.authored`);
  if (!isAltitudeReference(alt.reference)) {
    reject('Altitude reference must be launchRelative, agl, or msl.', `${path}.reference`);
  }
  // Always unresolved on the way in: whoever authors a height does not get to
  // assert what it is in MSL. altitude.js is the only writer of that field.
  return {
    authored: /** @type {number} */ (alt.authored),
    reference: /** @type {Altitude['reference']} */ (alt.reference),
    resolvedMslM: null,
  };
}

/**
 * @param {MissionDocumentV1} doc @param {unknown} segmentId
 * @returns {{ index: number, segment: Segment }}
 */
function findSegment(doc, segmentId) {
  if (!isStr(segmentId)) reject('A segment id is required.', 'segmentId');
  const index = doc.route.segments.findIndex((s) => s.id === segmentId);
  if (index === -1) reject(`No segment '${String(segmentId)}' on this route.`, 'segmentId');
  return { index, segment: /** @type {Segment} */ (doc.route.segments[index]) };
}

/** @type {Record<string, Handler>} */
const HANDLERS = {
  setTitle(doc, payload) {
    const title = payload.title;
    if (typeof title !== 'string') reject('Title must be text.', 'title');
    return { ...doc, title: /** @type {string} */ (title) };
  },

  /**
   * Route-preserving, and that is the whole point of it (ADR 0002): waypoints
   * keep their absolute coordinates when the launch pin moves. The old map
   * behaviour — moving the launch throws the route away — is dead. A pilot
   * nudging the launch pin 40 m to the actual parking spot was never asking to
   * delete the four waypoints they had just drawn.
   *
   * What does change is what is *known*. The new site's elevation is not the
   * old site's, so unless the caller supplies one the elevation goes to null
   * and every launch-relative altitude drops its resolved MSL figure. AGL
   * altitudes drop theirs too: this app's terrain snapshot is anchored on the
   * launch point, so moving the launch invalidates the samples that resolved
   * them. Both are re-derived by altitude.js against fresh data; neither is
   * left holding a number that describes a place the aircraft is no longer
   * launching from.
   */
  setLaunch(doc, payload) {
    const { latitude, longitude } = payload;
    if (!isLatLon(latitude, longitude)) {
      reject('A launch point needs a latitude in -90..90 and a longitude in -180..180.', 'launch');
    }
    const elevationMslM = 'elevationMslM' in payload
      ? (payload.elevationMslM === null ? null
        : isNum(payload.elevationMslM) ? payload.elevationMslM
          : reject('Launch elevation must be a number of metres MSL, or null.', 'launch.elevationMslM'))
      : null;
    const segments = doc.route.segments.map(
      (s) => unresolveIf(s, (ref) => ref === 'launchRelative' || ref === 'agl'));
    const rp = doc.route.returnPolicy;
    const returnPolicy = rp.altitude && rp.altitude.resolvedMslM != null && rp.altitude.reference !== 'msl'
      ? { ...rp, altitude: { ...rp.altitude, resolvedMslM: null } }
      : rp;
    return {
      ...doc,
      launch: {
        latitude: /** @type {number} */ (latitude),
        longitude: /** @type {number} */ (longitude),
        elevationMslM,
      },
      route: { ...doc.route, segments, returnPolicy },
    };
  },

  /**
   * Appends a waypoint and the segment that reaches it. Append-only on purpose:
   * inserting mid-route is a different editing gesture with its own question
   * (which of the two new legs inherits the old leg's altitude and intent?),
   * and answering it silently here would be worse than not offering it. M2 can
   * add `insertWaypoint` with that answer written down.
   */
  addWaypoint(doc, payload, ctx) {
    const { latitude, longitude } = payload;
    if (!isLatLon(latitude, longitude)) {
      reject('A waypoint needs a latitude in -90..90 and a longitude in -180..180.', 'latitude/longitude');
    }
    const intent = payload.intent === undefined ? 'transit' : payload.intent;
    if (!isSegmentIntent(intent)) reject(`Intent must be one of ${SEGMENT_INTENTS.join(', ')}.`, 'intent');
    const holds = intentHoldsStation(intent);
    if (!holds && payload.holdS != null) {
      reject(`A '${intent}' segment cannot carry a dwell time.`, 'holdS');
    }
    if (holds && payload.holdS != null && (!isNum(payload.holdS) || payload.holdS < 0)) {
      reject('Dwell time must be a non-negative number of seconds.', 'holdS');
    }

    /** @type {Waypoint} */
    const waypoint = {
      id: ctx.idgen(ID_PREFIXES.waypoint),
      latitude: /** @type {number} */ (latitude),
      longitude: /** @type {number} */ (longitude),
    };
    const tail = doc.route.waypoints[doc.route.waypoints.length - 1];
    /** @type {Segment} */
    const segment = {
      id: ctx.idgen(ID_PREFIXES.segment),
      from: tail ? tail.id : LAUNCH_NODE,
      to: waypoint.id,
      altitude: payload.altitude === undefined ? defaultAltitude() : readAltitude(payload.altitude, 'altitude'),
      speedPolicy: payload.speedPolicy === undefined ? defaultSpeedPolicy() : readSpeedPolicy(payload.speedPolicy),
      intent,
      holdS: holds && isNum(payload.holdS) ? payload.holdS : null,
      subjectRef: null,
      camera: null,
      overrides: null,
    };
    return withRoute(doc, [...doc.route.segments, segment], [...doc.route.waypoints, waypoint]);
  },

  /**
   * Moves a waypoint and nothing else. The inbound segment's AGL altitude
   * loses its resolved figure — the ground under the arrival point is different
   * ground now — while launch-relative and MSL heights are untouched, because
   * neither depends on where in the world the point is.
   */
  moveWaypoint(doc, payload) {
    const { id, latitude, longitude } = payload;
    if (!isStr(id)) reject('A waypoint id is required.', 'id');
    const index = doc.route.waypoints.findIndex((w) => w.id === id);
    if (index === -1) reject(`No waypoint '${String(id)}' on this route.`, 'id');
    if (!isLatLon(latitude, longitude)) {
      reject('A waypoint needs a latitude in -90..90 and a longitude in -180..180.', 'latitude/longitude');
    }
    const waypoints = doc.route.waypoints.map((w, i) => (i === index
      ? { ...w, latitude: /** @type {number} */ (latitude), longitude: /** @type {number} */ (longitude) }
      : w));
    const segments = doc.route.segments.map(
      (s) => (s.to === id ? unresolveIf(s, (ref) => ref === 'agl') : s));
    return withRoute(doc, segments, waypoints);
  },

  /**
   * Removes a waypoint and repairs the chain. The segment that *ended* at this
   * waypoint goes with it — that is forced by the invariant, since segment i is
   * the leg arriving at waypoint i — and the following segment is re-anchored
   * to whatever now precedes it: the previous waypoint, or the launch node when
   * the first waypoint is the one being dropped. Every surviving segment keeps
   * its id, its altitude and its intent.
   */
  removeWaypoint(doc, payload) {
    const { id } = payload;
    if (!isStr(id)) reject('A waypoint id is required.', 'id');
    const index = doc.route.waypoints.findIndex((w) => w.id === id);
    if (index === -1) reject(`No waypoint '${String(id)}' on this route.`, 'id');

    const waypoints = doc.route.waypoints.filter((_, i) => i !== index);
    const segments = doc.route.segments.filter((_, i) => i !== index);
    const successor = segments[index];
    if (successor) {
      const previous = waypoints[index - 1];
      segments[index] = { ...successor, from: previous ? previous.id : LAUNCH_NODE };
    }
    return withRoute(doc, segments, waypoints);
  },

  setSegmentAltitude(doc, payload) {
    const { index, segment } = findSegment(doc, payload.segmentId);
    const altitude = readAltitude(payload, 'altitude');
    const segments = [...doc.route.segments];
    segments[index] = { ...segment, altitude };
    return withRoute(doc, segments);
  },

  setSegmentSpeed(doc, payload) {
    const { index, segment } = findSegment(doc, payload.segmentId);
    const speedPolicy = readSpeedPolicy(payload.speedPolicy);
    const segments = [...doc.route.segments];
    segments[index] = { ...segment, speedPolicy };
    return withRoute(doc, segments);
  },

  /**
   * A dwell time is meaningful for exactly two intents. Setting a segment to
   * `hold` keeps whatever duration it already had (re-typing it after a
   * mis-click is not a thing anyone should have to do); setting it to anything
   * else drops the duration rather than leaving an orphan number for a later
   * exporter to find and believe.
   *
   * The camera's orbit bag gets the same treatment for the same reason: it is
   * meaningful only on intent 'orbit' (E-SEG-CAMERA-ORBIT), so leaving that
   * intent drops it — otherwise the orphaned radius would make this very
   * command fail validation, and the only way out of 'orbit' would be to
   * remember to clear the radius first. Pitch and yaw survive; they mean the
   * same thing on every camera intent.
   */
  setSegmentIntent(doc, payload) {
    const { index, segment } = findSegment(doc, payload.segmentId);
    const intent = payload.intent;
    if (!isSegmentIntent(intent)) reject(`Intent must be one of ${SEGMENT_INTENTS.join(', ')}.`, 'intent');
    const holds = intentHoldsStation(intent);
    if (!holds && payload.holdS != null) {
      reject(`A '${intent}' segment cannot carry a dwell time.`, 'holdS');
    }
    if (holds && payload.holdS != null && (!isNum(payload.holdS) || payload.holdS < 0)) {
      reject('Dwell time must be a non-negative number of seconds.', 'holdS');
    }
    const holdS = !holds ? null
      : isNum(payload.holdS) ? payload.holdS
        : (segment.holdS ?? null);
    const camera = intent !== 'orbit' && segment.camera?.orbit != null
      ? { ...segment.camera, orbit: null }
      : (segment.camera ?? null);
    const segments = [...doc.route.segments];
    segments[index] = { ...segment, intent, holdS, camera };
    return withRoute(doc, segments);
  },

  setReturnPolicy(doc, payload) {
    const mode = payload.mode;
    if (typeof mode !== 'string' || !RETURN_MODES.includes(mode)) {
      reject(`Return mode must be one of ${RETURN_MODES.join(', ')}.`, 'mode');
    }
    const altitude = payload.altitude == null ? null : readAltitude(payload.altitude, 'altitude');
    return {
      ...doc,
      route: {
        ...doc.route,
        returnPolicy: { mode: /** @type {'direct'|'retrace'|'none'} */ (mode), altitude },
      },
    };
  },

  /**
   * A patch, not a replacement: the rail changes one knob at a time, and
   * demanding all four back on every gust-factor nudge is how a control surface
   * loses a setting nobody was editing. The merged result still has to validate,
   * so a patch cannot smuggle a bad reserve past the contract.
   */
  setPlanningPolicy(doc, payload) {
    const reserve = payload.reserve === undefined
      ? doc.planningPolicy.reserve
      : (isObj(payload.reserve)
        ? { ...doc.planningPolicy.reserve, ...payload.reserve }
        : reject('reserve must be an object.', 'reserve'));
    return {
      ...doc,
      planningPolicy: {
        ...doc.planningPolicy,
        ...payload,
        reserve: /** @type {{ landFloorPct: number }} */ (reserve),
      },
    };
  },

  /**
   * Snapshots, not references (ADR 0002). Each record is deep-copied on the way
   * in, so a later catalog edit — or a pack instance the pilot re-measures next
   * week — cannot reach backwards into a mission that was already planned and
   * saved. Passing `null` for a slot clears it; omitting the key leaves it be.
   */
  snapshotLoadout(doc, payload) {
    /** @type {Partial<MissionDocumentV1>} */ const patch = {};
    for (const [key, field] of /** @type {const} */ ([
      ['aircraft', 'aircraftSnapshot'], ['battery', 'batterySnapshot'], ['payload', 'payloadSnapshot'],
    ])) {
      if (!(key in payload)) continue;
      const value = payload[key];
      if (value === null) { patch[field] = null; continue; }
      if (!isObj(value)) reject(`${key} must be an embedded record object, or null.`, key);
      patch[field] = /** @type {never} */ (structuredClone(value));
    }
    return { ...doc, ...patch };
  },

  setEnvironmentReference(doc, payload) {
    const source = payload.source;
    if (typeof source !== 'string' || !ENVIRONMENT_SOURCES.includes(source)) {
      reject(`Environment source must be one of ${ENVIRONMENT_SOURCES.join(', ')}.`, 'source');
    }
    // A full replacement with the absent keys spelled out, rather than a merge:
    // "live weather, no values yet" and "the preset I picked an hour ago" must
    // not be able to blend into a record that claims both.
    return {
      ...doc,
      environmentReference: {
        source: /** @type {'live'|'preset'|'manual'} */ (source),
        presetId: isStr(payload.presetId) ? payload.presetId : null,
        capturedAt: isStr(payload.capturedAt) ? payload.capturedAt : null,
        values: isObj(payload.values) ? /** @type {never} */ (structuredClone(payload.values)) : null,
        provenance: isObj(payload.provenance) ? structuredClone(payload.provenance) : null,
      },
    };
  },

  // ADR 0011 §2 (M7 wave B): subjects, shot geometry, templates — scene-commands.js.
  ...SCENE_HANDLERS,
  ...DIVE_HANDLERS,
};

/* ---------- the reducer ---------- */

/**
 * Apply one command to a mission.
 *
 * Returns a new document on success, and the *same* document object on
 * rejection — so `next === doc` means the command did nothing, and every
 * rejection is explained through `deps.onWarning`.
 *
 * @param {MissionDocumentV1} doc
 * @param {MissionCommand} command
 * @param {ReducerDeps} [deps]
 * @returns {MissionDocumentV1}
 */
export function missionReduce(doc, command, deps = {}) {
  const idgen = deps.idgen ?? defaultIdgen;
  const now = deps.now ?? (() => new Date().toISOString());
  /** @param {string} code @param {string} message @param {string} [type] @param {string|null} [path] */
  const warn = (code, message, type = '', path = null) => {
    deps.onWarning?.({ code, command: type, path, message });
    return doc;
  };

  if (!isObj(command) || typeof command.type !== 'string') {
    return warn('W-CMD-MALFORMED', 'A command must be an object with a string `type`.');
  }
  const type = command.type;
  // Own-property lookup: `'toString'` or `'__proto__'` as a command type must
  // hit the unknown branch, not the prototype chain.
  const handler = Object.hasOwn(HANDLERS, type) ? HANDLERS[type] : undefined;
  if (!handler) {
    return warn('W-CMD-UNKNOWN',
      `'${type}' is not a mission command. Known commands: ${MISSION_COMMANDS.join(', ')}.`, type);
  }
  const payload = isObj(command.payload) ? command.payload : {};

  let candidate;
  try {
    candidate = handler(doc, payload, { idgen });
  } catch (e) {
    if (e instanceof Rejection) return warn('W-CMD-REJECTED', e.message, type, e.path);
    throw e;
  }

  // The contract check. Only errors this command *introduced* count against it:
  // a document that arrived with a hole in it stays editable, which is the
  // difference between a mission a pilot can repair and one they cannot open.
  const verdict = validateMission(candidate);
  if (!verdict.ok) {
    const before = new Set(validateMission(doc).errors.map((e) => `${e.path}|${e.code}`));
    const introduced = verdict.errors.filter((e) => !before.has(`${e.path}|${e.code}`));
    if (introduced.length) {
      const first = /** @type {import('./mission-schema.js').ValidationIssue} */ (introduced[0]);
      return warn('W-CMD-REJECTED', first.message, type, first.path);
    }
  }

  return { ...candidate, updatedAt: now() };
}
