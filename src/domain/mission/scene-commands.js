// scene-commands.js — the M7 wave B reducer commands for the reserved
// cinematic bags (ADR 0011 §2): `scene.subjects`, `segment.camera`,
// `scene.cameraProfile`, `scene.templates[]`. Split out of mission-reducer.js
// once the reducer crossed the file's own ~700-line modularity note — same
// envelope, same two rules ("a rejected command changes nothing", "the
// reducer never hands back an invalid document"), just filed separately so
// mission-reducer.js stays the dozen commands M2 shipped plus wiring.
//
// `Rejection`/`reject()` live here rather than being duplicated in
// mission-reducer.js: `missionReduce`'s single dispatch loop (mission-reducer.js)
// tells a declined command apart from a real bug with one `instanceof
// Rejection` check, and two distinct classes of the same name would silently
// break that check for every command in this file. mission-reducer.js imports
// both from here instead of defining its own.

import {
  ID_PREFIXES, SEGMENT_INTENTS, isSegmentIntent, intentHoldsStation,
} from './mission-schema.js';
import { isValidName, sanitizeName, checkCameraShape, checkCameraProfile } from './scene-schema.js';

/** @typedef {import('./mission-schema.js').MissionDocumentV1} MissionDocumentV1 */
/** @typedef {import('./mission-schema.js').Segment} Segment */
/** @typedef {import('./mission-schema.js').Subject} Subject */
/** @typedef {import('./mission-schema.js').SegmentCamera} SegmentCamera */
/** @typedef {import('./mission-schema.js').CameraProfile} CameraProfile */
/** @typedef {import('./mission-schema.js').SceneTemplate} SceneTemplate */
/** @typedef {import('./mission-schema.js').ValidationIssue} ValidationIssue */
/** @typedef {{ [key: string]: unknown }} Bag */
/** @typedef {{ idgen: (prefix: string) => string }} HandlerCtx */
/** @typedef {(doc: MissionDocumentV1, payload: Bag, ctx: HandlerCtx) => MissionDocumentV1} Handler */

/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** @param {unknown} v @returns {v is string} */
const isStr = (v) => typeof v === 'string' && v.length > 0;
/** @param {unknown} v @returns {v is Bag} */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} lat @param {unknown} lon */
const isLatLon = (lat, lon) => isNum(lat) && lat >= -90 && lat <= 90 && isNum(lon) && lon >= -180 && lon <= 180;

/** Thrown internally by a handler to reject its command; caught only by
 * `missionReduce` (mission-reducer.js), which imports this same class. */
export class Rejection extends Error {
  /** @param {string} message @param {string|null} [path] */
  constructor(message, path = null) { super(message); this.path = path; }
}

/** @param {string} message @param {string|null} [path] @returns {never} */
export function reject(message, path = null) { throw new Rejection(message, path); }

/**
 * @param {MissionDocumentV1} doc @param {unknown} segmentId @param {string} pathLabel
 * @returns {{ index: number, segment: Segment }}
 */
function findSegment(doc, segmentId, pathLabel) {
  if (!isStr(segmentId)) reject('A segment id is required.', pathLabel);
  const index = doc.route.segments.findIndex((s) => s.id === segmentId);
  if (index === -1) reject(`No segment '${String(segmentId)}' on this route.`, pathLabel);
  return { index, segment: /** @type {Segment} */ (doc.route.segments[index]) };
}

/** @param {MissionDocumentV1} doc @param {Segment[]} segments */
const withRoute = (doc, segments) => ({ ...doc, route: { ...doc.route, segments } });

/**
 * Validates an incoming `camera` bag against the shared segment/template shape
 * (scene-schema.js) and, only if it is clean, returns the normalised shape to
 * store — never the caller's own object, so an accepted bag can never carry a
 * key the shape does not name. `null`/`undefined` pass through as `null`: a
 * segment or template with no shot geometry yet is not an error.
 *
 * @param {unknown} camera @param {unknown} intent @param {string} path @param {string} codePrefix
 * @returns {SegmentCamera|null}
 */
function readCameraShape(camera, intent, path, codePrefix) {
  if (camera === null || camera === undefined) return null;
  /** @type {ValidationIssue[]} */ const issues = [];
  checkCameraShape(camera, intent, path, codePrefix, (p, code, message) => issues.push({ path: p, code, message }));
  if (issues.length) reject(/** @type {ValidationIssue} */ (issues[0]).message, issues[0].path);
  const c = /** @type {Bag} */ (camera);
  return {
    pitchDeg: isNum(c.pitchDeg) ? c.pitchDeg : null,
    yawOffsetDeg: isNum(c.yawOffsetDeg) ? c.yawOffsetDeg : null,
    orbit: isObj(c.orbit)
      ? { radiusM: /** @type {number} */ (c.orbit.radiusM), clockwise: c.orbit.clockwise === true }
      : null,
  };
}

/**
 * Same normalise-only-if-clean contract as {@link readCameraShape}, for
 * `scene.cameraProfile`. The name is sanitized on the way in (trim + cap),
 * the same convention src/data.js and src/share.js use for a saved record's
 * name, rather than rejecting a name that only needs tidying.
 *
 * @param {unknown} profile @param {string} path
 * @returns {CameraProfile}
 */
function readCameraProfile(profile, path) {
  /** @type {ValidationIssue[]} */ const issues = [];
  checkCameraProfile(profile, path, (p, code, message) => issues.push({ path: p, code, message }));
  if (issues.length) reject(/** @type {ValidationIssue} */ (issues[0]).message, issues[0].path);
  const p = /** @type {Bag} */ (profile);
  return {
    name: sanitizeName(p.name),
    sensorWidthMm: /** @type {number} */ (p.sensorWidthMm),
    sensorHeightMm: /** @type {number} */ (p.sensorHeightMm),
    focalLengthMm: /** @type {number} */ (p.focalLengthMm),
    stabilized: p.stabilized === true,
  };
}

/** @type {Record<string, Handler>} */
export const SCENE_HANDLERS = {
  /** Mints a subject and appends it to the scene. An omitted name defaults to
   * a placeholder rather than rejecting — a pilot dropping a pin on the map
   * has not typed a label yet, and this is not the mistake `addWaypoint`
   * guards against. */
  addSubject(doc, payload, ctx) {
    const { latitude, longitude } = payload;
    if (!isLatLon(latitude, longitude)) {
      reject('A subject needs a latitude in -90..90 and a longitude in -180..180.', 'latitude/longitude');
    }
    const name = payload.name === undefined ? 'Untitled subject' : sanitizeName(payload.name);
    if (!isValidName(name)) reject('A subject needs a non-empty name.', 'name');
    const elevationMslM = payload.elevationMslM == null ? null
      : isNum(payload.elevationMslM) ? payload.elevationMslM
        : reject('Subject elevation must be a number of metres MSL, or null.', 'elevationMslM');
    const radiusM = payload.radiusM == null ? null
      : isNum(payload.radiusM) ? payload.radiusM
        : reject('Subject radius must be a number of metres, or null.', 'radiusM');
    /** @type {Subject} */
    const subject = {
      id: ctx.idgen(ID_PREFIXES.subject),
      name: /** @type {string} */ (name),
      latitude: /** @type {number} */ (latitude),
      longitude: /** @type {number} */ (longitude),
      elevationMslM: /** @type {number|null} */ (elevationMslM),
      radiusM: /** @type {number|null} */ (radiusM),
    };
    return { ...doc, scene: { ...doc.scene, subjects: [...doc.scene.subjects, subject] } };
  },

  moveSubject(doc, payload) {
    const { id, latitude, longitude } = payload;
    if (!isStr(id)) reject('A subject id is required.', 'id');
    const index = doc.scene.subjects.findIndex((s) => s.id === id);
    if (index === -1) reject(`No subject '${String(id)}' in this scene.`, 'id');
    if (!isLatLon(latitude, longitude)) {
      reject('A subject needs a latitude in -90..90 and a longitude in -180..180.', 'latitude/longitude');
    }
    const subjects = doc.scene.subjects.map((s, i) => (i === index
      ? { ...s, latitude: /** @type {number} */ (latitude), longitude: /** @type {number} */ (longitude) }
      : s));
    return { ...doc, scene: { ...doc.scene, subjects } };
  },

  /** Removes a subject and, in the same reduction, nulls every segment's
   * `subjectRef` that dangled at it — the document is never invalid between
   * commands (ADR 0011 §2), so a segment never gets to point at a subject
   * that stopped existing one command ago. */
  removeSubject(doc, payload) {
    const { id } = payload;
    if (!isStr(id)) reject('A subject id is required.', 'id');
    const index = doc.scene.subjects.findIndex((s) => s.id === id);
    if (index === -1) reject(`No subject '${String(id)}' in this scene.`, 'id');
    const subjects = doc.scene.subjects.filter((_, i) => i !== index);
    const segments = doc.route.segments.map((s) => (s.subjectRef === id ? { ...s, subjectRef: null } : s));
    return { ...doc, scene: { ...doc.scene, subjects }, route: { ...doc.route, segments } };
  },

  /** A full replacement of the shot geometry, not a merge, matching the
   * validated shape's own contract: a bag that stops being a junk drawer does
   * not get to keep an old key a new payload never mentioned. */
  setSegmentCamera(doc, payload) {
    const { index, segment } = findSegment(doc, payload.segmentId, 'segmentId');
    const camera = readCameraShape(payload.camera, segment.intent, 'camera', 'E-SEG-CAMERA');
    const segments = [...doc.route.segments];
    segments[index] = { ...segment, camera };
    return withRoute(doc, segments);
  },

  /** `null` clears the pointer. A non-null ref must name a subject already in
   * the scene — the same reference-integrity rule checkRoute enforces on
   * load applies the moment this command tries to write one. */
  setSegmentSubject(doc, payload) {
    const { index, segment } = findSegment(doc, payload.segmentId, 'segmentId');
    if (!('subjectRef' in payload)) reject('subjectRef is required (use null to clear).', 'subjectRef');
    const subjectRef = payload.subjectRef;
    if (subjectRef !== null && subjectRef !== undefined) {
      if (!isStr(subjectRef) || !doc.scene.subjects.some((s) => s.id === subjectRef)) {
        reject(`No subject '${String(subjectRef)}' in this scene.`, 'subjectRef');
      }
    }
    const segments = [...doc.route.segments];
    segments[index] = { ...segment, subjectRef: /** @type {string|null} */ (subjectRef ?? null) };
    return withRoute(doc, segments);
  },

  /** The same E-SEG-HOLD rule checkRoute validates on load: a dwell time
   * means something only on the segment's own current intent. This command
   * touches holdS alone — unlike setSegmentIntent, it never changes what the
   * segment holds, so there is nothing here to reconcile the intent against. */
  setSegmentHold(doc, payload) {
    const { index, segment } = findSegment(doc, payload.segmentId, 'segmentId');
    const holdS = payload.holdS;
    const holds = intentHoldsStation(segment.intent);
    if (!holds && holdS !== null && holdS !== undefined) {
      reject(`A '${segment.intent}' segment cannot carry a dwell time.`, 'holdS');
    }
    if (holds && holdS !== null && holdS !== undefined && (!isNum(holdS) || holdS < 0)) {
      reject('Dwell time must be a non-negative number of seconds.', 'holdS');
    }
    const segments = [...doc.route.segments];
    segments[index] = { ...segment, holdS: holds && isNum(holdS) ? holdS : null };
    return withRoute(doc, segments);
  },

  /** `null` clears the mission's one active profile; a non-null payload must
   * be the full validated shape (scene-schema.js) — there is no per-field
   * patch here because a camera profile is a preset, swapped whole. */
  setCameraProfile(doc, payload) {
    const profile = payload.profile;
    const cameraProfile = profile === null || profile === undefined ? null : readCameraProfile(profile, 'profile');
    return { ...doc, scene: { ...doc.scene, cameraProfile } };
  },

  /** Mints a reusable shot preset. `scene.templates` may be absent on a
   * document older than this command (an old mission has never seen one) —
   * treated as `[]`, the same "missing reads as empty" rule validateMission
   * applies on load. */
  saveSceneTemplate(doc, payload, ctx) {
    const name = sanitizeName(payload.name);
    if (!isValidName(name)) reject('A template needs a non-empty name.', 'name');
    const intent = payload.intent;
    if (!isSegmentIntent(intent)) reject(`Intent must be one of ${SEGMENT_INTENTS.join(', ')}.`, 'intent');
    const holds = intentHoldsStation(intent);
    const holdS = payload.holdS;
    if (!holds && holdS !== null && holdS !== undefined) {
      reject(`A '${intent}' template cannot carry a dwell time.`, 'holdS');
    }
    if (holds && holdS !== null && holdS !== undefined && (!isNum(holdS) || holdS < 0)) {
      reject('Dwell time must be a non-negative number of seconds.', 'holdS');
    }
    const camera = payload.camera === undefined ? null : readCameraShape(payload.camera, intent, 'camera', 'E-TPL-CAMERA');
    /** @type {SceneTemplate} */
    const template = {
      id: ctx.idgen(ID_PREFIXES.template),
      name,
      intent: /** @type {import('./mission-schema.js').SegmentIntent} */ (intent),
      holdS: holds && isNum(holdS) ? holdS : null,
      camera,
    };
    const templates = doc.scene.templates ?? [];
    return { ...doc, scene: { ...doc.scene, templates: [...templates, template] } };
  },

  /** Copies the template's `intent`/`holdS`/`camera` onto a segment — never a
   * live reference, so editing or removing the template afterward cannot
   * reach back into a segment that already applied it (ADR 0011 §2). The
   * copy still obeys the intent/hold invariant: a non-holding template intent
   * lands `holdS: null` on the segment, the same as `setSegmentIntent`. */
  applySceneTemplate(doc, payload) {
    const { templateId, segmentId } = payload;
    if (!isStr(templateId)) reject('A template id is required.', 'templateId');
    const template = (doc.scene.templates ?? []).find((t) => t.id === templateId);
    if (!template) reject(`No template '${String(templateId)}' in this scene.`, 'templateId');
    const { index, segment } = findSegment(doc, segmentId, 'segmentId');
    const t = /** @type {SceneTemplate} */ (template);
    const holds = intentHoldsStation(t.intent);
    const segments = [...doc.route.segments];
    segments[index] = {
      ...segment,
      intent: t.intent,
      holdS: holds ? (t.holdS ?? null) : null,
      camera: t.camera ? structuredClone(t.camera) : null,
    };
    return withRoute(doc, segments);
  },

  removeSceneTemplate(doc, payload) {
    const { id } = payload;
    if (!isStr(id)) reject('A template id is required.', 'id');
    const templates = doc.scene.templates ?? [];
    const index = templates.findIndex((t) => t.id === id);
    if (index === -1) reject(`No template '${String(id)}' in this scene.`, 'id');
    return { ...doc, scene: { ...doc.scene, templates: templates.filter((_, i) => i !== index) } };
  },
};
