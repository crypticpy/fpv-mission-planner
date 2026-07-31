// qgc-plan.js — QGroundControl `.plan` files, read and written (ADR 0010 §3).
//
// A `.plan` is JSON, which makes it the easiest format in this milestone to
// write and the most dangerous one to read: `JSON.parse` will hand back an
// object with a `__proto__` key in it if a file says so, and one `{...parsed}`
// anywhere downstream turns that into prototype pollution. So nothing here is
// ever spread or merged — every field of every imported document is read by
// name, checked, and assigned (ADR 0010 §4).
//
// Every field mapping below was verified against QGroundControl's own source
// and the MAVLink message definitions on 2026-07-31, because a plan file that
// QGC silently reinterprets is a plan that flies somewhere else:
//
//   the plan envelope. `groundStation`, `fileType` and `version` are all
//     required on load, `fileType` must be `"Plan"`, and `version` must be
//     exactly 1 (min and max supported are both `kPlanFileVersion`). The
//     `mission`, `geoFence` and `rallyPoints` objects are **all three
//     required** — a plan carrying only a mission is rejected before its items
//     are read, so this writer always emits the empty fence and rally objects
//     at their own version 2.
//     src/MissionManager/PlanMasterController.cc, .../Parsing/Json/JsonParsing.cc
//
//   the mission object. `plannedHomePosition` (array), `items` (array) and
//     `firmwareType` are required; `vehicleType`, `cruiseSpeed`, `hoverSpeed`
//     and `globalPlanAltitudeMode` are optional. `plannedHomePosition` is
//     [latitude, longitude, AMSL altitude] and its altitude is *required* by
//     QGC's coordinate reader — which is why an unknown launch elevation fails
//     this export rather than writing a zero (ADR 0003).
//     src/MissionManager/MissionController.cc `_loadJsonMissionFileV2`
//
//   a SimpleItem. `type`, `frame`, `command`, `params` and `autoContinue` are
//     required, `params` must hold exactly 7 values, and params 1–4 must each
//     be a number or `null` — which is how a "use the current heading" yaw is
//     written. `doJumpId` is optional and is the item's 1-based sequence
//     number (home is 0). The altitude trio `AltitudeMode`/`Altitude`/
//     `AMSLAltAboveTerrain` is all-or-nothing: naming one of them makes all
//     three required.
//     src/MissionManager/MissionItem.cc, .../SimpleMissionItem.cc
//
//   the frames. MAV_FRAME_GLOBAL = 0 (MSL), MAV_FRAME_GLOBAL_RELATIVE_ALT = 3
//     (above home), MAV_FRAME_GLOBAL_TERRAIN_ALT = 10 (AGL), MAV_FRAME_MISSION
//     = 2 (not a frame — what QGC itself writes for a command that carries no
//     altitude). MAV_CMD_NAV_WAYPOINT = 16 with param1 = hold seconds and
//     param4 = yaw (NaN/null = current heading mode); NAV_RETURN_TO_LAUNCH =
//     20 with no params; DO_CHANGE_SPEED = 178 with param1 = SPEED_TYPE
//     (1 = groundspeed), param2 = m/s, param3 = throttle % (-1 = no change).
//     mavlink/message_definitions/v1.0/common.xml
//
//   `AltitudeMode` is QGC's own display enum, not a MAVLink one, and it was
//     renamed to `AltitudeFrame` upstream while keeping the JSON key. Its
//     middle members have kept their numbers across that rename — 1 Relative,
//     2 Absolute, 4 Terrain — so those three are safe to write for both old
//     and new QGC, while 0 and 5 swapped meaning and are never written here.
//     Import ignores the field entirely and reads `frame`: the MAVLink frame is
//     the one both this app and the vehicle agree on, and QGC itself falls back
//     to it when the trio is absent.
//     src/QmlControls/QGroundControlQmlGlobal.h `enum AltitudeFrame`

import {
  ID_PREFIXES, createMission, defaultIdgen, validateMission,
} from '../../domain/mission/mission-schema.js';
import { adapterResult, assertSafeSize, deriveLosses, sanitizeText } from './adapter-contracts.js';

/** @typedef {import('../../domain/mission/compile.js').CompiledMission} CompiledMission */
/** @typedef {import('../../domain/mission/compile.js').CompiledAltitude} CompiledAltitude */
/** @typedef {import('../../domain/mission/mission-schema.js').MissionDocumentV1} MissionDocumentV1 */
/** @typedef {import('../../domain/mission/mission-schema.js').Altitude} Altitude */
/** @typedef {import('../../domain/mission/mission-schema.js').AltitudeReference} AltitudeReference */
/** @typedef {import('../../domain/mission/mission-schema.js').Waypoint} Waypoint */
/** @typedef {import('../../domain/mission/mission-schema.js').Segment} Segment */
/** @typedef {import('./adapter-contracts.js').SemanticLoss} SemanticLoss */
/** @typedef {import('./adapter-contracts.js').AdapterError} AdapterError */
/** @typedef {{ text: string, filename: string, mime: string }} ExportPayload */

/** ADR 0007's format identity, as Wave D's router reads it. */
export const FORMAT = Object.freeze({
  id: 'qgc-plan',
  label: 'QGroundControl Plan',
  extensions: Object.freeze(['.plan']),
  mime: 'application/json',
});

/**
 * What this format can hold, per ADR 0010 §2 concept.
 *
 * `altitude-reference` is native because all three of this app's frames have a
 * MAV_FRAME of their own; `speed` is native because DO_CHANGE_SPEED carries
 * metres per second exactly, and a leg whose speed the compiler could not
 * resolve earns a value-level loss instead of a table entry. `camera-intent`
 * and `reserve` have nowhere to go in a plan file at all.
 * @type {import('./adapter-contracts.js').SupportTable}
 */
export const SUPPORT = Object.freeze({
  geometry: 'native',
  'altitude-reference': 'native',
  speed: 'native',
  hold: 'native',
  'camera-intent': 'unsupported',
  'return-policy': 'native',
  reserve: 'unsupported',
});

const ADAPTER_VERSION = '1.0.0';
const DOCUMENT_FORMAT = 'mission-document-v1';

/** MAV_CMD values this adapter writes and reads (common.xml). */
const CMD = Object.freeze({ WAYPOINT: 16, RTL: 20, CHANGE_SPEED: 178 });

/** MAV_FRAME values (common.xml); `MISSION` is the non-frame for command items. */
const FRAME = Object.freeze({ GLOBAL: 0, MISSION: 2, RELATIVE: 3, TERRAIN: 10 });

/**
 * DO_CHANGE_SPEED's param1, the SPEED_TYPE enum: 0 airspeed, 1 groundspeed,
 * 2 climb rate, 3 descent rate. Only the first two are a speed along the route;
 * the last two are vertical rates that would be nonsense as a cruise speed.
 */
const SPEED_TYPE_AIRSPEED = 0;
const SPEED_TYPE_GROUNDSPEED = 1;
/** @type {Record<number, string>} */
const SPEED_TYPE_WORDS = { 2: 'climb rate', 3: 'descent rate' };
const THROTTLE_NO_CHANGE = -1;

/**
 * Each authored frame's MAVLink frame, QGC display mode, and the CompiledAltitude
 * field carrying its metres. The authored frame always resolves — converting a
 * height to the frame it was written in is the identity — so this is a total
 * mapping and an export never has to re-reference an altitude.
 */
const FRAMES = /** @type {const} */ ({
  launchRelative: { frame: FRAME.RELATIVE, mode: 1, field: 'launchRelM', word: 'launch-relative' },
  msl: { frame: FRAME.GLOBAL, mode: 2, field: 'amslM', word: 'MSL' },
  agl: { frame: FRAME.TERRAIN, mode: 4, field: 'aglM', word: 'AGL' },
});

/**
 * Which authored frame a MAVLink frame number means, for the import direction.
 * @type {Map<number, AltitudeReference>}
 */
const REFERENCE_BY_FRAME = new Map([
  [FRAME.GLOBAL, 'msl'],
  [FRAME.RELATIVE, 'launchRelative'],
  [FRAME.TERRAIN, 'agl'],
]);

/**
 * MAV_AUTOPILOT_GENERIC — "generic autopilot, full support for everything".
 * A mission document is not authored against a firmware, and claiming PX4 or
 * ArduPilot here would be a fact this app does not have. QGC maps anything it
 * does not recognise as PX4 or ArduPilot to its Generic firmware class, which
 * is exactly what this plan is.
 */
const FIRMWARE_TYPE = 0;

/**
 * MAV_TYPE_QUADROTOR. This planner plans multirotors, and the vehicle type is
 * what decides whether QGC reads `hoverSpeed` or `cruiseSpeed` for its own time
 * estimates — so it picks the field this app's cruise speed actually means.
 */
const VEHICLE_TYPE = 2;

/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const inLatRange = (v) => isNum(v) && v >= -90 && v <= 90;
/** @param {unknown} v */
const inLonRange = (v) => isNum(v) && v >= -180 && v <= 180;

/**
 * A filename stem safe to hand a download: no separators, no spaces, no dots to
 * confuse an extension.
 * @param {string|undefined} base
 * @param {string} title
 * @returns {string}
 */
function fileStem(base, title) {
  const cleaned = sanitizeText(base ?? title, { maxLen: 64 })
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'mission' : cleaned;
}

/**
 * A failed AdapterResult for the export direction, generic rather than fixed to
 * `<null>` so each call site's own declared return type flows in contextually —
 * the pattern `gpx.js` sets, and the reason no caller has to cast.
 * @template [T=unknown]
 * @param {readonly AdapterError[]} errors
 * @param {readonly SemanticLoss[]} [semanticLosses]
 * @returns {import('./adapter-contracts.js').AdapterResult<T>}
 */
const exportFailed = (errors, semanticLosses = []) => adapterResult({
  payload: /** @type {T} */ (null),
  errors,
  semanticLosses,
  sourceFormat: DOCUMENT_FORMAT,
  targetFormat: FORMAT.id,
  adapterVersion: ADAPTER_VERSION,
});

/**
 * The same, for the import direction, where the formats swap places.
 * @template [T=unknown]
 * @param {readonly AdapterError[]} errors
 * @returns {import('./adapter-contracts.js').AdapterResult<T>}
 */
const importFailed = (errors) => adapterResult({
  payload: /** @type {T} */ (null),
  errors,
  sourceFormat: FORMAT.id,
  targetFormat: DOCUMENT_FORMAT,
  adapterVersion: ADAPTER_VERSION,
});

/* ---------- export ---------- */

/**
 * One SimpleItem, with its keys in the order Qt writes them (alphabetical, and
 * uppercase first) so a diff against a plan QGC saved stays about the mission.
 * @param {object} spec
 * @param {number} spec.command
 * @param {number} spec.frame
 * @param {number} spec.doJumpId
 * @param {readonly (number|null)[]} spec.params  exactly 7
 * @param {{ mode: number, altitude: number, amslAboveTerrain: number|null }|null} [spec.altitude]
 * @returns {Record<string, unknown>}
 */
function simpleItem({ command, frame, doJumpId, params, altitude = null }) {
  /** @type {Record<string, unknown>} */ const item = {};
  if (altitude) {
    // All three or none: naming one of these keys makes QGC require the others.
    item.AMSLAltAboveTerrain = altitude.amslAboveTerrain;
    item.Altitude = altitude.altitude;
    item.AltitudeMode = altitude.mode;
  }
  item.autoContinue = true;
  item.command = command;
  item.doJumpId = doJumpId;
  item.frame = frame;
  item.params = [...params];
  item.type = 'SimpleItem';
  return item;
}

/**
 * A CompiledMission as a QGroundControl plan.
 *
 * Fails rather than guesses in two places: a launch point with no elevation
 * (QGC requires an AMSL altitude on `plannedHomePosition`, and a fabricated one
 * silently re-datums every relative altitude in the plan), and a mission with
 * no waypoints (a plan must carry at least one mission item).
 *
 * @param {CompiledMission} compiled
 * @param {{ filenameBase?: string }} [options]
 * @returns {import('./adapter-contracts.js').AdapterResult<ExportPayload>}
 */
export function exportMission(compiled, { filenameBase } = {}) {
  if (!isRecord(compiled) || !Array.isArray(compiled.points) || !Array.isArray(compiled.legs)) {
    return exportFailed([{ code: 'E-QGC-NOT-COMPILED', message: 'Export needs a compiled mission.' }]);
  }
  const losses = deriveLosses(compiled.inventory, SUPPORT);
  /** @type {string[]} */ const warnings = [];

  if (compiled.points.length === 0) {
    return exportFailed([{
      code: 'E-QGC-EMPTY',
      message: 'A plan file must contain at least one mission item; this mission has no waypoints.',
    }], losses);
  }
  if (!isNum(compiled.home.elevationMslM)) {
    return exportFailed([{
      code: 'E-QGC-HOME-ELEVATION',
      message: 'QGroundControl needs the launch point\'s elevation above sea level, and this mission has none. '
        + 'Resolve the launch elevation before exporting — a fabricated home altitude re-datums every '
        + 'launch-relative altitude in the plan.',
    }], losses);
  }

  /** @type {Record<string, unknown>[]} */ const items = [];
  /** @type {number|null} */ let cruiseFromLegs = null;
  /** @type {number|null} */ let lastSpeedMs = null;

  for (let i = 0; i < compiled.points.length; i++) {
    const point = compiled.points[i];
    const leg = compiled.legs[i];
    const spec = FRAMES[point.altitude.reference];
    const altitudeM = spec ? point.altitude[spec.field] : null;
    if (!spec || !isNum(altitudeM)) {
      return exportFailed([{
        code: 'E-QGC-ALTITUDE-UNRESOLVED',
        message: `Waypoint ${i + 1} has no height in the frame it was authored in `
          + `(${point.altitude.reference}), so there is no altitude to write.`,
      }], losses);
    }

    const speedMs = leg ? leg.speed.ms : null;
    if (leg && leg.speed.mode === 'cruise' && isNum(speedMs) && cruiseFromLegs === null) {
      cruiseFromLegs = speedMs;
    }
    if (isNum(speedMs) && speedMs !== lastSpeedMs) {
      items.push(simpleItem({
        command: CMD.CHANGE_SPEED,
        frame: FRAME.MISSION,
        doJumpId: items.length + 1,
        params: [SPEED_TYPE_GROUNDSPEED, speedMs, THROTTLE_NO_CHANGE, 0, 0, 0, 0],
      }));
      lastSpeedMs = speedMs;
    } else if (leg && !isNum(speedMs)) {
      // A DO_CHANGE_SPEED from an earlier leg is still latched in the vehicle,
      // so "no speed here" does not mean "the vehicle's own speed" unless
      // nothing has been commanded yet. The loss is the pilot's only warning
      // about this leg, so it names the speed that will actually be flown.
      losses.push({
        concept: 'speed',
        detail: `leg ${i + 1} ${isNum(lastSpeedMs)
          ? `holds the ${lastSpeedMs} m/s commanded earlier in this plan`
          : 'flies at the vehicle\'s own speed'}: a '${leg.speed.mode}' policy `
          + 'resolved to no number, and this adapter will not invent one',
        disposition: 'dropped',
      });
    }

    const holdS = leg && isNum(leg.holdS) ? leg.holdS : 0;
    items.push(simpleItem({
      command: CMD.WAYPOINT,
      frame: spec.frame,
      doJumpId: items.length + 1,
      // param2 accept radius and param3 pass radius at 0 leave both to the
      // vehicle, which is what QGC writes for a plain waypoint; param4 null is
      // "hold the current heading mode" rather than a yaw of zero.
      params: [holdS, 0, 0, null, point.latitude, point.longitude, altitudeM],
      altitude: {
        mode: spec.mode,
        altitude: altitudeM,
        // QGC fills this in for terrain-framed items once it has terrain data;
        // null is what it writes when it does not, and null is what we know.
        amslAboveTerrain: spec.frame === FRAME.TERRAIN && isNum(point.altitude.amslM)
          ? point.altitude.amslM
          : null,
      },
    }));
  }

  if (compiled.returnPolicy.mode === 'direct') {
    items.push(simpleItem({
      command: CMD.RTL,
      frame: FRAME.MISSION,
      doJumpId: items.length + 1,
      params: [0, 0, 0, 0, 0, 0, 0],
    }));
    if (compiled.returnPolicy.altitude !== null) {
      losses.push({
        concept: 'return-policy',
        detail: `the return altitude of ${compiled.returnPolicy.altitude.authored} m is a vehicle `
          + 'parameter (RTL_RETURN_ALT and its equivalents), not something a plan file can set',
        disposition: 'dropped',
      });
    }
  } else if (compiled.returnPolicy.mode === 'retrace') {
    losses.push({
      concept: 'return-policy',
      detail: 'a retraced return has no command in this format; the plan ends at the last waypoint',
      disposition: 'dropped',
    });
  }

  if (items.some((item) => item.frame === FRAME.TERRAIN)) {
    warnings.push('Terrain-framed altitudes need terrain data on the aircraft; without it the '
      + 'flight controller cannot fly them as authored.');
  }

  /** @type {Record<string, unknown>} */ const mission = {
    // `cruiseSpeed` describes forward flight for fixed-wing and VTOL airframes,
    // which this planner does not plan, so it is left out rather than filled
    // with a multirotor figure. Both keys are optional on load.
    firmwareType: FIRMWARE_TYPE,
    globalPlanAltitudeMode: FRAMES[compiled.points[0].altitude.reference].mode,
  };
  if (isNum(cruiseFromLegs)) mission.hoverSpeed = cruiseFromLegs;
  mission.items = items;
  mission.plannedHomePosition = [
    compiled.home.latitude, compiled.home.longitude, compiled.home.elevationMslM,
  ];
  mission.vehicleType = VEHICLE_TYPE;
  mission.version = 2;

  const plan = {
    fileType: 'Plan',
    geoFence: { circles: [], polygons: [], version: 2 },
    groundStation: 'QGroundControl',
    mission,
    rallyPoints: { points: [], version: 2 },
    version: 1,
  };

  return adapterResult({
    payload: {
      text: `${JSON.stringify(plan, null, 4)}\n`,
      filename: `${fileStem(filenameBase, compiled.title)}.plan`,
      mime: FORMAT.mime,
    },
    warnings,
    semanticLosses: losses,
    sourceFormat: DOCUMENT_FORMAT,
    targetFormat: FORMAT.id,
    adapterVersion: ADAPTER_VERSION,
  });
}

/* ---------- import ---------- */

/**
 * The mission items, read into the pieces a document is built from.
 * @typedef {object} ReadItems
 * @property {{ latitude: number, longitude: number, altitude: Altitude, holdS: number|null, speedMs: number|null }[]} stops
 * @property {boolean} returnsToLaunch
 * @property {string[]} unknown   one label per item this adapter dropped
 * @property {boolean} airspeed   a speed in this file was commanded as airspeed
 */

/**
 * Walk `items`, or say why it could not be walked.
 * @param {unknown[]} raw
 * @returns {{ read: ReadItems }|{ error: AdapterError }}
 */
function readItems(raw) {
  /** @type {ReadItems} */
  const read = { stops: [], returnsToLaunch: false, unknown: [], airspeed: false };
  /** @type {number|null} */ let speedMs = null;

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isRecord(item)) {
      return { error: { code: 'E-QGC-ITEM-TYPE', message: `Mission item ${i + 1} is not an object.` } };
    }
    if (item.type === 'ComplexItem') {
      const kind = sanitizeText(item.complexItemType ?? 'complex', { maxLen: 40 }) || 'complex';
      read.unknown.push(`${kind} pattern`);
      continue;
    }
    if (item.type !== 'SimpleItem') {
      read.unknown.push(`item of type '${sanitizeText(item.type, { maxLen: 40 })}'`);
      continue;
    }
    const params = item.params;
    if (!Array.isArray(params) || params.length !== 7) {
      return {
        error: {
          code: 'E-QGC-PARAMS',
          message: `Mission item ${i + 1} does not carry the seven parameters a simple item has.`,
        },
      };
    }
    const command = item.command;

    if (command === CMD.RTL) { read.returnsToLaunch = true; continue; }

    if (command === CMD.CHANGE_SPEED) {
      const requested = params[1];
      if (requested !== null && requested !== undefined && !isNum(requested)) {
        return {
          error: {
            code: 'E-QGC-SPEED-TYPE',
            message: `The speed change at item ${i + 1} is not a number.`,
          },
        };
      }
      // param1 says which speed this is. Only a groundspeed is the speed a leg
      // of this document flies at: a climb or descent rate is a different
      // quantity entirely, and reading one as a cruise speed is the silent
      // reinterpretation this adapter exists to avoid.
      const type = isNum(params[0]) ? params[0] : SPEED_TYPE_GROUNDSPEED;
      if (type !== SPEED_TYPE_GROUNDSPEED && type !== SPEED_TYPE_AIRSPEED) {
        read.unknown.push(`a ${SPEED_TYPE_WORDS[type] ?? `type ${type}`} change`);
        continue;
      }
      if (type === SPEED_TYPE_AIRSPEED && isNum(requested) && requested > 0) {
        read.airspeed = true;
      }
      // -1 is MAVLink's "no change", which leaves the speed already commanded in
      // force — not a reset. -2 is "back to the vehicle default", which is a
      // speed this document cannot carry.
      if (isNum(requested) && requested > 0) speedMs = requested;
      else if (requested !== -1) speedMs = null;
      continue;
    }

    if (command !== CMD.WAYPOINT) {
      read.unknown.push(`MAV_CMD ${isNum(command) ? command : 'unknown'}`);
      continue;
    }

    const reference = REFERENCE_BY_FRAME.get(isNum(item.frame) ? item.frame : -1);
    if (!reference) {
      read.unknown.push(`waypoint in MAV_FRAME ${isNum(item.frame) ? item.frame : 'unknown'}`);
      continue;
    }
    const [hold, , , , latitude, longitude, altitude] = params;
    if (!inLatRange(latitude) || !inLonRange(longitude)) {
      return {
        error: {
          code: 'E-QGC-GEO-RANGE',
          message: `Waypoint at item ${i + 1} is not at a latitude in -90..90 and a longitude in -180..180.`,
        },
      };
    }
    if (!isNum(altitude)) {
      return {
        error: { code: 'E-QGC-ALTITUDE', message: `Waypoint at item ${i + 1} has no numeric altitude.` },
      };
    }
    if (hold !== null && hold !== undefined && !isNum(hold)) {
      return {
        error: { code: 'E-QGC-HOLD', message: `The hold time at item ${i + 1} is not a number.` },
      };
    }
    const holdS = isNum(hold) && hold > 0 ? hold : null;
    read.stops.push({
      latitude,
      longitude,
      altitude: { authored: altitude, reference, resolvedMslM: null },
      holdS,
      speedMs,
    });
  }
  return { read };
}

/**
 * A QGroundControl plan as a mission document.
 *
 * Identity does not survive the trip: a plan file carries no waypoint ids, so
 * fresh ones are minted and a loss entry says so. Altitudes arrive unresolved —
 * `resolvedMslM` is the job of `domain/mission/altitude.js` against the launch
 * elevation this import does carry, and computing it here would be a second
 * place that arithmetic lives (ADR 0003).
 *
 * @param {unknown} text
 * @param {{ idgen?: (prefix: string) => string, now?: () => string }} [deps]
 * @returns {import('./adapter-contracts.js').AdapterResult<MissionDocumentV1>}
 */
export function importMission(text, { idgen = defaultIdgen, now } = {}) {
  const size = assertSafeSize(text);
  if (!size.ok) return importFailed([/** @type {AdapterError} */ (size.error)]);

  /** @type {unknown} */ let parsed;
  try {
    parsed = JSON.parse(/** @type {string} */ (text));
  } catch {
    return importFailed([{ code: 'E-QGC-PARSE', message: 'This file is not valid JSON.' }]);
  }
  if (!isRecord(parsed)) {
    return importFailed([{ code: 'E-QGC-ROOT', message: 'A plan file is a JSON object.' }]);
  }
  // Both of these quote the file back, so both are capped: a 5 MB string in
  // `fileType` is a 5 MB error message otherwise (ADR 0010 §4).
  if (parsed.fileType !== 'Plan') {
    return importFailed([{
      code: 'E-QGC-FILETYPE',
      message: 'Expected a plan file (fileType "Plan"), found '
        + `${sanitizeText(JSON.stringify(parsed.fileType) ?? 'nothing', { maxLen: 40 })}.`,
    }]);
  }
  if (parsed.version !== 1) {
    return importFailed([{
      code: 'E-QGC-VERSION',
      message: 'This adapter reads plan file version 1; this file says '
        + `${sanitizeText(JSON.stringify(parsed.version) ?? 'nothing', { maxLen: 20 })}.`,
    }]);
  }
  const mission = parsed.mission;
  if (!isRecord(mission) || !Array.isArray(mission.items)) {
    return importFailed([{ code: 'E-QGC-MISSION', message: 'This plan carries no mission items.' }]);
  }
  const home = mission.plannedHomePosition;
  if (!Array.isArray(home) || !inLatRange(home[0]) || !inLonRange(home[1])) {
    return importFailed([{
      code: 'E-QGC-HOME',
      message: 'This plan has no usable planned home position.',
    }]);
  }
  if (home[2] !== null && home[2] !== undefined && !isNum(home[2])) {
    return importFailed([{ code: 'E-QGC-HOME-ELEVATION', message: 'The planned home altitude is not a number.' }]);
  }

  const items = readItems(mission.items);
  if ('error' in items) return importFailed([items.error]);
  const { stops, returnsToLaunch, unknown, airspeed } = items.read;
  if (stops.length === 0) {
    // A plan of nothing but survey patterns and takeoff commands is a real
    // plan; it is just not a route this app can hold. Saying so is better than
    // handing back an empty mission that looks like a successful import.
    return importFailed([{
      code: 'E-QGC-NO-WAYPOINTS',
      message: 'This plan has no waypoint this planner can fly'
        + `${unknown.length > 0 ? `; it holds ${[...new Set(unknown)].join(', ')}` : ''}.`,
    }]);
  }

  /** @type {SemanticLoss[]} */
  const losses = [{
    concept: 'geometry',
    detail: 'waypoint and segment identity is not carried by a plan file; this import minted fresh ids',
    disposition: 'approximated',
  }, {
    concept: 'speed',
    detail: 'speeds arrive as fixed targets in metres per second; the policy they were authored under '
      + '(cruise, max-range) is not carried by this format',
    disposition: 'approximated',
  }];
  if (airspeed) {
    losses.push({
      concept: 'speed',
      detail: 'a speed in this plan was commanded as airspeed and is carried here as a groundspeed '
        + 'target; the two differ by the wind, which this planner models separately',
      disposition: 'approximated',
    });
  }
  if (unknown.length > 0) {
    losses.push({
      concept: 'geometry',
      detail: `dropped ${unknown.length} item(s) this planner does not model: ${[...new Set(unknown)].join(', ')}`,
      disposition: 'dropped',
    });
  }

  const doc = createMission({
    launch: {
      latitude: home[0],
      longitude: home[1],
      elevationMslM: isNum(home[2]) ? home[2] : null,
    },
    title: 'Imported QGroundControl plan',
    returnPolicy: { mode: returnsToLaunch ? 'direct' : 'none', altitude: null },
    provenance: { origin: 'imported', sourceFormat: FORMAT.id },
  }, { idgen, now });

  // Field by field, never a spread: every value below has been range-checked
  // above, and nothing from the parsed object reaches the document by shape.
  let previous = 'launch';
  for (const stop of stops) {
    /** @type {Waypoint} */
    const waypoint = { id: idgen(ID_PREFIXES.waypoint), latitude: stop.latitude, longitude: stop.longitude };
    /** @type {Segment} */
    const segment = {
      id: idgen(ID_PREFIXES.segment),
      from: previous,
      to: waypoint.id,
      altitude: {
        authored: stop.altitude.authored,
        reference: stop.altitude.reference,
        resolvedMslM: null,
      },
      speedPolicy: stop.speedMs === null
        ? { mode: 'cruise', targetMs: null }
        : { mode: 'fixed', targetMs: stop.speedMs },
      intent: stop.holdS === null ? 'transit' : 'hold',
      holdS: stop.holdS,
    };
    doc.route.waypoints.push(waypoint);
    doc.route.segments.push(segment);
    previous = waypoint.id;
  }

  const validation = validateMission(doc);
  if (!validation.ok) {
    return importFailed(validation.errors.map((issue) => ({
      code: issue.code,
      message: `${issue.path}: ${issue.message}`,
    })));
  }

  return adapterResult({
    payload: doc,
    semanticLosses: losses,
    sourceFormat: FORMAT.id,
    targetFormat: DOCUMENT_FORMAT,
    adapterVersion: ADAPTER_VERSION,
  });
}
