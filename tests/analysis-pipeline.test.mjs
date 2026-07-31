import test from 'node:test';
import assert from 'node:assert/strict';

import { destination } from '../src/domain/geo.js';
import { planMission, U } from '../src/domain/physics.js';
import { planRoute } from '../src/domain/route.js';
import { climbEnergyWh } from '../src/domain/vertical.js';
import { createMission } from '../src/domain/mission/mission-schema.js';
import { missionReduce } from '../src/domain/mission/mission-reducer.js';
import { resolveMissionAltitudes } from '../src/domain/mission/altitude.js';
import {
  analyzeMission, clearAnalysisCache, newestOnly,
} from '../src/application/analysis/analyze.js';
import { ANALYSIS_MODEL_VERSION } from '../src/application/analysis/analysis-contracts.js';

/* M2: the single analysis pipeline.
 *
 * The load-bearing claim is that nothing was re-derived. analyzeMission is an
 * arrangement of planMission and planRoute, not a second opinion about either,
 * so the first test here is parity: the same inputs through the pipeline have
 * to produce the *same numbers*, exactly, as calling the model directly. Every
 * fixture below it is about the things the old ad-hoc pipeline could not say —
 * which segment a number belongs to, what a hold costs, what a return policy
 * changes, and what the tool does not know.
 *
 * Deterministic by construction: ids are injected, the clock is injected, and
 * no provider here touches the network. */

const AUSTIN = { lat: 30.2672, lng: -97.7431 };
const LAUNCH_ELEV_M = U.ftToM(550);
const WIND_FROM = 170;
const AT = '2026-07-30T12:00:00.000Z';

// MOZ7 V2 + NAV 5000 6S Li-Ion — the same fixture route.test.mjs and
// reserve.test.mjs plan against, so a number here can be read beside theirs.
const moz7 = {
  dryMassG: 843, propDiaIn: 7.5, numRotors: 4, cdA: 0.042,
  etaProp: 0.55, avionicsW: 12, maxSpeedMs: 30.5, cruiseMs: 18,
};
const nav5000 = { chem: 'liion', s: 6, capAh: 5.0, massG: 499, irPackMilliOhm: 60 };

function inputs(overrides = {}, envOverrides = {}) {
  return {
    drone: moz7, battery: nav5000, payloadG: 0, extraG: 0,
    env: {
      elevM: LAUNCH_ELEV_M, tempC: U.fToC(75), rhPct: 40,
      windFromDeg: WIND_FROM, windMode: 'headOut',
      windAvgMs: U.mphToMs(8), windGustMs: U.mphToMs(16),
      ...envOverrides,
    },
    landFloorPct: 20, cruiseMode: 'real', realVMs: moz7.cruiseMs, overheadF: 1.05,
    ...overrides,
  };
}

/** Per-prefix counters, so a fixture's ids read `seg_1`, `wpt_2`, `msn_1`. */
function idgen() {
  const counts = Object.create(null);
  return (prefix) => `${prefix}_${counts[prefix] = (counts[prefix] ?? 0) + 1}`;
}

const wpAt = (courseDeg, km) => {
  const [lat, lng] = destination(AUSTIN.lat, AUSTIN.lng, courseDeg, km);
  return { lat, lng };
};

/**
 * A mission document from a list of `{ at, altM, intent, holdS }` points. Every
 * command goes through the real reducer — a fixture the reducer would reject is
 * a fixture that proves nothing, so rejections fail the test loudly.
 */
function mission(points, { returnMode = null } = {}) {
  const deps = {
    idgen: idgen(),
    now: () => AT,
    onWarning: (w) => assert.fail(`fixture rejected: ${w.code} ${w.message}`),
  };
  let doc = createMission({
    launch: { latitude: AUSTIN.lat, longitude: AUSTIN.lng, elevationMslM: LAUNCH_ELEV_M },
    title: 'fixture',
  }, deps);
  for (const p of points) {
    const intent = p.intent ?? 'transit';
    doc = missionReduce(doc, {
      type: 'addWaypoint',
      payload: {
        latitude: p.at.lat,
        longitude: p.at.lng,
        intent,
        altitude: { authored: p.altM ?? 80, reference: 'launchRelative' },
        ...(p.holdS != null ? { holdS: p.holdS } : {}),
        ...(p.speedPolicy ? { speedPolicy: p.speedPolicy } : {}),
      },
    }, deps);
  }
  if (returnMode) {
    doc = missionReduce(doc, {
      type: 'setReturnPolicy', payload: { mode: returnMode, altitude: null },
    }, deps);
  }
  return resolveMissionAltitudes(doc).doc;
}

const revisionOf = (doc) => ({ missionId: doc.id, missionUpdatedAt: doc.updatedAt });

function analyze(doc, inp = inputs(), extra = {}) {
  return analyzeMission({ doc, inputs: inp, revision: revisionOf(doc) }, {
    plan: planMission,
    routePlan: planRoute,
    now: () => AT,
    ...extra,
  });
}

const codes = (snap) => snap.constraints.map((c) => c.code);
const segAt = (snap, doc, i) => snap.segments[doc.route.segments[i].id];

/* ---------- 1. parity: the pipeline is an arrangement, not a model ---------- */

test('a one-segment mission reproduces planMission exactly', () => {
  const inp = inputs();
  const direct = planMission(inp);
  assert.ok(direct.radiusKm > 1, 'the fixture has to close a mission');

  const doc = mission([{ at: wpAt(0, direct.radiusKm * 0.6) }]);
  const snap = analyze(doc, inp);

  for (const key of ['rho', 'densityAltM', 'massKg', 'areaM2', 'radiusKm', 'totalKm',
    'timeMin', 'hoverTimeMin', 'cruiseTimeMin', 'speedLimitMs', 'overheadF']) {
    assert.equal(snap.plan[key], direct[key], `plan.${key} moved`);
  }
  assert.equal(snap.plan.hover.pW, direct.hover.pW);
  assert.equal(snap.plan.wind.planningMs, direct.wind.planningMs);
  for (const key of ['packWh', 'deliveredWh', 'usableWh', 'reserveWh', 'reservePct',
    'getHomeWh', 'huntLandWh', 'getHomeWindMs']) {
    assert.equal(snap.plan.energy[key], direct.energy[key], `energy.${key} moved`);
  }
  // The old pipeline pushed terrain and link warnings onto this very array.
  assert.equal(snap.plan.warnings.length, direct.warnings.length,
    'the analysis must not mutate the plan it was handed');
});

test('the route in the snapshot is planRoute, leg for leg', () => {
  const inp = inputs();
  const plan = planMission(inp);
  const points = [wpAt(20, plan.radiusKm * 0.5), wpAt(80, plan.radiusKm * 0.45)];
  const doc = mission(points.map((at) => ({ at })));
  const snap = analyze(doc, inp);

  const direct = planRoute(plan, {
    launch: AUSTIN, waypoints: points, windFromDeg: WIND_FROM, inputs: inp,
  });
  assert.equal(snap.route.legs.length, direct.legs.length);
  for (let i = 0; i < direct.legs.length; i++) {
    assert.equal(snap.route.legs[i].distKm, direct.legs[i].distKm);
    assert.equal(snap.route.legs[i].whLeg, direct.legs[i].whLeg);
    assert.equal(snap.route.legs[i].vgMs, direct.legs[i].vgMs);
  }
  assert.equal(snap.route.totalWh, direct.totalWh);
  assert.equal(snap.route.marginWh, direct.marginWh);
  assert.equal(snap.route.loiter.wh, direct.loiter.wh);

  // And the per-segment view is a read of those same legs, not a second pass.
  assert.equal(segAt(snap, doc, 0).flightWh, direct.legs[0].whLeg);
  assert.equal(segAt(snap, doc, 1).flightWh, direct.legs[1].whLeg);
  assert.equal(segAt(snap, doc, 1).groundSpeedMs, direct.legs[1].vgMs);
});

/* ---------- 2. fixtures ---------- */

test('a dogleg reports every segment, in document order', () => {
  const plan = planMission(inputs());
  const doc = mission([
    { at: wpAt(0, plan.radiusKm * 0.4) },
    { at: wpAt(90, plan.radiusKm * 0.4) },
    { at: wpAt(45, plan.radiusKm * 0.3) },
  ]);
  const snap = analyze(doc);

  assert.equal(Object.keys(snap.segments).length, 3);
  doc.route.segments.forEach((seg, i) => {
    const s = snap.segments[seg.id];
    assert.equal(s.index, i);
    assert.equal(s.segmentId, seg.id);
    assert.ok(s.distanceKm > 0);
    assert.ok(s.flightWh > 0);
    assert.equal(s.holdWh, 0);
    assert.equal(s.energyWh, s.flightWh);
  });
  // Segment energies are the out-legs; the home leg is the route's, not a
  // segment's, because no authored segment describes it.
  const legs = snap.route.legs;
  assert.equal(legs[legs.length - 1].phase, 'home');
});

test('M3b: a climb costs energy and a descent never returns any', () => {
  const plan = planMission(inputs());
  const near = wpAt(0, plan.radiusKm * 0.35);
  const far = wpAt(0, plan.radiusKm * 0.7);

  const climb = analyze(mission([{ at: near, altM: 80 }, { at: far, altM: 140 }]));
  const climbDoc = mission([{ at: near, altM: 80 }, { at: far, altM: 140 }]);
  const level = analyze(mission([{ at: near, altM: 80 }, { at: far, altM: 80 }]));
  const descent = analyze(mission([{ at: near, altM: 140 }, { at: far, altM: 80 }]));

  const up = segAt(climb, climbDoc, 1);
  assert.ok(Math.abs(up.altitudeDeltaM - 60) < 1e-9, `+60 m expected, got ${up.altitudeDeltaM}`);
  assert.ok(up.explanations.includes('X-ALT-VERTICAL-CHARGED'));
  assert.ok(codes(climb).includes('W-ALT-VERTICAL-CONSERVATIVE'));
  // The advisory M3b replaced is registered and produced by nothing.
  assert.ok(!codes(climb).includes('W-ALT-VERTICAL-UNMODELLED'));

  // m·g·Δh/η, to the digit, against this leg's own delta — the pipeline computes
  // no vertical energy of its own, it calls the domain function.
  assert.equal(up.vertical.climbWh,
    climbEnergyWh(plan.cfg.massKg, plan.cfg.etaProp, up.altitudeDeltaM));
  assert.ok(Math.abs(up.vertical.climbWh
    - climbEnergyWh(plan.cfg.massKg, plan.cfg.etaProp, 60)) < 1e-12);
  assert.equal(up.vertical.descentWh, 0);

  const down = segAt(descent, climbDoc, 1);
  assert.ok(Math.abs(down.altitudeDeltaM + 60) < 1e-9, `-60 m expected, got ${down.altitudeDeltaM}`);
  assert.equal(down.vertical.climbWh, 0);
  assert.ok(down.vertical.descentWh >= 0, 'a descent may never credit the pack');
  assert.ok(descent.route.verticalWh >= level.route.verticalWh,
    'losing height must never make a route cheaper than staying level');

  // The level leg is level: no delta, so no vertical block at all.
  assert.equal(segAt(level, climbDoc, 1).altitudeDeltaM, 0);
  assert.equal(segAt(level, climbDoc, 1).vertical, null);
  // The first leg still climbs — from the launch point up to 80 m — in all three.
  assert.equal(segAt(level, climbDoc, 0).altitudeDeltaM, 80);

  // planRoute's own figure is untouched: the climb is a sibling of it, not a
  // correction to it. Same geometry, same level-flight energy.
  assert.equal(climb.route.plannedWh, level.route.plannedWh);
  assert.equal(descent.route.plannedWh, level.route.plannedWh);
  assert.equal(up.flightWh, segAt(level, climbDoc, 1).flightWh);
  // …and the extra 60 m of height is the whole difference in the mission total.
  assert.ok(Math.abs((climb.route.missionWh - level.route.missionWh)
    - climbEnergyWh(plan.cfg.massKg, plan.cfg.etaProp, 60)) < 1e-12);
});

test('a 120 s orbit costs exactly hover power for 120 s', () => {
  const plan = planMission(inputs());
  const points = [{ at: wpAt(0, plan.radiusKm * 0.4) }, { at: wpAt(60, plan.radiusKm * 0.4) }];
  const holdDoc = mission([points[0], { ...points[1], intent: 'orbit', holdS: 120 }]);
  const held = analyze(holdDoc);
  const plain = analyze(mission(points));

  const seg = segAt(held, holdDoc, 1);
  assert.equal(seg.holdS, 120);
  assert.equal(seg.holdWh, 120 * held.plan.hover.pW / 3600);
  assert.equal(seg.energyWh, seg.flightWh + seg.holdWh);
  assert.ok(seg.explanations.includes('X-HOLD-HOVER-POWER'));

  // The flying is unchanged; the mission total grows by the hold and only the
  // hold. The climb out to 80 m is in both and cancels.
  assert.equal(held.route.plannedWh, plain.route.plannedWh);
  assert.equal(held.route.holdWh, seg.holdWh);
  assert.equal(held.route.verticalWh, plain.route.verticalWh);
  assert.equal(held.route.missionWh,
    held.route.plannedWh + seg.holdWh + held.route.verticalWh);
  assert.equal(plain.route.missionWh, plain.route.plannedWh + plain.route.verticalWh);
  assert.ok(Math.abs((held.route.missionWh - plain.route.missionWh) - seg.holdWh) < 1e-12);
});

test('return policy decides which totals the mission is planned to', () => {
  const plan = planMission(inputs());
  const points = [
    { at: wpAt(0, plan.radiusKm * 0.35) },
    { at: wpAt(70, plan.radiusKm * 0.35) },
  ];
  const direct = analyze(mission(points));
  const retrace = analyze(mission(points, { returnMode: 'retrace' }));
  const none = analyze(mission(points, { returnMode: 'none' }));

  assert.equal(direct.route.returnMode, 'direct');
  assert.equal(direct.route.legs.length, 3, 'two out legs and the straight flight home');
  assert.equal(direct.route.plannedKm, direct.route.totalKm);

  // Retrace is the waypoint list plus its own reverse: the same solver, more legs.
  assert.equal(retrace.route.returnMode, 'retrace');
  assert.equal(retrace.route.legs.length, 4);
  assert.ok(retrace.route.plannedKm > direct.route.plannedKm);
  assert.ok(retrace.route.plannedWh > direct.route.plannedWh);
  // The authored segments still read off the out-legs, whatever follows them.
  assert.equal(segAt(retrace, mission(points), 0).flightWh, segAt(direct, mission(points), 0).flightWh);

  assert.equal(none.route.returnMode, 'none');
  assert.equal(none.route.plannedKm, none.route.outKm);
  assert.equal(none.route.plannedWh, none.route.outWh);
  assert.ok(codes(none).includes('W-RESERVE-ONE-WAY'));
  assert.ok(!codes(direct).includes('W-RESERVE-ONE-WAY'));
});

test('a headwind past the cruise speed surfaces as a coded critical constraint', () => {
  const gale = inputs({}, { windAvgMs: U.mphToMs(70), windGustMs: U.mphToMs(80) });
  const plan = planMission(gale);
  assert.ok(!plan.legs.out || !plan.legs.back || !plan.legs.home,
    'the fixture has to actually strand the mission');

  const doc = mission([{ at: wpAt(0, 2) }]);
  const snap = analyze(doc, gale);
  const stranded = snap.constraints.find((c) => c.code === 'W-WIND-NO-CLOSE');
  assert.ok(stranded, `expected W-WIND-NO-CLOSE, got ${codes(snap).join(', ')}`);
  assert.equal(stranded.severity, 'critical');
  assert.equal(stranded.id, 'W-WIND-NO-CLOSE@mission:mission');
  // Verbatim: M2 codes the sentence, it does not rewrite it.
  assert.equal(stranded.text,
    'Wind or loaded propulsion limits prevent a safe out-and-back at these settings.');
});

test('a dashboard note replaces the generic stranded text, keeping the code', () => {
  const gale = inputs({}, { windAvgMs: U.mphToMs(70), windGustMs: U.mphToMs(80) });
  const doc = mission([{ at: wpAt(0, 2) }]);
  const note = 'At 40 mph you can’t make headway home against a 61 mph headwind — wait for calmer wind.';
  const snap = analyze(doc, gale, { strandedNote: () => note });

  const found = snap.constraints.filter((c) => c.code === 'W-WIND-NO-CLOSE');
  assert.equal(found.length, 1, 'the note replaces the generic line rather than doubling it');
  assert.equal(found[0].text, note);
  assert.equal(found[0].severity, 'critical');
});

/* ---------- 3. absence is a stated fact ---------- */

test('missing providers become unknown-severity constraints, not silence', () => {
  const doc = mission([{ at: wpAt(0, 3) }]);
  const snap = analyze(doc);

  const terrain = snap.constraints.find((c) => c.code === 'W-DATA-TERRAIN-ABSENT');
  const link = snap.constraints.find((c) => c.code === 'W-DATA-LINK-ABSENT');
  assert.ok(terrain && link, `expected both absence codes, got ${codes(snap).join(', ')}`);
  assert.equal(terrain.severity, 'unknown');
  assert.equal(link.severity, 'unknown');
  assert.equal(snap.link, null);
  assert.equal(snap.provenance.terrainSource, null);
});

test('injected providers are classified, anchored and left verbatim', () => {
  const doc = mission([{ at: wpAt(0, 3) }]);
  const terrainText = 'Terrain above your cruise altitude: the ground 1.2 mi out on the '
    + '170° (S) — headwind leg rises 120 ft higher than a cruise held 80 m above the launch point. '
    + 'Climb over it, or pick another bearing — the footprint ring is energy only and knows nothing '
    + 'about the hill.';
  const linkText = 'Energy OK, link blocked: the pack reaches 2.0 mi out on the 170° (S) — headwind leg.';
  const snap = analyze(doc, inputs(), {
    terrainWarnings: () => [{ level: 'critical', text: terrainText }],
    elevationProfile: () => ({ points: [{ distKm: 0, elevM: 167 }], spanKm: 3.4 }),
    linkStats: () => ({ blocked: true, band: { id: '5g8' } }),
    linkWarnings: () => [{ level: 'critical', text: linkText }],
  });

  const terrain = snap.constraints.find((c) => c.code === 'W-TERR-CLEARANCE');
  assert.ok(terrain, `expected W-TERR-CLEARANCE, got ${codes(snap).join(', ')}`);
  assert.equal(terrain.text, terrainText);
  assert.equal(terrain.severity, 'critical');
  assert.equal(terrain.anchor.scope, 'mission');
  assert.ok(terrain.explanation.inputs.length > 0);
  assert.ok(terrain.explanation.baseline.length > 0);

  const link = snap.constraints.find((c) => c.code === 'W-RF-LOS-BLOCKED');
  assert.ok(link);
  assert.equal(link.text, linkText);
  assert.equal(snap.link.blocked, true);
  // The wired profile provider quiets the profile's own absence code, but it
  // does not vouch for the route: with no corridor field port wired, the route
  // checks still state W-DATA-TERRAIN-ABSENT beside the injected findings.
  const absent = snap.constraints.find((c) => c.code === 'W-DATA-TERRAIN-ABSENT');
  assert.ok(absent, 'the unwired field port is a stated absence, not silence');
  assert.match(absent.text, /route/, 'and it speaks about the route, not the profile');
  assert.ok(!codes(snap).includes('W-DATA-LINK-ABSENT'));
});

test('a terrain provider with no profile still says so', () => {
  const doc = mission([{ at: wpAt(0, 3) }]);
  const snap = analyze(doc, inputs(), {
    terrainWarnings: () => [],
    elevationProfile: () => null,
  });
  const absent = snap.constraints.find((c) => c.code === 'W-DATA-TERRAIN-ABSENT');
  assert.ok(absent);
  assert.match(absent.text, /no elevation profile/);
});

test('no battery is a stated critical, not a thrown error', () => {
  const doc = mission([{ at: wpAt(0, 3) }]);
  const snap = analyze(doc, inputs({ battery: null }));
  assert.equal(snap.plan, null);
  assert.equal(snap.route, null);
  assert.deepEqual(snap.segments, {});
  assert.ok(codes(snap).includes('W-ENERGY-NO-PACK'));
  // The corridor survives: the ground under a route is knowable without a pack.
  assert.ok(snap.corridor.samples.length >= 1);
});

/* ---------- 4. an unhonoured speed policy is named, not silently dropped ---------- */

test('a fixed-speed segment says the solver could not take it', () => {
  const plan = planMission(inputs());
  const doc = mission([
    { at: wpAt(0, plan.radiusKm * 0.4), speedPolicy: { mode: 'fixed', targetMs: 9 } },
  ]);
  const snap = analyze(doc);
  const seg = segAt(snap, doc, 0);
  assert.equal(seg.speedMode, 'fixed');
  assert.equal(seg.speedTargetMs, 9);
  assert.equal(seg.speedHonoured, false);
  assert.ok(seg.explanations.includes('X-SPEED-POLICY-FALLBACK'));

  const c = snap.constraints.find((x) => x.code === 'W-SPEED-POLICY-UNSUPPORTED');
  assert.ok(c);
  assert.equal(c.anchor.scope, 'segment');
  assert.equal(c.anchor.refId, doc.route.segments[0].id);
  assert.equal(c.id, `W-SPEED-POLICY-UNSUPPORTED@segment:${doc.route.segments[0].id}`);
});

/* ---------- 5. the corridor ---------- */

test('the corridor samples the authored route, launch first', () => {
  const plan = planMission(inputs());
  const doc = mission([
    { at: wpAt(0, plan.radiusKm * 0.5) },
    { at: wpAt(90, plan.radiusKm * 0.5) },
  ]);
  const { corridor } = analyze(doc);

  assert.equal(corridor.missionId, doc.id);
  assert.equal(corridor.revision, doc.updatedAt);
  assert.equal(corridor.corridorWidthM, 0);
  assert.ok(corridor.spacingM >= 30);
  assert.equal(corridor.samples[0].id, 'launch:0');
  assert.equal(corridor.samples[0].distanceKm, 0);

  // Ids name the segment they sit on, distances only ever increase, and every
  // segment's far end is sampled exactly.
  const ids = corridor.samples.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'sample ids must be unique');
  for (let i = 1; i < corridor.samples.length; i++) {
    assert.ok(corridor.samples[i].distanceKm > corridor.samples[i - 1].distanceKm);
  }
  for (const seg of doc.route.segments) {
    assert.ok(ids.some((id) => id.startsWith(`${seg.id}:`)), `no samples on ${seg.id}`);
  }
  const last = corridor.samples[corridor.samples.length - 1];
  assert.equal(last.segmentId, doc.route.segments[1].id);
});

test('a mission with no waypoints falls back to the planned bearing', () => {
  const doc = mission([]);
  const snap = analyze(doc);
  assert.equal(snap.route, null);
  assert.deepEqual(snap.segments, {});

  const { corridor } = snap;
  assert.ok(corridor.samples.length > 1);
  assert.equal(corridor.samples[0].id, 'launch:0');
  assert.ok(corridor.samples[1].id.startsWith('primary:'));
  assert.equal(corridor.samples[1].segmentId, null);
  // The fallback runs out to the turnaround on the planned course.
  assert.equal(corridor.samples[1].bearingDeg, WIND_FROM);
  const last = corridor.samples[corridor.samples.length - 1];
  assert.ok(Math.abs(last.distanceKm - snap.plan.radiusKm) < 1e-9);
});

/* ---------- 6. the memo ---------- */

test('the same question twice is the same snapshot object', () => {
  clearAnalysisCache();
  const doc = mission([{ at: wpAt(0, 4) }]);
  const first = analyze(doc, inputs());
  const again = analyze(doc, inputs());
  assert.equal(first, again, 'a structurally identical request must hit the memo');
  assert.equal(first.provenance.cacheKey, again.provenance.cacheKey);
  assert.equal(first.provenance.modelVersion, ANALYSIS_MODEL_VERSION);
  assert.equal(first.id, `ana_${first.provenance.cacheKey}`);

  const windier = analyze(doc, inputs({}, { windAvgMs: U.mphToMs(9) }));
  assert.notEqual(windier, first);
  assert.notEqual(windier.provenance.cacheKey, first.provenance.cacheKey);

  // A different route under the same revision stamp is a different question.
  const moved = analyze(mission([{ at: wpAt(10, 4) }]), inputs());
  assert.notEqual(moved.provenance.cacheKey, first.provenance.cacheKey);

  // As is the same question asked with a different set of providers.
  const withTerrain = analyze(doc, inputs(), { terrainWarnings: () => [] });
  assert.notEqual(withTerrain.provenance.cacheKey, first.provenance.cacheKey);
});

test('a snapshot cannot be edited in place', () => {
  const doc = mission([{ at: wpAt(0, 4) }]);
  const snap = analyze(doc);
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.constraints));
  assert.ok(Object.isFrozen(snap.segments));
  assert.ok(Object.isFrozen(snap.corridor));
  assert.throws(() => { snap.constraints.push({}); });
});

/* ---------- 7. the stale-drop guard ---------- */

test('newestOnly() refuses an answer to a question that has moved on', () => {
  const guard = newestOnly();
  const r1 = { missionId: 'msn_1', missionUpdatedAt: '2026-07-30T12:00:00.000Z' };
  const r2 = { missionId: 'msn_1', missionUpdatedAt: '2026-07-30T12:00:01.000Z' };
  const r3 = { missionId: 'msn_2', missionUpdatedAt: '2026-07-30T12:00:01.000Z' };

  assert.equal(guard.accept(r1), false, 'nothing has begun, so nothing is current');

  guard.begin(r1);
  assert.equal(guard.accept(r1), true);
  assert.equal(guard.accept(r1, 'snapshot'), 'snapshot');

  // Interleaved: the second pass begins before the first one finishes.
  guard.begin(r2);
  assert.equal(guard.accept(r1), false, 'the slow answer is dropped');
  assert.equal(guard.accept(r1, 'snapshot'), false);
  assert.equal(guard.accept(r2, 'snapshot'), 'snapshot');

  // A different mission entirely is still just "not the newest".
  guard.begin(r3);
  assert.equal(guard.accept(r2), false);
  assert.equal(guard.accept(r3), true);

  // Tokens are monotonic, so a caller can log which pass an answer came from.
  const a = guard.begin(r3);
  const b = guard.begin(r3);
  assert.ok(b > a);
  assert.equal(guard.accept(r3), true, 're-beginning the same revision keeps it current');
});

/* ---------- 8. provenance ---------- */

test('every provenance field is present, carrying null when nothing supplied it', () => {
  const doc = mission([{ at: wpAt(0, 4) }]);
  const snap = analyze(doc);
  const keys = ['modelVersion', 'forecastIssue', 'forecastValid', 'terrainSource',
    'samplingResolution', 'calibrationSource', 'retrievedAt', 'computedAt', 'cacheKey'];
  for (const key of keys) {
    assert.ok(key in snap.provenance, `provenance.${key} is missing entirely`);
  }
  assert.equal(snap.provenance.forecastIssue, null);
  assert.equal(snap.provenance.calibrationSource, null);
  assert.equal(snap.provenance.computedAt, AT);
  assert.match(snap.provenance.samplingResolution, /corridor samples/);
});

test('the composition layer can state provenance the document cannot', () => {
  const doc = mission([{ at: wpAt(0, 4) }]);
  const snap = analyze(doc, inputs(), {
    elevationProfile: () => ({ points: [{ distKm: 0, elevM: 167 }], spanKm: 4.6 }),
    terrainWarnings: () => [],
    provenance: {
      terrainSource: 'Open-Meteo elevation (Copernicus DEM 30 m)',
      forecastIssue: '2026-07-30T06:00:00Z',
      retrievedAt: '2026-07-30T11:58:00Z',
    },
  });
  assert.equal(snap.provenance.terrainSource, 'Open-Meteo elevation (Copernicus DEM 30 m)');
  assert.equal(snap.provenance.forecastIssue, '2026-07-30T06:00:00Z');
  assert.equal(snap.provenance.retrievedAt, '2026-07-30T11:58:00Z');
  assert.match(snap.provenance.samplingResolution, /elevation points over 4.6 km/);
});
