// ardupilot-wpl.js — the `QGC WPL 110` plain-text mission file (ADR 0010 §3).
//
// The oldest and most widely read mission format in this milestone: Mission
// Planner, MAVProxy, QGroundControl and impload all load it, which is why it is
// here even though `.plan` carries strictly more. It is twelve tab-separated
// columns per line under one magic header, and every column below was checked
// against real files and the code that reads them on 2026-07-31:
//
//   INDEX  CURRENT  FRAME  COMMAND  PARAM1..4  X(lat)  Y(lon)  Z(alt)  AUTOCONTINUE
//
//   row 0 is home. QGroundControl's own loader says so in as many words —
//     "ArduPilot file, planned home position is already in position 0" — and
//     ArduPilot's developers confirm the convention. Real files carry frame 0
//     (MSL) and command 16 on that row, so its altitude is above sea level
//     while the rows beneath it are usually frame 3, relative to home.
//     src/MissionManager/MissionController.cc `_loadTextMissionFile`
//     https://discuss.ardupilot.org/t/first-line-in-mission-file/60436
//
//   CURRENT is `false:0, true:1` per the MISSION_ITEM definition, and it is a
//     display flag rather than a mission semantic: Mission Planner writes 1 on
//     row 0, while ArduPilot's own autotest missions carry 0 on every row. This
//     adapter writes Mission Planner's shape and ignores the column on import.
//
//   AUTOCONTINUE is "Autocontinue to next waypoint. 0: false, 1: true" — 1
//     throughout in real files, and 1 is what this adapter writes; a mission
//     document has no way to say "pause here for a human".
//
//   the numbers. pymavlink writes every float as `%f` — six decimals — and the
//     columns are separated by single tabs with one trailing newline. This
//     adapter matches, except for latitude and longitude, which it writes at
//     seven decimals: MAVLink's own MISSION_ITEM_INT carries degrees scaled by
//     1e7, so the seventh decimal is real precision the format can hold and the
//     sixth would quantise every coordinate to about 11 cm.
//     https://raw.githubusercontent.com/ArduPilot/pymavlink/master/mavwp.py
//
//   commands are the MAVLink ones (common.xml): NAV_WAYPOINT 16 with param1 =
//     hold seconds, NAV_RETURN_TO_LAUNCH 20 with no parameters, DO_CHANGE_SPEED
//     178 with param1 = SPEED_TYPE (1 = groundspeed), param2 = m/s and param3 =
//     throttle percent where -1 means "no change". Frames: 0 MSL, 3 relative to
//     home, 10 terrain/AGL. Commands that carry no location take frame 0 in
//     real ArduPilot files — the DO_JUMP row of `CMAC-copter-circuit.txt` does
//     — rather than MAV_FRAME_MISSION, and this adapter follows the files.
//
//   terrain frame. ArduPilot's mission command list page reads as though
//     MAV_FRAME_GLOBAL_TERRAIN_ALT were Plane-only, while its terrain-following
//     page documents the Copter parameter (`TERRAIN_ENABLE`) that turns it on
//     and ArduPilot's own generic autotest mission uses frame 10. The docs
//     contradict each other, so AGL altitudes are written in frame 10 and the
//     result carries a warning saying the aircraft needs terrain data to fly
//     them — the export is not blocked on a documentation disagreement.
//     https://ardupilot.org/copter/docs/terrain-following.html

import {
  ID_PREFIXES, createMission, defaultIdgen, validateMission,
} from '../../domain/mission/mission-schema.js';
import { adapterResult, assertSafeSize, deriveLosses, sanitizeText } from './adapter-contracts.js';

/** @typedef {import('../../domain/mission/compile.js').CompiledMission} CompiledMission */
/** @typedef {import('../../domain/mission/mission-schema.js').MissionDocumentV1} MissionDocumentV1 */
/** @typedef {import('../../domain/mission/mission-schema.js').AltitudeReference} AltitudeReference */
/** @typedef {import('../../domain/mission/mission-schema.js').Waypoint} Waypoint */
/** @typedef {import('../../domain/mission/mission-schema.js').Segment} Segment */
/** @typedef {import('./adapter-contracts.js').SemanticLoss} SemanticLoss */
/** @typedef {import('./adapter-contracts.js').AdapterError} AdapterError */
/** @typedef {{ text: string, filename: string, mime: string }} ExportPayload */

/** ADR 0007's format identity, as Wave D's router reads it. */
export const FORMAT = Object.freeze({
  id: 'ardupilot-wpl',
  label: 'ArduPilot mission (QGC WPL 110)',
  extensions: Object.freeze(['.waypoints', '.txt']),
  mime: 'text/plain',
});

/**
 * What this format can hold, per ADR 0010 §2 concept.
 *
 * The same MAVLink commands as a `.plan` file, so the same table — what a WPL
 * file loses against a plan is structure and vendor metadata, not mission
 * meaning. Hold is native because NAV_WAYPOINT's first parameter is dwell time
 * in seconds; speed because DO_CHANGE_SPEED carries metres per second.
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

/** The magic first line. The trailing digits are the format version, not a count. */
const HEADER = 'QGC WPL 110';

/** MAV_CMD values this adapter writes and reads (common.xml). */
const CMD = Object.freeze({ WAYPOINT: 16, RTL: 20, TAKEOFF: 22, CHANGE_SPEED: 178 });

/** MAV_FRAME values (common.xml). */
const FRAME = Object.freeze({ GLOBAL: 0, RELATIVE: 3, TERRAIN: 10 });

/**
 * DO_CHANGE_SPEED's param1, the SPEED_TYPE enum: 0 airspeed, 1 groundspeed,
 * 2 climb rate, 3 descent rate. Only the first two are a speed along the route;
 * Copter uses the last two for WPNAV_SPEED_UP/DN, which are not cruise speeds.
 */
const SPEED_TYPE_AIRSPEED = 0;
const SPEED_TYPE_GROUNDSPEED = 1;
/** @type {Record<number, string>} */
const SPEED_TYPE_WORDS = { 2: 'climb rate', 3: 'descent rate' };
const THROTTLE_NO_CHANGE = -1;

/** Twelve columns, no more and no fewer — a short row is a corrupt row. */
const COLUMNS = 12;

/** Each authored frame's MAVLink frame and the CompiledAltitude field to read. */
const FRAMES = /** @type {const} */ ({
  launchRelative: { frame: FRAME.RELATIVE, field: 'launchRelM' },
  msl: { frame: FRAME.GLOBAL, field: 'amslM' },
  agl: { frame: FRAME.TERRAIN, field: 'aglM' },
});

/** @type {Map<number, AltitudeReference>} */
const REFERENCE_BY_FRAME = new Map([
  [FRAME.GLOBAL, 'msl'],
  [FRAME.RELATIVE, 'launchRelative'],
  [FRAME.TERRAIN, 'agl'],
]);

/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
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
 * One tab-separated row.
 * @param {object} spec
 * @param {number} spec.seq
 * @param {number} spec.current
 * @param {number} spec.frame
 * @param {number} spec.command
 * @param {readonly [number, number, number, number]} spec.params
 * @param {number} spec.latitude
 * @param {number} spec.longitude
 * @param {number} spec.altitude
 * @returns {string}
 */
function row({ seq, current, frame, command, params, latitude, longitude, altitude }) {
  return [
    seq, current, frame, command,
    ...params.map((p) => p.toFixed(6)),
    latitude.toFixed(7), longitude.toFixed(7), altitude.toFixed(6),
    1, // AUTOCONTINUE: this planner has no "wait for the pilot" waypoint.
  ].join('\t');
}

/**
 * A CompiledMission as a `QGC WPL 110` file.
 *
 * Fails without a launch elevation, exactly as the QGroundControl adapter does
 * and for the same reason: row 0 is home and its altitude column is read as
 * metres above sea level. A zero written there is a claim this app cannot make,
 * and every GCS that loads the file would show the mission datumed to it.
 *
 * @param {CompiledMission} compiled
 * @param {{ filenameBase?: string }} [options]
 * @returns {import('./adapter-contracts.js').AdapterResult<ExportPayload>}
 */
export function exportMission(compiled, { filenameBase } = {}) {
  if (!isRecord(compiled) || !Array.isArray(compiled.points) || !Array.isArray(compiled.legs)) {
    return exportFailed([{ code: 'E-WPL-NOT-COMPILED', message: 'Export needs a compiled mission.' }]);
  }
  const losses = deriveLosses(compiled.inventory, SUPPORT);
  /** @type {string[]} */ const warnings = [];

  if (compiled.points.length === 0) {
    return exportFailed([{
      code: 'E-WPL-EMPTY',
      message: 'A waypoint file needs at least one waypoint; this mission has none.',
    }], losses);
  }
  if (!isNum(compiled.home.elevationMslM)) {
    return exportFailed([{
      code: 'E-WPL-HOME-ELEVATION',
      message: 'The home row of a waypoint file carries the launch elevation above sea level, and this '
        + 'mission has none. Resolve the launch elevation before exporting — every ground station that '
        + 'reads this file would datum the mission to a fabricated home.',
    }], losses);
  }

  /** @type {string[]} */ const rows = [];
  // Row 0 is home: frame 0 (MSL), command 16, no parameters, and the CURRENT
  // flag Mission Planner writes there.
  rows.push(row({
    seq: 0,
    current: 1,
    frame: FRAME.GLOBAL,
    command: CMD.WAYPOINT,
    params: [0, 0, 0, 0],
    latitude: compiled.home.latitude,
    longitude: compiled.home.longitude,
    altitude: compiled.home.elevationMslM,
  }));

  /** @type {number|null} */ let lastSpeedMs = null;
  let usesTerrainFrame = false;

  for (let i = 0; i < compiled.points.length; i++) {
    const point = compiled.points[i];
    const leg = compiled.legs[i];
    const spec = FRAMES[point.altitude.reference];
    const altitudeM = spec ? point.altitude[spec.field] : null;
    if (!spec || !isNum(altitudeM)) {
      return exportFailed([{
        code: 'E-WPL-ALTITUDE-UNRESOLVED',
        message: `Waypoint ${i + 1} has no height in the frame it was authored in `
          + `(${point.altitude.reference}), so there is no altitude to write.`,
      }], losses);
    }
    if (spec.frame === FRAME.TERRAIN) usesTerrainFrame = true;

    const speedMs = leg ? leg.speed.ms : null;
    if (isNum(speedMs) && speedMs !== lastSpeedMs) {
      rows.push(row({
        seq: rows.length,
        current: 0,
        frame: FRAME.GLOBAL,
        command: CMD.CHANGE_SPEED,
        params: [SPEED_TYPE_GROUNDSPEED, speedMs, THROTTLE_NO_CHANGE, 0],
        latitude: 0,
        longitude: 0,
        altitude: 0,
      }));
      lastSpeedMs = speedMs;
    } else if (leg && !isNum(speedMs)) {
      // A DO_CHANGE_SPEED from an earlier row is still latched in the vehicle,
      // so "no speed here" does not mean "the vehicle's own speed" unless
      // nothing has been commanded yet. The loss is the pilot's only warning
      // about this leg, so it names the speed that will actually be flown.
      losses.push({
        concept: 'speed',
        detail: `leg ${i + 1} ${isNum(lastSpeedMs)
          ? `holds the ${lastSpeedMs} m/s commanded earlier in this file`
          : 'flies at the vehicle\'s own speed'}: a '${leg.speed.mode}' policy `
          + 'resolved to no number, and this adapter will not invent one',
        disposition: 'dropped',
      });
    }

    rows.push(row({
      seq: rows.length,
      current: 0,
      frame: spec.frame,
      command: CMD.WAYPOINT,
      // param2 accept radius and param3 pass radius at 0 leave both to the
      // vehicle's own parameters; param4 yaw at 0 is what real ArduPilot files
      // carry for a plain waypoint.
      params: [leg && isNum(leg.holdS) ? leg.holdS : 0, 0, 0, 0],
      latitude: point.latitude,
      longitude: point.longitude,
      altitude: altitudeM,
    }));
  }

  if (compiled.returnPolicy.mode === 'direct') {
    rows.push(row({
      seq: rows.length,
      current: 0,
      frame: FRAME.GLOBAL,
      command: CMD.RTL,
      params: [0, 0, 0, 0],
      latitude: 0,
      longitude: 0,
      altitude: 0,
    }));
  } else if (compiled.returnPolicy.mode === 'retrace') {
    losses.push({
      concept: 'return-policy',
      detail: 'a retraced return has no command in this format; the file ends at the last waypoint',
      disposition: 'dropped',
    });
  }

  if (usesTerrainFrame) {
    warnings.push('Terrain-framed altitudes need terrain data on the aircraft (ArduPilot\'s '
      + 'TERRAIN_ENABLE, with GCS terrain or a rangefinder); without it the flight controller cannot '
      + 'fly them as authored.');
  }
  if (compiled.returnPolicy.mode === 'direct' && compiled.returnPolicy.altitude !== null) {
    losses.push({
      concept: 'return-policy',
      detail: `the return altitude of ${compiled.returnPolicy.altitude.authored} m is a vehicle `
        + 'parameter (ArduPilot\'s RTL_ALT), not something a waypoint file can set',
      disposition: 'dropped',
    });
  }

  return adapterResult({
    payload: {
      text: `${[HEADER, ...rows].join('\n')}\n`,
      filename: `${fileStem(filenameBase, compiled.title)}.waypoints`,
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

/** One parsed row, still in file terms. */
/** @typedef {{ line: number, seq: number, frame: number, command: number, params: number[], latitude: number, longitude: number, altitude: number }} WplRow */

/**
 * Every non-blank line after the header, as numbers.
 *
 * Split on whitespace runs rather than on a single tab: real files are
 * tab-separated, pymavlink's own reader splits on any whitespace, and no column
 * of this format can contain a space — so the tolerant split costs nothing and
 * reads files a stricter one would reject.
 *
 * @param {string[]} lines
 * @returns {{ rows: WplRow[] }|{ error: AdapterError }}
 */
function parseRows(lines) {
  /** @type {WplRow[]} */ const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (text === '') continue;
    const cells = text.split(/\s+/);
    if (cells.length !== COLUMNS) {
      return {
        error: {
          code: 'E-WPL-COLUMNS',
          message: `Line ${i + 2} has ${cells.length} columns; a waypoint file has ${COLUMNS}.`,
        },
      };
    }
    /** @type {number[]} */ const values = [];
    for (const cell of cells) {
      const value = Number(cell);
      // `Number('')` is 0 and `Number('12abc')` is NaN; both are caught here, so
      // no NaN reaches a coordinate or an altitude.
      if (!Number.isFinite(value)) {
        return {
          error: {
            code: 'E-WPL-NOT-A-NUMBER',
            message: `Line ${i + 2} contains "${sanitizeText(cell, { maxLen: 24 })}", which is not a number.`,
          },
        };
      }
      values.push(value);
    }
    rows.push({
      line: i + 2,
      seq: values[0],
      frame: values[2],
      command: values[3],
      params: values.slice(4, 8),
      latitude: values[8],
      longitude: values[9],
      altitude: values[10],
    });
  }
  return { rows };
}

/**
 * A `QGC WPL 110` file as a mission document.
 *
 * Row 0 becomes the launch point, following every ground station that reads
 * this format. Waypoint identity is not in the file, so fresh ids are minted
 * and a loss says so.
 *
 * @param {unknown} text
 * @param {{ idgen?: (prefix: string) => string, now?: () => string }} [deps]
 * @returns {import('./adapter-contracts.js').AdapterResult<MissionDocumentV1>}
 */
export function importMission(text, { idgen = defaultIdgen, now } = {}) {
  const size = assertSafeSize(text);
  if (!size.ok) return importFailed([/** @type {AdapterError} */ (size.error)]);

  const lines = /** @type {string} */ (text).split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines[0].trim() !== HEADER) {
    return importFailed([{
      code: 'E-WPL-HEADER',
      message: `A waypoint file starts with "${HEADER}"; this one starts with `
        + `"${sanitizeText(lines[0], { maxLen: 32 })}".`,
    }]);
  }

  const parsed = parseRows(lines.slice(1));
  if ('error' in parsed) return importFailed([parsed.error]);
  const { rows } = parsed;
  if (rows.length === 0) {
    return importFailed([{ code: 'E-WPL-EMPTY', message: 'This waypoint file has no rows.' }]);
  }

  const inRange = (/** @type {WplRow} */ r) => r.latitude >= -90 && r.latitude <= 90
    && r.longitude >= -180 && r.longitude <= 180;

  const home = rows[0];
  if (!inRange(home)) {
    return importFailed([{
      code: 'E-WPL-HOME',
      message: 'The home row is not at a latitude in -90..90 and a longitude in -180..180.',
    }]);
  }

  /** @type {SemanticLoss[]} */
  const losses = [{
    concept: 'geometry',
    detail: 'waypoint and segment identity is not carried by a waypoint file; this import minted fresh ids',
    disposition: 'approximated',
  }, {
    concept: 'speed',
    detail: 'speeds arrive as fixed targets in metres per second; the policy they were authored under '
      + '(cruise, max-range) is not carried by this format',
    disposition: 'approximated',
  }];
  /** @type {string[]} */ const warnings = [];
  /** @type {string[]} */ const unknown = [];

  // Row 0 carries the launch elevation only when it says which datum it is in.
  // A home row in a relative frame is claiming a height above itself, which is
  // no elevation at all.
  let elevationMslM = /** @type {number|null} */ (null);
  if (home.frame === FRAME.GLOBAL) elevationMslM = home.altitude;
  else warnings.push(`The home row is in MAV_FRAME ${home.frame} rather than 0 (above sea level), `
    + 'so this import took its position but not its elevation.');

  const doc = createMission({
    launch: { latitude: home.latitude, longitude: home.longitude, elevationMslM },
    title: 'Imported ArduPilot mission',
    provenance: { origin: 'imported', sourceFormat: FORMAT.id },
  }, { idgen, now });

  /** @type {number|null} */ let speedMs = null;
  let previous = 'launch';
  let returnsToLaunch = false;
  let airspeed = false;

  for (const item of rows.slice(1)) {
    if (item.command === CMD.RTL) { returnsToLaunch = true; continue; }
    if (item.command === CMD.CHANGE_SPEED) {
      // param1 says which speed this is. Copter commands climb and descent
      // rates through this same message, and a vertical rate read as a cruise
      // speed is the silent reinterpretation this adapter exists to avoid.
      const type = item.params[0];
      if (type !== SPEED_TYPE_GROUNDSPEED && type !== SPEED_TYPE_AIRSPEED) {
        unknown.push(`a ${SPEED_TYPE_WORDS[type] ?? `type ${type}`} change`);
        continue;
      }
      if (type === SPEED_TYPE_AIRSPEED && item.params[1] > 0) airspeed = true;
      // -1 is "no change", which leaves the speed already commanded in force —
      // not a reset. -2 is "back to the vehicle default", which is not a speed
      // this document can carry.
      if (item.params[1] > 0) speedMs = item.params[1];
      else if (item.params[1] !== -1) speedMs = null;
      continue;
    }
    if (item.command === CMD.TAKEOFF) {
      unknown.push('a takeoff command (the aircraft climbs to the first waypoint instead)');
      continue;
    }
    if (item.command !== CMD.WAYPOINT) {
      unknown.push(`MAV_CMD ${item.command}`);
      continue;
    }
    const reference = REFERENCE_BY_FRAME.get(item.frame);
    if (!reference) {
      unknown.push(`a waypoint in MAV_FRAME ${item.frame}`);
      continue;
    }
    if (!inRange(item)) {
      return importFailed([{
        code: 'E-WPL-GEO-RANGE',
        message: `Line ${item.line} is not at a latitude in -90..90 and a longitude in -180..180.`,
      }]);
    }
    const holdS = item.params[0] > 0 ? item.params[0] : null;
    /** @type {Waypoint} */
    const waypoint = { id: idgen(ID_PREFIXES.waypoint), latitude: item.latitude, longitude: item.longitude };
    /** @type {Segment} */
    const segment = {
      id: idgen(ID_PREFIXES.segment),
      from: previous,
      to: waypoint.id,
      altitude: { authored: item.altitude, reference, resolvedMslM: null },
      speedPolicy: speedMs === null ? { mode: 'cruise', targetMs: null } : { mode: 'fixed', targetMs: speedMs },
      intent: holdS === null ? 'transit' : 'hold',
      holdS,
    };
    doc.route.waypoints.push(waypoint);
    doc.route.segments.push(segment);
    previous = waypoint.id;
  }

  if (doc.route.waypoints.length === 0) {
    return importFailed([{
      code: 'E-WPL-NO-WAYPOINTS',
      message: 'This file has a home row but no waypoints this planner can fly.',
    }]);
  }
  if (airspeed) {
    losses.push({
      concept: 'speed',
      detail: 'a speed in this file was commanded as airspeed and is carried here as a groundspeed '
        + 'target; the two differ by the wind, which this planner models separately',
      disposition: 'approximated',
    });
  }
  if (unknown.length > 0) {
    losses.push({
      concept: 'geometry',
      detail: `dropped ${unknown.length} row(s) this planner does not model: ${[...new Set(unknown)].join(', ')}`,
      disposition: 'dropped',
    });
  }
  doc.route.returnPolicy = { mode: returnsToLaunch ? 'direct' : 'none', altitude: null };

  const validation = validateMission(doc);
  if (!validation.ok) {
    return importFailed(validation.errors.map((issue) => ({
      code: issue.code,
      message: `${issue.path}: ${issue.message}`,
    })));
  }

  return adapterResult({
    payload: doc,
    warnings,
    semanticLosses: losses,
    sourceFormat: FORMAT.id,
    targetFormat: DOCUMENT_FORMAT,
    adapterVersion: ADAPTER_VERSION,
  });
}
