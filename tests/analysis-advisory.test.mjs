import test from 'node:test';
import assert from 'node:assert/strict';

import { destination } from '../src/domain/geo.js';
import { planMission, U } from '../src/domain/physics.js';
import { planRoute } from '../src/domain/route.js';
import { createMission } from '../src/domain/mission/mission-schema.js';
import { missionReduce } from '../src/domain/mission/mission-reducer.js';
import { resolveMissionAltitudes } from '../src/domain/mission/altitude.js';
import { analyzeMission, clearAnalysisCache } from '../src/application/analysis/analyze.js';
import { CONSTRAINT_CODES } from '../src/application/analysis/constraints.js';
import {
  ADVISORY_CLASS_CODE, ADVISORY_SENSITIVITY_BOUND, SEVERITIES,
} from '../src/application/analysis/analysis-contracts.js';

/* M5 wave 3: the mountain-flow advisory, seen from the pipeline.
 *
 * Wave 1 proved the maths on analytic terrain and wave 2 proved the sampler.
 * What is left to prove is the join, and the join is where the honesty rules
 * live:
 *
 *   the zones are render data and the constraints are aggregate — a route past
 *     a ridge produces hundreds of lee cells and exactly one lee warning;
 *   the classId → code map is frozen, so the colour on the map and the code in
 *     the brief cannot drift apart;
 *   an absence is stated. No grid is 'unavailable' and W-WIND-NODATA, a grid
 *     with holes in it says how many, and neither is ever quiet ground;
 *   a number that only exists because the air is calm says so at 'unknown'
 *     rather than dressing arithmetic up as a hazard.
 *
 * Every fixture is analytic, for the same reason wave 1's are: a Gaussian ridge
 * has a windward side and a lee side that are known before the code runs. The
 * grid is placed around the launch so it reads like the ground the route flies
 * over, but nothing in the advisory reads its geography — that is the
 * renderer's problem, and wave 1's tests say so too.
 *
 * Deterministic by construction: injected ids, injected clock, no network. */

const RAD = Math.PI / 180;
const AUSTIN = { lat: 30.2672, lng: -97.7431 };
const LAUNCH_ELEV_M = U.ftToM(550);
const WIND_FROM = 170;                 // flow toward 350°, near enough due north
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
      windFromDeg: WIND_FROM, windMode: 'headOut',
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

/** A two-waypoint out-and-back, built through the real reducer. */
function mission() {
  const deps = {
    idgen: idgen(),
    now: () => AT,
    onWarning: (w) => assert.fail(`fixture rejected: ${w.code} ${w.message}`),
  };
  let doc = createMission({
    launch: { latitude: AUSTIN.lat, longitude: AUSTIN.lng, elevationMslM: LAUNCH_ELEV_M },
    title: 'advisory fixture',
  }, deps);
  for (const km of [1.2, 2.0]) {
    const [lat, lng] = destination(AUSTIN.lat, AUSTIN.lng, 0, km);
    doc = missionReduce(doc, {
      type: 'addWaypoint',
      payload: {
        latitude: lat, longitude: lng, intent: 'transit',
        altitude: { authored: 80, reference: 'launchRelative' },
      },
    }, deps);
  }
  return resolveMissionAltitudes(doc).doc;
}

const DOC = mission();
const revisionOf = (doc) => ({ missionId: doc.id, missionUpdatedAt: doc.updatedAt });

/**
 * One pass. `advisory` is the wave-3 port set — an area grid, a sounding and the
 * level the wind was read at — which analyze.js reads exactly the way the host
 * hands them over.
 */
function analyze(advisory = {}, inp = inputs()) {
  return analyzeMission({ doc: DOC, inputs: inp, revision: revisionOf(DOC) }, {
    plan: planMission,
    routePlan: planRoute,
    now: () => AT,
    ...advisory,
  });
}

/* ---------- synthetic ground ---------- */

const CELL_M = 90;
const N = 21;

/**
 * A square grid from an analytic surface, centred on the launch. `h(x, y)` takes
 * metres east and metres north of that centre.
 *
 * @param {(x: number, y: number) => number|null} h
 * @param {{ n?: number, cellSizeM?: number }} [opts]
 */
function gridFrom(h, { n = N, cellSizeM = CELL_M } = {}) {
  const mid = (n - 1) / 2;
  const mPerDegLng = 111320 * Math.cos(AUSTIN.lat * RAD);
  const cells = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const x = (col - mid) * cellSizeM;
      const y = (mid - row) * cellSizeM;
      cells.push({
        lat: AUSTIN.lat + y / 111320,
        lng: AUSTIN.lng + x / mPerDegLng,
        elevM: h(x, y),
      });
    }
  }
  return { rows: n, cols: n, cellSizeM, cells };
}

/** An infinite Gaussian ridge of relief `heightM`, crest line on `axisDeg`. */
const ridgeSurface = (axisDeg, heightM = 300, sigmaM = 250) => (x, y) => {
  const u = x * Math.cos(axisDeg * RAD) - y * Math.sin(axisDeg * RAD);
  return heightM * Math.exp(-(u * u) / (2 * sigmaM * sigmaM));
};

/** A constant plane rising `slope` metres per metre toward `upDeg`. */
const planeSurface = (slope, upDeg) => (x, y) => (
  slope * (x * Math.sin(upDeg * RAD) + y * Math.cos(upDeg * RAD))
);

/** The index of the cell nearest `distM` from the grid centre on `bearingDeg`. */
function cellAt(grid, bearingDeg, distM) {
  const mid = (grid.rows - 1) / 2;
  const col = Math.round(mid + (distM * Math.sin(bearingDeg * RAD)) / grid.cellSizeM);
  const row = Math.round(mid - (distM * Math.cos(bearingDeg * RAD)) / grid.cellSizeM);
  return row * grid.cols + col;
}

/** The sampler's answer shape: the grid, and who said so. */
function fieldFrom(grid, provOverrides = {}) {
  const missing = grid.cells.filter((c) => c.elevM == null).length;
  return {
    grid,
    provenance: {
      source: 'Open-Meteo elevation API',
      dataset: 'copernicus-dem-90m',
      resolutionM: 90,
      attribution: 'Elevation: Copernicus DEM via Open-Meteo (CC BY 4.0)',
      retrievedAt: AT,
      requested: grid.cells.length,
      cacheHits: 0,
      fetched: grid.cells.length,
      missing,
      coverage: missing === 0 ? 'complete' : 'partial',
      notes: Object.freeze([]),
      ...provOverrides,
    },
  };
}

/* ---------- the ports, as the host hands them over ---------- */

/**
 * @param {object|null} field  the grid in hand for this route, or null
 * @param {{ pending?: boolean, sounding?: object[], soundingAt?: object|null,
 *           sig?: string, levelM?: number }} [opts]
 */
const ports = (field, opts = {}) => ({
  advisoryGrid: () => ({ field, pending: opts.pending ?? false }),
  advisorySignature: opts.sig ?? 'grid-fixture',
  sounding: () => ({ levels: opts.sounding ?? [], at: opts.soundingAt ?? null }),
  windLevelM: opts.levelM ?? 80,
});

/**
 * A stable barrier layer: isothermal through the lowest 220 m, which is a rising
 * potential temperature and so a real N, with a third level above the 300 m
 * barrier that the layer selection leaves out. `windMph` is what the regime
 * reads its cross-barrier speed from.
 */
const stableSounding = (windMph) => [
  { hPa: 1000, heightM: 0, tempC: 25, windMph, windFromDeg: WIND_FROM },
  { hPa: 975, heightM: 220, tempC: 25, windMph, windFromDeg: WIND_FROM },
  { hPa: 900, heightM: 900, tempC: 20, windMph, windFromDeg: WIND_FROM },
];

/**
 * The codes this milestone's producer raised. Filtered on the producer and not
 * on the `W-WIND-` prefix, deliberately: the prefix is older than this producer
 * — W-WIND-GUST-AUTHORITY and friends are the *planner* talking about wind — and
 * the advisory's aggregate findings are the ones with `producer: 'wind'`.
 */
const windCodes = (snap) => snap.constraints
  .filter((c) => CONSTRAINT_CODES[c.code]?.producer === 'wind').map((c) => c.code);
const windConstraint = (snap, code) => snap.constraints.find((c) => c.code === code);
const classOf = (snap, idx) => snap.advisories.forcing.cells[idx].classId;

test.beforeEach(() => { clearAnalysisCache(); });

/* ---------- 1. a grid and a wind produce zones, and one constraint per class ---------- */

test('the advisory classifies the ground around the route and says each finding once', () => {
  // Crest line east–west, wind out of the south: the southern flank climbs, the
  // crest is crossed, the northern flank descends.
  const grid = gridFrom(ridgeSurface(90));
  const snap = analyze(ports(fieldFrom(grid), { sig: 'ridge' }));

  assert.equal(snap.advisories.status, 'ready');
  assert.equal(snap.advisories.grid, grid, 'the grid the map draws is the grid that was classified');
  assert.equal(snap.advisories.forcing.cells.length, grid.cells.length, 'one class per cell');
  assert.equal(snap.advisories.forcing.meta.baseline, 'B1-terrain-forcing');
  assert.equal(snap.advisories.forcing.meta.counts.unknown, 0, 'complete ground classifies completely');

  // The zones themselves: hundreds of cells, in the three classes a ridge in a
  // crossing wind has to produce.
  const counts = snap.advisories.forcing.meta.counts.byClass;
  assert.ok(counts.lee > 20 && counts.uplift > 20, `flanks: ${JSON.stringify(counts)}`);
  assert.ok(counts.ridge > 0, `a crest was crossed: ${JSON.stringify(counts)}`);

  // …and exactly one constraint each. Hundreds of identical warnings is a
  // warning list nobody reads, which is why the codes are aggregate.
  const codes = windCodes(snap);
  for (const code of ['W-WIND-LEE', 'W-WIND-UPLIFT', 'W-WIND-ACCEL']) {
    assert.equal(codes.filter((c) => c === code).length, 1, `${code} is said once: ${codes}`);
  }
  assert.equal(codes.includes('W-WIND-NODATA'), false, 'a complete grid is not missing data');

  assert.equal(windConstraint(snap, 'W-WIND-LEE').severity, 'warning');
  assert.equal(windConstraint(snap, 'W-WIND-UPLIFT').severity, 'advisory');
  assert.equal(windConstraint(snap, 'W-WIND-ACCEL').severity, 'caution');
  for (const code of ['W-WIND-LEE', 'W-WIND-UPLIFT', 'W-WIND-ACCEL']) {
    assert.equal(CONSTRAINT_CODES[code].producer, 'wind', code);
    assert.equal(CONSTRAINT_CODES[code].severity, windConstraint(snap, code).severity,
      `${code} carries the registry's severity, not one invented at the call site`);
  }

  // The prohibited claims, present as their opposites in the sentence a pilot
  // reads — not only in the explanation block behind it.
  assert.match(windConstraint(snap, 'W-WIND-LEE').text, /not a forecast vertical velocity/);
  assert.match(windConstraint(snap, 'W-WIND-LEE').text, /cannot tell you where a rotor is/);
  assert.match(windConstraint(snap, 'W-WIND-UPLIFT').text, /not lift you can plan on/);

  // Provenance says which wind, read at which level, over whose ground.
  const p = snap.advisories.provenance;
  assert.equal(p.wind.levelM, 80);
  assert.match(p.wind.source, /@80m$/, 'the level the figure was read at travels with it');
  assert.ok(p.wind.windMph > 0);
  assert.match(p.gridAttribution ?? '', /CC BY 4\.0/, 'the licence travels with the data');
  assert.equal(p.rows, N);
  assert.equal(p.cols, N);
  assert.equal(p.cellSizeM, CELL_M);
  assert.equal(p.coverage, 'complete');
  assert.equal(p.sensitivityBound, ADVISORY_SENSITIVITY_BOUND);
});

test('the same question twice produces the same constraint ids', () => {
  const field = fieldFrom(gridFrom(ridgeSurface(90)));
  const first = analyze(ports(field, { sig: 'ridge' }));
  clearAnalysisCache();
  const second = analyze(ports(field, { sig: 'ridge' }));

  assert.notEqual(second, first, 'the memo was cleared, so this is a second computation');
  assert.deepEqual(
    second.constraints.map((c) => c.id),
    first.constraints.map((c) => c.id),
    'ids are derived from the finding, not from the order a run happened to take',
  );
  const ids = first.constraints.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'and no two constraints share one');
});

/* ---------- 2. the lee is a fact about the wind, not about the map ---------- */

test('reversing the wind moves the lee to the opposite flank', () => {
  const grid = gridFrom(ridgeSurface(90));
  const field = fieldFrom(grid);
  const north = cellAt(grid, 0, 250);   // 250 m from the crest, downwind at 170°
  const south = cellAt(grid, 180, 250); // …and the same distance upwind

  const blowingNorth = analyze(ports(field, { sig: 'ridge-170' }));
  assert.equal(classOf(blowingNorth, north), 'lee');
  assert.equal(classOf(blowingNorth, south), 'uplift');

  clearAnalysisCache();
  const blowingSouth = analyze(
    ports(field, { sig: 'ridge-350' }), inputs({ windFromDeg: 350 }),
  );
  assert.equal(classOf(blowingSouth, north), 'uplift', 'the old lee flank now climbs');
  assert.equal(classOf(blowingSouth, south), 'lee', 'and the old windward flank is the lee');

  // Both are the same warning about a different piece of ground: the code is
  // stable, the zones under it moved.
  assert.ok(windCodes(blowingNorth).includes('W-WIND-LEE'));
  assert.ok(windCodes(blowingSouth).includes('W-WIND-LEE'));
});

/* ---------- 3. missing data is a stated warning, never silence (ADR 0008) ---------- */

test('no area grid at all is unavailable and says so, whether or not a port is wired', () => {
  // Nobody asked: the pipeline is running without the wave-2 sampler.
  const unwired = analyze();
  assert.equal(unwired.advisories.status, 'unavailable');
  assert.equal(unwired.advisories.forcing, null);
  assert.equal(unwired.advisories.grid, null);
  const stated = windConstraint(unwired, 'W-WIND-NODATA');
  assert.ok(stated, 'an unwired port is a stated absence, not a quiet one');
  assert.equal(stated.severity, 'unknown');
  assert.match(stated.text, /not a clear area/);

  // Asked, and the answer never came: the provider is dead, and the pass still
  // has to return rather than throw.
  clearAnalysisCache();
  const dead = analyze(ports(null, { sig: 'dead' }));
  assert.equal(dead.advisories.status, 'unavailable');
  assert.equal(windConstraint(dead, 'W-WIND-NODATA').severity, 'unknown');
  assert.match(windConstraint(dead, 'W-WIND-NODATA').text, /could not be sampled/);
  assert.match(dead.advisories.provenance.notes.join(' '), /no area grid/);
});

test('a sample still in flight is pending, and pending is not a finding', () => {
  const snap = analyze(ports(null, { pending: true, sig: 'in-flight' }));
  assert.equal(snap.advisories.status, 'pending');
  assert.deepEqual(windCodes(snap), [],
    'a question that has been asked and not yet answered is not a warning');
  assert.match(snap.advisories.provenance.notes.join(' '), /still being sampled/);
});

test('a grid with holes in it counts them, because missing is not clear', () => {
  // A square of the ridge came back without elevation — the shape of a failed
  // batch, which the sampler reports rather than throws.
  const hole = (x, y) => (Math.abs(x) < 200 && Math.abs(y - 400) < 200
    ? null
    : ridgeSurface(90)(x, y));
  const snap = analyze(ports(fieldFrom(gridFrom(hole)), { sig: 'holed' }));

  assert.equal(snap.advisories.status, 'ready', 'the rest of the grid still answered');
  const unknown = snap.advisories.forcing.meta.counts.unknown;
  assert.ok(unknown > 0, 'the hole is unknown, not zero-forcing');
  assert.equal(snap.advisories.provenance.unknownCells, unknown);
  const nodata = windConstraint(snap, 'W-WIND-NODATA');
  assert.ok(nodata, 'a hole in the coverage is stated');
  assert.equal(nodata.severity, 'unknown');
  assert.match(nodata.text, new RegExp(`${unknown} of the`), 'and counted');
  assert.match(nodata.text, /missing is not\s+clear|missing, and missing is not/);

  // The classes that survived are still reported: a hole does not suppress the
  // finding around it.
  assert.ok(windCodes(snap).includes('W-WIND-LEE'));
});

test('a grid where nothing could be classified is unavailable, not empty ground', () => {
  const snap = analyze(ports(fieldFrom(gridFrom(() => null)), { sig: 'blank' }));
  assert.equal(snap.advisories.status, 'unavailable');
  assert.equal(snap.advisories.forcing.meta.counts.classified, 0);
  assert.match(windConstraint(snap, 'W-WIND-NODATA').text, /no usable elevation/);
  assert.equal(windCodes(snap).includes('W-WIND-LEE'), false, 'nothing is claimed about it');
});

/* ---------- 4. the sounding: regime, and whose sky it is ---------- */

test('preset weather has no sounding, so the regime is unknown and stays silent', () => {
  const snap = analyze(ports(fieldFrom(gridFrom(ridgeSurface(90))), { sig: 'preset' }));

  assert.equal(snap.advisories.regime.regime, 'unknown');
  assert.equal(snap.advisories.regime.froude, null);
  assert.equal(snap.advisories.regime.basis.reason, 'insufficient-levels');
  assert.equal(windCodes(snap).includes('W-WIND-REGIME'), false,
    'a test that could not be run is not a finding about the flow');
  assert.equal(snap.advisories.provenance.soundingLevels, 0);

  // …and the terrain forcing is computed anyway: w* needs a wind, not a
  // sounding, and a preset supplies one.
  assert.equal(snap.advisories.status, 'ready');
  assert.ok(snap.advisories.forcing.meta.counts.byClass.lee > 0);
  assert.ok(windCodes(snap).includes('W-WIND-LEE'));
});

test('a stable layer in real wind is a regime caution', () => {
  const snap = analyze(ports(fieldFrom(gridFrom(ridgeSurface(90))), {
    sig: 'stable', sounding: stableSounding(8), soundingAt: { ...AUSTIN },
  }));

  const regime = snap.advisories.regime;
  assert.equal(regime.basis.reason, 'ok');
  assert.equal(regime.basis.windSource, 'sounding', 'the sounding speaks for itself');
  assert.ok(regime.froude > 0);
  assert.ok(regime.regime === 'blocked' || regime.regime === 'transition', regime.regime);

  const said = windConstraint(snap, 'W-WIND-REGIME');
  assert.ok(said, 'a regime that is not flow-over is stated');
  assert.equal(said.severity, 'caution');
  assert.match(said.text, /Fr = \d/);
  assert.equal(windCodes(snap).includes('W-WIND-STALE'), false, 'the sounding is for here');
  assert.equal(snap.advisories.provenance.soundingStale, false);
  assert.equal(snap.advisories.provenance.soundingLevels, 3);
});

test('an envelope that never leaves transition says so, not that it spans regimes', () => {
  // Fr ≈ 1 through the isothermal layer over the 300 m ridge: every ±30%
  // member lands inside (0.5, 2.0), so band.regimes is exactly ['transition'].
  // The defect this pins: the spans-more-than-one sentence firing here read
  // "spans more than one regime (transition)" — a self-contradiction, and it
  // contradicted the panel's rendering of the very same snapshot.
  const snap = analyze(ports(fieldFrom(gridFrom(ridgeSurface(90))), {
    sig: 'fr-near-one', sounding: stableSounding(12), soundingAt: { ...AUSTIN },
  }));

  const regime = snap.advisories.regime;
  assert.equal(regime.regime, 'transition');
  assert.deepEqual([...regime.band.regimes], ['transition'],
    'the fixture must sit wholly inside the transition band for this test to bite');

  const said = windConstraint(snap, 'W-WIND-REGIME');
  assert.ok(said, 'an envelope all in transition is still a finding');
  assert.equal(said.severity, 'caution');
  assert.doesNotMatch(said.text, /spans more than one regime/,
    'an envelope of one regime may not be described as spanning several');
  assert.match(said.text, /stays there across the whole sensitivity envelope/);
});

test('a Froude number that is zero only because the air is calm says so, at unknown', () => {
  const snap = analyze(ports(fieldFrom(gridFrom(ridgeSurface(90))), {
    sig: 'calm', sounding: stableSounding(0.5), soundingAt: { ...AUSTIN },
  }));

  assert.ok(snap.advisories.regime.basis.uMs <= 0.5, 'the barrier layer is calm');
  assert.equal(snap.advisories.regime.regime, 'blocked', 'Fr → 0 with U, arithmetically');

  const said = windConstraint(snap, 'W-WIND-REGIME');
  assert.equal(said.severity, 'unknown',
    'inventing a hazard out of a still afternoon is exactly what this branch refuses to do');
  assert.match(said.text, /calm/);
  assert.match(said.text, /not established/);
});

test('a sounding fetched somewhere else describes the air over there, and says which', () => {
  const [lat, lng] = destination(AUSTIN.lat, AUSTIN.lng, 90, 40); // 40 km east
  const snap = analyze(ports(fieldFrom(gridFrom(ridgeSurface(90))), {
    sig: 'stale', sounding: stableSounding(8), soundingAt: { lat, lng },
  }));

  const stale = windConstraint(snap, 'W-WIND-STALE');
  assert.ok(stale, 'a sounding about somewhere else is not quietly used as if it were about here');
  assert.equal(stale.severity, 'unknown');
  assert.match(stale.text, /40\.0 km/, 'the offset is stated, not implied');

  const p = snap.advisories.provenance;
  assert.equal(p.soundingStale, true);
  assert.ok(Math.abs(p.soundingOffsetKm - 40) < 0.5);
  assert.deepEqual(p.soundingAt, { lat, lng });

  // A launch nudged by less than the latch's own precision is the same point,
  // and must not raise a warning about itself.
  clearAnalysisCache();
  const same = analyze(ports(fieldFrom(gridFrom(ridgeSurface(90))), {
    sig: 'near', sounding: stableSounding(8), soundingAt: { lat: AUSTIN.lat + 5e-4, lng: AUSTIN.lng },
  }));
  assert.equal(windCodes(same).includes('W-WIND-STALE'), false);
  assert.equal(same.advisories.provenance.soundingStale, false);
});

/* ---------- 5. classification the envelope overturns is a sensitivity finding ---------- */

test('zones the perturbation envelope moves are reported as unsettled, not as lines', () => {
  // A plane rising at right angles to the flow: w* is zero everywhere, so every
  // cell reads 'low' — until the wind is varied by ±20°, which is enough of a
  // component along the fall line to push the whole grid over the threshold.
  const grid = gridFrom(planeSurface(0.6, WIND_FROM + 180 + 90));
  const snap = analyze(ports(fieldFrom(grid), { sig: 'knife-edge' }));

  assert.ok(snap.advisories.provenance.wind.windMph >= 8,
    'the fixture is calibrated to the planning wind; a change in it belongs in this number');
  assert.equal(snap.advisories.forcing.meta.counts.byClass.low, grid.cells.length,
    'nothing is forced when the flow runs along the contours');
  assert.ok(snap.advisories.sensitivity.changedFraction > ADVISORY_SENSITIVITY_BOUND,
    `changed ${snap.advisories.sensitivity.changedFraction}`);

  const said = windConstraint(snap, 'W-WIND-SENSITIVE');
  assert.ok(said, 'past the bound this baseline was validated to, the uncertainty is the finding');
  assert.equal(said.severity, 'caution');
  assert.match(said.text, /±20°/);
  assert.match(said.text, /not settled/);
});

/* ---------- 6. registry hygiene ---------- */

test('every advisory code is registered, attributed to the wind producer, and explained', () => {
  const codes = Object.keys(CONSTRAINT_CODES)
    .filter((c) => CONSTRAINT_CODES[c].producer === 'wind');
  assert.deepEqual(codes.sort(), [
    'W-WIND-ACCEL', 'W-WIND-LEE', 'W-WIND-NODATA', 'W-WIND-REGIME',
    'W-WIND-SENSITIVE', 'W-WIND-STALE', 'W-WIND-UPLIFT',
  ]);

  for (const code of codes) {
    const entry = CONSTRAINT_CODES[code];
    assert.equal(entry.code, code, `${code} is keyed by its own code`);
    assert.equal(entry.producer, 'wind', code);
    assert.ok(SEVERITIES.includes(entry.severity), `${code}: ${entry.severity}`);
    assert.ok(entry.explanation, `${code} has an explanation`);
    assert.ok(entry.explanation.inputs.length > 0, `${code} names its inputs`);
    assert.ok(entry.explanation.baseline.length > 0, `${code} names its baseline`);
    assert.ok(entry.explanation.limitations.length > 0, `${code} names its limitations`);
  }

  // The frozen map is what keeps the map colour and the brief code the same
  // identifier. 'low' and 'unknown' raise nothing by design.
  for (const [classId, code] of Object.entries(ADVISORY_CLASS_CODE)) {
    if (code == null) {
      assert.ok(classId === 'low' || classId === 'unknown', classId);
      continue;
    }
    assert.ok(CONSTRAINT_CODES[code], `${classId} → ${code} is registered`);
  }
});
