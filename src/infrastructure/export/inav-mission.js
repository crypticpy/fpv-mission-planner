// inav-mission.js — the INAV Configurator `.mission` file (ADR 0010 §3).
//
// INAV's mission file is small XML: a `<mission>` root, a `<version>` child, an
// optional `<mwp>` element carrying the planner's own map state, and one
// `<missionitem>` per point. Everything below was verified on 2026-07-31
// against INAV's published schema and the Configurator code that reads and
// writes these files, because three of its fields mean something other than
// what they look like:
//
//   `alt` is **integer metres in the file**. The Configurator divides by 100 on
//     save and calls `parseInt(...) * 100` on load, so its internal centimetres
//     become whole metres on disk — and a fractional altitude written here is
//     truncated by the real loader, not rounded. This adapter therefore rounds
//     to the metre on export and says so in a loss when the rounding moved the
//     number.
//     inav-configurator/tabs/mission_control.js (save ~4444, load ~4317)
//
//   the altitude datum is **bit 0 of `parameter3`**, not a field of its own:
//     `MWNP.P3 = { ALT_TYPE: 0, // Altitude (alt): Relative (to home) (0) or
//     Absolute (AMSL) (1) }`. There is no third option, which is why an AGL
//     altitude cannot be written as authored and is re-referenced with a loss.
//     inav-configurator/js/mwnp.js
//
//   `flag` = 165 (0xA5) marks the **last** item — the MSP protocol's "last WP"
//     value — and multi-mission files use it to delimit one mission from the
//     next. A 165 before the end of the file means more than one mission is in
//     it, so this import takes the first and says how many it left.
//     iNavFlight/inav docs/development/wp_mission_schema/README.md
//     inav-configurator/js/waypointCollection.js `update()`
//
//   the actions are a closed set — UNASSIGNED, WAYPOINT, POSHOLD_UNLIM,
//     POSHOLD_TIME, RTH, SET_POI, JUMP, SET_HEAD, LAND — of which this planner
//     models three. WAYPOINT's `parameter1` is speed in cm/s; POSHOLD_TIME's
//     `parameter1` is wait seconds and its `parameter2` is speed in cm/s; RTH's
//     `parameter1` is a non-zero "force land". Latitude and longitude are
//     decimal degrees WGS84, and `no` is 1-based and contiguous.
//     iNavFlight/inav docs/development/wp_mission_schema/mw-mission.xsd
//
//   `<mwp>` is optional and every one of its attributes is optional; the loader
//     matches it by name and simply falls back when it is absent. Its `home-x`
//     and `home-y` are longitude and latitude of the home marker, in the same
//     x=longitude, y=latitude sense as its `cx`/`cy` map centre, and real files
//     carry `home-x="0" home-y="0"` when no home was set. That element is the
//     only place a launch point can live in this format at all.
//
// Import ships (ADR 0010, amended). The evidence is a closed loop: the same
// Configurator source both writes and reads every attribute this adapter
// touches, INAV publishes an XSD and two complete sample files, and the values
// this adapter writes round-trip exactly through its own reader — the format
// quantises altitude to the metre and speed to the centimetre per second, and
// nothing else it carries is lossy.

import {
  ID_PREFIXES, createMission, defaultIdgen, validateMission,
} from '../../domain/mission/mission-schema.js';
import { adapterResult, assertSafeSize, deriveLosses, sanitizeText } from './adapter-contracts.js';
import {
  XML_DECLARATION, buildXml, localName, parseXml, xmlNode,
} from './xml.js';

/** @typedef {import('../../domain/mission/compile.js').CompiledMission} CompiledMission */
/** @typedef {import('../../domain/mission/compile.js').CompiledAltitude} CompiledAltitude */
/** @typedef {import('../../domain/mission/mission-schema.js').MissionDocumentV1} MissionDocumentV1 */
/** @typedef {import('../../domain/mission/mission-schema.js').AltitudeReference} AltitudeReference */
/** @typedef {import('../../domain/mission/mission-schema.js').Waypoint} Waypoint */
/** @typedef {import('../../domain/mission/mission-schema.js').Segment} Segment */
/** @typedef {import('./adapter-contracts.js').SemanticLoss} SemanticLoss */
/** @typedef {import('./adapter-contracts.js').AdapterError} AdapterError */
/** @typedef {import('./xml.js').XmlNode} XmlNode */
/** @typedef {{ text: string, filename: string, mime: string }} ExportPayload */

/** ADR 0007's format identity, as Wave D's router reads it. */
export const FORMAT = Object.freeze({
  id: 'inav-mission',
  label: 'INAV mission',
  extensions: Object.freeze(['.mission']),
  mime: 'application/xml',
});

/**
 * What this format can hold, per ADR 0010 §2 concept.
 *
 * `altitude-reference` is `approximate` rather than native for two reasons that
 * both survive any single mission: the file holds whole metres, which is
 * coarser than ADR 0010's 0.1 m round-trip tolerance, and it has no AGL datum
 * at all. `hold` and `speed` stay native because their quantisation — whole
 * seconds and whole centimetres per second — is finer than the tolerances that
 * govern them (1 s, 0.1 m/s), so a value that goes in comes back.
 * @type {import('./adapter-contracts.js').SupportTable}
 */
export const SUPPORT = Object.freeze({
  geometry: 'native',
  'altitude-reference': 'approximate',
  speed: 'native',
  hold: 'native',
  'camera-intent': 'unsupported',
  'return-policy': 'native',
  reserve: 'unsupported',
});

const ADAPTER_VERSION = '1.0.0';
const DOCUMENT_FORMAT = 'mission-document-v1';

/**
 * The schema version current Configurator and impload write for a single
 * mission. It names the file format, not this app — `generator` on the `<mwp>`
 * element is where this app signs its work.
 */
const SCHEMA_VERSION = '2.3-pre8';

/** The MSP "last WP" value, which this format uses as its end-of-mission flag. */
const END_FLAG = 165;

/** Bit 0 of parameter3: 0 = relative to home, 1 = above mean sea level. */
const P3_AMSL_BIT = 1;

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
 * The height to write and the datum bit to write it under.
 *
 * Both of this format's datums are ones the author may have written in
 * directly, and where they did, the authored number *is* the height — no launch
 * elevation and no terrain sample are needed to know that 50 m above launch is
 * 50 m above launch. The compiler cannot say so itself: it routes every frame
 * through sea level, so a launch-relative altitude with no launch elevation
 * comes back unresolved in its own frame. Reading `authored` here is what lets a
 * mission with no surveyed elevation export to this format at all, which is the
 * whole reason it needs no home altitude where the MAVLink formats do.
 *
 * AGL does not exist here, so an AGL altitude is re-referenced — to
 * launch-relative when the compiler resolved that, otherwise to AMSL — and the
 * caller records the loss. That conversion is a real one, and it stays the
 * compiler's to make.
 *
 * @param {CompiledAltitude} altitude
 * @returns {{ metres: number, amsl: boolean, rereferenced: AltitudeReference|null }|null}
 */
function heightFor(altitude) {
  if (altitude.reference === 'launchRelative' && isNum(altitude.authored)) {
    return { metres: altitude.authored, amsl: false, rereferenced: null };
  }
  if (altitude.reference === 'msl' && isNum(altitude.authored)) {
    return { metres: altitude.authored, amsl: true, rereferenced: null };
  }
  if (altitude.reference === 'agl') {
    if (isNum(altitude.launchRelM)) {
      return { metres: altitude.launchRelM, amsl: false, rereferenced: 'launchRelative' };
    }
    if (isNum(altitude.amslM)) return { metres: altitude.amslM, amsl: true, rereferenced: 'msl' };
  }
  return null;
}

/**
 * A CompiledMission as an INAV `.mission` file.
 *
 * Unlike the two MAVLink formats, this one needs no launch elevation: its
 * altitudes are relative to a home the aircraft sets for itself, and the launch
 * point rides in `<mwp home-x/home-y>` as a position alone. A mission with no
 * resolved elevation still exports here, and honestly.
 *
 * @param {CompiledMission} compiled
 * @param {{ filenameBase?: string }} [options]
 * @returns {import('./adapter-contracts.js').AdapterResult<ExportPayload>}
 */
export function exportMission(compiled, { filenameBase } = {}) {
  if (!isRecord(compiled) || !Array.isArray(compiled.points) || !Array.isArray(compiled.legs)) {
    return exportFailed([{ code: 'E-INAV-NOT-COMPILED', message: 'Export needs a compiled mission.' }]);
  }
  const losses = deriveLosses(compiled.inventory, SUPPORT);
  if (compiled.points.length === 0) {
    return exportFailed([{
      code: 'E-INAV-EMPTY',
      message: 'A mission file needs at least one waypoint; this mission has none.',
    }], losses);
  }

  /** @type {XmlNode[]} */ const items = [];
  /** @type {number[]} */ const rounded = [];
  /** @type {Set<string>} */ const rereferenced = new Set();

  for (let i = 0; i < compiled.points.length; i++) {
    const point = compiled.points[i];
    const leg = compiled.legs[i];
    const height = heightFor(point.altitude);
    if (!height) {
      return exportFailed([{
        code: 'E-INAV-ALTITUDE-UNRESOLVED',
        message: `Waypoint ${i + 1} is authored ${point.altitude.reference} and this format holds only `
          + 'launch-relative and sea-level heights; re-referencing it needs a terrain sample or a '
          + 'launch elevation, and neither resolved.',
      }], losses);
    }
    const metres = Math.round(height.metres);
    if (Math.abs(metres - height.metres) > 0.05) rounded.push(i + 1);
    if (height.rereferenced) rereferenced.add(height.rereferenced);

    // 0 is this format's "no speed given, fly the configured cruise" — which is
    // the flight controller's number, not the one this mission asked for, so a
    // leg whose policy resolved to nothing loses its speed here and says so.
    const speedCms = leg && isNum(leg.speed.ms) ? Math.round(leg.speed.ms * 100) : 0;
    if (leg && !isNum(leg.speed.ms)) {
      losses.push({
        concept: 'speed',
        detail: `leg ${i + 1} flies at the vehicle's own configured speed: a '${leg.speed.mode}' policy `
          + 'resolved to no number, and this adapter will not invent one',
        disposition: 'dropped',
      });
    }
    // Whole seconds are finer than the second this planner promises to keep, so
    // rounding a hold is not a loss — except at the bottom, where a hold under
    // half a second rounds to none and the waypoint stops being a hold at all.
    // That is a change of kind rather than of precision, so it is named.
    const holdS = leg && isNum(leg.holdS) && leg.holdS > 0 ? Math.round(leg.holdS) : 0;
    if (leg && isNum(leg.holdS) && leg.holdS > 0 && holdS === 0) {
      losses.push({
        concept: 'hold',
        detail: `the ${leg.holdS} s hold at waypoint ${i + 1} is shorter than the whole second this `
          + 'format counts in, so the aircraft passes through instead of stopping',
        disposition: 'dropped',
      });
    }

    items.push(xmlNode('missionitem', {
      no: items.length + 1,
      action: holdS > 0 ? 'POSHOLD_TIME' : 'WAYPOINT',
      lat: point.latitude.toFixed(7),
      lon: point.longitude.toFixed(7),
      alt: metres,
      parameter1: holdS > 0 ? holdS : speedCms,
      parameter2: holdS > 0 ? speedCms : 0,
      parameter3: height.amsl ? P3_AMSL_BIT : 0,
    }));
  }

  if (compiled.returnPolicy.mode === 'direct') {
    // RTH carries no position of its own; real files leave its coordinates at
    // zero. parameter1 = 0 is "return, do not force a landing".
    items.push(xmlNode('missionitem', {
      no: items.length + 1,
      action: 'RTH',
      lat: (0).toFixed(7),
      lon: (0).toFixed(7),
      alt: 0,
      parameter1: 0,
      parameter2: 0,
      parameter3: 0,
    }));
    if (compiled.returnPolicy.altitude !== null) {
      losses.push({
        concept: 'return-policy',
        detail: `the return altitude of ${compiled.returnPolicy.altitude.authored} m is a vehicle `
          + 'setting (INAV\'s nav_rth_altitude), not something a mission file can set',
        disposition: 'dropped',
      });
    }
  } else if (compiled.returnPolicy.mode === 'retrace') {
    losses.push({
      concept: 'return-policy',
      detail: 'a retraced return has no action in this format; the mission ends at the last waypoint',
      disposition: 'dropped',
    });
  }

  // The last item, whatever it is, carries the end-of-mission flag.
  items[items.length - 1].attrs.flag = String(END_FLAG);

  if (rounded.length > 0) {
    losses.push({
      concept: 'altitude-reference',
      detail: `altitude rounded to whole metres, the only precision this format has, at `
        + `${rounded.length === 1 ? 'waypoint' : 'waypoints'} ${rounded.join(', ')}`,
      disposition: 'approximated',
    });
  }
  for (const reference of rereferenced) {
    losses.push({
      concept: 'altitude-reference',
      detail: `AGL heights were re-referenced to ${reference === 'msl' ? 'sea level' : 'the launch point'}: `
        + 'this format has no above-ground datum, so the aircraft will fly the height it is given '
        + 'rather than following the terrain',
      disposition: 'approximated',
    });
  }

  const centre = {
    lat: compiled.points.reduce((sum, p) => sum + p.latitude, 0) / compiled.points.length,
    lon: compiled.points.reduce((sum, p) => sum + p.longitude, 0) / compiled.points.length,
  };
  const mission = xmlNode('mission', {}, [
    xmlNode('version', { value: SCHEMA_VERSION }),
    xmlNode('mwp', {
      cx: centre.lon.toFixed(7),
      cy: centre.lat.toFixed(7),
      'home-x': compiled.home.longitude.toFixed(7),
      'home-y': compiled.home.latitude.toFixed(7),
      // No `zoom`: it is the planner's map scale, every attribute of this
      // element is optional, and a zoom level is not a thing this app knows.
      'save-date': compiled.updatedAt,
      generator: 'fpv-planner',
    }),
    ...items,
  ]);

  return adapterResult({
    payload: {
      text: `${XML_DECLARATION}\n${buildXml(mission, { indent: ' ' })}\n`,
      filename: `${fileStem(filenameBase, compiled.title)}.mission`,
      mime: FORMAT.mime,
    },
    semanticLosses: losses,
    sourceFormat: DOCUMENT_FORMAT,
    targetFormat: FORMAT.id,
    adapterVersion: ADAPTER_VERSION,
  });
}

/* ---------- import ---------- */

/**
 * An element or attribute name from an imported file, safe to put in a message.
 *
 * XML names may run to any length and may contain U+202E and friends, and these
 * names are quoted back to the pilot in a loss entry — so they are capped and
 * stripped exactly like every other imported string (ADR 0010 §4).
 *
 * @param {string} name
 * @returns {string}
 */
const vendorName = (name) => sanitizeText(name, { maxLen: 40 });

/** How many vendor extensions are named before the rest become a count. */
const VENDOR_NAMES_SHOWN = 10;

/** The attributes this adapter reads; anything else is a vendor extension. */
const KNOWN_ITEM_ATTRS = Object.freeze([
  'no', 'action', 'lat', 'lon', 'alt', 'parameter1', 'parameter2', 'parameter3', 'flag',
]);

/**
 * One `<missionitem>`, as numbers, or the reason it is not one.
 * @typedef {object} InavItem
 * @property {string} action
 * @property {number} latitude
 * @property {number} longitude
 * @property {number} altitude
 * @property {number} p1
 * @property {number} p2
 * @property {number} p3
 * @property {number} flag
 */

/**
 * An attribute as a finite number, or null when it is absent or not one.
 * @param {Record<string, string>} attrs
 * @param {string} key
 * @returns {number|null}
 */
function numAttr(attrs, key) {
  if (!Object.hasOwn(attrs, key)) return null;
  const raw = attrs[key].trim();
  if (raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * An INAV `.mission` file as a mission document.
 *
 * The format carries no launch point of its own beyond the planner's map home,
 * so the launch is taken from `<mwp home-x/home-y>` when it is set and from the
 * first waypoint when it is not — with a loss either way, because neither is a
 * surveyed launch elevation.
 *
 * @param {unknown} text
 * @param {{ idgen?: (prefix: string) => string, now?: () => string }} [deps]
 * @returns {import('./adapter-contracts.js').AdapterResult<MissionDocumentV1>}
 */
export function importMission(text, { idgen = defaultIdgen, now } = {}) {
  const size = assertSafeSize(text);
  if (!size.ok) return importFailed([/** @type {AdapterError} */ (size.error)]);

  // The strict reader refuses DOCTYPE, entity declarations and processing
  // instructions outright (ADR 0010 §4), so no entity expansion happens here.
  const parsed = parseXml(text);
  if (!parsed.ok || !parsed.root) {
    return importFailed(parsed.errors.map((issue) => ({ code: issue.code, message: issue.message })));
  }
  const root = parsed.root;
  if (localName(root.name).toLowerCase() !== 'mission') {
    return importFailed([{
      code: 'E-INAV-ROOT',
      message: `An INAV mission has a <mission> root; this document has <${sanitizeText(root.name, { maxLen: 40 })}>.`,
    }]);
  }

  /** @type {string[]} */ const warnings = [];
  /** @type {SemanticLoss[]} */ const losses = [];
  /** @type {Set<string>} */ const unknownElements = new Set();
  /** @type {Set<string>} */ const unknownAttrs = new Set();
  /** @type {Set<string>} */ const droppedActions = new Set();

  /** @type {{ latitude: number, longitude: number }|null} */ let mapHome = null;
  /** @type {InavItem[]} */ const items = [];
  let missionsInFile = 1;
  let fractionalAltitude = false;

  // Everything after the first end-of-mission flag belongs to a later mission in
  // a multi-mission file, headers included.
  const firstMissionClosed = () => items.length > 0 && items[items.length - 1].flag === END_FLAG;

  for (const child of root.children) {
    const name = localName(child.name).toLowerCase();
    // <version> is read past rather than gated on, unlike a plan file's version.
    // INAV's own published sample carries `value="42"`, which is not a version
    // any release ships — so refusing an unrecognised one would refuse a file
    // the format's own documentation offers as an example. The element names
    // and attributes are what carry meaning here.
    if (name === 'version') continue;
    if (name === 'mwp' || name === 'meta') {
      // A header that belongs to a later mission must not re-home this one: in a
      // multi-mission file each segment carries its own <meta home-x/home-y>,
      // and taking the last one would move the launch point hundreds of metres
      // to a place no imported waypoint goes near.
      if (firstMissionClosed()) continue;
      // The planner metadata some tools nest here (<details> and its children)
      // is dropped rather than read, so it is named with the other extensions.
      for (const nested of child.children) {
        unknownElements.add(vendorName(`<${localName(nested.name).toLowerCase()}>`));
      }
      const lon = numAttr(child.attrs, 'home-x');
      const lat = numAttr(child.attrs, 'home-y');
      // 0/0 is what this format writes for "no home was set", and the Gulf of
      // Guinea is not a launch site.
      if (lat !== null && lon !== null && (lat !== 0 || lon !== 0)
        && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        mapHome = { latitude: lat, longitude: lon };
      }
      continue;
    }
    if (name !== 'missionitem') { unknownElements.add(vendorName(`<${name}>`)); continue; }

    if (firstMissionClosed()) {
      missionsInFile = 2;
      continue;
    }

    for (const key of Object.keys(child.attrs)) {
      if (!KNOWN_ITEM_ATTRS.includes(key)) unknownAttrs.add(vendorName(key));
    }
    // `no` is read as a label, not as a sort key: the multi-mission form in
    // INAV's own samples restarts it at 1 for each mission, so it is not unique
    // across a file and document order is the only ordering that always holds.
    const latitude = numAttr(child.attrs, 'lat');
    const longitude = numAttr(child.attrs, 'lon');
    const altitude = numAttr(child.attrs, 'alt');
    const action = sanitizeText(child.attrs.action ?? '', { maxLen: 24 }).toUpperCase();
    if (latitude === null || longitude === null || altitude === null) {
      return importFailed([{
        code: 'E-INAV-ITEM-NUMBERS',
        message: `Mission item ${items.length + 1} has a lat, lon or alt that is missing or not a number.`,
      }]);
    }
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return importFailed([{
        code: 'E-INAV-GEO-RANGE',
        message: `Mission item ${items.length + 1} is not at a latitude in -90..90 and a longitude in -180..180.`,
      }]);
    }
    if (!Number.isInteger(altitude)) fractionalAltitude = true;
    items.push({
      action,
      latitude,
      longitude,
      altitude,
      p1: numAttr(child.attrs, 'parameter1') ?? 0,
      p2: numAttr(child.attrs, 'parameter2') ?? 0,
      p3: numAttr(child.attrs, 'parameter3') ?? 0,
      flag: numAttr(child.attrs, 'flag') ?? 0,
    });
  }

  if (items.length === 0) {
    return importFailed([{ code: 'E-INAV-NO-ITEMS', message: 'This mission file has no mission items.' }]);
  }

  /** @type {{ latitude: number, longitude: number, altitude: number, reference: AltitudeReference, holdS: number|null, speedMs: number|null }[]} */
  const stops = [];
  let returnsToLaunch = false;
  let holdWithoutTime = false;

  for (const item of items) {
    if (item.action === 'RTH') {
      returnsToLaunch = true;
      if (item.p1 !== 0) {
        losses.push({
          concept: 'return-policy',
          detail: 'the return in this file forces a landing on arrival, which this planner does not model',
          disposition: 'dropped',
        });
      }
      continue;
    }
    if (item.action !== 'WAYPOINT' && item.action !== 'POSHOLD_TIME') {
      droppedActions.add(item.action === '' ? 'an item with no action' : item.action);
      continue;
    }
    // A POSHOLD_TIME with no time in it is a hold the file failed to specify.
    // The position is still good, so the waypoint is kept as a transit and the
    // hold that was meant is reported rather than quietly forgotten.
    const hold = item.action === 'POSHOLD_TIME' && item.p1 > 0 ? item.p1 : null;
    if (item.action === 'POSHOLD_TIME' && hold === null) holdWithoutTime = true;
    const speedCms = item.action === 'POSHOLD_TIME' ? item.p2 : item.p1;
    stops.push({
      latitude: item.latitude,
      longitude: item.longitude,
      altitude: item.altitude,
      // Bit 0 of parameter3 is the datum; every other bit belongs to features
      // this planner does not model and is left alone.
      reference: (item.p3 & P3_AMSL_BIT) === P3_AMSL_BIT ? 'msl' : 'launchRelative',
      holdS: hold,
      speedMs: speedCms > 0 ? speedCms / 100 : null,
    });
  }

  if (stops.length === 0) {
    return importFailed([{
      code: 'E-INAV-NO-WAYPOINTS',
      message: 'This file has mission items but none this planner can fly as a waypoint.',
    }]);
  }

  const launch = mapHome ?? { latitude: stops[0].latitude, longitude: stops[0].longitude };
  losses.push({
    concept: 'geometry',
    detail: mapHome
      ? 'the launch point came from the planner map home in this file, which carries no elevation'
      : 'this format carries no launch point, so the first waypoint was used as the launch',
    disposition: 'approximated',
  }, {
    concept: 'geometry',
    detail: 'waypoint and segment identity is not carried by a mission file; this import minted fresh ids',
    disposition: 'approximated',
  }, {
    concept: 'altitude-reference',
    detail: 'altitudes arrive in whole metres, the only precision this format holds',
    disposition: 'approximated',
  });
  if (stops.some((stop) => stop.speedMs !== null)) {
    losses.push({
      concept: 'speed',
      detail: 'speeds arrive as fixed targets in metres per second; the policy they were authored under '
        + '(cruise, max-range) is not carried by this format',
      disposition: 'approximated',
    });
  }
  if (holdWithoutTime) {
    losses.push({
      concept: 'hold',
      detail: 'a hold in this file carries no time, so it was read as a waypoint the aircraft '
        + 'passes through',
      disposition: 'dropped',
    });
  }
  if (droppedActions.size > 0) {
    losses.push({
      concept: 'geometry',
      detail: `dropped item(s) this planner does not model: ${[...droppedActions].join(', ')}`,
      disposition: 'dropped',
    });
  }
  if (unknownElements.size > 0 || unknownAttrs.size > 0) {
    // A file can carry thousands of distinct unknown names; the loss names the
    // first few and counts the rest rather than growing with the input.
    const names = [...unknownElements, ...unknownAttrs];
    const shown = names.slice(0, VENDOR_NAMES_SHOWN).join(', ');
    losses.push({
      concept: 'geometry',
      detail: `dropped vendor extensions this planner does not model: ${shown}`
        + (names.length > VENDOR_NAMES_SHOWN ? ` and ${names.length - VENDOR_NAMES_SHOWN} more` : ''),
      disposition: 'dropped',
    });
  }
  if (missionsInFile > 1) {
    warnings.push('This file holds more than one mission; only the first was imported.');
  }
  if (fractionalAltitude) {
    warnings.push('An altitude in this file is not a whole number of metres. INAV reads this field as '
      + 'an integer and would truncate it, so the aircraft may fly lower than the file reads.');
  }

  const doc = createMission({
    launch: { latitude: launch.latitude, longitude: launch.longitude, elevationMslM: null },
    title: 'Imported INAV mission',
    returnPolicy: { mode: returnsToLaunch ? 'direct' : 'none', altitude: null },
    provenance: { origin: 'imported', sourceFormat: FORMAT.id },
  }, { idgen, now });

  let previous = 'launch';
  for (const stop of stops) {
    /** @type {Waypoint} */
    const waypoint = { id: idgen(ID_PREFIXES.waypoint), latitude: stop.latitude, longitude: stop.longitude };
    /** @type {Segment} */
    const segment = {
      id: idgen(ID_PREFIXES.segment),
      from: previous,
      to: waypoint.id,
      altitude: { authored: stop.altitude, reference: stop.reference, resolvedMslM: null },
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
    warnings,
    semanticLosses: losses,
    sourceFormat: FORMAT.id,
    targetFormat: DOCUMENT_FORMAT,
    adapterVersion: ADAPTER_VERSION,
  });
}
