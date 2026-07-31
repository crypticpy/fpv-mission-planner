import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { planMission } from '../src/domain/physics.js';
import { plannedCourseDeg } from '../src/terrain.js';
import {
  ANALYSIS_MODEL_VERSION, ANCHOR_SCOPES, MISSION_ANCHOR, SEVERITIES, SEVERITY_RANK,
  anchorAt, constraintId, constraintKey, hashKey, isSeverity, provenanceOf, stableStringify,
} from '../src/application/analysis/analysis-contracts.js';
import {
  CONSTRAINT_CODES, EXPLANATION_CODES, LEGACY_SEVERITY,
  classifyLegacy, draftConstraint, draftFromLegacy, finalizeConstraints,
} from '../src/application/analysis/constraints.js';
import { primaryBearingDeg } from '../src/application/analysis/analyze.js';

/* ADR 0008 asks for stable codes, a fixed severity taxonomy, and an explanation
 * on every finding. The tests that matter here are the ones that fail when a
 * code is renamed, when a producer grows a sentence nobody named, and when the
 * duplicated planned-bearing rule drifts from the copy in src/terrain.js. */

const src = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

/* ---------- 1. the registry is a contract ---------- */

test('the constraint code registry is exactly this list', () => {
  // These ids end up in saved dismissals and exported briefs. Changing one is a
  // deliberate act; this list is where it gets acknowledged.
  assert.deepEqual(Object.keys(CONSTRAINT_CODES).sort(), [
    'W-AIR-DENSITY-ALTITUDE',
    'W-ALT-DENSITY-OPTIMISTIC',
    'W-ALT-VERTICAL-CONSERVATIVE',
    // Retired in M3b and deliberately still registered: the id travels in saved
    // dismissals and exported briefs, and a reader who meets it has to be able
    // to look it up. Nothing produces it any more.
    'W-ALT-VERTICAL-UNMODELLED',
    'W-ANALYSIS-UNCLASSIFIED',
    'W-DATA-ALTITUDE-UNRESOLVED',
    'W-DATA-LINK-ABSENT',
    'W-DATA-TERRAIN-ABSENT',
    'W-DATA-TERRAIN-SAMPLE-MISSING',
    'W-ENERGY-HOVER-NEAR-RATING',
    'W-ENERGY-HOVER-OVER-RATING',
    'W-ENERGY-NO-PACK',
    'W-ENERGY-PACK-COLD',
    'W-ENERGY-PACK-PREHEATED',
    'W-ENERGY-PARALLEL-PACKS',
    'W-ENERGY-SAG-LIMITED',
    'W-LIFT-MARGINAL',
    'W-LIFT-NO-LIFT',
    'W-LIFT-NO-MARGIN',
    'W-RESERVE-HOLD-BUDGET',
    'W-RESERVE-ONE-WAY',
    'W-RETURN-ENERGY-SHORT',
    'W-RETURN-TERRAIN-BLOCKED',
    'W-RETURN-TERRAIN-UNKNOWN',
    'W-RF-FRESNEL',
    'W-RF-LOS-BLOCKED',
    'W-ROUTE-RESERVE-SHORT',
    'W-ROUTE-UNFLYABLE',
    'W-SPEED-POLICY-UNSUPPORTED',
    'W-TERR-CLEARANCE',
    'W-TERR-CLEARANCE-LOW',
    'W-WIND-ACCEL',
    'W-WIND-GUST-AUTHORITY',
    'W-WIND-LEE',
    'W-WIND-LEVEL-MISMATCH',
    'W-WIND-NO-CLOSE',
    'W-WIND-NODATA',
    'W-WIND-REGIME',
    'W-WIND-SENSITIVE',
    'W-WIND-STALE',
    'W-WIND-UPLIFT',
  ]);
});

test('every registry entry is complete and well formed', () => {
  const producers = new Set(['plan', 'terrain', 'link', 'analysis', 'wind']);
  for (const [key, entry] of Object.entries(CONSTRAINT_CODES)) {
    assert.equal(entry.code, key, `${key} disagrees with its own code field`);
    assert.ok(key.startsWith('W-'), `${key} is not namespaced`);
    assert.ok(isSeverity(entry.severity), `${key} has severity ${entry.severity}`);
    assert.ok(producers.has(entry.producer), `${key} has producer ${entry.producer}`);
    assert.ok(entry.legacyLevel === null || entry.legacyLevel in LEGACY_SEVERITY,
      `${key} claims legacy level ${entry.legacyLevel}`);
    assert.ok(entry.explanation.inputs.length > 0, `${key} explains no inputs`);
    assert.ok(entry.explanation.baseline.length > 0, `${key} states no baseline`);
    assert.ok(entry.explanation.limitations.length > 0, `${key} admits no limitations`);
    // A registered legacy level must agree with the mapping, or the table lies.
    if (entry.legacyLevel) {
      assert.equal(entry.severity, LEGACY_SEVERITY[entry.legacyLevel],
        `${key} maps ${entry.legacyLevel} to ${entry.severity}`);
    }
  }
});

test('the legacy level mapping is the whole taxonomy', () => {
  assert.deepEqual(LEGACY_SEVERITY, {
    critical: 'critical',
    serious: 'warning',
    warning: 'caution',
    info: 'advisory',
  });
  for (const severity of Object.values(LEGACY_SEVERITY)) assert.ok(isSeverity(severity));
  assert.deepEqual(SEVERITIES.slice().sort(),
    ['advisory', 'caution', 'critical', 'low-forcing', 'unknown', 'warning']);
  // Ranks are a total order over the taxonomy — the rail sorts on them.
  const ranks = SEVERITIES.map((s) => SEVERITY_RANK[s]);
  assert.deepEqual(ranks, [0, 1, 2, 3, 4, 5]);
  assert.equal(SEVERITY_RANK.unknown < SEVERITY_RANK['low-forcing'], true);
});

test('explanation codes are namespaced and described', () => {
  for (const [code, text] of Object.entries(EXPLANATION_CODES)) {
    assert.ok(code.startsWith('X-'), `${code} is not namespaced`);
    assert.ok(text.length > 0);
  }
});

/* ---------- 2. no producer's sentence goes unnamed ---------- */

const moz7 = {
  dryMassG: 843, propDiaIn: 7.5, numRotors: 4, cdA: 0.042,
  etaProp: 0.55, avionicsW: 12, maxSpeedMs: 30.5, cruiseMs: 18,
};
const nav5000 = { chem: 'liion', s: 6, capAh: 5.0, massG: 499, irPackMilliOhm: 60 };
const rated = { ...moz7, maxThrustGPerRotor: 600 };

const bag = (overrides = {}, env = {}) => ({
  drone: moz7, battery: { ...nav5000 }, payloadG: 0, extraG: 0,
  env: {
    elevM: 167, tempC: 24, rhPct: 40, windFromDeg: 170, windMode: 'headOut',
    windAvgMs: 3.5, windGustMs: 7, ...env,
  },
  landFloorPct: 20, cruiseMode: 'real', realVMs: 18, overheadF: 1.05, ...overrides,
});

/** One fixture per warning physics.js can emit, and the code it must classify to. */
const PLAN_FIXTURES = [
  ['W-LIFT-NO-LIFT', bag({ drone: rated, payloadG: 1600 })],
  ['W-LIFT-NO-MARGIN', bag({ drone: rated, payloadG: 700 })],
  ['W-LIFT-MARGINAL', bag({ drone: rated })],
  ['W-ENERGY-PARALLEL-PACKS', bag({ battery: { ...nav5000, packCount: 2, harnessMassG: 40 } })],
  ['W-WIND-NO-CLOSE', bag({}, { windAvgMs: 31, windGustMs: 35 })],
  ['W-WIND-GUST-AUTHORITY', bag({}, { windAvgMs: 31, windGustMs: 35 })],
  ['W-ENERGY-HOVER-OVER-RATING', bag({ battery: { ...nav5000, maxContA: 5 } })],
  ['W-ENERGY-HOVER-NEAR-RATING', bag({ battery: { ...nav5000, maxContA: 12 } })],
  ['W-ENERGY-SAG-LIMITED', bag({ battery: { ...nav5000, irPackMilliOhm: 400 } })],
  ['W-ENERGY-PACK-COLD', bag({ packTempC: -5 }, { tempC: -5 })],
  ['W-ENERGY-PACK-PREHEATED', bag({ packTempC: 25 }, { tempC: -5 })],
  ['W-AIR-DENSITY-ALTITUDE', bag({}, { elevM: 3200, tempC: 30 })],
];

test('every warning planMission can emit has a code', () => {
  const seen = new Set();
  for (const [expected, inputs] of PLAN_FIXTURES) {
    const plan = planMission(inputs);
    const codes = (plan.warnings ?? []).map((w) => classifyLegacy('plan', w.text));
    for (const code of codes) {
      assert.notEqual(code, 'W-ANALYSIS-UNCLASSIFIED',
        `an unnamed warning reached the registry: ${JSON.stringify(plan.warnings)}`);
      seen.add(code);
    }
    assert.ok(codes.includes(expected),
      `fixture for ${expected} produced ${codes.join(', ') || 'nothing'}`);
  }
  // Between them the fixtures reach every plan-producer code in the registry.
  const registered = Object.values(CONSTRAINT_CODES)
    .filter((e) => e.producer === 'plan').map((e) => e.code);
  assert.deepEqual([...seen].sort(), registered.slice().sort());
});

test('the render producers still say what the matchers look for', () => {
  // The matchers are anchored on prose that lives in another layer. Reading the
  // source is how this test notices a rewrite without importing a DOM module.
  const terrain = src('../src/render/terrain.js');
  assert.match(terrain, /Terrain above your cruise altitude/);
  assert.match(terrain, /of clearance \$\{at\(s\.minClearanceAtKm\)\}/);
  assert.match(terrain, /Energy OK, link blocked/);
  assert.match(terrain, /Energy OK, link degrading/);
  // analyze.js takes W-WIND-NO-CLOSE's text from an injected strandedNote, and
  // M2b feeds that from this export. Losing it is a silent downgrade to the
  // generic sentence, so the seam is named here.
  assert.match(src('../src/render/dashboard.js'), /export function zeroRadiusNote\(/);

  assert.equal(classifyLegacy('terrain', 'Terrain above your cruise altitude: the ground …'),
    'W-TERR-CLEARANCE');
  assert.equal(classifyLegacy('terrain', 'Only 90 ft of clearance 1.2 mi out on the …'),
    'W-TERR-CLEARANCE-LOW');
  assert.equal(classifyLegacy('link', 'Energy OK, link blocked: the pack reaches …'),
    'W-RF-LOS-BLOCKED');
  assert.equal(classifyLegacy('link', 'Energy OK, link degrading: the 5.8 GHz first …'),
    'W-RF-FRESNEL');
});

test('a producer is not allowed to claim another producer’s sentence', () => {
  assert.equal(classifyLegacy('plan', 'Terrain above your cruise altitude: …'),
    'W-ANALYSIS-UNCLASSIFIED');
  assert.equal(classifyLegacy('terrain', 'WILL NOT FLY: 4000 g all-up weight …'),
    'W-ANALYSIS-UNCLASSIFIED');
});

test('an unclassified warning keeps its text and its urgency', () => {
  const draft = draftFromLegacy('plan', { level: 'serious', text: 'Something new happened.' });
  assert.equal(draft.code, 'W-ANALYSIS-UNCLASSIFIED');
  assert.equal(draft.text, 'Something new happened.');
  assert.equal(draft.severity, 'warning', 'serious maps to warning even without a code');

  const odd = draftFromLegacy('plan', { level: 'nonsense', text: 'Who knows.' });
  assert.equal(odd.severity, 'unknown', 'an unrecognised level is an unknown, not a default');
});

test('a classified warning takes its severity from the registry, not the producer', () => {
  // A producer that quietly downgrades its own level must not be able to
  // downgrade the finding — the registry is the contract.
  const draft = draftFromLegacy('plan',
    { level: 'warning', text: 'WILL NOT FLY: 4000 g all-up weight exceeds …' });
  assert.equal(draft.code, 'W-LIFT-NO-LIFT');
  assert.equal(draft.severity, 'critical');
});

/* ---------- 3. ids ---------- */

test('a constraint id is its code and its anchor', () => {
  assert.equal(constraintKey('W-TERR-CLEARANCE', MISSION_ANCHOR), 'W-TERR-CLEARANCE@mission:mission');
  assert.equal(constraintKey('W-TERR-CLEARANCE', anchorAt('segment', 'seg_2')),
    'W-TERR-CLEARANCE@segment:seg_2');
  assert.equal(constraintId('W-TERR-CLEARANCE', anchorAt('sample', 'seg_2:4')),
    'W-TERR-CLEARANCE@sample:seg_2:4');
  assert.equal(constraintId('W-TERR-CLEARANCE', MISSION_ANCHOR, 2), 'W-TERR-CLEARANCE@mission:mission#2');
  assert.deepEqual(ANCHOR_SCOPES.slice(), ['mission', 'segment', 'sample']);
  assert.equal(anchorAt('mission', 'ignored'), MISSION_ANCHOR);
});

test('finalizeConstraints assigns stable, collision-free ids in producer order', () => {
  const ids = finalizeConstraints([
    draftConstraint('W-TERR-CLEARANCE', 'first'),
    draftConstraint('W-RF-FRESNEL', 'second', anchorAt('segment', 'seg_1')),
    draftConstraint('W-TERR-CLEARANCE', 'third'),
    draftConstraint('W-RF-FRESNEL', 'fourth', anchorAt('segment', 'seg_2')),
  ]);
  assert.deepEqual(ids.map((c) => c.id), [
    'W-TERR-CLEARANCE@mission:mission',
    'W-RF-FRESNEL@segment:seg_1',
    'W-TERR-CLEARANCE@mission:mission#2',
    'W-RF-FRESNEL@segment:seg_2',
  ]);
  assert.deepEqual(ids.map((c) => c.text), ['first', 'second', 'third', 'fourth']);
  assert.equal(new Set(ids.map((c) => c.id)).size, 4, 'ids collide');
  assert.ok(Object.isFrozen(ids[0]));

  // Same drafts, same ids: a recompute must not renumber anything.
  const again = finalizeConstraints([
    draftConstraint('W-TERR-CLEARANCE', 'first'),
    draftConstraint('W-RF-FRESNEL', 'second', anchorAt('segment', 'seg_1')),
    draftConstraint('W-TERR-CLEARANCE', 'third'),
    draftConstraint('W-RF-FRESNEL', 'fourth', anchorAt('segment', 'seg_2')),
  ]);
  assert.deepEqual(again.map((c) => c.id), ids.map((c) => c.id));
});

test('an unregistered code is a programming error, not a silent finding', () => {
  assert.throws(() => draftConstraint('W-MADE-UP', 'text'), RangeError);
});

/* ---------- 4. deterministic keys ---------- */

test('stableStringify ignores key order and drops absent properties', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(stableStringify({ a: 1, b: undefined }), stableStringify({ a: 1 }));
  assert.notEqual(stableStringify({ a: 1, b: null }), stableStringify({ a: 1 }));
  assert.equal(stableStringify({ a: [{ y: 1, x: 2 }] }), '{"a":[{"x":2,"y":1}]}');
  // NaN and Infinity are states this tool distinguishes; JSON's null is not.
  assert.equal(stableStringify({ a: NaN }), '{"a":"NaN"}');
  assert.equal(stableStringify({ a: Infinity }), '{"a":"Infinity"}');
  assert.notEqual(stableStringify({ a: NaN }), stableStringify({ a: null }));
});

test('hashKey is stable and sensitive', () => {
  assert.equal(hashKey('abc'), hashKey('abc'));
  assert.notEqual(hashKey('abc'), hashKey('abd'));
  assert.match(hashKey('abc'), /^[0-9a-z]+$/);
});

test('provenanceOf always states every field', () => {
  const p = provenanceOf();
  assert.equal(p.modelVersion, ANALYSIS_MODEL_VERSION);
  for (const key of ['forecastIssue', 'forecastValid', 'terrainSource', 'samplingResolution',
    'calibrationSource', 'retrievedAt']) {
    assert.equal(p[key], null, `${key} should default to a stated null`);
  }
  assert.equal(provenanceOf({ terrainSource: 'DEM' }).terrainSource, 'DEM');
  // The model version is the one thing a caller cannot restate.
  assert.equal(provenanceOf({ modelVersion: 'wishful' }).modelVersion, 'wishful');
  assert.equal(ANALYSIS_MODEL_VERSION, 'analysis-v1');
});

/* ---------- 5. the layering rule arch-check cannot reach ---------- */

test('nothing in src/application imports outside domain and application', () => {
  // arch-check counts these modules as layered, but its rule skips *unlayered
  // targets* so the migration can proceed file by file — and state.js,
  // terrain.js, rf.js, weather.js and all of src/render are still unlayered.
  // ADR 0009's allowlist is therefore unenforced for exactly the imports M2a
  // was told to keep out. This test is that enforcement, and it covers every
  // application module added later, not just today's three.
  const appDir = new URL('../src/application/', import.meta.url);
  /** @param {URL} dir @returns {URL[]} */
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const child = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    return e.isDirectory() ? walk(child) : e.name.endsWith('.js') ? [child] : [];
  });

  const files = walk(appDir);
  assert.ok(files.length >= 3, 'expected to find the analysis modules');
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')   // a doc-block example is not an import
      .replace(/^\s*\/\/.*$/gm, '');
    for (const [, spec] of text.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const rel = fileURLToPath(new URL(spec, file));
      const from = fileURLToPath(file);
      assert.ok(spec.startsWith('.'), `${from} uses a bare specifier '${spec}'`);
      assert.match(rel, /\/src\/(domain|application)\//,
        `${from} imports '${spec}', which is outside domain and application`);
    }
  }
});

/* ---------- 6. the duplicated bearing rule ---------- */

test('the analysis and the terrain profile agree on the planned course', () => {
  // src/terrain.js owns a fetch and a module-level cache, so the application
  // layer restates this rule rather than importing it. The duplication is only
  // safe while the two agree — on every mode, at every degree.
  for (let deg = 0; deg < 360; deg++) {
    for (const mode of ['headOut', 'tailOut', 'cross', undefined]) {
      assert.equal(primaryBearingDeg(deg, mode), plannedCourseDeg(deg, mode),
        `${deg}° in ${mode} mode`);
    }
  }
  // And it survives the shapes a missing forecast can produce.
  assert.equal(primaryBearingDeg(undefined, 'headOut'), 0);
  assert.equal(primaryBearingDeg(NaN, 'cross'), 90);
  assert.equal(primaryBearingDeg(-10, 'headOut'), plannedCourseDeg(-10, 'headOut'));
  assert.equal(primaryBearingDeg(370.4, 'tailOut'), plannedCourseDeg(370.4, 'tailOut'));
});
