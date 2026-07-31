import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileMission } from '../src/domain/mission/compile.js';
import { ID_PREFIXES, createMission, validateMission } from '../src/domain/mission/mission-schema.js';
import {
  FORMAT, SUPPORT, exportMission, importMission,
} from '../src/infrastructure/export/inav-mission.js';

/* INAV's `.mission` is the format this planner can be most wrong in quietly.
 * Altitudes are whole metres, speeds whole centimetres per second, the datum is
 * one bit of an integer attribute, and the launch point is optional planner map
 * state rather than a surveyed home — so the tests here are about what survives
 * the quantisation, what is named when it does not, and the multi-mission file,
 * where the naive read takes waypoints from one mission and a home from another.
 *
 * Both fixtures are the sample files INAV publishes with its schema; see the
 * .provenance.md beside each. */

const FIXTURES = new URL('./fixtures/interop/', import.meta.url);
const fixture = (name) => readFileSync(new URL(name, FIXTURES), 'utf8');

/** Deterministic ids and clock; the tag keeps authored ids apart from minted ones. */
function harness(tag = '') {
  let ids = 0;
  let tick = 0;
  return {
    idgen: (prefix) => `${prefix}_${tag}${++ids}`,
    now: () => new Date(Date.UTC(2026, 6, 31, 12, 0, tick++)).toISOString(),
  };
}

/** Flat ground at 150 m, for the AGL cases. */
const GROUND = () => 150;

const AIRCRAFT = {
  sourceId: 'ac_test', name: 'Test quad', dryMassG: 650, propDiaIn: 5, numRotors: 4, ducted: false,
  etaProp: 0.7, cdA: 0.012, avionicsW: 6, maxSpeedMs: 25, cruiseMs: 11,
  maxThrustGPerRotor: 900, propulsion: null, parallelHarnessMassG: 0,
};

const LAUNCH = { latitude: 54.5707123, longitude: -3.2989342, elevationMslM: 96 };

/** @param {object} spec */
function mission({ stops, returnPolicy, launch = LAUNCH, aircraft = null, scene = [] }, deps) {
  const doc = createMission({
    launch, aircraft, returnPolicy, title: 'Ullswater run',
  }, deps);
  for (const subject of scene) doc.scene.subjects.push(subject);
  let previous = 'launch';
  for (const stop of stops) {
    const waypoint = {
      id: deps.idgen(ID_PREFIXES.waypoint), latitude: stop.latitude, longitude: stop.longitude,
    };
    doc.route.waypoints.push(waypoint);
    doc.route.segments.push({
      id: deps.idgen(ID_PREFIXES.segment),
      from: previous,
      to: waypoint.id,
      altitude: {
        authored: stop.altitude, reference: stop.reference ?? 'launchRelative', resolvedMslM: null,
      },
      speedPolicy: stop.speed ?? { mode: 'fixed', targetMs: 12.5 },
      intent: stop.intent ?? 'transit',
      holdS: stop.holdS ?? null,
      subjectRef: stop.subjectRef ?? null,
      camera: stop.camera ?? null,
    });
    previous = waypoint.id;
  }
  return doc;
}

/* Whole metres, so the round trip has nothing to round. */
const RUN = [
  { latitude: 54.5722109, longitude: -3.2869291, altitude: 50 },
  { latitude: 54.5708178, longitude: -3.2642698, altitude: 65, holdS: 20, intent: 'hold' },
  { latitude: 54.5698227, longitude: -3.2385206, altitude: 40 },
];

function missionOf(spec = {}, deps = harness()) {
  const doc = mission({ stops: RUN, ...spec }, deps);
  const compiled = compileMission(doc, { terrainSampler: spec.terrainSampler ?? null });
  const result = exportMission(compiled, { filenameBase: spec.filenameBase });
  return { doc, compiled, result };
}

/** Every `<missionitem>` as an attribute map, without a parser in the test. */
function itemsOf(result) {
  return [...result.payload.text.matchAll(/<missionitem\b([^>]*)>/g)].map(([, raw]) => {
    /** @type {Record<string, string>} */ const attrs = {};
    for (const [, key, value] of raw.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[key] = value;
    return attrs;
  });
}

const near = (actual, expected, tolerance, what) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `${what}: ${actual} is further than ${tolerance} from ${expected}`,
);

const conceptsOf = (result) => result.semanticLosses.map((loss) => loss.concept);

/* ---------- 1. the document shape ---------- */

test('the file is a declaration, a mission root, a version and a header', () => {
  const { result } = missionOf();
  const text = result.payload.text;

  assert.match(text, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/);
  assert.match(text, /<mission>/);
  // The published samples write `<version ...></version>`; this writer emits the
  // self-closing form of the same empty element. Both are the same document to
  // any XML parser, and the Configurator reads the file with one.
  assert.match(text, /<version value="2\.3-pre8"\/>/);
  assert.match(text, /\n$/);
  assert.equal(result.payload.mime, 'application/xml');
  assert.equal(text.indexOf('<mwp'), text.lastIndexOf('<mwp'), 'one header, not one per waypoint');
});

test('the header carries the real launch point, x as longitude and y as latitude', () => {
  const { result } = missionOf();
  const [, raw] = result.payload.text.match(/<mwp\b([^>]*)>/);

  assert.match(raw, /home-x="-3\.2989342"/, 'home-x is longitude');
  assert.match(raw, /home-y="54\.5707123"/, 'home-y is latitude');
  // cx/cy centre the planner's map on the route, in the same x/y sense.
  const cx = Number(raw.match(/cx="([^"]+)"/)[1]);
  const cy = Number(raw.match(/cy="([^"]+)"/)[1]);
  near(cx, (-3.2869291 + -3.2642698 + -3.2385206) / 3, 1e-6, 'map centre longitude');
  near(cy, (54.5722109 + 54.5708178 + 54.5698227) / 3, 1e-6, 'map centre latitude');
  assert.match(raw, /generator="fpv-planner"/);
});

test('items are numbered from one and the last one carries the end flag', () => {
  const { result } = missionOf({ returnPolicy: { mode: 'direct', altitude: null } });
  const items = itemsOf(result);

  items.forEach((item, i) => assert.equal(item.no, String(i + 1)));
  assert.equal(items[items.length - 1].flag, '165', 'the mission ends where the flag says it does');
  assert.equal(items.filter((item) => item.flag === '165').length, 1, 'one end, one mission');
  for (const item of items.slice(0, -1)) assert.equal('flag' in item, false);
});

test('the payload names itself, and the envelope says where it came from', () => {
  const { result } = missionOf({ filenameBase: 'Ullswater run/take 2' });
  assert.equal(result.payload.filename, 'Ullswater-run-take-2.mission');
  assert.equal(result.sourceFormat, 'mission-document-v1');
  assert.equal(result.targetFormat, FORMAT.id);
  assert.equal(result.adapterVersion, '1.0.0');
  assert.deepEqual([...FORMAT.extensions], ['.mission']);
});

/* ---------- 2. the field mapping ---------- */

test('a plain waypoint carries its speed in parameter1, in centimetres per second', () => {
  const { result } = missionOf();
  const [first] = itemsOf(result);

  assert.equal(first.action, 'WAYPOINT');
  assert.equal(first.parameter1, '1250', '12.5 m/s is 1250 cm/s');
  assert.equal(first.parameter2, '0');
  assert.equal(first.lat, '54.5722109');
  assert.equal(first.lon, '-3.2869291');
  assert.equal(first.alt, '50', 'whole metres, not centimetres');
});

test('a holding waypoint becomes POSHOLD_TIME, and its two parameters change meaning', () => {
  const items = itemsOf(missionOf().result);
  const hold = items[1];

  assert.equal(hold.action, 'POSHOLD_TIME');
  assert.equal(hold.parameter1, '20', 'parameter1 is the dwell in seconds here');
  assert.equal(hold.parameter2, '1250', 'and the speed moves to parameter2');
  assert.equal(items[0].action, 'WAYPOINT', 'a transit stays a plain waypoint');
});

test('parameter3 bit zero is the datum, and nothing else in that field is touched', () => {
  // RTH carries no altitude of its own, so the datum bit is only asserted on the
  // items that fly to a place.
  const flown = (result) => itemsOf(result).filter((item) => item.action !== 'RTH');

  for (const item of flown(missionOf().result)) {
    assert.equal(item.parameter3, '0', 'relative to home');
  }
  const msl = flown(missionOf({ stops: RUN.map((s) => ({ ...s, reference: 'msl' })) }).result);
  assert.equal(msl.length, 3);
  for (const item of msl) assert.equal(item.parameter3, '1', 'bit 0 set is above sea level');
});

test('a direct return is an RTH item with no position of its own', () => {
  const direct = missionOf({ returnPolicy: { mode: 'direct', altitude: null } }).result;
  const items = itemsOf(direct);
  const rth = items[items.length - 1];

  assert.equal(rth.action, 'RTH');
  assert.equal(rth.lat, '0.0000000');
  assert.equal(rth.lon, '0.0000000');
  assert.equal(rth.parameter1, '0', '0 is "return without forcing a landing"');
  assert.equal(rth.flag, '165');

  const retrace = missionOf({ returnPolicy: { mode: 'retrace', altitude: null } }).result;
  assert.equal(itemsOf(retrace).some((item) => item.action === 'RTH'), false);
  assert.ok(retrace.semanticLosses.some((l) => l.concept === 'return-policy' && /retraced/.test(l.detail)));
});

test('a mission with no launch elevation still exports, because this format never needed one', () => {
  // The two MAVLink adapters refuse here: both put an absolute home altitude in
  // a required field. INAV's altitudes are relative to a home the aircraft sets
  // for itself, so there is no number to invent and nothing to refuse.
  const { result } = missionOf({ launch: { ...LAUNCH, elevationMslM: null } });
  assert.equal(result.status, 'degraded');
  assert.ok(result.payload.text.includes('home-y="54.5707123"'), 'the position still rides in the header');

  const flown = itemsOf(result).filter((item) => item.action !== 'RTH');
  assert.equal(flown.length, 3);
  assert.deepEqual(flown.map((item) => item.alt), ['50', '65', '40'], 'the authored heights, unchanged');
  assert.deepEqual(flown.map((item) => item.parameter3), ['0', '0', '0'], 'relative to the home it will set');
});

test('an unresolved speed is the format\'s own "fly your configured cruise", not an invented number', () => {
  const cruise = { mode: 'cruise', targetMs: null };
  const unresolved = missionOf({ stops: RUN.map((s) => ({ ...s, speed: cruise })) }).result;
  for (const item of itemsOf(unresolved)) {
    assert.equal(item.parameter1 === '0' || item.parameter2 === '0', true, '0 means "no speed given"');
  }
  assert.ok(unresolved.semanticLosses.some((l) => l.concept === 'speed'));

  const resolved = missionOf({ aircraft: AIRCRAFT, stops: RUN.map((s) => ({ ...s, speed: cruise })) }).result;
  assert.equal(itemsOf(resolved)[0].parameter1, '1100', 'the aircraft\'s own 11 m/s');
});

/* ---------- 3. what the quantisation costs ---------- */

test('a fractional altitude is rounded to the format\'s precision and the loss says which waypoint', () => {
  const { result } = missionOf({ stops: [{ ...RUN[0], altitude: 62.4 }, { ...RUN[1], altitude: 50 }] });
  const items = itemsOf(result);

  assert.equal(items[0].alt, '62');
  assert.equal(items[1].alt, '50');
  const loss = result.semanticLosses.find((l) => /rounded to whole metres/.test(l.detail));
  assert.ok(loss, 'the rounding is named');
  assert.equal(loss.disposition, 'approximated');
  assert.match(loss.detail, /waypoint 1$/, 'and only the waypoint it happened at');
  assert.equal(missionOf().result.semanticLosses.some((l) => /rounded/.test(l.detail)), false,
    'whole metres round-trip with nothing to say');
});

test('an AGL altitude is re-referenced rather than written as if the format had a ground datum', () => {
  const { result } = missionOf({
    stops: RUN.map((s) => ({ ...s, reference: 'agl' })), terrainSampler: GROUND,
  });
  const loss = result.semanticLosses.find((l) => /re-referenced/.test(l.detail));

  assert.ok(loss, 'the datum change is named');
  assert.equal(loss.concept, 'altitude-reference');
  assert.match(loss.detail, /rather than following the terrain/,
    'and what the aircraft will actually do is said plainly');
  // 150 m of ground under a 50 m AGL altitude, against a 96 m launch: 104 m
  // above the launch point.
  assert.equal(itemsOf(result)[0].alt, '104');
  assert.equal(itemsOf(result)[0].parameter3, '0', 'now a launch-relative height');
});

test('an AGL altitude with nothing to re-reference it against is refused', () => {
  const { result } = missionOf({
    stops: [{ ...RUN[0], reference: 'agl' }], launch: { ...LAUNCH, elevationMslM: null },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.payload, null);
  assert.equal(result.errors[0].code, 'E-INAV-ALTITUDE-UNRESOLVED');
});

test('the support table records altitude as approximate, which is what whole metres are', () => {
  assert.deepEqual(SUPPORT, {
    geometry: 'native',
    'altitude-reference': 'approximate',
    speed: 'native',
    hold: 'native',
    'camera-intent': 'unsupported',
    'return-policy': 'native',
    reserve: 'unsupported',
  });
  assert.equal(Object.isFrozen(SUPPORT), true);
  // Hold and speed stay native: whole seconds and whole cm/s are finer than the
  // 1 s and 0.1 m/s this planner promises to preserve. Whole metres are not
  // finer than 0.1 m, so altitude cannot make the same claim.
  const concepts = conceptsOf(missionOf().result);
  assert.ok(concepts.includes('altitude-reference'), 'every export says the altitude is approximate');
  assert.equal(concepts.includes('hold'), false);
  assert.equal(concepts.includes('speed'), false);
});

test('a rich mission names every concept this format cannot hold', () => {
  const scene = [{
    id: 'sub_1', name: 'Ullswater pier', latitude: 54.5708, longitude: -3.2642,
    elevationMslM: 150, radiusM: 40,
  }];
  const stops = [
    { ...RUN[0] },
    { ...RUN[1], subjectRef: 'sub_1', camera: { tilt: -25 } },
    { ...RUN[2], intent: 'orbit' },
  ];
  const { result } = missionOf({ stops, scene, returnPolicy: { mode: 'direct', altitude: null } });

  assert.equal(result.status, 'degraded');
  assert.deepEqual(conceptsOf(result).sort(), ['altitude-reference', 'camera-intent', 'reserve']);
  for (const loss of result.semanticLosses) assert.ok(loss.detail.length > 0);
});

/* ---------- 4. the round trip ---------- */

test('a mission survives export and import inside ADR 0010\'s tolerances', () => {
  const { doc, result } = missionOf({ returnPolicy: { mode: 'direct', altitude: null } });
  const back = importMission(result.payload.text, harness('in'));

  assert.equal(back.payload.route.waypoints.length, doc.route.waypoints.length);
  doc.route.waypoints.forEach((original, i) => {
    const arrived = back.payload.route.waypoints[i];
    near(arrived.latitude, original.latitude, 1e-6, `waypoint ${i} latitude`);
    near(arrived.longitude, original.longitude, 1e-6, `waypoint ${i} longitude`);
  });
  doc.route.segments.forEach((original, i) => {
    const arrived = back.payload.route.segments[i];
    near(arrived.altitude.authored, original.altitude.authored, 0.1, `segment ${i} altitude`);
    assert.equal(arrived.altitude.reference, original.altitude.reference);
    near(arrived.speedPolicy.targetMs, 12.5, 0.1, `segment ${i} speed`);
    if (original.holdS !== null) near(arrived.holdS, original.holdS, 1, `segment ${i} hold`);
    else assert.equal(arrived.holdS, null);
  });
  assert.equal(back.payload.route.returnPolicy.mode, 'direct');
  near(back.payload.launch.latitude, LAUNCH.latitude, 1e-6, 'launch latitude');
  near(back.payload.launch.longitude, LAUNCH.longitude, 1e-6, 'launch longitude');
});

test('the launch elevation does not survive, because the file has nowhere to put it', () => {
  const { result } = missionOf();
  const back = importMission(result.payload.text, harness('in'));

  assert.equal(back.payload.launch.elevationMslM, null, 'better absent than fabricated');
  assert.ok(back.semanticLosses.some((l) => /carries no elevation/.test(l.detail)));
});

test('an MSL mission comes back MSL, by the one bit that says so', () => {
  const { result } = missionOf({ stops: RUN.map((s) => ({ ...s, reference: 'msl' })) });
  const back = importMission(result.payload.text, harness('in'));
  for (const segment of back.payload.route.segments) {
    assert.equal(segment.altitude.reference, 'msl');
  }
});

test('ids do not survive the trip, and the import says so rather than pretending', () => {
  const { doc, result } = missionOf();
  const back = importMission(result.payload.text, harness('in'));
  const originalIds = new Set(doc.route.waypoints.map((w) => w.id));

  for (const waypoint of back.payload.route.waypoints) {
    assert.match(waypoint.id, /^wpt_in\d+$/, 'ids come from the caller\'s generator');
    assert.equal(originalIds.has(waypoint.id), false);
  }
  assert.ok(back.semanticLosses.some((l) => /minted fresh ids/.test(l.detail)));
});

test('an imported document is one the schema accepts, and says it was imported', () => {
  const { result } = missionOf();
  const back = importMission(result.payload.text, harness('in'));

  assert.equal(validateMission(back.payload).ok, true);
  assert.deepEqual(validateMission(back.payload).errors, []);
  assert.equal(back.payload.provenance.origin, 'imported');
  assert.equal(back.payload.provenance.sourceFormat, FORMAT.id);
  assert.equal(back.sourceFormat, FORMAT.id);
  assert.equal(back.targetFormat, 'mission-document-v1');
  assert.equal(back.status, 'degraded');
  for (const segment of back.payload.route.segments) {
    assert.equal(segment.altitude.resolvedMslM, null);
  }
});

/* ---------- 5. refusals and hostile input ---------- */

test('an empty mission is refused rather than written as a file with no items', () => {
  const empty = missionOf({ stops: [] }).result;
  assert.equal(empty.status, 'failed');
  assert.equal(empty.errors[0].code, 'E-INAV-EMPTY');
});

test('a DOCTYPE is refused before anything in the document is read', () => {
  const hostile = '<?xml version="1.0"?>\n'
    + '<!DOCTYPE mission [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n'
    + '<mission><missionitem no="1" action="WAYPOINT" lat="54.5" lon="-3.2" alt="50"'
    + ' parameter1="0" parameter2="0" parameter3="0" flag="165"></missionitem></mission>\n';
  const result = importMission(hostile, harness());

  assert.equal(result.status, 'failed');
  assert.equal(result.payload, null);
  assert.equal(result.errors[0].code, 'X-DOCTYPE-FORBIDDEN');
  assert.equal(result.errors.some((e) => /passwd/.test(e.message)), false,
    'the refusal does not quote the payload back');
});

test('a standalone ENTITY declaration is refused too', () => {
  const result = importMission('<!ENTITY x "y"><mission></mission>', harness());
  assert.equal(result.status, 'failed');
  assert.equal(result.errors[0].code, 'X-ENTITY-FORBIDDEN');
});

test('a document that is not a mission is refused by its root element', () => {
  const cases = [
    ['<gpx version="1.1"><wpt lat="1" lon="2"></wpt></gpx>', 'E-INAV-ROOT'],
    ['<mission></mission>', 'E-INAV-NO-ITEMS'],
    ['<mission><version value="2.3-pre8"></version></mission>', 'E-INAV-NO-ITEMS'],
  ];
  for (const [text, code] of cases) {
    const result = importMission(text, harness());
    assert.equal(result.status, 'failed', text);
    assert.equal(result.errors[0].code, code, text);
  }
  assert.equal(importMission('not xml at all', harness()).status, 'failed');
});

test('an item with a missing or non-numeric position is refused, not read as zero', () => {
  const item = (attrs) => `<mission><missionitem no="1" action="WAYPOINT" ${attrs} flag="165"></missionitem></mission>`;
  const cases = [
    ['lat="fifty" lon="-3.2" alt="50"', 'E-INAV-ITEM-NUMBERS'],
    ['lat="54.5" alt="50"', 'E-INAV-ITEM-NUMBERS'],
    ['lat="54.5" lon="-3.2"', 'E-INAV-ITEM-NUMBERS'],
    ['lat="54.5" lon="-3.2" alt=""', 'E-INAV-ITEM-NUMBERS'],
    ['lat="91.2" lon="-3.2" alt="50"', 'E-INAV-GEO-RANGE'],
    ['lat="54.5" lon="-183.2" alt="50"', 'E-INAV-GEO-RANGE'],
  ];
  for (const [attrs, code] of cases) {
    const result = importMission(item(attrs), harness());
    assert.equal(result.status, 'failed', attrs);
    assert.equal(result.errors[0].code, code, attrs);
    assert.equal(result.payload, null, attrs);
  }
});

test('a file of actions this planner cannot fly is refused, with the actions named', () => {
  const text = '<mission>'
    + '<missionitem no="1" action="JUMP" lat="0" lon="0" alt="0" parameter1="1" parameter2="0" parameter3="0"></missionitem>'
    + '<missionitem no="2" action="SET_HEAD" lat="0" lon="0" alt="0" parameter1="90" parameter2="0" parameter3="0" flag="165"></missionitem>'
    + '</mission>';
  const result = importMission(text, harness());
  assert.equal(result.status, 'failed');
  assert.equal(result.errors[0].code, 'E-INAV-NO-WAYPOINTS');
});

test('a hostile __proto__ in the document does not reach Object.prototype', () => {
  const text = '<mission>'
    + '<__proto__ polluted="true"></__proto__>'
    + '<missionitem no="1" action="WAYPOINT" lat="54.5722109" lon="-3.2869291" alt="50"'
    + ' parameter1="0" parameter2="0" parameter3="0" __proto__="polluted" constructor="polluted"'
    + ' flag="165"></missionitem>'
    + '</mission>';
  const result = importMission(text, harness('in'));

  assert.equal(result.status, 'degraded', 'the mission is still readable');
  assert.equal(({}).polluted, undefined, 'nothing reached Object.prototype');
  assert.equal(({}).constructor, Object, 'and constructor is still constructor');
  assert.equal(Object.hasOwn(result.payload, '__proto__'), false);
  assert.equal(Object.getPrototypeOf(result.payload), Object.prototype);
  assert.equal(JSON.stringify(result.payload).includes('polluted'), false);
  // The keys the format does not define are dropped, and named rather than
  // silently swallowed.
  const dropped = result.semanticLosses.find((l) => /vendor extensions/.test(l.detail));
  assert.ok(dropped, 'the unknown element and attributes are named');
  assert.match(dropped.detail, /__proto__/);
});

test('a file too large to trust is refused before it is parsed', () => {
  const oversized = `<mission>${'<!-- pad -->'.repeat(500000)}</mission>`;
  const result = importMission(oversized, harness());
  assert.equal(result.status, 'failed');
  assert.equal(result.errors[0].code, 'E-IMPORT-TOO-LARGE');
});

test('a fractional altitude in a file is a warning, because INAV would truncate it', () => {
  const text = '<mission><missionitem no="1" action="WAYPOINT" lat="54.5722109" lon="-3.2869291"'
    + ' alt="50.7" parameter1="0" parameter2="0" parameter3="0" flag="165"></missionitem></mission>';
  const result = importMission(text, harness('in'));

  assert.equal(result.payload.route.segments[0].altitude.authored, 50.7, 'the file said 50.7');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /truncate/, 'and the aircraft would fly 50');
});

/* ---------- 6. the fixtures ---------- */

test('INAV\'s own sequential sample imports as its first mission only', () => {
  const result = importMission(fixture('inav-schema-sequential.mission'), harness('in'));

  assert.equal(result.status, 'degraded');
  assert.equal(validateMission(result.payload).ok, true);
  assert.equal(result.payload.route.waypoints.length, 3, 'three items before the first flag 165');
  near(result.payload.route.waypoints[0].latitude, 54.5722109, 1e-6, 'first waypoint');
  near(result.payload.route.waypoints[2].latitude, 54.5698227, 1e-6, 'last waypoint of mission one');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /more than one mission/);
});

test('a zero home in the sample means "no home was set", not the Gulf of Guinea', () => {
  const text = fixture('inav-schema-sequential.mission');
  assert.match(text, /home-x="0" home-y="0"/);

  const result = importMission(text, harness('in'));
  near(result.payload.launch.latitude, 54.5722109, 1e-6, 'the launch fell back to the first waypoint');
  near(result.payload.launch.longitude, -3.2869291, 1e-6, 'the launch fell back to the first waypoint');
  assert.ok(result.semanticLosses.some((l) => /first waypoint was used as the launch/.test(l.detail)));
});

test('the mwp sample reads <meta> as a header, and takes the home of the mission it imported', () => {
  const result = importMission(fixture('inav-schema-mwp-meta.mission'), harness('in'));

  assert.equal(validateMission(result.payload).ok, true);
  assert.equal(result.payload.route.waypoints.length, 3);
  // Each mission in this file carries its own <meta home-x/home-y>. Reading the
  // last one would put the launch ~950 m from every waypoint imported.
  near(result.payload.launch.latitude, 54.5707123, 1e-6, 'the first mission\'s home');
  near(result.payload.launch.longitude, -3.2989342, 1e-6, 'the first mission\'s home');
  assert.ok(result.semanticLosses.some((l) => /planner map home/.test(l.detail)));
});

test('a comment, a nested <details> and an unknown version do not stop the read', () => {
  const text = fixture('inav-schema-mwp-meta.mission');
  assert.match(text, /<!--mw planner 0\.01-->/);
  assert.match(text, /<version value="42">/, 'not a version any INAV release ships');

  const result = importMission(text, harness('in'));
  assert.equal(result.status, 'degraded');
  const dropped = result.semanticLosses.find((l) => /vendor extensions/.test(l.detail));
  assert.ok(dropped, 'mwptools\' own metadata is dropped and named');
  assert.match(dropped.detail, /<details>/);
});

test('a fixture round-trips through this adapter without moving', () => {
  const imported = importMission(fixture('inav-schema-sequential.mission'), harness('in'));
  const compiled = compileMission(imported.payload);
  const again = importMission(exportMission(compiled).payload.text, harness('re'));

  imported.payload.route.waypoints.forEach((original, i) => {
    const arrived = again.payload.route.waypoints[i];
    near(arrived.latitude, original.latitude, 1e-6, `waypoint ${i} latitude`);
    near(arrived.longitude, original.longitude, 1e-6, `waypoint ${i} longitude`);
  });
  imported.payload.route.segments.forEach((original, i) => {
    near(again.payload.route.segments[i].altitude.authored, original.altitude.authored, 0.1, `segment ${i}`);
    assert.equal(again.payload.route.segments[i].altitude.reference, original.altitude.reference);
  });
});
