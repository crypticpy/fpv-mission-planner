import test from 'node:test';
import assert from 'node:assert/strict';

import { destination, distanceKm } from '../src/domain/geo.js';
import { planMission, U } from '../src/domain/physics.js';
import { planRoute } from '../src/domain/route.js';
import { createMission } from '../src/domain/mission/mission-schema.js';
import { missionReduce } from '../src/domain/mission/mission-reducer.js';
import { resolveMissionAltitudes } from '../src/domain/mission/altitude.js';
import { analyzeMission, clearAnalysisCache } from '../src/application/analysis/analyze.js';
import {
  TERRAIN_CLEARANCE_WARN_M,
} from '../src/application/analysis/analysis-contracts.js';
import { createTerrainSampler, nearestGroundSampler } from '../src/application/terrain/sample-corridor.js';
import { CLEARANCE_WARN_M } from '../src/terrain.js';

/* Milestone 3's exit gate, as tests.
 *
 * Everything here runs END TO END: a real mission document, through the real
 * pipeline, whose published corridor is answered by the real corridor sampler
 * over a synthetic surface, whose field goes back through the real pipeline as
 * the terrain port. Nothing about the ground is hand-fed to the constraint code
 * — if the ids the corridor publishes and the ids the field returns ever stop
 * matching, these fail rather than quietly anchoring a warning at nothing.
 *
 * The four gate bullets, and where each is proved:
 *
 *   1. seven surfaces (flat, ridge, valley, saddle, pass, cliff, missing tile)
 *      survive the whole path, and a ridge under a low leg produces a clearance
 *      constraint anchored at the sample that caused it — §2, §3;
 *   2. unknown clearance is never presentable as clear — §4;
 *   3. terrain, physics, RF, wind and the renderer share one set of sample
 *      identifiers — §5;
 *   4. density and wind move with altitude where the forecast supports it, and
 *      no gradient is invented where it does not — §6.
 */

const AUSTIN = { lat: 30.2672, lng: -97.7431 };
const LAUNCH_ELEV_M = 168;
const AT = '2026-07-30T12:00:00.000Z';

const moz7 = {
  dryMassG: 843, propDiaIn: 7.5, numRotors: 4, cdA: 0.042,
  etaProp: 0.55, avionicsW: 12, maxSpeedMs: 30.5, cruiseMs: 18,
};
const nav5000 = { chem: 'liion', s: 6, capAh: 5.0, massG: 499, irPackMilliOhm: 60 };

function inputs(envOverrides = {}) {
  return {
    drone: moz7, battery: nav5000, payloadG: 0, extraG: 0,
    env: {
      elevM: LAUNCH_ELEV_M, tempC: U.fToC(75), rhPct: 40,
      windFromDeg: 170, windMode: 'headOut',
      windAvgMs: U.mphToMs(8), windGustMs: U.mphToMs(16),
      ...envOverrides,
    },
    landFloorPct: 20, cruiseMode: 'real', realVMs: moz7.cruiseMs, overheadF: 1.05,
  };
}

function idgen() {
  const counts = Object.create(null);
  return (prefix) => `${prefix}_${counts[prefix] = (counts[prefix] ?? 0) + 1}`;
}

const wpAt = (courseDeg, km) => {
  const [lat, lng] = destination(AUSTIN.lat, AUSTIN.lng, courseDeg, km);
  return { lat, lng };
};

/** A mission from `{ at, altM }` points, built through the real reducer. */
function mission(points) {
  const deps = {
    idgen: idgen(),
    now: () => AT,
    onWarning: (w) => assert.fail(`fixture rejected: ${w.code} ${w.message}`),
  };
  let doc = createMission({
    launch: { latitude: AUSTIN.lat, longitude: AUSTIN.lng, elevationMslM: LAUNCH_ELEV_M },
    title: 'terrain gate',
  }, deps);
  for (const p of points) {
    doc = missionReduce(doc, {
      type: 'addWaypoint',
      payload: {
        latitude: p.at.lat,
        longitude: p.at.lng,
        intent: p.intent ?? 'transit',
        altitude: p.altitude ?? { authored: p.altM ?? 80, reference: 'launchRelative' },
      },
    }, deps);
  }
  return resolveMissionAltitudes(doc).doc;
}

const revisionOf = (doc) => ({ missionId: doc.id, missionUpdatedAt: doc.updatedAt });
const codes = (snap) => snap.constraints.map((c) => c.code);
const has = (snap, code) => codes(snap).includes(code);
const find = (snap, code) => snap.constraints.find((c) => c.code === code) ?? null;

/* ---------- 1. the surfaces ---------- */

/**
 * Every fixture is a function of distance from launch, in km, to ground
 * elevation in metres MSL — or null for a hole in the data. Synthetic on
 * purpose: a real DEM tile would make the assertions below depend on Copernicus
 * rather than on the code under test.
 */
const SURFACES = {
  /** Featureless. Nothing to say about it, which is itself worth proving. */
  flat: () => LAUNCH_ELEV_M,

  /* A flat-topped rise 140 m above launch between 1.3 and 1.7 km. Flat-topped on
   * purpose: a Gaussian peak's sampled height depends on where the corridor's
   * stations happen to fall, so the margin under a leg would drift with the
   * route length rather than being a fact about the fixture. */
  ridge: (km) => LAUNCH_ELEV_M + (km >= 1.3 && km <= 1.7 ? 140 : 0),

  /** The inverse: the ground falls away to 90 m below launch at 1.5 km. */
  valley: (km) => LAUNCH_ELEV_M - 90 * Math.exp(-((km - 1.5) ** 2) / 0.05),

  /** Two peaks with a dip between them — the classic saddle. */
  saddle: (km) => LAUNCH_ELEV_M
    + 130 * Math.exp(-((km - 1.0) ** 2) / 0.02)
    + 130 * Math.exp(-((km - 2.0) ** 2) / 0.02)
    + 60 * Math.exp(-((km - 1.5) ** 2) / 0.06),

  /** High ground either side of a low gap the route threads. */
  pass: (km) => LAUNCH_ELEV_M + 120 - 120 * Math.exp(-((km - 1.5) ** 2) / 0.08),

  /** A step: level, then 110 m higher from 1.4 km out and staying there. */
  cliff: (km) => LAUNCH_ELEV_M + (km >= 1.4 ? 110 : 0),

  /** Ground everywhere except a band the provider has nothing for. */
  missingTile: (km) => (km > 1.2 && km < 2.0 ? null : LAUNCH_ELEV_M),
};

/**
 * An elevation provider over one surface. Same port shape as the Open-Meteo
 * adapter, and nothing here touches the network.
 */
function surfaceProvider(surface, { notes = [] } = {}) {
  return {
    source: 'synthetic surface',
    dataset: 'test fixture',
    resolutionM: 30,
    attribution: 'Elevation data by the test fixture (no licence, no reality)',
    async elevations(points) {
      const elevationsM = points.map((p) => surface(distanceKm(AUSTIN, { lat: p.lat, lng: p.lng })));
      const answered = elevationsM.filter((e) => e != null).length;
      return {
        elevationsM,
        provenance: {
          source: 'synthetic surface',
          dataset: 'test fixture',
          resolutionM: 30,
          attribution: 'Elevation data by the test fixture (no licence, no reality)',
          retrievedAt: AT,
          requested: points.length,
          answered,
          missing: points.length - answered,
          batches: 1,
          notes: Object.freeze(notes.slice()),
        },
      };
    },
  };
}

/**
 * The whole path: analyse, sample the corridor the analysis published, analyse
 * again with the field in hand. Two passes is not a test artefact — it is
 * exactly what the host does, because the corridor is a *product* of the
 * analysis and cannot be sampled before it exists.
 */
async function analyzeOverGround(doc, { surface, inp = inputs(), extra = {} } = {}) {
  clearAnalysisCache();
  const deps = { plan: planMission, routePlan: planRoute, now: () => AT, ...extra };
  const dry = analyzeMission({ doc, inputs: inp, revision: revisionOf(doc) }, deps);
  if (!surface) return { dry, field: null, wet: dry };
  const sample = createTerrainSampler({
    provider: surfaceProvider(surface),
    crossTrackOffsetM: 300,
    now: () => AT,
  });
  const field = await sample(dry.corridor);
  clearAnalysisCache();
  const wet = analyzeMission({ doc, inputs: inp, revision: revisionOf(doc) }, {
    ...deps, terrainField: () => field, terrainSignature: 'fixture',
  });
  return { dry, field, wet };
}

/* ---------- 2. one threshold, one place ---------- */

test('the pipeline and the terrain card agree on what "low clearance" means', () => {
  assert.equal(TERRAIN_CLEARANCE_WARN_M, CLEARANCE_WARN_M,
    'the route-wide check and the single-bearing card must not disagree about the number — '
    + 'the pipeline restates it because ADR 0009 forbids the import, not because it is free to differ');
});

/* ---------- 3. every surface, end to end ---------- */

test('every terrain fixture survives the whole path, corridor to constraints', async () => {
  // 40 m above launch: low enough that the ridge, the cliff and the saddle are
  // genuinely in the way, high enough that flat ground is not.
  const doc = mission([{ at: wpAt(45, 1.0), altM: 40 }, { at: wpAt(45, 3.0), altM: 40 }]);

  for (const [name, surface] of Object.entries(SURFACES)) {
    const { field, wet } = await analyzeOverGround(doc, { surface });
    assert.ok(field, `${name}: a field came back`);
    assert.ok(field.samples.length > 0, `${name}: the field has samples`);
    assert.equal(field.missionId, doc.id, `${name}: the field answers this mission`);
    // The load-bearing part: whatever the surface did, the analysis completed
    // and said something. A fixture that threw, or that produced a snapshot with
    // no corridor, would fail here rather than at some assertion downstream.
    assert.ok(wet.corridor.samples.length > 0, `${name}: the corridor survived`);
    assert.ok(Array.isArray(wet.constraints), `${name}: constraints came back`);
    for (const c of wet.constraints) {
      assert.ok(c.code && c.severity && c.explanation, `${name}: ${c.code} is a complete constraint`);
    }
  }
});

test('a ridge under a low leg is a clearance constraint, anchored where the ridge is', async () => {
  const doc = mission([{ at: wpAt(45, 1.0), altM: 40 }, { at: wpAt(45, 3.0), altM: 40 }]);
  const { field, wet } = await analyzeOverGround(doc, { surface: SURFACES.ridge });

  const hit = find(wet, 'W-TERR-CLEARANCE');
  assert.ok(hit, `the ridge is 140 m over a 40 m leg, so it must be reported: got ${codes(wet).join(', ')}`);
  assert.equal(hit.severity, 'critical', 'ground above the planned altitude is not an advisory');
  assert.equal(hit.anchor.scope, 'sample', 'anchored at the sample that caused it, not at the mission');

  // The anchor has to resolve — into the field, and into the corridor the
  // analysis published. An id that exists in only one of them is the failure
  // this whole milestone is built to prevent.
  const sample = field.byId[hit.anchor.refId];
  assert.ok(sample, 'the anchor names a sample the field actually holds');
  const inCorridor = wet.corridor.samples.find((s) => s.id === hit.anchor.refId);
  assert.ok(inCorridor, 'the same id is in the corridor the analysis published');

  // …and it is the ridge, not just any sample.
  assert.ok(sample.distanceKm >= 1.3 && sample.distanceKm <= 1.7,
    `the anchor is on the ridge (${sample.distanceKm.toFixed(2)} km), not somewhere else on the route`);
  assert.equal(sample.groundMslM, LAUNCH_ELEV_M + 140, 'and that sample really is the high ground');

  // The segment carrying the ridge knows about it too, by the same id.
  const seg = wet.segments[sample.segmentId];
  assert.ok(seg, 'the sample names a segment the snapshot holds');
  assert.ok(seg.clearance, 'that segment carries a clearance block');
  assert.equal(seg.clearance.atSampleId, hit.anchor.refId,
    'the segment and the constraint blame the same sample');
  assert.ok(seg.clearance.minM < 0, 'and it is a negative clearance, not a thin one');
  assert.equal(seg.clearance.missing, 0, 'nothing went unanswered on this surface');
});

test('a leg with a thin margin over the ridge is a low-clearance warning, not a strike', async () => {
  // The ridge tops out 140 m above launch; hold 155 m and the margin is ~15 m —
  // inside CLEARANCE_WARN_M but never below the ground.
  const doc = mission([{ at: wpAt(45, 1.0), altM: 155 }, { at: wpAt(45, 3.0), altM: 155 }]);
  const { wet } = await analyzeOverGround(doc, { surface: SURFACES.ridge });
  assert.ok(!has(wet, 'W-TERR-CLEARANCE'),
    `a leg that clears the ridge is not a strike: ${codes(wet).join(', ')}`);
  const low = find(wet, 'W-TERR-CLEARANCE-LOW');
  assert.ok(low, `a ${TERRAIN_CLEARANCE_WARN_M} m margin is worth saying: ${codes(wet).join(', ')}`);
  assert.equal(low.anchor.scope, 'sample');
});

test('flat ground under a normal leg says nothing about clearance', async () => {
  const doc = mission([{ at: wpAt(45, 1.0), altM: 80 }, { at: wpAt(45, 3.0), altM: 80 }]);
  const { wet } = await analyzeOverGround(doc, { surface: SURFACES.flat });
  assert.ok(!has(wet, 'W-TERR-CLEARANCE'), 'no strike over flat ground');
  assert.ok(!has(wet, 'W-TERR-CLEARANCE-LOW'), 'and no thin margin either');
  assert.ok(!has(wet, 'W-DATA-TERRAIN-SAMPLE-MISSING'), 'the ground was sampled and answered');
});

test('a valley under the leg is clearance, not a problem', async () => {
  const doc = mission([{ at: wpAt(45, 1.0), altM: 80 }, { at: wpAt(45, 3.0), altM: 80 }]);
  const { field, wet } = await analyzeOverGround(doc, { surface: SURFACES.valley });
  assert.ok(!has(wet, 'W-TERR-CLEARANCE'), 'ground below the launch point is not in the way');
  assert.ok(!has(wet, 'W-TERR-CLEARANCE-LOW'));
  const low = field.samples.filter((s) => s.groundMslM != null)
    .reduce((m, s) => Math.min(m, s.groundMslM), Infinity);
  assert.ok(low < LAUNCH_ELEV_M - 50, 'the fixture really is a valley');
});

test('a cliff face under the leg is reported at the step, not at the start', async () => {
  const doc = mission([{ at: wpAt(45, 1.0), altM: 40 }, { at: wpAt(45, 3.0), altM: 40 }]);
  const { field, wet } = await analyzeOverGround(doc, { surface: SURFACES.cliff });
  const hit = find(wet, 'W-TERR-CLEARANCE');
  assert.ok(hit, `a 110 m step under a 40 m leg is a strike: ${codes(wet).join(', ')}`);
  const sample = field.byId[hit.anchor.refId];
  assert.ok(sample.distanceKm >= 1.4, 'the anchor is on the high side of the step');
});

/* ---------- 4. an unknown is never a pass ---------- */

test('a route over a hole in the data carries the data-absence constraint', async () => {
  const doc = mission([{ at: wpAt(45, 1.0), altM: 80 }, { at: wpAt(45, 3.0), altM: 80 }]);
  const { field, wet } = await analyzeOverGround(doc, { surface: SURFACES.missingTile });

  assert.equal(field.provenance.coverage, 'partial', 'the fixture really does have a hole');
  assert.ok(field.provenance.missing > 0);

  const gap = find(wet, 'W-DATA-TERRAIN-SAMPLE-MISSING');
  assert.ok(gap, `a hole under the route has to be said out loud: ${codes(wet).join(', ')}`);
  assert.equal(gap.severity, 'unknown', 'an absence is an unknown, not a warning about a known thing');

  // The adversarial half: nothing anywhere in the snapshot may read as "clear".
  // A pilot skimming the rail must not be able to come away thinking the ground
  // under that band was checked and found fine.
  const said = wet.constraints.map((c) => `${c.text} ${c.explanation.limitations.join(' ')}`).join(' ');
  assert.ok(!/\bterrain is clear\b/i.test(said), 'nothing claims the terrain is clear');
  assert.ok(!/\bno terrain (?:problem|conflict|issue)/i.test(said));

  // …and the segment's own clearance block counts the hole rather than quietly
  // reporting a minimum taken over only the samples that happened to answer.
  const holed = Object.values(wet.segments).filter((s) => s.clearance && s.clearance.missing > 0);
  assert.ok(holed.length > 0, 'the segment over the hole counts its unanswered samples');
  for (const seg of holed) {
    assert.ok(seg.explanations.includes('X-TERR-SAMPLE-MISSING'),
      'and says so on the segment, not only on the mission-wide rail');
  }
  assert.equal(gap.anchor.scope, 'segment', 'the absence is anchored at the leg it is under');
  assert.ok(wet.segments[gap.anchor.refId], 'and that segment id resolves into the snapshot');
});

test('a route whose ground was never sampled at all states that, and never clears it', async () => {
  const doc = mission([{ at: wpAt(45, 1.0), altM: 80 }, { at: wpAt(45, 3.0), altM: 80 }]);
  clearAnalysisCache();
  // The port is wired — someone asked — and nothing has come back yet. This is
  // the state the app is in for the first second of every session, and it is the
  // one where silence would be most dangerous.
  const snap = analyzeMission({ doc, inputs: inputs(), revision: revisionOf(doc) }, {
    plan: planMission, routePlan: planRoute, now: () => AT,
    terrainField: () => null,
  });
  const gap = find(snap, 'W-DATA-TERRAIN-SAMPLE-MISSING');
  assert.ok(gap, `a wired port with no answer is an unknown: ${codes(snap).join(', ')}`);
  assert.equal(gap.severity, 'unknown');
  assert.ok(!has(snap, 'W-TERR-CLEARANCE'), 'and no clearance verdict is offered either way');
  assert.ok(!has(snap, 'W-TERR-CLEARANCE-LOW'));
  for (const seg of Object.values(snap.segments)) {
    assert.equal(seg.clearance, null, 'a segment with no ground under it carries no clearance block');
  }
});

test('a field for a different route is not evidence about this one', async () => {
  const doc = mission([{ at: wpAt(45, 1.0), altM: 80 }, { at: wpAt(45, 3.0), altM: 80 }]);
  const elsewhere = mission([{ at: wpAt(225, 1.0), altM: 80 }, { at: wpAt(225, 3.0), altM: 80 }]);
  const { field } = await analyzeOverGround(elsewhere, { surface: SURFACES.ridge });

  clearAnalysisCache();
  const snap = analyzeMission({ doc, inputs: inputs(), revision: revisionOf(doc) }, {
    plan: planMission, routePlan: planRoute, now: () => AT,
    terrainField: () => field, terrainSignature: 'wrong-route',
  });
  assert.ok(has(snap, 'W-DATA-TERRAIN-SAMPLE-MISSING'),
    'ground sampled under another route is an unknown here, not a pass');
  assert.ok(!has(snap, 'W-TERR-CLEARANCE'));
});

test('a mission renamed mid-flight keeps the ground it already sampled', async () => {
  const doc = mission([{ at: wpAt(45, 1.0), altM: 40 }, { at: wpAt(45, 3.0), altM: 40 }]);
  const { field } = await analyzeOverGround(doc, { surface: SURFACES.ridge });
  // Same geometry, new updatedAt: the route did not move, so throwing the field
  // away would replace a real clearance figure with an unknown for no reason.
  const renamed = { ...doc, title: 'renamed', updatedAt: '2026-07-30T12:05:00.000Z' };
  clearAnalysisCache();
  const snap = analyzeMission({ doc: renamed, inputs: inputs(), revision: revisionOf(renamed) }, {
    plan: planMission, routePlan: planRoute, now: () => AT,
    terrainField: () => field, terrainSignature: 'fixture',
  });
  assert.ok(!has(snap, 'W-DATA-TERRAIN-SAMPLE-MISSING'), 'the ground under an unmoved route is still valid');
  assert.ok(has(snap, 'W-TERR-CLEARANCE'), 'and the ridge is still reported');
});

/* ---------- 4b. the two other route-wide questions ---------- */

/** A wall high enough to cut the sightline as well as the leg. */
const WALL = (km) => LAUNCH_ELEV_M + (km >= 1.3 && km <= 1.7 ? 300 : 0);

test('ground across the line to a waypoint cuts the sightline, per segment', async () => {
  const doc = mission([{ at: wpAt(45, 1.0), altM: 250 }, { at: wpAt(45, 3.0), altM: 60 }]);
  const { field, wet } = await analyzeOverGround(doc, { surface: WALL, extra: { linkGhz: 5.8 } });

  const los = find(wet, 'W-RF-LOS-BLOCKED');
  assert.ok(los, `a 300 m wall between the pilot and the waypoint blocks it: ${codes(wet).join(', ')}`);
  assert.equal(los.anchor.scope, 'sample');
  const at = field.byId[los.anchor.refId];
  assert.ok(at.distanceKm >= 1.3 && at.distanceKm <= 1.7, 'anchored at the wall');
  assert.match(los.text, /5800 MHz/, 'and it says which band it is talking about');
});

test('a sightline with nothing sampled on it is never reported as clear', async () => {
  // A single close waypoint: no corridor station falls strictly between the
  // launch point and it, so the ray has no evidence on it at all.
  const doc = mission([{ at: wpAt(45, 0.15), altM: 80 }]);
  const { wet } = await analyzeOverGround(doc, { surface: SURFACES.flat, extra: { linkGhz: 5.8 } });
  assert.ok(!has(wet, 'W-RF-LOS-BLOCKED'), 'nothing counted, so nothing is claimed either way');
  assert.ok(!has(wet, 'W-RF-FRESNEL'));
});

test('the direct flight home is checked against the ground on it', async () => {
  const doc = mission([{ at: wpAt(45, 1.0), altM: 250 }, { at: wpAt(45, 3.0), altM: 60 }]);
  const { wet } = await analyzeOverGround(doc, { surface: WALL, extra: { linkGhz: 5.8 } });
  const home = find(wet, 'W-RETURN-TERRAIN-BLOCKED');
  assert.ok(home, `a failsafe RTH through a 300 m wall is worth saying: ${codes(wet).join(', ')}`);
  assert.equal(home.severity, 'critical');
  assert.equal(home.anchor.scope, 'sample');
});

test('a route flown straight out and back does not report its own return unsurveyed', async () => {
  // The regression this rule was written against: the line home *is* the
  // corridor, sampled end to end, and a coverage metric binned at the sampling
  // step still called a third of it a hole.
  const doc = mission([{ at: wpAt(45, 1.0), altM: 120 }, { at: wpAt(45, 3.0), altM: 120 }]);
  const { wet } = await analyzeOverGround(doc, { surface: SURFACES.flat });
  assert.ok(!has(wet, 'W-RETURN-TERRAIN-UNKNOWN'),
    `every metre of this line home carries a sample: ${codes(wet).join(', ')}`);
});

test('a dogleg whose flight home crosses unsampled country says so', async () => {
  // Out east, then north: the direct line home from the last waypoint cuts
  // across ground no leg of this route passes over.
  const doc = mission([
    { at: wpAt(90, 2.5), altM: 120 },
    { at: wpAt(0, 2.5), altM: 120 },
  ]);
  const { wet } = await analyzeOverGround(doc, { surface: SURFACES.flat });
  const unknown = find(wet, 'W-RETURN-TERRAIN-UNKNOWN');
  assert.ok(unknown, `the hypotenuse home was never sampled: ${codes(wet).join(', ')}`);
  assert.equal(unknown.severity, 'unknown', 'not looked at is not the same as looked at and bad');
  assert.equal(unknown.anchor.scope, 'segment');
  assert.ok(wet.segments[unknown.anchor.refId], 'and the segment it names is in the snapshot');
});

test('a waypoint whose return height never resolved does not pass its return check silently', async () => {
  // An above-ground-level waypoint over a hole in the data: its altitude never
  // resolves, so the flight home from it cannot be checked at any height. The
  // ground on the line home is itself well sampled — coverage is not what is
  // missing — and counting that coverage as "return checked" was the defect.
  const doc = mission([{ at: wpAt(45, 3.0), altitude: { authored: 60, reference: 'agl' } }]);
  const { wet } = await analyzeOverGround(doc, { surface: (km) => (km > 2.9 ? null : LAUNCH_ELEV_M) });
  const unknown = find(wet, 'W-RETURN-TERRAIN-UNKNOWN');
  assert.ok(unknown, `an uncheckable return is unsurveyed, not silent: ${codes(wet).join(', ')}`);
});

test('a wired profile port does not excuse an unwired field port', () => {
  // The embedder scenario: the single-bearing profile ports are wired and
  // content, the corridor field port is not wired at all. The route must still
  // carry a ground statement — the profile path's contentment says nothing
  // about the route's corridor.
  clearAnalysisCache();
  const doc = mission([{ at: wpAt(45, 1.0), altM: 80 }]);
  const snap = analyzeMission({ doc, inputs: inputs(), revision: revisionOf(doc) }, {
    plan: planMission, routePlan: planRoute, now: () => AT,
    terrainWarnings: () => [],
  });
  const absent = find(snap, 'W-DATA-TERRAIN-ABSENT');
  assert.ok(absent, `the route still carries a ground statement: ${codes(snap).join(', ')}`);
  assert.match(absent.text, /route/, 'and it speaks about the route, not the profile');
});

/* ---------- 5. one set of identifiers ---------- */

test('every terrain-anchored constraint resolves into both the corridor and the field', async () => {
  // A route that gives every check something to say: low over a ridge, out past
  // it, and back over the same high ground on the way home.
  const doc = mission([
    { at: wpAt(45, 1.0), altM: 40 },
    { at: wpAt(45, 2.2), altM: 40 },
    { at: wpAt(45, 3.4), altM: 40 },
  ]);
  const { field, wet } = await analyzeOverGround(doc, { surface: SURFACES.saddle, extra: { linkGhz: 5.8 } });

  const corridorIds = new Set(wet.corridor.samples.map((s) => s.id));
  const segmentIds = new Set(Object.keys(wet.segments));
  let sampleAnchored = 0;

  for (const c of wet.constraints) {
    if (c.anchor.scope === 'sample') {
      sampleAnchored++;
      assert.ok(corridorIds.has(c.anchor.refId),
        `${c.code} anchors at ${c.anchor.refId}, which the corridor does not publish`);
      assert.ok(field.byId[c.anchor.refId],
        `${c.code} anchors at ${c.anchor.refId}, which the field does not hold`);
    }
    if (c.anchor.scope === 'segment') {
      assert.ok(segmentIds.has(c.anchor.refId),
        `${c.code} anchors at segment ${c.anchor.refId}, which the snapshot does not hold`);
    }
  }
  assert.ok(sampleAnchored > 0, 'this fixture is supposed to produce sample-anchored findings');

  // The other direction: every id the field holds for a centre sample is an id
  // the corridor asked about. The sampler derives ids from the request, and this
  // is the assertion that keeps it derived rather than invented.
  for (const s of field.samples) {
    if (s.track !== 'centre') continue;
    assert.ok(corridorIds.has(s.id), `the field invented a centre id: ${s.id}`);
  }
  // …and every corridor sample got an answer slot, holes included.
  for (const want of wet.corridor.samples) {
    assert.ok(field.byId[want.id], `the field dropped a corridor sample: ${want.id}`);
  }

  // Segment ids are the document's, not a second numbering: the renderer reads
  // `snapshot.segments[doc.route.segments[i].id]` and has to find something.
  for (const seg of doc.route.segments) {
    assert.ok(wet.segments[seg.id], `the snapshot has nothing for document segment ${seg.id}`);
  }
  // And the field's per-sample segmentId points back into the same set.
  for (const s of field.samples) {
    if (s.segmentId == null) continue;
    assert.ok(segmentIds.has(s.segmentId), `the field names an unknown segment: ${s.segmentId}`);
  }
});

test('the altitude resolver reads the same field the constraints do', async () => {
  // `agl` is the one frame that cannot resolve without ground, so it is the one
  // that proves the sampler the document uses and the field the pipeline reads
  // are the same measurement.
  const doc = mission([
    { at: wpAt(45, 1.5), altitude: { authored: 50, reference: 'agl' } },
  ]);
  const before = doc.route.segments[0].altitude;
  assert.equal(before.resolvedMslM, null, 'with no ground, an agl altitude cannot resolve — and does not guess');

  const { field } = await analyzeOverGround(doc, { surface: SURFACES.ridge });
  const resolved = resolveMissionAltitudes(doc, nearestGroundSampler(field)).doc;
  const after = resolved.route.segments[0].altitude;
  assert.ok(after.resolvedMslM != null, 'once the field lands, the same altitude resolves');
  // 50 m above the ridge top, which the surface puts ~140 m over launch.
  assert.ok(after.resolvedMslM > LAUNCH_ELEV_M + 150,
    `resolved to ${after.resolvedMslM} m — that is not the ground the field describes`);
});

/* ---------- 6. the air and the wind at altitude ---------- */

const LEVELS_SHEARED = {
  10: { windMph: 6, windFromDeg: 170 },
  80: { windMph: 12, windFromDeg: 185 },
  120: { windMph: 16, windFromDeg: 195 },
  180: { windMph: 22, windFromDeg: 205 },
};
const LEVELS_ONE = { 80: { windMph: 12, windFromDeg: 185 } };

test('wind and density move with altitude when the forecast publishes levels', async () => {
  // Two legs at very different heights over the same ground.
  const doc = mission([
    { at: wpAt(45, 1.0), altM: 20 },
    { at: wpAt(45, 2.5), altM: 400 },
  ]);
  const { wet } = await analyzeOverGround(doc, {
    surface: SURFACES.flat,
    extra: { windLevels: () => LEVELS_SHEARED },
  });

  const [lowSeg, highSeg] = doc.route.segments.map((s) => wet.segments[s.id]);
  assert.ok(lowSeg.wind && highSeg.wind, 'both legs carry a wind block');
  assert.notEqual(lowSeg.wind.windMph, highSeg.wind.windMph,
    'a 20 m leg and a 400 m leg are not flying the same wind on a sheared forecast');
  assert.ok(highSeg.wind.windMph > lowSeg.wind.windMph, 'and it is windier up there, as the forecast says');
  assert.equal(lowSeg.wind.basis, 'interpolated', '20 m sits between the 10 m and 80 m levels');
  assert.equal(highSeg.wind.basis, 'clamped', '400 m is above every published level — quoted, not extrapolated');
  assert.deepEqual([...highSeg.wind.levelsM], [180], 'and it names the level it was clamped to');

  assert.ok(lowSeg.air && highSeg.air, 'both legs carry an air block');
  assert.ok(highSeg.air.rho < lowSeg.air.rho, 'the air is thinner 400 m up');
  assert.ok(highSeg.air.hoverPowerRatio > lowSeg.air.hoverPowerRatio,
    'so the rotors need more power there than the one density the plan was solved at');
  assert.ok(highSeg.air.densityAltM > lowSeg.air.densityAltM);

  assert.ok(has(wet, 'W-WIND-LEVEL-MISMATCH'),
    `a route spanning 380 m of a sheared forecast has to say so: ${codes(wet).join(', ')}`);
});

test('a single-level forecast produces no invented gradient', async () => {
  const doc = mission([
    { at: wpAt(45, 1.0), altM: 20 },
    { at: wpAt(45, 2.5), altM: 400 },
  ]);
  const { wet } = await analyzeOverGround(doc, {
    surface: SURFACES.flat,
    extra: { windLevels: () => LEVELS_ONE },
  });

  const [lowSeg, highSeg] = doc.route.segments.map((s) => wet.segments[s.id]);
  assert.equal(lowSeg.wind.basis, 'single-level');
  assert.equal(highSeg.wind.basis, 'single-level');
  assert.equal(lowSeg.wind.windMph, highSeg.wind.windMph,
    'one published level is one wind — a shear here would be this tool making something up');
  assert.equal(highSeg.wind.windFromDeg, LEVELS_ONE[80].windFromDeg);

  // Said out loud rather than left as a silent equality: the pilot is flying a
  // 380 m height band on a forecast that describes one height.
  const mismatch = find(wet, 'W-WIND-LEVEL-MISMATCH');
  assert.ok(mismatch, `the single-level span has to be stated: ${codes(wet).join(', ')}`);
  assert.match(mismatch.text, /one level|single level/i);
});

test('with no forecast levels at all, no leg claims a wind', async () => {
  const doc = mission([{ at: wpAt(45, 1.0), altM: 20 }, { at: wpAt(45, 2.5), altM: 400 }]);
  const { wet } = await analyzeOverGround(doc, { surface: SURFACES.flat });
  for (const seg of doc.route.segments) {
    assert.equal(wet.segments[seg.id].wind, null,
      'no levels published means no per-altitude wind — the plan flies the rail figure and says so');
  }
});

test('a climb over the pass is charged, and the descent off it gives nothing back', async () => {
  const doc = mission([
    { at: wpAt(45, 1.5), altM: 250 },
    { at: wpAt(45, 3.0), altM: 40 },
  ]);
  const { wet } = await analyzeOverGround(doc, { surface: SURFACES.pass });
  const [up, down] = doc.route.segments.map((s) => wet.segments[s.id]);

  assert.ok(up.vertical.climbWh > 0, 'the climb costs energy');
  assert.equal(up.vertical.descentWh, 0);
  assert.equal(down.vertical.climbWh, 0);
  assert.ok(down.vertical.descentWh >= 0, 'and the descent is never a credit');
  assert.ok(wet.route.verticalWh > 0, 'the route total carries it');
  assert.ok(wet.route.missionWh >= wet.route.plannedWh,
    'vertical energy is added to the mission, never subtracted from it');
  assert.ok(has(wet, 'W-ALT-VERTICAL-CONSERVATIVE'),
    `the conservative vertical model states itself: ${codes(wet).join(', ')}`);
});
