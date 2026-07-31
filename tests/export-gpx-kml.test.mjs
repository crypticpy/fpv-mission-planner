import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createMission, validateMission } from '../src/domain/mission/mission-schema.js';
import { missionReduce } from '../src/domain/mission/mission-reducer.js';
import { CONCEPTS, compileMission } from '../src/domain/mission/compile.js';
import { MAX_IMPORT_BYTES } from '../src/infrastructure/export/adapter-contracts.js';
import { XML_DECLARATION } from '../src/infrastructure/export/xml.js';
import { FORMAT as GPX_FORMAT, SUPPORT as GPX_SUPPORT, exportMission as gpxExport, importMission } from '../src/infrastructure/export/gpx.js';
import { FORMAT as KML_FORMAT, SUPPORT as KML_SUPPORT, exportMission as kmlExport } from '../src/infrastructure/export/kml.js';

/* This is M6 Wave B's exit gate (ADR 0010 §3, §4): GPX 1.1 export and import,
 * KML 2.2 export, against the frozen adapter contract Wave A shipped. Four
 * things are under test — the module surface Wave D's router depends on, the
 * export mapping (geometry native, everything else a named loss), import's
 * three-tier geometry fallback (trk, then rte, then bare wpt) against golden
 * fixtures verified against the topografix schema, and import security: a
 * hostile file is refused, not survived, and text that looks like markup
 * arrives inert rather than executed. */

/* ---------- fixture helpers, mirroring mission-compile.test.mjs ---------- */

const AUSTIN = { latitude: 30.2672, longitude: -97.7431, elevationMslM: 168 };
const RIDGE = { latitude: 30.3, longitude: -97.8 };
const SADDLE = { latitude: 30.4, longitude: -97.9 };

/** Deterministic identity and a clock that ticks one second per command. */
function harness() {
  let ids = 0;
  let ticks = 0;
  return {
    idgen: (prefix) => `${prefix}_${++ids}`,
    now: () => new Date(Date.UTC(2026, 6, 31, 12, 0, ticks++)).toISOString(),
  };
}

const run = (doc, commands, deps) => commands.reduce((d, c) => missionReduce(d, c, deps), doc);
const wp = (at, rest = {}) => ({ type: 'addWaypoint', payload: { ...at, ...rest } });

/** A mission at `launch` with whatever route `commands` describes, guaranteed valid. */
function mission({ launch = AUSTIN, commands = [] } = {}) {
  const deps = harness();
  const start = createMission({ launch, title: 'Pedernales ridge run' }, deps);
  const doc = run(start, commands, deps);
  assert.deepEqual(validateMission(doc).errors, [], 'fixture must be a valid document');
  return doc;
}

const concepts = (compiled) => compiled.inventory.map((entry) => entry.concept);

/** A mission using every one of the compiler's concepts, for the loss exit gate. */
function richCompiled() {
  const doc = mission({
    commands: [
      wp(RIDGE, { intent: 'hold', holdS: 12 }),
      wp(SADDLE, { intent: 'reveal' }),
      {
        type: 'setCameraProfile',
        payload: {
          profile: {
            name: 'Full-frame mirrorless camera',
            sensorWidthMm: 36, sensorHeightMm: 24, focalLengthMm: 24, stabilized: false,
          },
        },
      },
    ],
  });
  return compileMission(doc);
}

const fixture = (name) => readFileSync(new URL(`./fixtures/interop/${name}`, import.meta.url), 'utf8');

/* ---------- 1. the module surface Wave D's router depends on ---------- */

test('gpx.js exports the frozen FORMAT descriptor', () => {
  assert.deepEqual(GPX_FORMAT, { id: 'gpx', label: 'GPX 1.1', extensions: ['.gpx'], mime: 'application/gpx+xml' });
  assert.ok(Object.isFrozen(GPX_FORMAT));
  assert.ok(Object.isFrozen(GPX_FORMAT.extensions));
});

test('kml.js exports the frozen FORMAT descriptor', () => {
  assert.deepEqual(KML_FORMAT, {
    id: 'kml', label: 'KML', extensions: ['.kml'], mime: 'application/vnd.google-earth.kml+xml',
  });
  assert.ok(Object.isFrozen(KML_FORMAT));
  assert.ok(Object.isFrozen(KML_FORMAT.extensions));
});

test('both adapters declare the same support table: geometry native, altitude approximate, the rest unsupported', () => {
  const expected = {
    geometry: 'native',
    'altitude-reference': 'approximate',
    speed: 'unsupported',
    hold: 'unsupported',
    'camera-intent': 'unsupported',
    'return-policy': 'unsupported',
    reserve: 'unsupported',
  };
  for (const SUPPORT of [GPX_SUPPORT, KML_SUPPORT]) {
    assert.deepEqual(SUPPORT, expected);
    assert.ok(Object.isFrozen(SUPPORT));
  }
});

/* ---------- 2. GPX export mapping ---------- */

test('exportMission writes launch as a named wpt and the first trkpt, and slugs the filename', () => {
  const compiled = compileMission(mission({ commands: [wp(RIDGE), wp(SADDLE)] }));
  const result = gpxExport(compiled, { filenameBase: 'My Mission!' });

  assert.notEqual(result.status, 'failed');
  assert.equal(result.payload.filename, 'my-mission.gpx');
  assert.equal(result.payload.mime, 'application/gpx+xml');
  assert.match(result.payload.text, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(result.payload.text, /<gpx version="1\.1" creator="fpv-planner" xmlns="http:\/\/www\.topografix\.com\/GPX\/1\/1">/);
  assert.match(result.payload.text, /<wpt lat="30\.2672" lon="-97\.7431">[\s\S]*?<name>Launch<\/name>/);

  const trkptCount = (result.payload.text.match(/<trkpt/g) ?? []).length;
  assert.equal(trkptCount, 3, 'one trkpt for launch plus one per waypoint');
});

test('a subject becomes its own wpt', () => {
  // This app's reducer has no addSubject command yet (M7 owns the scene
  // editor), so the fixture builds scene.subjects by hand — a field this
  // codebase already lets a snapshot builder assign directly (mission-schema.js).
  const doc = mission({ commands: [wp(RIDGE)] });
  const withSubject = {
    ...doc,
    scene: { ...doc.scene, subjects: [{ id: 'sub_1', name: 'Barn', latitude: 30.31, longitude: -97.81, elevationMslM: 210, radiusM: null }] },
  };
  const compiled = compileMission(withSubject);
  const result = gpxExport(compiled);
  assert.match(result.payload.text, /<wpt lat="30\.31" lon="-97\.81">[\s\S]*?<ele>210<\/ele>[\s\S]*?<name>Barn<\/name>/);
});

test('an unresolved altitude omits <ele> and reports a value-level loss naming the point', () => {
  const compiled = compileMission(mission({ launch: { ...AUSTIN, elevationMslM: null }, commands: [wp(RIDGE)] }));
  const result = gpxExport(compiled);

  assert.equal(result.status, 'degraded');
  assert.equal(result.payload.text.includes('<ele>'), false, 'nothing resolved to MSL here, so nothing is written');
  const loss = result.semanticLosses.find((l) => l.detail.includes(compiled.points[0].id));
  assert.ok(loss, 'the point is named in a loss entry');
  assert.equal(loss.concept, 'altitude-reference');
  assert.equal(loss.disposition, 'approximated');
});

/* ---------- 3. GPX import: the three geometry fallbacks, against golden fixtures ---------- */

test('importMission reads the trk/trkseg/trkpt fixture (topografix-track.gpx) into a valid mission', () => {
  const result = importMission(fixture('topografix-track.gpx'));
  assert.notEqual(result.status, 'failed');
  const doc = result.payload;
  assert.equal(validateMission(doc).ok, true);

  assert.equal(doc.launch.latitude, 30.2672);
  assert.equal(doc.launch.longitude, -97.7431);
  assert.equal(doc.launch.elevationMslM, 168);
  assert.equal(doc.route.waypoints.length, 2);
  assert.equal(doc.route.segments[0].altitude.reference, 'msl');
  assert.equal(doc.route.segments[0].altitude.resolvedMslM, 248);
  assert.equal(doc.route.segments[0].from, 'launch');
  assert.equal(doc.route.segments[1].from, doc.route.waypoints[0].id);

  assert.equal(doc.provenance.origin, 'imported');
  assert.equal(doc.provenance.sourceFormat, 'gpx');
  assert.match(doc.title, /Pedernales/);
  assert.ok(result.semanticLosses.some((l) => l.concept === 'geometry'));
});

test('importMission falls back to rte/rtept (topografix-route.gpx) when there is no trk', () => {
  const result = importMission(fixture('topografix-route.gpx'));
  assert.notEqual(result.status, 'failed');
  const doc = result.payload;
  assert.equal(validateMission(doc).ok, true);
  assert.equal(doc.launch.latitude, 30.2672);
  assert.equal(doc.route.waypoints.length, 1);
  assert.equal(doc.route.segments[0].altitude.resolvedMslM, 248);
});

test('importMission falls back to a bare wpt list (topografix-waypoints.gpx) and reports missing elevation', () => {
  const result = importMission(fixture('topografix-waypoints.gpx'));
  assert.notEqual(result.status, 'failed');
  const doc = result.payload;
  assert.equal(validateMission(doc).ok, true);
  assert.equal(doc.route.waypoints.length, 1);
  assert.equal(doc.route.segments[0].altitude.reference, 'launchRelative');
  assert.equal(doc.route.segments[0].altitude.authored, 80);

  const loss = result.semanticLosses.find((l) => l.concept === 'altitude-reference');
  assert.ok(loss);
  assert.match(loss.detail, /1 waypoint of 1 point/);
});

test('a GPX root that is not <gpx> fails with a machine-readable code', () => {
  const result = importMission(`${XML_DECLARATION}\n<not-gpx/>`);
  assert.equal(result.status, 'failed');
  assert.equal(result.payload, null);
  assert.equal(result.errors[0].code, 'E-GPX-ROOT');
});

test('a lat/lon outside range fails rather than clamps', () => {
  const xml = `${XML_DECLARATION}\n<gpx version="1.1" creator="x" xmlns="http://www.topografix.com/GPX/1/1">`
    + '<wpt lat="200" lon="-97.7"><ele>100</ele></wpt></gpx>';
  const result = importMission(xml);
  assert.equal(result.status, 'failed');
  assert.equal(result.payload, null);
  assert.equal(result.errors[0].code, 'E-GPX-GEO-RANGE');
});

test('a hostile lat value is capped and control-stripped before it is echoed in the error', () => {
  const hostile = `evil${'A'.repeat(200000)}`;
  const xml = `${XML_DECLARATION}\n<gpx version="1.1" creator="x" xmlns="http://www.topografix.com/GPX/1/1">`
    + `<wpt lat="${hostile}" lon="-97.7"/></gpx>`;
  const result = importMission(xml);
  assert.equal(result.status, 'failed');
  assert.equal(result.errors[0].code, 'E-GPX-GEO-RANGE');
  const message = result.errors[0].message;
  assert.ok(message.length < 200, `the echoed value is capped, got ${message.length} chars`);
  for (const ch of message) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    assert.ok(cp >= 0x20 && !(cp >= 0x7f && cp <= 0x9f), 'no control characters survive into the note');
  }
});

/* ---------- 4. round-trip: the exit gate's defined tolerance ---------- */

test('export then import round-trips coordinates within 1e-6° and MSL altitude within 0.1 m', () => {
  const doc = mission({
    commands: [
      wp(RIDGE, { altitude: { authored: 248.123456, reference: 'msl' } }),
      wp(SADDLE, { altitude: { authored: 301.5, reference: 'msl' } }),
    ],
  });
  const compiled = compileMission(doc);
  const exported = gpxExport(compiled);
  assert.notEqual(exported.status, 'failed');

  const imported = importMission(exported.payload.text);
  assert.notEqual(imported.status, 'failed');
  const reDoc = imported.payload;

  assert.ok(Math.abs(reDoc.launch.latitude - compiled.home.latitude) <= 1e-6);
  assert.ok(Math.abs(reDoc.launch.longitude - compiled.home.longitude) <= 1e-6);
  assert.ok(Math.abs(reDoc.launch.elevationMslM - compiled.home.elevationMslM) <= 0.1);

  compiled.points.forEach((point, i) => {
    const waypoint = reDoc.route.waypoints[i];
    const segment = reDoc.route.segments[i];
    assert.ok(Math.abs(waypoint.latitude - point.latitude) <= 1e-6, `waypoint ${i} latitude`);
    assert.ok(Math.abs(waypoint.longitude - point.longitude) <= 1e-6, `waypoint ${i} longitude`);
    assert.ok(Math.abs(segment.altitude.resolvedMslM - point.altitude.amslM) <= 0.1, `waypoint ${i} altitude`);
  });
});

/* ---------- 5. import security: hostile input is refused, not survived ---------- */

test('a DOCTYPE-bearing GPX is refused, not survived', () => {
  const hostile = `${XML_DECLARATION}\n<!DOCTYPE gpx SYSTEM "file:///etc/passwd">\n`
    + '<gpx version="1.1" creator="x" xmlns="http://www.topografix.com/GPX/1/1"><wpt lat="1" lon="1"/></gpx>';
  const result = importMission(hostile);
  assert.equal(result.status, 'failed');
  assert.equal(result.payload, null);
  assert.equal(result.errors[0].code, 'X-DOCTYPE-FORBIDDEN');
});

test('an oversized file is refused before any parser sees it', () => {
  const huge = `${XML_DECLARATION}\n<gpx version="1.1" creator="x" xmlns="http://www.topografix.com/GPX/1/1">`
    + `<!-- ${'x'.repeat(MAX_IMPORT_BYTES + 1)} -->`
    + '</gpx>';
  const result = importMission(huge);
  assert.equal(result.status, 'failed');
  assert.equal(result.payload, null);
  assert.equal(result.errors[0].code, 'E-IMPORT-TOO-LARGE');
});

test('markup nested inside <name> never reaches the title as executable content, and nothing throws', () => {
  const xml = `${XML_DECLARATION}
<gpx version="1.1" creator="x" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name><script>alert(1)</script></name></metadata>
  <wpt lat="30.0" lon="-97.0"><ele>100</ele></wpt>
</gpx>`;
  let result;
  assert.doesNotThrow(() => { result = importMission(xml); });
  assert.notEqual(result.status, 'failed');
  assert.equal(result.payload.title.includes('<'), false, 'the stored title carries no markup');
  assert.equal(result.payload.title.includes('script'), false);
});

/* ---------- 6. every unsupported concept in a rich mission is a named loss ---------- */

test('a mission using every concept loses every one this format cannot hold', () => {
  const compiled = richCompiled();
  assert.deepEqual(concepts(compiled), CONCEPTS.slice(), 'fixture exercises every concept, in CONCEPTS order');

  for (const exportMission of [gpxExport, kmlExport]) {
    const result = exportMission(compiled);
    const lost = result.semanticLosses.map((l) => l.concept);
    for (const concept of ['speed', 'hold', 'camera-intent', 'camera-profile', 'return-policy', 'reserve']) {
      assert.ok(lost.includes(concept), `${concept} should be named as a loss`);
    }
    assert.ok(lost.includes('altitude-reference'), 'altitude-reference is approximated, still a named loss');
    assert.equal(lost.includes('geometry'), false, 'geometry is native, not a loss');
    assert.equal(result.status, 'degraded');
  }
});

/* ---------- 7. KML specifics: lon,lat order and the drape rule ---------- */

test('KML LineString coordinates are lon,lat,alt (longitude first) with altitudeMode absolute when everything resolves', () => {
  const compiled = compileMission(mission({
    commands: [
      wp(RIDGE, { altitude: { authored: 248, reference: 'msl' } }),
      wp(SADDLE, { altitude: { authored: 300, reference: 'msl' } }),
    ],
  }));
  const result = kmlExport(compiled);

  assert.match(result.payload.text, /<kml xmlns="http:\/\/www\.opengis\.net\/kml\/2\.2">/);
  assert.match(result.payload.text, /<altitudeMode>absolute<\/altitudeMode>/);

  const coordBlocks = result.payload.text.match(/<coordinates>[^<]+<\/coordinates>/g);
  const lineCoords = coordBlocks[coordBlocks.length - 1];
  assert.ok(lineCoords.includes(`${compiled.home.longitude},${compiled.home.latitude},${compiled.home.elevationMslM}`),
    'the line starts at launch, longitude first');
});

test('KML drapes the whole line to clampToGround when any altitude is unresolved, and names the loss', () => {
  const compiled = compileMission(mission({ launch: { ...AUSTIN, elevationMslM: null }, commands: [wp(RIDGE)] }));
  const result = kmlExport(compiled);

  assert.match(result.payload.text, /<altitudeMode>clampToGround<\/altitudeMode>/);
  assert.ok(result.semanticLosses.some((l) => l.concept === 'altitude-reference' && /drape/.test(l.detail)));

  const coordBlocks = result.payload.text.match(/<coordinates>[^<]+<\/coordinates>/g);
  const lineCoords = coordBlocks[coordBlocks.length - 1].replace(/<\/?coordinates>/g, '').trim();
  for (const tuple of lineCoords.split(' ')) {
    assert.equal(tuple.split(',').length, 2, 'no fabricated altitude on a clamped line, not even a 0');
  }
});
