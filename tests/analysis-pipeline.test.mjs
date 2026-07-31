import test from 'node:test';
import assert from 'node:assert/strict';

import { destination, distanceKm } from '../src/domain/geo.js';
import { planMission, powerAtSpeed, U } from '../src/domain/physics.js';
import { planRoute } from '../src/domain/route.js';
import { createTerrainSampler } from '../src/application/terrain/sample-corridor.js';
import { climbEnergyWh } from '../src/domain/vertical.js';
import { adaptiveHalfSweep, radiusAtAlpha, fullCircle, polarAreaKm2 } from '../src/sweep.js';
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

/* The same airframe as an embedded snapshot, for the fixtures that need the
 * document to know what the aircraft can do. `maxSpeedMs` is the one M7's
 * wind-aware hold check reads, and it is read off the document — not off the
 * planner's inputs — because that is where an imported mission carries it. */
const MOZ7_SNAPSHOT = {
  sourceId: 'moz7v2', name: 'GEPRC MOZ7 V2', dryMassG: 843, propDiaIn: 7.5, numRotors: 4,
  etaProp: 0.55, cdA: 0.042, avionicsW: 12, maxSpeedMs: 30.5, cruiseMs: 18,
};

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
 *
 * `scene` is a list of `doc => command` builders applied after the route, so a
 * fixture can name the segment or subject the reducer just minted. `aircraft` is
 * an embedded loadout snapshot for the checks that read one.
 */
function mission(points, { returnMode = null, aircraft = null, scene = [] } = {}) {
  const deps = {
    idgen: idgen(),
    now: () => AT,
    onWarning: (w) => assert.fail(`fixture rejected: ${w.code} ${w.message}`),
  };
  let doc = createMission({
    launch: { latitude: AUSTIN.lat, longitude: AUSTIN.lng, elevationMslM: LAUNCH_ELEV_M },
    title: 'fixture',
  }, deps);
  if (aircraft) doc = missionReduce(doc, { type: 'snapshotLoadout', payload: { aircraft } }, deps);
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
  for (const command of scene) doc = missionReduce(doc, command(doc), deps);
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

test('a 120 s orbit costs its worst quarter: tangential speed plus the wind', () => {
  const plan = planMission(inputs());
  const points = [{ at: wpAt(0, plan.radiusKm * 0.4) }, { at: wpAt(60, plan.radiusKm * 0.4) }];
  const holdDoc = mission([points[0], { ...points[1], intent: 'orbit', holdS: 120 }]);
  const held = analyze(holdDoc);
  const plain = analyze(mission(points));

  const seg = segAt(held, holdDoc, 1);
  const windMs = plan.wind.planningMs;
  assert.ok(windMs > 1, 'the fixture has to have wind in it for this to be a test');

  // ADR 0011 §3: an orbit is charged at the airspeed of its upwind quarter —
  // the rate it carries around the circle, plus the wind straight into it — and
  // that figure goes through the same rotor model as every other speed.
  assert.equal(seg.holdS, 120);
  assert.equal(seg.holdAirspeedMs, seg.groundSpeedMs + windMs);
  assert.equal(seg.holdPowerW, powerAtSpeed(plan.cfg, seg.holdAirspeedMs));
  assert.equal(seg.holdWh, 120 * seg.holdPowerW / 3600);
  assert.ok(seg.holdWh > 120 * held.plan.hover.pW / 3600,
    'carrying a circle through a headwind cannot cost less than hovering in still air');
  assert.equal(seg.energyWh, seg.flightWh + seg.holdWh);
  assert.ok(seg.explanations.includes('X-HOLD-ORBIT-AIRSPEED'));

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
  assert.equal(direct.route.waypointCount, 2);

  // Retrace is the waypoint list plus its own reverse: the same solver, more legs.
  assert.equal(retrace.route.returnMode, 'retrace');
  assert.equal(retrace.route.legs.length, 4);
  // The count the pilot authored, not the doubled list the solver flew — the map
  // puts one pin per authored waypoint and has no other way to know where the
  // mirror starts.
  assert.equal(retrace.route.waypointCount, 2);
  assert.equal(none.route.waypointCount, 2);
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

/* ---------- 8b. forecast age and flight-count calibration (ADR 0012 §1) ---------- */

/* forecastAgeDrafts anchors on when the environment was *fetched*
 * (prov.retrievedAt), never on the forecast hour it describes (validAt) — an
 * archive lookup is deliberately about an hour that already happened, and
 * that is never itself a reason to warn. What ages is how long ago the fetch
 * landed, and only when there was a fetch to age at all: a manual or preset
 * environment carries no provenance, and must never earn either code however
 * stale its capturedAt looks. capturedAt is only the fallback, because it is
 * a push instant, re-stamped by every rail edit. */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The exact shape mission-commands.js's environmentReference() fills in (SI
// units, every field required by checkEnvironment) — a fixture with a hole in
// it would be rejected by the reducer's own validation, not a fixture the
// forecast-age logic ever sees.
const VALID_ENV_VALUES = {
  temperatureC: 24, relativeHumidityPct: 40, windAvgMs: 5, windGustMs: 8, windFromDeg: 170,
};

/**
 * A one-waypoint mission whose environmentReference was fetched `ageMs`
 * before AT — the same clock every `analyze()` call in this file runs the
 * pipeline on, so the age is pinned exactly rather than raced against a real
 * clock. No memo clearing: the aircraft bag and the env provenance bag are
 * both part of analyzeMission's cache key, so fixtures differing only there
 * are different questions rather than hits on each other's snapshot.
 */
function withFetchedEnv(ageMs, { source = 'live' } = {}) {
  const doc = mission([{ at: wpAt(0, 4) }]);
  const capturedAt = new Date(Date.parse(AT) - ageMs).toISOString();
  return missionReduce(doc, {
    type: 'setEnvironmentReference',
    payload: {
      source,
      capturedAt,
      values: VALID_ENV_VALUES,
      provenance: { source: 'open-meteo-forecast', retrievedAt: capturedAt, validAt: capturedAt },
    },
  }, { idgen: idgen(), now: () => AT });
}

test('a forecast just under 6 hours old earns neither age code', () => {
  const doc = withFetchedEnv(HOUR_MS * 6 - 1000);
  const snap = analyze(doc);
  assert.ok(!codes(snap).includes('W-DATA-FORECAST-AGE'));
  assert.ok(!codes(snap).includes('W-DATA-FORECAST-STALE'));
});

test('a forecast just past 6 hours old earns a caution, not yet a warning', () => {
  const doc = withFetchedEnv(HOUR_MS * 6 + 1000);
  const snap = analyze(doc);
  assert.ok(codes(snap).includes('W-DATA-FORECAST-AGE'));
  assert.ok(!codes(snap).includes('W-DATA-FORECAST-STALE'));
});

test('a forecast just past 24 hours old escalates to a warning, and the caution does not also fire', () => {
  const doc = withFetchedEnv(DAY_MS + 1000);
  const snap = analyze(doc);
  assert.ok(codes(snap).includes('W-DATA-FORECAST-STALE'));
  assert.ok(!codes(snap).includes('W-DATA-FORECAST-AGE'));
});

test('the forecast-age caution still fires in the no-pack branch of compute()', () => {
  const doc = withFetchedEnv(HOUR_MS * 6 + 1000);
  const snap = analyze(doc, inputs({ battery: null }));
  assert.ok(codes(snap).includes('W-DATA-FORECAST-AGE'));
});

test('a manual or preset environment never earns a forecast-age code, however old its capturedAt', () => {
  for (const source of ['manual', 'preset']) {
    const doc = mission([{ at: wpAt(0, 4) }]);
    const oldCapture = new Date(Date.parse(AT) - DAY_MS * 5).toISOString();
    // No provenance at all — a manual entry or a saved preset has no fetch
    // instant to age, which is exactly what gates this off in forecastAgeDrafts.
    const withEnv = missionReduce(doc, {
      type: 'setEnvironmentReference',
      payload: { source, presetId: source === 'preset' ? 'calm-evening' : null, capturedAt: oldCapture, values: VALID_ENV_VALUES },
    }, { idgen: idgen(), now: () => AT });
    const snap = analyze(withEnv);
    assert.ok(!codes(snap).includes('W-DATA-FORECAST-AGE'), `${source} must never age`);
    assert.ok(!codes(snap).includes('W-DATA-FORECAST-STALE'), `${source} must never age`);
  }
});

test('a fetched environment bag reaches the snapshot provenance unchanged, end to end', () => {
  const doc = mission([{ at: wpAt(0, 4) }]);
  const capturedAt = '2026-07-30T09:00:00.000Z'; // 3 hours before AT, under the caution threshold
  const withEnv = missionReduce(doc, {
    type: 'setEnvironmentReference',
    payload: {
      source: 'live',
      capturedAt,
      values: VALID_ENV_VALUES,
      provenance: { source: 'open-meteo-forecast', retrievedAt: capturedAt, validAt: '2026-07-30T09:00' },
    },
  }, { idgen: idgen(), now: () => AT });

  const snap = analyze(withEnv);
  // The fetch bag's `validAt` is where the pipeline's `forecastValid` comes
  // from — the one place the two vocabularies (weather.js's and ADR 0008's)
  // meet (buildProvenance).
  assert.equal(snap.provenance.forecastValid, '2026-07-30T09:00');
  assert.equal(snap.provenance.retrievedAt, capturedAt);
  // Under 6 hours old: neither age code fires, proving this is a clean read
  // rather than a side effect of the threshold tests above.
  assert.ok(!codes(snap).includes('W-DATA-FORECAST-AGE'));
  assert.ok(!codes(snap).includes('W-DATA-FORECAST-STALE'));
});

test('a re-push that re-stamps capturedAt does not reset the forecast age clock', () => {
  // A wind-level edit hours after the fetch re-pushes the same environment
  // (app.js's editEnv): capturedAt becomes "now" while retrievedAt stays the
  // fetch instant. The age anchors on the fetch, so the caution still fires.
  const doc = mission([{ at: wpAt(0, 4) }]);
  const fetchedAt = new Date(Date.parse(AT) - HOUR_MS * 7).toISOString();
  const withEnv = missionReduce(doc, {
    type: 'setEnvironmentReference',
    payload: {
      source: 'live',
      capturedAt: AT, // the push instant — fresh, unlike the fetch behind it
      values: VALID_ENV_VALUES,
      provenance: { source: 'open-meteo-forecast', retrievedAt: fetchedAt, validAt: fetchedAt },
    },
  }, { idgen: idgen(), now: () => AT });
  const snap = analyze(withEnv);
  assert.ok(codes(snap).includes('W-DATA-FORECAST-AGE'));
  // …and the snapshot's own retrievedAt reports the fetch, not the push.
  assert.equal(snap.provenance.retrievedAt, fetchedAt);
});

test('calibrationSource names the flight count a calibrated aircraft rode in on', () => {
  const doc = mission([{ at: wpAt(0, 4) }], {
    aircraft: { ...MOZ7_SNAPSHOT, calibrated: true, nFlights: 3 },
  });
  const snap = analyze(doc);
  assert.equal(snap.provenance.calibrationSource, 'flight-log calibration (3 flights)');
});

test('calibrationSource is singular for exactly one flight', () => {
  const doc = mission([{ at: wpAt(0, 4) }], {
    aircraft: { ...MOZ7_SNAPSHOT, calibrated: true, nFlights: 1 },
  });
  const snap = analyze(doc);
  assert.equal(snap.provenance.calibrationSource, 'flight-log calibration (1 flight)');
});

test('calibrationSource omits the count for a snapshot saved before nFlights existed', () => {
  // A pre-M8 document's aircraftSnapshot has no nFlights key at all; the rig
  // is genuinely calibrated, so the label must not invent "(0 flights)".
  const doc = mission([{ at: wpAt(0, 4) }], {
    aircraft: { ...MOZ7_SNAPSHOT, calibrated: true },
  });
  const snap = analyze(doc);
  assert.equal(snap.provenance.calibrationSource, 'flight-log calibration');
});

test('an uncalibrated aircraft names its stated confidence instead of a flight count', () => {
  const doc = mission([{ at: wpAt(0, 4) }], {
    aircraft: { ...MOZ7_SNAPSHOT, calibrated: false, confidence: 'manufacturer spec' },
  });
  const snap = analyze(doc);
  assert.equal(snap.provenance.calibrationSource, 'manufacturer spec');
});

/* ---------- 9. the footprint ---------- */

/* The wind-shaped turnaround envelope moved out of src/map.js and into the
 * pipeline under ADR 0004, so the map became a thing that draws a snapshot
 * rather than the only place the footprint existed. These hold it to the same
 * claim the plan and the route are held to above: an arrangement of sweep.js and
 * planMission, producing their numbers exactly. */

const SWEEP_KIT = { adaptiveHalfSweep, radiusAtAlpha, fullCircle, polarAreaKm2 };

test('the footprint is sweep.js and planMission, ray for ray', () => {
  clearAnalysisCache();
  const inp = inputs();
  const doc = mission([{ at: wpAt(0, 4) }]);

  // An absent kit is an absent ring, not half of one.
  assert.equal(analyze(doc, inp).footprint, null);

  const fp = analyze(doc, inp, { sweepKit: SWEEP_KIT }).footprint;
  assert.ok(fp, 'a wired sweepKit produces a footprint');

  const windFrom = inp.env.windFromDeg;
  const cache = new Map();
  const half = (cruiseMode) => adaptiveHalfSweep((alpha) => planMission({
    ...inp, cruiseMode, courseDeg: windFrom + alpha, lite: true, _pCache: cache,
  }).radiusKm);
  const halfReal = half(inp.cruiseMode);
  const real = fullCircle(halfReal, windFrom);
  const best = fullCircle(half('range'), windFrom);

  assert.ok(real.radii.some((r) => r > 0), 'the fixture has to sweep a real ring');
  assert.deepEqual(fp.courses, real.courses);
  assert.deepEqual(fp.radii, real.radii);
  assert.deepEqual(fp.byCourse, real.byCourse);
  assert.deepEqual(fp.bestCourses, best.courses);
  assert.deepEqual(fp.bestRadii, best.radii);
  assert.deepEqual(fp.bestByCourse, best.byCourse);
  assert.equal(fp.areaKm2, polarAreaKm2(real.courses, real.radii));

  // The three axis reaches come off the half-sweep at their exact offsets, which
  // is not the same as indexing byCourse whenever the wind is off a whole degree.
  assert.equal(fp.upwindKm, radiusAtAlpha(halfReal, 0));
  assert.equal(fp.downwindKm, radiusAtAlpha(halfReal, 180));
  assert.equal(fp.crosswindKm, radiusAtAlpha(halfReal, 90));

  // Where it is centred and which way the planning case points out of it.
  assert.deepEqual(fp.launch, { lat: AUSTIN.lat, lng: AUSTIN.lng });
  assert.equal(fp.windFromDeg, WIND_FROM);
  assert.equal(fp.plannedCourseDeg, WIND_FROM, 'headOut flies into the wind');
  assert.ok(Object.isFrozen(fp));
});

test('the footprint memo outlives the snapshot memo: a route edit does not re-fly it', () => {
  clearAnalysisCache();
  const inp = inputs();
  const one = analyze(mission([{ at: wpAt(0, 4) }]), inp, { sweepKit: SWEEP_KIT });
  const two = analyze(mission([{ at: wpAt(0, 4) }, { at: wpAt(90, 4) }]), inp,
    { sweepKit: SWEEP_KIT });

  assert.notEqual(one, two, 'a different route is a different question');
  assert.equal(one.footprint, two.footprint,
    'but not a different ring — the footprint reads the rail, not the route');

  // The rail moving is what invalidates it.
  const windier = analyze(mission([{ at: wpAt(0, 4) }]),
    inputs({}, { windAvgMs: U.mphToMs(9) }), { sweepKit: SWEEP_KIT });
  assert.notEqual(windier.footprint, one.footprint);
  assert.notDeepEqual(windier.footprint.radii, one.footprint.radii);

  // And a hard reset drops it with everything else.
  clearAnalysisCache();
  const after = analyze(mission([{ at: wpAt(0, 4) }]), inp, { sweepKit: SWEEP_KIT });
  assert.notEqual(after.footprint, one.footprint, 'cleared means recomputed');
  assert.deepEqual(after.footprint.radii, one.footprint.radii, 'recomputed, not different');
});

test('no pack is no ring, however the sweep is wired', () => {
  clearAnalysisCache();
  const snap = analyze(mission([{ at: wpAt(0, 3) }]), inputs({ battery: null }),
    { sweepKit: SWEEP_KIT });
  assert.equal(snap.plan, null);
  assert.equal(snap.footprint, null);
});

/* ---------- 10. the shot (M7) ----------
 *
 * ADR 0011 §3's claim in three parts: the camera geometry reaches the snapshot
 * so nothing downstream recomputes it (ADR 0002), a hold pays for the wind it
 * has to sit in, and a cinematic segment goes through every gate a transit leg
 * does rather than around them.
 *
 * The shot numbers below are hand-derived from a 3-4-5 triangle laid out in
 * metres, not read back from domain/camera.js. */

/* The ADR's own analytic lens: 36 x 24 mm at 24 mm is exactly 2*atan(0.75)
 * across and 2*atan(0.5) down. */
const FULL_FRAME = {
  name: 'Full-frame mirrorless camera',
  sensorWidthMm: 36, sensorHeightMm: 24, focalLengthMm: 24, stabilized: false,
};
const H_FOV_DEG = 2 * Math.atan(0.75) * 180 / Math.PI;      // 73.7398...

/** `doc => command` builders, so a fixture can name what the reducer just minted. */
const addSubject = (payload) => () => ({ type: 'addSubject', payload });
const frameSegment = (i) => (d) => ({
  type: 'setSegmentSubject',
  payload: { segmentId: d.route.segments[i].id, subjectRef: d.scene.subjects[0].id },
});
const segmentCamera = (i, camera) => (d) => ({
  type: 'setSegmentCamera', payload: { segmentId: d.route.segments[i].id, camera },
});
const withProfile = (profile) => () => ({ type: 'setCameraProfile', payload: { profile } });

const close = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol,
  `${what}: ${actual} is not within ${tol} of ${expected}`);

/* Leg 1 of this route runs 1000 m due north, level, 80 m above the launch point.
 * The subject sits 400 m along that leg and 300 m to its right, at exactly the
 * height the leg is flown at — so every figure below is a 3-4-5 triangle:
 *
 *              start ----400m----+----600m---- end     (travelling north)
 *                                |
 *                              300m            distance from start = 500 m
 *                                |             distance from end   = 300*sqrt(5)
 *                             subject          (mid is 500 m along, so the
 *                                               subject sits 100 m behind it) */
const SHOT_WP1 = wpAt(0, 1);
const SHOT_WP2 = wpAt(0, 2);
const SHOT_ALT_M = 80;
const [SHOT_SUB_LAT, SHOT_SUB_LNG] = (() => {
  const [lat, lng] = destination(SHOT_WP1.lat, SHOT_WP1.lng, 0, 0.4);
  return destination(lat, lng, 90, 0.3);
})();
const SHOT_SUBJECT = {
  name: 'Pennybacker Bridge',
  latitude: SHOT_SUB_LAT, longitude: SHOT_SUB_LNG,
  elevationMslM: LAUNCH_ELEV_M + SHOT_ALT_M,
  radiusM: 50,
};

/** The two-waypoint fixture above, with whatever scene the caller asks for. */
const shotMission = (scene, { subject = SHOT_SUBJECT, intent = 'transit', holdS = null } = {}) =>
  mission(
    [{ at: SHOT_WP1, altM: SHOT_ALT_M },
      { at: SHOT_WP2, altM: SHOT_ALT_M, intent, ...(holdS != null ? { holdS } : {}) }],
    { aircraft: MOZ7_SNAPSHOT, scene: subject ? [addSubject(subject), ...scene] : scene },
  );

test('a framed leg carries its whole shot, computed against the altitudes everything else used', () => {
  const doc = shotMission([frameSegment(1), withProfile(FULL_FRAME)]);
  const seg = segAt(analyze(doc), doc, 1);

  assert.equal(seg.subjectRef, doc.scene.subjects[0].id);
  const shot = seg.shot;
  assert.ok(shot, 'a segment pointed at a subject has a shot');
  assert.equal(shot.subjectId, doc.scene.subjects[0].id);
  assert.equal(shot.subjectName, 'Pennybacker Bridge');

  // 3-4-5 from the start, and sqrt(300^2 + 600^2) from the end. The tolerance is
  // for the geodesic the fixture is laid out on, not for the arithmetic.
  close(shot.distanceStartM, 500, 0.2, 'distance at the start of the leg');
  close(shot.distanceEndM, 300 * Math.sqrt(5), 0.2, 'distance at the end of the leg');
  // From the midpoint the subject is 300 m right and 100 m behind: atan2(300, -100).
  close(shot.bearingToSubjectDeg, 180 - Math.atan2(300, 100) * 180 / Math.PI, 0.05, 'bearing');
  // Level with the leg, so the shot is dead flat — exactly, not nearly.
  assert.equal(shot.elevationAngleDeg, 0);
  // Northbound leg, subject to the right of travel: it enters frame left while
  // still ahead and leaves frame right once behind.
  assert.equal(shot.screenDirection, 'left-to-right');

  // A 50 m radius at 500 m subtends 2*atan(0.1); the frame is 2*atan(0.75) wide.
  close(shot.framingStart, 2 * Math.atan(50 / 500) * 180 / Math.PI / H_FOV_DEG, 1e-4, 'framing at the start');
  close(shot.framingEnd, 2 * Math.atan(50 / shot.distanceEndM) * 180 / Math.PI / H_FOV_DEG, 1e-9, 'framing at the end');
  assert.ok(shot.framingStart > shot.framingEnd, 'the subject fills less frame as the leg leaves it');
  assert.equal(shot.subjectRadiusM, 50);
  close(shot.fov.hDeg, H_FOV_DEG, 1e-9, 'horizontal field of view');
  close(shot.fov.vDeg, 2 * Math.atan(0.5) * 180 / Math.PI, 1e-9, 'vertical field of view');
  assert.ok(seg.explanations.includes('X-SHOT-FRAMED'));
});

test('a segment framing nothing has no shot, and a shot missing an input has named nulls', () => {
  // Nothing attached: no subject reference, no camera bag, no shot at all.
  const bare = shotMission([], { subject: null });
  const bareSeg = segAt(analyze(bare), bare, 1);
  assert.equal(bareSeg.subjectRef, null);
  assert.equal(bareSeg.camera, null);
  assert.equal(bareSeg.shot, null);
  assert.equal(bareSeg.explanations.includes('X-SHOT-FRAMED'), false);

  // A subject at an unknown height: the geometry cannot be had, and every field
  // that depended on it is null rather than a height standing in for one.
  const noElev = shotMission([frameSegment(1), withProfile(FULL_FRAME)],
    { subject: { ...SHOT_SUBJECT, elevationMslM: null } });
  const floating = segAt(analyze(noElev), noElev, 1).shot;
  assert.ok(floating, 'the record still exists — it says what is missing');
  for (const field of ['distanceStartM', 'distanceEndM', 'bearingToSubjectDeg',
    'elevationAngleDeg', 'screenDirection', 'framingStart', 'framingEnd']) {
    assert.equal(floating[field], null, `${field} has no value without the subject's height`);
  }
  assert.equal(floating.subjectRadiusM, 50, 'what is known is still stated');
  assert.equal(floating.subjectId, noElev.scene.subjects[0].id);

  // A scene with no lens: the geometry stands, the framing does not.
  const unprofiled = shotMission([frameSegment(1)]);
  const shot = segAt(analyze(unprofiled), unprofiled, 1).shot;
  assert.equal(shot.fov, null);
  assert.equal(shot.framingStart, null);
  assert.equal(shot.framingEnd, null);
  close(shot.distanceStartM, 500, 0.2, 'distance survives an unprofiled camera');

  // A radius nobody measured: same rule, other input.
  const noRadius = shotMission([frameSegment(1), withProfile(FULL_FRAME)],
    { subject: { ...SHOT_SUBJECT, radiusM: null } });
  const unsized = segAt(analyze(noRadius), noRadius, 1).shot;
  assert.equal(unsized.subjectRadiusM, null);
  assert.equal(unsized.framingStart, null);
  close(unsized.distanceStartM, 500, 0.2, 'distance survives an unmeasured subject');
});

test('the camera bag reaches the snapshot verbatim', () => {
  const camera = { pitchDeg: -15, yawOffsetDeg: 10, orbit: null };
  const doc = shotMission([frameSegment(1), segmentCamera(1, camera)]);
  assert.deepEqual(segAt(analyze(doc), doc, 1).camera, camera);
});

test('a hold is charged at the airspeed it takes to stay put, calm air included', () => {
  const doc = mission([{ at: wpAt(0, 1) }, { at: wpAt(0, 2), intent: 'hold', holdS: 90 }]);
  const holdWhAt = (inp) => {
    const plan = planMission(inp);
    const seg = segAt(analyze(doc, inp), doc, 1);
    assert.equal(seg.holdAirspeedMs, plan.wind.planningMs, 'station-keeping is flying at the wind');
    assert.equal(seg.holdPowerW, powerAtSpeed(plan.cfg, plan.wind.planningMs));
    assert.equal(seg.holdWh, 90 * seg.holdPowerW / 3600);
    assert.ok(seg.explanations.includes('X-HOLD-STATION-POWER'));
    return { seg, plan };
  };

  // Calm air: powerAtSpeed(cfg, 0) *is* plan.hover.pW, by construction in
  // physics.js. The pre-M7 figure is therefore preserved to the bit for a
  // windless plan — the new model costs nothing where there is nothing to fight.
  const calm = holdWhAt(inputs({}, { windAvgMs: 0, windGustMs: 0 }));
  assert.equal(calm.seg.holdAirspeedMs, 0);
  assert.equal(calm.seg.holdPowerW, calm.plan.hover.pW);
  assert.equal(calm.seg.holdWh, 90 * calm.plan.hover.pW / 3600);

  // A light wind costs *less* than hovering, and that is the rotor model
  // speaking rather than a mistake: translational lift makes slow forward
  // flight cheaper than a hover, and route.js has charged loiter this way since
  // M1. The claim M7 makes is "the airspeed it takes", not "more".
  const breeze = holdWhAt(inputs());
  assert.ok(breeze.plan.wind.planningMs > 0 && breeze.plan.wind.planningMs < 10);
  assert.ok(breeze.seg.holdWh < calm.seg.holdWh,
    'a hold in a light breeze is cheaper than a hover — the power curve dips before it climbs');

  // Past the dip the curve climbs steeply, and a real wind costs real energy.
  const blow = holdWhAt(inputs({}, { windAvgMs: U.mphToMs(30), windGustMs: U.mphToMs(34) }));
  assert.ok(blow.plan.wind.planningMs > 12);
  assert.ok(blow.seg.holdWh > calm.seg.holdWh,
    'holding station against a real wind costs more than hovering in still air');
  assert.ok(blow.seg.holdWh > breeze.seg.holdWh);
});

test('a segment that does not station-keep is untouched by the wind-aware hold model', () => {
  const inp = inputs();
  const plan = planMission(inp);
  const points = [wpAt(20, plan.radiusKm * 0.5), wpAt(80, plan.radiusKm * 0.45)];
  const doc = mission(points.map((at) => ({ at })));
  const snap = analyze(doc, inp);

  // The same fixture the parity test uses, against the same direct call: a leg
  // with no dwell is the integrator's own figure and nothing else.
  const direct = planRoute(plan, {
    launch: AUSTIN, waypoints: points, windFromDeg: WIND_FROM, inputs: inp,
  });
  for (let i = 0; i < 2; i++) {
    const seg = segAt(snap, doc, i);
    assert.equal(seg.flightWh, direct.legs[i].whLeg);
    assert.equal(seg.energyWh, direct.legs[i].whLeg, 'no dwell, so no addition to the leg');
    assert.equal(seg.holdWh, 0);
    assert.equal(seg.holdAirspeedMs, null, 'a transit leg is not asked what holding would cost');
    assert.equal(seg.holdPowerW, null);
  }
  assert.equal(snap.route.holdWh, 0);
  assert.equal(snap.route.missionWh, snap.route.plannedWh + snap.route.verticalWh);
});

test('a framing intent with nothing to frame is a named warning', () => {
  const doc = mission([{ at: wpAt(0, 1) }, { at: wpAt(0, 2), intent: 'approach' }],
    { aircraft: MOZ7_SNAPSHOT });
  const snap = analyze(doc);
  const missing = snap.constraints.find((c) => c.code === 'W-SHOT-SUBJECT-MISSING');
  assert.ok(missing, `expected W-SHOT-SUBJECT-MISSING, got ${codes(snap).join(', ')}`);
  assert.equal(missing.severity, 'warning');
  assert.equal(missing.anchor.scope, 'segment', 'subject findings anchor to the segment (ADR 0011 §4)');
  assert.equal(missing.anchor.refId, doc.route.segments[1].id);
  assert.match(missing.text, /'approach'/);
  assert.ok(missing.explanation.limitations.length > 0);

  // Attach a subject to the same leg and the finding goes away.
  const framed = shotMission([frameSegment(1)], { intent: 'approach' });
  assert.equal(codes(analyze(framed)).includes('W-SHOT-SUBJECT-MISSING'), false);
});

test('an orbit inside its own subject, or with no radius at all, is a named warning', () => {
  // 30 m around a subject 50 m in radius: the circle is inside the thing.
  const tight = shotMission([frameSegment(1), segmentCamera(1, { orbit: { radiusM: 30, clockwise: true } })],
    { intent: 'orbit', holdS: 60 });
  const snapTight = analyze(tight);
  const inside = snapTight.constraints.find((c) => c.code === 'W-SHOT-ORBIT-RADIUS');
  assert.ok(inside, `expected W-SHOT-ORBIT-RADIUS, got ${codes(snapTight).join(', ')}`);
  assert.equal(inside.anchor.refId, tight.route.segments[1].id);
  assert.match(inside.text, /Pennybacker Bridge/, 'the text names the subject the anchor cannot');
  assert.match(inside.text, /30 m/);
  assert.match(inside.text, /50 m/);

  // No radius authored anywhere: unresolvable, and said so rather than guessed.
  const vague = shotMission([frameSegment(1)], { intent: 'orbit', holdS: 60 });
  const unresolved = analyze(vague).constraints.find((c) => c.code === 'W-SHOT-ORBIT-RADIUS');
  assert.ok(unresolved);
  assert.match(unresolved.text, /no radius authored/);

  // A circle outside the subject, with a radius, says nothing.
  const clean = shotMission([frameSegment(1), segmentCamera(1, { orbit: { radiusM: 120, clockwise: true } })],
    { intent: 'orbit', holdS: 60 });
  const cleanCodes = codes(analyze(clean));
  assert.equal(cleanCodes.includes('W-SHOT-ORBIT-RADIUS'), false);
  assert.equal(cleanCodes.includes('W-SHOT-SUBJECT-MISSING'), false);
  assert.equal(cleanCodes.includes('W-SHOT-HOLD-WIND'), false, 'this wind is well inside the airframe');
});

test('a hold the airframe cannot fly against the wind is a named warning', () => {
  const gale = inputs({}, { windAvgMs: U.mphToMs(70), windGustMs: U.mphToMs(80) });
  assert.ok(planMission(gale).wind.planningMs > MOZ7_SNAPSHOT.maxSpeedMs,
    'the fixture has to ask for more airspeed than the airframe has');

  const doc = shotMission([frameSegment(1)], { intent: 'hold', holdS: 60 });
  const snap = analyze(doc, gale);
  const unflyable = snap.constraints.find((c) => c.code === 'W-SHOT-HOLD-WIND');
  assert.ok(unflyable, `expected W-SHOT-HOLD-WIND, got ${codes(snap).join(', ')}`);
  assert.equal(unflyable.severity, 'warning');
  assert.equal(unflyable.anchor.refId, doc.route.segments[1].id);
  assert.match(unflyable.text, /Pennybacker Bridge/);
  assert.match(unflyable.text, /30\.5 m\/s/);

  // The same shot in the fixture's own wind is flyable, and says nothing.
  assert.equal(codes(analyze(doc)).includes('W-SHOT-HOLD-WIND'), false);

  // And with no aircraft snapshot there is no top speed to check against, so
  // nothing is claimed either way.
  const anonymous = mission([{ at: wpAt(0, 1) }, { at: wpAt(0, 2), intent: 'hold', holdS: 60 }]);
  assert.equal(codes(analyze(anonymous, gale)).includes('W-SHOT-HOLD-WIND'), false);
});

test('an orbit over a ridge still raises its clearance warning and still debits the reserve', async () => {
  // 140 m of flat-topped ridge from 1.3 km out, and an orbit held over it at
  // 40 m above launch — 100 m under the ground it is circling.
  const surface = (km) => LAUNCH_ELEV_M + (km >= 1.3 && km <= 2.7 ? 140 : 0);
  const provider = {
    source: 'synthetic surface', dataset: 'test fixture', resolutionM: 30,
    attribution: 'Elevation data by the test fixture (no licence, no reality)',
    async elevations(points) {
      const elevationsM = points.map((p) => surface(distanceKm(AUSTIN, { lat: p.lat, lng: p.lng })));
      return {
        elevationsM,
        provenance: {
          source: 'synthetic surface', dataset: 'test fixture', resolutionM: 30,
          attribution: 'Elevation data by the test fixture (no licence, no reality)',
          retrievedAt: AT, requested: points.length, answered: points.length,
          missing: 0, batches: 1, notes: Object.freeze([]),
        },
      };
    },
  };

  const doc = mission([
    { at: wpAt(45, 1.0), altM: 40 },
    { at: wpAt(45, 3.0), altM: 40, intent: 'orbit', holdS: 1800 },
  ], { aircraft: MOZ7_SNAPSHOT });
  const level = mission([{ at: wpAt(45, 1.0), altM: 40 }, { at: wpAt(45, 3.0), altM: 40 }]);

  clearAnalysisCache();
  const dry = analyze(doc);
  const field = await createTerrainSampler({ provider, crossTrackOffsetM: 300, now: () => AT })(dry.corridor);
  clearAnalysisCache();
  const wet = analyze(doc, inputs(), { terrainField: () => field, terrainSignature: 'ridge' });

  // The gate the shot must not bypass: the ground under a cinematic segment is
  // checked exactly as it is under a transit leg, and the finding anchors at the
  // sample that caused it.
  const clearance = wet.constraints.find((c) => c.code === 'W-TERR-CLEARANCE');
  assert.ok(clearance, `expected W-TERR-CLEARANCE, got ${codes(wet).join(', ')}`);
  assert.equal(clearance.anchor.scope, 'sample');
  const seg = segAt(wet, doc, 1);
  assert.ok(seg.clearance.minM < 0, 'the orbit is flown below the ridge it circles');

  // …and the energy gate too: the dwell is charged, it lands in the mission
  // total, and it is measured against the loiter budget like any other hold.
  assert.ok(seg.holdWh > 0);
  assert.equal(wet.route.holdWh, seg.holdWh);
  assert.equal(wet.route.missionWh, wet.route.plannedWh + seg.holdWh + wet.route.verticalWh);
  assert.ok(wet.route.missionWh > analyze(level).route.missionWh, 'the orbit costs the mission something');
  assert.ok(codes(wet).includes('W-RESERVE-HOLD-BUDGET'),
    'a 30-minute orbit is past what is left for loitering, and says so');
});
