// gpx.js — GPX 1.1 export and import (ADR 0010 §3).
//
// GPX speaks one geometry (a track of lat/lon/ele points) and nothing else:
// no speed policy, no hold, no camera intent, no return policy, no reserve
// figure. So this adapter's job is narrow — carry the route and the launch
// point faithfully, in the one altitude frame GPX has (metres MSL, the `ele`
// element) — and everything ADR 0010 §2 calls a concept beyond geometry is a
// named loss by construction, via `deriveLosses` against `SUPPORT` below.
//
// Field semantics verified against the topografix XSD (see the fixture
// provenance files under tests/fixtures/interop/ for source URL and retrieval
// date): `gpxType`'s child order is `metadata, wpt*, rte*, trk*`; `wptType`'s
// own order is `ele` before `name`. This file's writer follows both orders —
// not because this codebase's own reader cares about order, but because a GPX
// file this app produces should validate against a strict reader too.
//
// Export never fabricates a number: an unresolved `amslM` omits `<ele>` and
// says so in a loss entry, rather than writing an elevation nobody measured
// (ADR 0003). Import is the mirror image and the more dangerous half — every
// `.gpx` handed to `importMission` is untrusted input, so it is size-capped
// and run through `xml.js`'s strict reader before anything else touches it,
// coordinates outside -90..90/-180..180 fail the import rather than clamp,
// and the only string that reaches the built document (the mission title) is
// `sanitizeText`-ed first.

import { XML_DECLARATION, buildXml, localName, parseXml, xmlNode } from './xml.js';
import { adapterResult, assertSafeSize, deriveLosses, sanitizeText } from './adapter-contracts.js';
import {
  ID_PREFIXES, LAUNCH_NODE, createMission, defaultAltitude, defaultIdgen, defaultSpeedPolicy, validateMission,
} from '../../domain/mission/mission-schema.js';

/** @typedef {import('../../domain/mission/compile.js').CompiledMission} CompiledMission */
/** @typedef {import('./adapter-contracts.js').SupportTable} SupportTable */
/** @typedef {import('./adapter-contracts.js').SemanticLoss} SemanticLoss */
/** @typedef {import('./adapter-contracts.js').AdapterError} AdapterError */
/** @typedef {import('./xml.js').XmlNode} XmlNode */
/** @typedef {import('../../domain/mission/mission-schema.js').MissionDeps} MissionDeps */
//
// Note: `AdapterResult` is intentionally NOT re-exported as a local `@typedef`
// alias here. TypeScript's JSDoc checker resolves `@template [T=unknown]`
// generics through an `import(...).Name<T>` expression, but an intermediate
// `@typedef {import(...).Name} Name` alias collapses that to the template's
// default (`unknown`) and then reports "Name is not generic" wherever the
// alias is later applied with `<T>`. Referencing
// `import('./adapter-contracts.js').AdapterResult<T>` directly in each
// `@returns` tag below sidesteps that — confirmed against a minimal repro
// before applying this pattern.

/** Wave D's router keys formats by this; frozen so no caller can mutate it out from under another. */
export const FORMAT = Object.freeze({
  id: 'gpx', label: 'GPX 1.1', extensions: Object.freeze(['.gpx']), mime: 'application/gpx+xml',
});

/**
 * GPX carries a route and a launch point and nothing else this app models.
 * `altitude-reference` is `approximate` rather than `native`: every frame this
 * app knows (launch-relative, AGL, MSL) collapses into the one number GPX
 * has, which is a re-referencing an adapter must own up to even when the
 * figure itself is exact.
 * @type {SupportTable}
 */
export const SUPPORT = Object.freeze({
  geometry: 'native',
  'altitude-reference': 'approximate',
  speed: 'unsupported',
  hold: 'unsupported',
  'camera-intent': 'unsupported',
  'return-policy': 'unsupported',
  reserve: 'unsupported',
});

const ADAPTER_VERSION = '1.0.0';

/** The UI's own title input cap (ADR 0010 §4: imported text is capped like any other). */
const TITLE_MAX_LEN = 80;

/**
 * Matches src/render/missions.js's own export-filename slug, so a saved name reads the same everywhere.
 * @param {string} title @returns {string}
 */
const slug = (title) => (title || 'mission').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'mission';

/** @param {number} n @param {string} noun */
const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/* ---------- export ---------- */

/**
 * One `<wpt>`: `ele` before `name`, the XSD's own child order, and `ele`
 * omitted rather than fabricated when there is nothing to write.
 * @param {{ latitude: number, longitude: number, elevationMslM: number|null, name: string }} p
 * @returns {XmlNode}
 */
function wptNode({ latitude, longitude, elevationMslM, name }) {
  /** @type {XmlNode[]} */ const children = [];
  if (elevationMslM !== null) children.push(xmlNode('ele', {}, [], String(elevationMslM)));
  children.push(xmlNode('name', {}, [], name));
  return xmlNode('wpt', { lat: latitude, lon: longitude }, children);
}

/**
 * One `<trkpt>`: geometry only, `<ele>` omitted when unresolved.
 * @param {number} latitude @param {number} longitude @param {number|null} elevationMslM
 * @returns {XmlNode}
 */
function trkptNode(latitude, longitude, elevationMslM) {
  const children = elevationMslM !== null ? [xmlNode('ele', {}, [], String(elevationMslM))] : [];
  return xmlNode('trkpt', { lat: latitude, lon: longitude }, children);
}

/**
 * A compiled mission as GPX 1.1: the launch point as both the first `<trkpt>`
 * and a named `<wpt>`, every scene subject as its own `<wpt>`, and the route
 * as a single `<trk><trkseg>`.
 *
 * @param {CompiledMission} compiled
 * @param {{ filenameBase?: string }} [options]
 * @returns {import('./adapter-contracts.js').AdapterResult<{ text: string, filename: string, mime: string }>}
 */
export function exportMission(compiled, { filenameBase } = {}) {
  const losses = deriveLosses(compiled.inventory, SUPPORT);
  const title = compiled.title;

  const wpts = [
    wptNode({ ...compiled.home, name: 'Launch' }),
    ...compiled.scene.subjects.map((s) => wptNode({
      latitude: s.latitude, longitude: s.longitude, elevationMslM: s.elevationMslM, name: s.name,
    })),
  ];

  const trkpts = [trkptNode(compiled.home.latitude, compiled.home.longitude, compiled.home.elevationMslM)];
  for (const point of compiled.points) {
    trkpts.push(trkptNode(point.latitude, point.longitude, point.altitude.amslM));
    if (point.altitude.amslM === null) {
      losses.push({
        concept: 'altitude-reference',
        detail: `waypoint '${point.id}' has no resolved MSL altitude; its <trkpt> carries no <ele>`,
        disposition: 'approximated',
      });
    }
  }

  const gpx = xmlNode('gpx', { version: '1.1', creator: 'fpv-planner', xmlns: 'http://www.topografix.com/GPX/1/1' }, [
    xmlNode('metadata', {}, [xmlNode('name', {}, [], title)]),
    ...wpts,
    xmlNode('trk', {}, [
      xmlNode('name', {}, [], title),
      xmlNode('trkseg', {}, trkpts),
    ]),
  ]);

  const text = `${XML_DECLARATION}\n${buildXml(gpx)}\n`;
  const filename = `${slug(filenameBase || title)}${FORMAT.extensions[0]}`;

  return adapterResult({
    payload: { text, filename, mime: FORMAT.mime },
    semanticLosses: losses,
    sourceFormat: 'mission-document-v1',
    targetFormat: FORMAT.id,
    adapterVersion: ADAPTER_VERSION,
  });
}

/* ---------- import ---------- */

/**
 * The direct children of `node` whose local name is `name`, in document order.
 * @param {XmlNode} node @param {string} name @returns {XmlNode[]}
 */
const childrenNamed = (node, name) => node.children.filter((c) => localName(c.name) === name);

/** @param {XmlNode} node @param {string} name @returns {XmlNode|null} */
const firstChildNamed = (node, name) => childrenNamed(node, name)[0] ?? null;

/**
 * `<ele>`'s number, or `null` when the element is absent or empty — `Number('')`
 * is 0, which would turn "no elevation was written" into a fabricated sea-level
 * figure, exactly what ADR 0003 forbids.
 * @param {XmlNode} node @returns {number|null}
 */
function eleOf(node) {
  const eleNode = firstChildNamed(node, 'ele');
  const raw = (eleNode?.text ?? '').trim();
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * The geometry this file carries: the first non-empty of a `trk`'s `trkpt`s,
 * an `rte`'s `rtept`s, or the root's own bare `wpt` list.
 * @param {XmlNode} root @returns {XmlNode[]}
 */
function routePoints(root) {
  const trkpts = childrenNamed(root, 'trk')
    .flatMap((trk) => childrenNamed(trk, 'trkseg').flatMap((seg) => childrenNamed(seg, 'trkpt')));
  if (trkpts.length > 0) return trkpts;

  const rtepts = childrenNamed(root, 'rte').flatMap((rte) => childrenNamed(rte, 'rtept'));
  if (rtepts.length > 0) return rtepts;

  return childrenNamed(root, 'wpt');
}

/**
 * A failed AdapterResult, filled in with this adapter's fixed formats. Generic
 * (rather than fixed to `<null>`) so each call site's own declared return type
 * (e.g. `AdapterResult<MissionDocumentV1>`) flows in contextually — TS infers
 * `T` from the expected type of the enclosing `return`, so a caller never has
 * to cast a `failed(...)` result to match its own richer payload type.
 * @template [T=unknown]
 * @param {readonly AdapterError[]} errors
 * @returns {import('./adapter-contracts.js').AdapterResult<T>}
 */
const failed = (errors) => adapterResult({
  payload: /** @type {T} */ (null), errors, sourceFormat: FORMAT.id, targetFormat: 'mission-document-v1', adapterVersion: ADAPTER_VERSION,
});

/**
 * A `.gpx` file into a fresh, validated MissionDocumentV1.
 *
 * The chain: size cap, then the strict XML reader, then geometry (trk, else
 * rte, else bare wpt), then coordinate range checks that fail rather than
 * clamp, then a document built field-by-field — never by spreading a parsed
 * node — and validated before it is handed back.
 *
 * @param {string} text
 * @param {MissionDeps} [deps]
 * @returns {import('./adapter-contracts.js').AdapterResult<import('../../domain/mission/mission-schema.js').MissionDocumentV1>}
 */
export function importMission(text, { idgen, now } = {}) {
  const size = assertSafeSize(text);
  // assertSafeSize's own return type is the weaker `{ ok, error? }` (not a
  // discriminated union), so TS can't narrow `error` from `!ok` alone — but
  // every `!ok` branch in its implementation does set `error`, so this cast
  // reflects a true runtime invariant the frozen type just doesn't express.
  if (!size.ok) return failed([/** @type {AdapterError} */ (size.error)]);

  const parsed = parseXml(text);
  if (!parsed.ok) return failed(parsed.errors.map((e) => ({ code: e.code, message: e.message })));

  const root = /** @type {XmlNode} */ (parsed.root);
  if (localName(root.name) !== 'gpx') {
    return failed([{ code: 'E-GPX-ROOT', message: `Expected a <gpx> root element, found '<${localName(root.name)}>'.` }]);
  }

  const rawPoints = routePoints(root);
  if (rawPoints.length === 0) {
    return failed([{ code: 'E-GPX-EMPTY', message: 'This file has no trkpt, rtept, or wpt to build a route from.' }]);
  }

  /** @type {{ latitude: number, longitude: number, elevationMslM: number|null }[]} */
  const points = [];
  for (const node of rawPoints) {
    const latitude = Number(node.attrs.lat);
    const longitude = Number(node.attrs.lon);
    const inRange = Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
      && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
    if (!inRange) {
      return failed([{
        code: 'E-GPX-GEO-RANGE',
        message: `A point's lat/lon is not a valid coordinate: lat='${node.attrs.lat}', lon='${node.attrs.lon}'.`,
      }]);
    }
    points.push({ latitude, longitude, elevationMslM: eleOf(node) });
  }

  const [launchPoint, ...waypointPoints] = points;
  const idg = idgen ?? defaultIdgen;

  const waypoints = waypointPoints.map((p) => ({
    id: idg(ID_PREFIXES.waypoint), latitude: p.latitude, longitude: p.longitude,
  }));
  const segments = waypointPoints.map((p, i) => ({
    id: idg(ID_PREFIXES.segment),
    from: i === 0 ? LAUNCH_NODE : waypoints[i - 1].id,
    to: waypoints[i].id,
    altitude: p.elevationMslM !== null
      ? { authored: p.elevationMslM, reference: /** @type {'msl'} */ ('msl'), resolvedMslM: p.elevationMslM }
      : defaultAltitude(),
    speedPolicy: defaultSpeedPolicy(),
    intent: /** @type {'transit'} */ ('transit'),
    holdS: null,
    subjectRef: null,
    camera: null,
    overrides: null,
  }));

  const missingEle = waypointPoints.filter((p) => p.elevationMslM === null).length;
  /** @type {SemanticLoss[]} */
  const losses = [{ concept: 'geometry', detail: 'launch inferred from first point', disposition: 'approximated' }];
  if (missingEle > 0) {
    losses.push({
      concept: 'altitude-reference',
      detail: `${plural(missingEle, 'waypoint')} of ${plural(waypointPoints.length, 'point')} had no <ele> and default to 80 m above launch`,
      disposition: 'approximated',
    });
  }

  const metadataName = firstChildNamed(root, 'metadata');
  const nameNode = metadataName ? firstChildNamed(metadataName, 'name') : null;
  const rawTitle = nameNode ? sanitizeText(nameNode.text, { maxLen: TITLE_MAX_LEN }) : '';

  const doc = createMission({
    launch: { latitude: launchPoint.latitude, longitude: launchPoint.longitude, elevationMslM: launchPoint.elevationMslM },
    title: rawTitle || undefined,
    provenance: {
      origin: 'imported',
      sourceFormat: FORMAT.id,
      notes: rawTitle ? `GPX metadata name: "${rawTitle}".` : null,
    },
  }, { idgen: idg, now });

  const finalDoc = { ...doc, route: { ...doc.route, waypoints, segments } };

  const validation = validateMission(finalDoc);
  if (validation.errors.length > 0) {
    return failed(validation.errors.map((e) => ({ code: e.code, message: `${e.path}: ${e.message}` })));
  }

  return adapterResult({
    payload: finalDoc,
    semanticLosses: losses,
    sourceFormat: FORMAT.id,
    targetFormat: 'mission-document-v1',
    adapterVersion: ADAPTER_VERSION,
  });
}
