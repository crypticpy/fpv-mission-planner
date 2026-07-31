import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ADAPTERS, EXPORTABLE, IMPORTABLE, detectFormat, importAny,
} from '../src/infrastructure/export/import-router.js';

/* Wave D's registry and format sniff (ADR 0010 §6): the five adapters gathered
 * behind one shape, extension-first detection with a content-sniff fallback
 * for a renamed or extension-less file, and `importAny` routing a recognised
 * format to its adapter while handing `mission-document-v1` (this app's own
 * export) and anything unroutable back with a null result rather than
 * guessing. */

/** Deterministic identity and a clock that ticks one second per call. */
function harness() {
  let ids = 0;
  let ticks = 0;
  return {
    idgen: (prefix) => `${prefix}_${++ids}`,
    now: () => new Date(Date.UTC(2026, 6, 31, 12, 0, ticks++)).toISOString(),
  };
}

const fixture = (name) => readFileSync(new URL(`./fixtures/interop/${name}`, import.meta.url), 'utf8');

const MISSION_JSON = '{"schemaVersion":1,"id":"mission_1","title":"x"}';
const KML_SNIPPET = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<kml xmlns="http://www.opengis.net/kml/2.2"><Document></Document></kml>\n';

/* ---------- 1. the registry ---------- */

test('ADAPTERS gathers all five formats, frozen', () => {
  assert.equal(ADAPTERS.length, 5);
  assert.ok(Object.isFrozen(ADAPTERS));
  const ids = ADAPTERS.map((a) => a.format.id).sort();
  assert.deepEqual(ids, ['ardupilot-wpl', 'gpx', 'inav-mission', 'kml', 'qgc-plan'].sort());
  for (const a of ADAPTERS) {
    assert.ok(Object.isFrozen(a), `${a.format.id} surface must be frozen`);
    assert.equal(typeof a.exportMission, 'function');
  }
});

test('EXPORTABLE is all five; IMPORTABLE is every adapter but kml', () => {
  assert.equal(EXPORTABLE.length, 5);
  assert.equal(IMPORTABLE.length, 4);
  assert.ok(!IMPORTABLE.some((a) => a.format.id === 'kml'));
  assert.ok(EXPORTABLE.some((a) => a.format.id === 'kml'));
  for (const a of IMPORTABLE) assert.equal(typeof a.importMission, 'function');
});

/* ---------- 2. detectFormat, by extension ---------- */

test('detectFormat reads the extension first for every registered format', () => {
  assert.equal(detectFormat('route.gpx', ''), 'gpx');
  assert.equal(detectFormat('placemarks.kml', ''), 'kml');
  assert.equal(detectFormat('survey.plan', ''), 'qgc-plan');
  assert.equal(detectFormat('circuit.waypoints', ''), 'ardupilot-wpl');
  assert.equal(detectFormat('flight.mission', ''), 'inav-mission');
  assert.equal(detectFormat('saved.json', ''), 'mission-document-v1');
});

test('detectFormat is case-insensitive on the extension and ignores a path prefix', () => {
  assert.equal(detectFormat('MISSIONS/Route.GPX', ''), 'gpx');
});

/* ---------- 3. detectFormat, by content sniff ---------- */

test('detectFormat sniffs ArduPilot WPL by its magic first line, not by extension', () => {
  // .txt is ArduPilot WPL's own second extension, and also the shape of a file
  // that lost its real extension — so it always falls through to content.
  assert.equal(detectFormat('mission.txt', fixture('ardupilot-cmac-circuit.waypoints')), 'ardupilot-wpl');
  assert.equal(detectFormat('', fixture('ardupilot-cmac-circuit.waypoints')), 'ardupilot-wpl');
});

test('detectFormat sniffs QGC Plan JSON without needing the .plan extension', () => {
  assert.equal(detectFormat('untitled.txt', fixture('qgroundcontrol-plan-example.plan')), 'qgc-plan');
});

test('detectFormat sniffs this app\'s own JSON export by its schemaVersion field', () => {
  assert.equal(detectFormat('untitled.txt', MISSION_JSON), 'mission-document-v1');
});

test('detectFormat sniffs INAV, GPX and KML by their XML root element', () => {
  assert.equal(detectFormat('untitled.txt', fixture('inav-schema-sequential.mission')), 'inav-mission');
  assert.equal(detectFormat('untitled.txt', fixture('topografix-route.gpx')), 'gpx');
  assert.equal(detectFormat('untitled.txt', KML_SNIPPET), 'kml');
});

test('detectFormat returns null for a file that matches nothing this planner reads', () => {
  assert.equal(detectFormat('notes.txt', 'just some plain text, not a mission at all'), null);
  assert.equal(detectFormat('', ''), null);
});

/* ---------- 4. importAny, routing ---------- */

test('importAny hands mission-document-v1 back with a null result — the native path owns it', () => {
  const { formatId, result } = importAny(MISSION_JSON, { filename: 'saved.json' });
  assert.equal(formatId, 'mission-document-v1');
  assert.equal(result, null);
});

test('importAny routes a KML file to a null result — kml.js is export-only', () => {
  const { formatId, result } = importAny(KML_SNIPPET, { filename: 'placemarks.kml' });
  assert.equal(formatId, 'kml');
  assert.equal(result, null);
});

test('importAny returns a null format id and result for an unrecognised file', () => {
  const { formatId, result } = importAny('not a mission of any kind', { filename: 'readme.txt' });
  assert.equal(formatId, null);
  assert.equal(result, null);
});

test('importAny routes an ArduPilot WPL file to its adapter and returns a MissionDocumentV1 payload', () => {
  const { formatId, result } = importAny(fixture('ardupilot-cmac-circuit.waypoints'), {
    filename: 'ardupilot-cmac-circuit.waypoints', ...harness(),
  });
  assert.equal(formatId, 'ardupilot-wpl');
  assert.notEqual(result.status, 'failed');
  assert.equal(result.sourceFormat, 'ardupilot-wpl');
  assert.equal(result.targetFormat, 'mission-document-v1');
  assert.ok(result.payload && typeof result.payload.title === 'string');
});

test('importAny routes a QGC Plan file to its adapter', () => {
  // Both .plan fixtures on hand are deliberately negative cases (see
  // export-qgc.test.mjs: one is takeoff-only, the other is an older item
  // schema) — qgc-plan.js's own import correctness is that file's job. This
  // only has to show the router delegated: a qgc-plan-shaped error code proves
  // the text reached qgc-plan.js's importMission rather than being swallowed.
  const { formatId, result } = importAny(fixture('qgroundcontrol-sectiontest.plan'), {
    filename: 'qgroundcontrol-sectiontest.plan', ...harness(),
  });
  assert.equal(formatId, 'qgc-plan');
  assert.equal(result.sourceFormat, 'qgc-plan');
  assert.equal(result.targetFormat, 'mission-document-v1');
  assert.match(result.errors[0].code, /^E-QGC-/);
});

test('importAny routes an INAV mission file to its adapter', () => {
  const { formatId, result } = importAny(fixture('inav-schema-sequential.mission'), {
    filename: 'inav-schema-sequential.mission', ...harness(),
  });
  assert.equal(formatId, 'inav-mission');
  assert.notEqual(result.status, 'failed');
  assert.ok(result.payload);
});

test('importAny routes a GPX file to its adapter', () => {
  const { formatId, result } = importAny(fixture('topografix-route.gpx'), {
    filename: 'topografix-route.gpx', ...harness(),
  });
  assert.equal(formatId, 'gpx');
  assert.notEqual(result.status, 'failed');
  assert.ok(result.payload);
});

test('importAny threads idgen/now through to the adapter, deterministically', () => {
  const { result } = importAny(fixture('ardupilot-cmac-circuit.waypoints'), {
    filename: 'ardupilot-cmac-circuit.waypoints', ...harness(),
  });
  assert.equal(result.payload.id, 'msn_1');
});

test('importAny sniffs by content when no filename is given at all', () => {
  const { formatId } = importAny(fixture('qgroundcontrol-sectiontest.plan'), harness());
  assert.equal(formatId, 'qgc-plan');
});
