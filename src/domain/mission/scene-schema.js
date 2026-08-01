// scene-schema.js — shapes for the reserved cinematic bags (ADR 0011 §2):
// `scene.cameraProfile`, `segment.camera` (shared verbatim by `scene.templates[]`
// entries), and the name field all three of subjects/profiles/templates carry.
//
// This module imports nothing, on purpose (ADR 0011 "Consequences"): it is the
// pure half — validators and frozen shape constants only — so mission-schema.js
// can consume it without a cycle, and so it typechecks under strict checkJs with
// no import graph to drag in. mission-schema.js owns wiring these checks into
// `validateMission`'s two-register report (errors vs warnings); every function
// here reports only through the `Report` callback it is handed, the same shape
// `checkRoute`/`checkScene` already use, and never decides ok/not-ok itself.
//
// Every check in this file is an error, never a warning: an authored camera
// number out of range, or an unknown key in a bag that now has a shape, is a
// mistake or nonsense — not an incompleteness some later resolver will fill in
// the way an unresolved altitude is (mission-schema.js's W-ALT-UNRESOLVED).

/** @typedef {(path: string, code: string, message: string) => void} Report */
/** @typedef {{ [key: string]: unknown }} Bag */

/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** @param {unknown} v @returns {v is number} */
const isPositive = (v) => isNum(v) && v > 0;
/** @param {unknown} v @returns {v is Bag} */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Every name a pilot types into this bag — subject, camera profile, scene
 * template — shares one cap, the same length gpx.js's own title cap
 * (`TITLE_MAX_LEN`) uses for the same reason: long enough for a real label,
 * short enough that a map pin or a template chip never has to truncate badly.
 */
export const NAME_MAX_LEN = 80;

/**
 * Trims and caps an incoming name for storage. Never rejects — an empty or
 * over-long name is the reducer's job to reject via `isValidName`, this is
 * only what a handler applies to a value it has already accepted (the same
 * `.trim().slice(0, n)` shape src/data.js and src/share.js use for a saved
 * spot's or a shared record's name).
 * @param {unknown} v
 * @returns {string}
 */
export function sanitizeName(v) {
  return typeof v === 'string' ? v.trim().slice(0, NAME_MAX_LEN) : '';
}

/**
 * True for a name worth storing: text, not just whitespace, within the cap.
 * @param {unknown} v
 * @returns {v is string}
 */
export function isValidName(v) {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  return t.length > 0 && t.length <= NAME_MAX_LEN;
}

/**
 * The dive plan's gate vocabulary (M16, screens 3D-05…08), in flight order:
 * the ridge approach, the dive entry, where the pullout must be level, and the
 * altitude at which the run is broken off instead. One gate per kind — "the
 * recovery gate" has to name exactly one thing for the clearance math to mean
 * anything, so a second gate of a kind is a duplicate, not a sequence.
 * @type {readonly string[]}
 */
export const DIVE_GATE_KINDS = Object.freeze(['approach', 'dive', 'recovery', 'abort']);

/** @param {unknown} v @returns {v is string} */
export const isDiveGateKind = (v) => typeof v === 'string' && DIVE_GATE_KINDS.includes(v);

/** @type {readonly string[]} */
const CAMERA_KEYS = Object.freeze(['pitchDeg', 'yawOffsetDeg', 'orbit']);
/** @type {readonly string[]} */
const ORBIT_KEYS = Object.freeze(['radiusM', 'clockwise']);
/** @type {readonly string[]} */
const PROFILE_KEYS = Object.freeze(['name', 'sensorWidthMm', 'sensorHeightMm', 'focalLengthMm', 'stabilized']);

/**
 * The shared segment/template camera shape:
 * `{ pitchDeg, yawOffsetDeg, orbit: { radiusM, clockwise } | null }`. Every
 * top-level field is optional-nullable. `orbit` is meaningful only when the
 * owner's own intent holds station at `'orbit'` — carrying one on any other
 * intent is rejected the same way a dwell time on a non-holding intent is
 * (mission-schema.js's `checkRoute` holdS rule). Unknown keys, at either
 * level of the bag, are rejected under the same code: the point is that the
 * bag stops being a junk drawer the moment it has a shape, not that every
 * rejection needs its own code.
 *
 * @param {unknown} camera
 * @param {unknown} intent the owner's (possibly invalid) intent value
 * @param {string} path
 * @param {string} codePrefix e.g. `'E-SEG-CAMERA'` or `'E-TPL-CAMERA'`
 * @param {Report} err
 */
export function checkCameraShape(camera, intent, path, codePrefix, err) {
  if (camera === null || camera === undefined) return;
  if (!isObj(camera)) { err(path, `${codePrefix}-TYPE`, 'camera must be an object or null.'); return; }

  for (const key of Object.keys(camera)) {
    if (!CAMERA_KEYS.includes(key)) {
      err(`${path}.${key}`, `${codePrefix}-KEY`, `Unknown camera key '${key}'.`);
    }
  }

  const { pitchDeg, yawOffsetDeg, orbit } = camera;
  if (pitchDeg !== null && pitchDeg !== undefined && (!isNum(pitchDeg) || pitchDeg < -90 || pitchDeg > 90)) {
    err(`${path}.pitchDeg`, `${codePrefix}-PITCH`, 'pitchDeg must be a number between -90 and 90, or null.');
  }
  if (yawOffsetDeg !== null && yawOffsetDeg !== undefined
    && (!isNum(yawOffsetDeg) || yawOffsetDeg < -180 || yawOffsetDeg > 180)) {
    err(`${path}.yawOffsetDeg`, `${codePrefix}-YAW`, 'yawOffsetDeg must be a number between -180 and 180, or null.');
  }
  if (orbit !== null && orbit !== undefined) {
    if (intent !== 'orbit') {
      err(`${path}.orbit`, `${codePrefix}-ORBIT`, `orbit camera settings require an 'orbit' intent, not '${String(intent)}'.`);
    }
    if (!isObj(orbit)) {
      err(`${path}.orbit`, `${codePrefix}-ORBIT-TYPE`, 'orbit must be an object or null.');
    } else {
      for (const key of Object.keys(orbit)) {
        if (!ORBIT_KEYS.includes(key)) {
          err(`${path}.orbit.${key}`, `${codePrefix}-KEY`, `Unknown orbit key '${key}'.`);
        }
      }
      if (!isPositive(orbit.radiusM)) {
        err(`${path}.orbit.radiusM`, `${codePrefix}-ORBIT-RADIUS`, 'orbit.radiusM must be a positive, finite number of metres.');
      }
      if (typeof orbit.clockwise !== 'boolean') {
        err(`${path}.orbit.clockwise`, `${codePrefix}-ORBIT-CLOCKWISE`, 'orbit.clockwise must be a boolean.');
      }
    }
  }
}

/**
 * `scene.cameraProfile`'s validated shape:
 * `{ name, sensorWidthMm, sensorHeightMm, focalLengthMm, stabilized }`. The
 * whole block is nullable — a mission with no profile attached carries `null`
 * here, not a missing key.
 *
 * @param {unknown} profile
 * @param {string} path
 * @param {Report} err
 */
export function checkCameraProfile(profile, path, err) {
  if (profile === null || profile === undefined) return;
  if (!isObj(profile)) { err(path, 'E-SCENE-PROFILE-TYPE', 'cameraProfile must be an object or null.'); return; }

  for (const key of Object.keys(profile)) {
    if (!PROFILE_KEYS.includes(key)) {
      err(`${path}.${key}`, 'E-SCENE-PROFILE-KEY', `Unknown camera profile key '${key}'.`);
    }
  }
  if (!isValidName(profile.name)) {
    err(`${path}.name`, 'E-SCENE-PROFILE-NAME', `name must be non-empty text of at most ${NAME_MAX_LEN} characters.`);
  }
  for (const field of ['sensorWidthMm', 'sensorHeightMm', 'focalLengthMm']) {
    if (!isPositive(profile[field])) {
      err(`${path}.${field}`, 'E-SCENE-PROFILE-NUMBER', `${field} must be a positive, finite number.`);
    }
  }
  if (typeof profile.stabilized !== 'boolean') {
    err(`${path}.stabilized`, 'E-SCENE-PROFILE-STABILIZED', 'stabilized must be a boolean.');
  }
}

/** @type {readonly string[]} */
const DIVE_KEYS = Object.freeze(['gates', 'bailout', 'rthAltitudeMslM']);
/** @type {readonly string[]} */
const GATE_KEYS = Object.freeze(['id', 'kind', 'latitude', 'longitude', 'altitudeMslM', 'radiusM']);
/** @type {readonly string[]} */
const BAILOUT_KEYS = Object.freeze(['name', 'latitude', 'longitude', 'elevationMslM']);

/** @param {unknown} lat @param {unknown} lon */
const isLatLon = (lat, lon) => isNum(lat) && lat >= -90 && lat <= 90 && isNum(lon) && lon >= -180 && lon <= 180;

/**
 * `scene.dive`'s validated shape (M16):
 * `{ gates, bailout, rthAltitudeMslM }`, the whole block nullable — a mission
 * with no dive plan carries `null` (or, on a document older than M16, no key
 * at all), never an empty bag. Gates carry a *required* altitude, unlike a
 * subject's optional elevation: a gate that does not say how high it is is not
 * a gate, it is a pin. Unknown keys at every level share one code, the same
 * rule `checkCameraShape` states: a bag with a shape is not a junk drawer.
 *
 * @param {unknown} dive
 * @param {string} path
 * @param {Report} err
 */
export function checkDive(dive, path, err) {
  if (dive === null || dive === undefined) return;
  if (!isObj(dive)) { err(path, 'E-DIVE-TYPE', 'dive must be an object or null.'); return; }

  for (const key of Object.keys(dive)) {
    if (!DIVE_KEYS.includes(key)) err(`${path}.${key}`, 'E-DIVE-KEY', `Unknown dive key '${key}'.`);
  }

  if (!Array.isArray(dive.gates)) {
    err(`${path}.gates`, 'E-DIVE-GATES', 'dive.gates must be a list.');
  } else {
    /** @type {Set<string>} */ const ids = new Set();
    /** @type {Set<string>} */ const kinds = new Set();
    dive.gates.forEach((g, i) => {
      const gp = `${path}.gates[${i}]`;
      if (!isObj(g)) { err(gp, 'E-DIVE-GATE-TYPE', 'A dive gate must be an object.'); return; }
      for (const key of Object.keys(g)) {
        if (!GATE_KEYS.includes(key)) err(`${gp}.${key}`, 'E-DIVE-KEY', `Unknown dive gate key '${key}'.`);
      }
      if (typeof g.id !== 'string' || g.id.length === 0) err(`${gp}.id`, 'E-ID-MISSING', 'A dive gate needs a stable id.');
      else if (ids.has(g.id)) err(`${gp}.id`, 'E-ID-DUPLICATE', `Duplicate dive gate id '${g.id}'.`);
      else ids.add(g.id);
      if (!isDiveGateKind(g.kind)) {
        err(`${gp}.kind`, 'E-DIVE-GATE-KIND', `Gate kind must be one of ${DIVE_GATE_KINDS.join(', ')}.`);
      } else if (kinds.has(g.kind)) {
        err(`${gp}.kind`, 'E-DIVE-GATE-DUP', `A dive plan carries at most one '${g.kind}' gate.`);
      } else kinds.add(g.kind);
      if (!isLatLon(g.latitude, g.longitude)) {
        err(gp, 'E-GEO-RANGE', 'A dive gate needs a latitude in -90..90 and a longitude in -180..180.');
      }
      if (!isNum(g.altitudeMslM)) {
        err(`${gp}.altitudeMslM`, 'E-DIVE-GATE-ALT', 'A dive gate needs its altitude as a number of metres MSL.');
      }
      if (g.radiusM !== null && g.radiusM !== undefined && !isPositive(g.radiusM)) {
        err(`${gp}.radiusM`, 'E-DIVE-GATE-RADIUS', 'Gate corridor radius must be a positive number of metres, or null.');
      }
    });
  }

  const bailout = dive.bailout;
  if (bailout !== null && bailout !== undefined) {
    const bp = `${path}.bailout`;
    if (!isObj(bailout)) { err(bp, 'E-DIVE-BAILOUT-TYPE', 'bailout must be an object or null.'); return; }
    for (const key of Object.keys(bailout)) {
      if (!BAILOUT_KEYS.includes(key)) err(`${bp}.${key}`, 'E-DIVE-KEY', `Unknown bailout key '${key}'.`);
    }
    if (!isValidName(bailout.name)) {
      err(`${bp}.name`, 'E-DIVE-BAILOUT-NAME', `Bailout name must be non-empty text of at most ${NAME_MAX_LEN} characters.`);
    }
    if (!isLatLon(bailout.latitude, bailout.longitude)) {
      err(bp, 'E-GEO-RANGE', 'A bailout landing needs a latitude in -90..90 and a longitude in -180..180.');
    }
    if (bailout.elevationMslM !== null && bailout.elevationMslM !== undefined && !isNum(bailout.elevationMslM)) {
      err(`${bp}.elevationMslM`, 'E-DIVE-BAILOUT-ELEV', 'Bailout elevation must be a number of metres MSL, or null.');
    }
  }

  if (dive.rthAltitudeMslM !== null && dive.rthAltitudeMslM !== undefined && !isNum(dive.rthAltitudeMslM)) {
    err(`${path}.rthAltitudeMslM`, 'E-DIVE-RTH', 'The lost-link/RTH altitude must be a number of metres MSL, or null.');
  }
}
