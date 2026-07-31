// kml.js — KML 2.2 export (ADR 0010 §3; visualization only, no import).
//
// Field semantics verified against the OGC KML 2.2 reference (see the fixture
// provenance files under tests/fixtures/interop/ for source URL and retrieval
// date): the `http://www.opengis.net/kml/2.2` namespace, `<Document>` as the
// feature container, `<Point>`/`<LineString>` coordinates as `lon,lat[,alt]`
// tuples — longitude first, the one detail every GPX-to-KML port gets wrong
// once — and `<altitudeMode>absolute</altitudeMode>` for a line whose heights
// are metres MSL.
//
// The one rule this file exists to enforce: **a missing altitude is never
// written as 0.** Google Earth has no "I don't know" altitude, so the honest
// substitute is `clampToGround` — draping the whole line onto the terrain
// mesh instead of asserting a sea-level height nobody measured — and a loss
// entry saying so. A line is draped as a whole, not point-by-point: a route
// half at a measured height and half snapped to a fabricated one is a plan
// that reads as more precise than it is.
//
// Same concept support as gpx.js: KML speaks geometry and nothing else this
// app models beyond a re-referenced altitude.

import { XML_DECLARATION, buildXml, xmlNode } from './xml.js';
import { adapterResult, deriveLosses } from './adapter-contracts.js';

/** @typedef {import('../../domain/mission/compile.js').CompiledMission} CompiledMission */
/** @typedef {import('./adapter-contracts.js').SupportTable} SupportTable */
/** @typedef {import('./xml.js').XmlNode} XmlNode */
//
// Note: `AdapterResult` is intentionally NOT re-exported as a local `@typedef`
// alias here — see gpx.js's identical note. An intermediate alias to an
// imported `@template [T=unknown]` type collapses its generic arity, so each
// `@returns` tag below applies `<T>` to the `import(...)` expression directly.

/** Wave D's router keys formats by this; frozen so no caller can mutate it out from under another. */
export const FORMAT = Object.freeze({
  id: 'kml', label: 'KML', extensions: Object.freeze(['.kml']), mime: 'application/vnd.google-earth.kml+xml',
});

/** Identical to gpx.js's table: KML's only native concept is the route geometry. @type {SupportTable} */
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

/**
 * Matches src/render/missions.js's own export-filename slug, so a saved name reads the same everywhere.
 * @param {string} title @returns {string}
 */
const slug = (title) => (title || 'mission').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'mission';

/**
 * `lon,lat[,alt]` — longitude first, per the KML coordinate grammar. `alt`
 * is omitted rather than written as 0 when it is not known.
 * @param {number} latitude @param {number} longitude @param {number|null} elevationMslM
 * @returns {string}
 */
const coordTuple = (latitude, longitude, elevationMslM) => (elevationMslM === null
  ? `${longitude},${latitude}`
  : `${longitude},${latitude},${elevationMslM}`);

/**
 * A Point Placemark: the launch marker or one scene subject.
 * @param {{ latitude: number, longitude: number, elevationMslM: number|null, name: string }} p
 * @returns {XmlNode}
 */
function pointPlacemark({ latitude, longitude, elevationMslM, name }) {
  return xmlNode('Placemark', {}, [
    xmlNode('name', {}, [], name),
    xmlNode('Point', {}, [xmlNode('coordinates', {}, [], coordTuple(latitude, longitude, elevationMslM))]),
  ]);
}

/**
 * A compiled mission as KML 2.2: launch and every scene subject as Point
 * Placemarks, the route as a single LineString Placemark.
 *
 * @param {CompiledMission} compiled
 * @param {{ filenameBase?: string }} [options]
 * @returns {import('./adapter-contracts.js').AdapterResult<{ text: string, filename: string, mime: string }>}
 */
export function exportMission(compiled, { filenameBase } = {}) {
  const losses = deriveLosses(compiled.inventory, SUPPORT);
  const title = compiled.title;

  const vertices = [
    { latitude: compiled.home.latitude, longitude: compiled.home.longitude, elevationMslM: compiled.home.elevationMslM },
    ...compiled.points.map((p) => ({ latitude: p.latitude, longitude: p.longitude, elevationMslM: p.altitude.amslM })),
  ];
  const anyUnresolved = vertices.some((v) => v.elevationMslM === null);
  if (anyUnresolved) {
    losses.push({
      concept: 'altitude-reference',
      detail: 'the route line was draped onto the terrain (altitudeMode clampToGround) '
        + 'because one or more altitudes could not be resolved to MSL',
      disposition: 'approximated',
    });
  }
  const altitudeMode = anyUnresolved ? 'clampToGround' : 'absolute';
  // Draped as a whole (see file header): once any vertex lacks a resolved
  // height, no vertex on this line writes one, even the ones that have it.
  const coordinates = vertices
    .map((v) => (anyUnresolved ? coordTuple(v.latitude, v.longitude, null) : coordTuple(v.latitude, v.longitude, v.elevationMslM)))
    .join(' ');

  const placemarks = [
    pointPlacemark({ ...compiled.home, name: 'Launch' }),
    ...compiled.scene.subjects.map((s) => pointPlacemark({
      latitude: s.latitude, longitude: s.longitude, elevationMslM: s.elevationMslM, name: s.name,
    })),
    xmlNode('Placemark', {}, [
      xmlNode('name', {}, [], title),
      xmlNode('LineString', {}, [
        xmlNode('altitudeMode', {}, [], altitudeMode),
        xmlNode('coordinates', {}, [], coordinates),
      ]),
    ]),
  ];

  const kml = xmlNode('kml', { xmlns: 'http://www.opengis.net/kml/2.2' }, [
    xmlNode('Document', {}, [xmlNode('name', {}, [], title), ...placemarks]),
  ]);

  const text = `${XML_DECLARATION}\n${buildXml(kml)}\n`;
  const filename = `${slug(filenameBase || title)}${FORMAT.extensions[0]}`;

  return adapterResult({
    payload: { text, filename, mime: FORMAT.mime },
    semanticLosses: losses,
    sourceFormat: 'mission-document-v1',
    targetFormat: FORMAT.id,
    adapterVersion: ADAPTER_VERSION,
  });
}
