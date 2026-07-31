// import-router.js — the adapter registry and format detection Wave D's UI and
// tests read, so that a caller with a picked file never has to know there are
// five of these or import any of them by name (ADR 0010 §6).
//
// Infrastructure importing infrastructure: this file's only imports are its
// five sibling adapters, gathered behind one shape (`AdapterSurface`) so the
// rest of the app can iterate `ADAPTERS` instead of naming each module.

import * as gpx from './gpx.js';
import * as kml from './kml.js';
import * as qgcPlan from './qgc-plan.js';
import * as ardupilotWpl from './ardupilot-wpl.js';
import * as inavMission from './inav-mission.js';

/** @typedef {import('./adapter-contracts.js').AdapterResult} AdapterResult */
/** @typedef {import('./adapter-contracts.js').SupportTable} SupportTable */
/** @typedef {import('../../domain/mission/compile.js').CompiledMission} CompiledMission */

/**
 * One adapter's frozen identity plus the two functions this router calls by
 * name. `importMission` is `null` for kml.js, which is export-only (ADR 0010's
 * format table) — callers check for that rather than assuming every format
 * round-trips.
 * @typedef {object} AdapterSurface
 * @property {{ id: string, label: string, extensions: readonly string[], mime: string }} format
 * @property {SupportTable} support
 * @property {(compiled: CompiledMission, options?: { filenameBase?: string }) => AdapterResult} exportMission
 * @property {((text: string, deps?: { idgen?: (prefix: string) => string, now?: () => string }) => AdapterResult)|null} importMission
 */

/** @param {*} mod @returns {AdapterSurface} */
function surfaceOf(mod) {
  return Object.freeze({
    format: mod.FORMAT,
    support: mod.SUPPORT,
    exportMission: mod.exportMission,
    importMission: mod.importMission ?? null,
  });
}

/** Every format this planner speaks, gpx.js through inav-mission.js, in no particular priority order. */
export const ADAPTERS = Object.freeze([
  surfaceOf(gpx),
  surfaceOf(kml),
  surfaceOf(qgcPlan),
  surfaceOf(ardupilotWpl),
  surfaceOf(inavMission),
]);

/** The formats this planner can write — currently all five. */
export const EXPORTABLE = Object.freeze(ADAPTERS.filter((a) => typeof a.exportMission === 'function'));

/** The formats this planner can read — every adapter but kml.js. */
export const IMPORTABLE = Object.freeze(ADAPTERS.filter((a) => typeof a.importMission === 'function'));

/** Extension (lower-cased, dot included) → format id, derived from each adapter's own declared list. */
const EXT_FORMAT = new Map(ADAPTERS.flatMap((a) => a.format.extensions.map((ext) => [ext, a.format.id])));
EXT_FORMAT.set('.json', 'mission-document-v1');

/** @param {string} filename @returns {string} the lower-cased extension, dot included, or '' */
function extensionOf(filename) {
  const name = String(filename || '');
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/** @param {string} text @returns {string} `text` past any UTF-8 BOM and leading whitespace */
function leading(text) {
  const s = String(text ?? '');
  return (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s).trimStart();
}

/**
 * Whether `text`'s root element — past an optional `<?xml …?>` prolog — is
 * `tag`. A sniff, not a parse: detectFormat only has to tell one hand-written
 * fixture from another, not validate one, and the adapter's own strict reader
 * is what actually parses the file a moment later.
 * @param {string} text @param {string} tag @returns {boolean}
 */
function xmlRootStartsWith(text, tag) {
  let body = leading(text);
  if (body.startsWith('<?xml')) {
    const end = body.indexOf('?>');
    if (end === -1) return false;
    body = leading(body.slice(end + 2));
  }
  return new RegExp(`^<${tag}[\\s>]`, 'i').test(body);
}

/** @param {string} text @returns {string|null} */
function sniff(text) {
  const raw = String(text ?? '');
  if (raw.split('\n')[0].trim() === 'QGC WPL 110') return 'ardupilot-wpl';
  const body = leading(raw);
  if (body.startsWith('{')) {
    if (/"fileType"\s*:\s*"Plan"/.test(raw)) return 'qgc-plan';
    if (/"schemaVersion"/.test(raw)) return 'mission-document-v1';
    return null;
  }
  if (xmlRootStartsWith(raw, 'mission')) return 'inav-mission';
  if (xmlRootStartsWith(raw, 'gpx')) return 'gpx';
  if (xmlRootStartsWith(raw, 'kml')) return 'kml';
  return null;
}

/**
 * The format a file is — by extension first, by content when the extension
 * doesn't say. `.txt` is ArduPilot WPL's own second extension and is also
 * exactly what a file loses its real extension down to after a rename or a
 * trip through a download dialog, so it always falls through to content
 * regardless of what the map says.
 * @param {string} filename
 * @param {string} text
 * @returns {string|null} a format id (including `'mission-document-v1'`), or null when nothing matches
 */
export function detectFormat(filename, text) {
  const ext = extensionOf(filename);
  if (ext && ext !== '.txt' && EXT_FORMAT.has(ext)) return /** @type {string} */ (EXT_FORMAT.get(ext));
  return sniff(text);
}

/**
 * Route an imported file to the adapter its detected format names.
 *
 * `mission-document-v1` is not an adapter this router owns — mission-bridge.js's
 * own `importMission` already validates and persists it — so this hands the
 * format id back with a null result and leaves the native path to the caller
 * (ADR 0010 §6). A format this router recognises but cannot import (kml, or an
 * unrecognised file) also comes back with a null result: the format id still
 * tells the caller what was seen, even when there was nowhere to route it.
 *
 * @param {string} text
 * @param {{ filename?: string, idgen?: (prefix: string) => string, now?: () => string }} [options]
 * @returns {{ formatId: string|null, result: AdapterResult|null }}
 */
export function importAny(text, { filename = '', idgen, now } = {}) {
  const formatId = detectFormat(filename, text);
  if (!formatId || formatId === 'mission-document-v1') return { formatId, result: null };
  const surface = ADAPTERS.find((a) => a.format.id === formatId);
  if (!surface || !surface.importMission) return { formatId, result: null };
  return { formatId, result: surface.importMission(text, { idgen, now }) };
}
