import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeForcingField, classificationSensitivity,
  CLASS_SEVERITY, FORCING_CLASS_IDS, DEFAULT_FORCING_THRESHOLDS, DEFAULT_PERTURBATIONS,
} from '../src/domain/wind/terrain-forcing.js';
import { computeRegime, gridReliefM, REGIME_THRESHOLDS } from '../src/domain/wind/regime.js';
import { SEVERITIES } from '../src/application/analysis/analysis-contracts.js';

/* M5 wave 1: the mountain-flow advisory maths, and the exit-gate invariants it
 * has to satisfy before anything is drawn on a map.
 *
 * The plan's automated gate for this milestone names four things a pure test can
 * prove — synthetic slope signs reverse when the wind reverses; windward and lee
 * classification is invariant to map orientation; perturbation tests produce
 * bounded sensitivity; missing data never becomes a classification — and each
 * has a block below carrying the same words in its name.
 *
 * Every fixture is analytic. A Gaussian ridge, a plane, a col and a canyon are
 * shapes whose windward and lee sides are known before the code runs, which is
 * the artifact's own advice: "start with synthetic terrain fixtures … where
 * windward/lee sign and ridge-normal geometry are known". No DEM, no network,
 * no floating-point luck: where an assertion needs a tolerance it says why. */

const RAD = Math.PI / 180;
const MS_PER_MPH = 0.44704;

/** Cell size and grid width shared by the fixtures, so numbers read across tests. */
const CELL_M = 90;
const N = 21;

/**
 * A square grid from an analytic surface. `h(x, y)` takes metres east and metres
 * north of the grid centre; `lat`/`lng` are filled plausibly and never read by
 * the module under test, which is the point — the arithmetic is metric and the
 * geography is the renderer's problem.
 *
 * @param {(x: number, y: number) => number|null} h
 * @param {{ n?: number, cellSizeM?: number }} [opts]
 */
function gridFrom(h, { n = N, cellSizeM = CELL_M } = {}) {
  const mid = (n - 1) / 2;
  const cells = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const x = (col - mid) * cellSizeM;
      const y = (mid - row) * cellSizeM;
      cells.push({ lat: 45 + y / 111320, lng: -110 + x / 78700, elevM: h(x, y) });
    }
  }
  return { rows: n, cols: n, cellSizeM, cells };
}

/** An infinite Gaussian ridge of relief `heightM`, crest line on `axisDeg`. */
const ridgeSurface = (axisDeg, heightM = 300, sigmaM = 250) => (x, y) => {
  // Distance from the crest line, measured perpendicular to the axis bearing.
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
  const east = distM * Math.sin(bearingDeg * RAD);
  const north = distM * Math.cos(bearingDeg * RAD);
  const col = Math.round(mid + east / grid.cellSizeM);
  const row = Math.round(mid - north / grid.cellSizeM);
  return row * grid.cols + col;
}

/** Every classId in the field, as one string per row — readable on a failure. */
function classMap(grid, field) {
  const letter = { uplift: 'U', lee: 'L', ridge: 'R', gap: 'G', low: '.', unknown: '?' };
  return Array.from({ length: grid.rows }, (_, r) => Array.from(
    { length: grid.cols }, (_, c) => letter[field.cells[r * grid.cols + c].classId],
  ).join('')).join('\n');
}

/* ---------- gate 1: synthetic slope signs reverse when the wind reverses ---------- */

test('w* on a plane is the wind speed times the slope along the flow', () => {
  // A plane rising due east at 10%, wind out of the west: the flow runs straight
  // up the fall line, so w* is U·slope with nothing left to interpret.
  const grid = gridFrom(planeSurface(0.1, 90));
  const field = computeForcingField(grid, { windMph: 20, windFromDeg: 270 });
  const expected = 20 * MS_PER_MPH * 0.1;

  const middle = cellAt(grid, 0, 0);
  assert.ok(Math.abs(field.cells[middle].wStarMs - expected) < 1e-12);
  assert.equal(field.cells[middle].classId, 'uplift');

  // Wind across the fall line does no vertical work at all.
  const across = computeForcingField(grid, { windMph: 20, windFromDeg: 180 });
  assert.ok(Math.abs(across.cells[middle].wStarMs) < 1e-12);
  assert.equal(across.cells[middle].classId, 'low');
});

test('synthetic slope signs reverse exactly when wind direction reverses', () => {
  const grid = gridFrom(planeSurface(0.1, 90));
  const up = computeForcingField(grid, { windMph: 20, windFromDeg: 270 });
  const down = computeForcingField(grid, { windMph: 20, windFromDeg: 90 });

  for (let i = 0; i < up.cells.length; i++) {
    const a = up.cells[i].wStarMs;
    const b = down.cells[i].wStarMs;
    assert.ok(a != null && b != null);
    // Not `-a === b`: the two flow vectors are built from sin/cos of bearings
    // 180° apart, which agree to rounding rather than to the last bit. The
    // invariant is the sign flip; 1e-12 m/s is nine orders below the 0.5 m/s
    // threshold that decides anything.
    assert.ok(Math.abs(a + b) < 1e-12, `cell ${i}: ${a} vs ${b}`);
    assert.equal(Math.sign(a), -Math.sign(b));
    assert.equal(up.cells[i].classId, 'uplift');
    assert.equal(down.cells[i].classId, 'lee');
  }
  assert.equal(up.cells[0].severity, 'advisory');
  assert.equal(down.cells[0].severity, 'warning');
});

test('a ridge reads windward, crest, lee in flight order', () => {
  // Crest line east–west, wind out of the south: the southern flank climbs, the
  // crest is crossed, the northern flank descends.
  const grid = gridFrom(ridgeSurface(90));
  const field = computeForcingField(grid, { windMph: 20, windFromDeg: 180 });
  const map = classMap(grid, field);

  assert.equal(field.cells[cellAt(grid, 180, 5 * CELL_M)].classId, 'uplift', map);
  assert.equal(field.cells[cellAt(grid, 0, 0)].classId, 'ridge', map);
  assert.equal(field.cells[cellAt(grid, 0, 5 * CELL_M)].classId, 'lee', map);
  // The strongest descent sits just downwind of the crest, and it must not be
  // demoted to the crest's caution — severity has to be monotone in the
  // evidence, which is the whole reason `lee` outranks `ridge`.
  const justLee = field.cells[cellAt(grid, 0, 2 * CELL_M)];
  assert.equal(justLee.classId, 'lee', map);
  assert.equal(justLee.severity, 'warning');
});

/* ---------- gate 2: classification is invariant to map orientation ---------- */

test('lee and windward classification is invariant when scene and wind rotate together', () => {
  // Rotating the map cannot move the weather. For each bearing the whole scene
  // is rebuilt — ridge axis and wind together — and the three probes are taken
  // in scene-relative directions, so a classifier that had a grid-axis bias
  // (the mixed second derivative is where one would hide) fails here.
  for (const turn of [0, 37, 90, 143, 217, 300]) {
    const axisDeg = 90 + turn;
    const windFromDeg = 180 + turn;
    const grid = gridFrom(ridgeSurface(axisDeg));
    const field = computeForcingField(grid, { windMph: 20, windFromDeg });
    const where = `turn ${turn}\n${classMap(grid, field)}`;

    const windward = field.cells[cellAt(grid, windFromDeg, 5 * CELL_M)];
    const crest = field.cells[cellAt(grid, 0, 0)];
    const lee = field.cells[cellAt(grid, windFromDeg + 180, 5 * CELL_M)];

    assert.equal(windward.classId, 'uplift', where);
    assert.equal(crest.classId, 'ridge', where);
    assert.equal(lee.classId, 'lee', where);
    assert.ok(windward.wStarMs > 0 && lee.wStarMs < 0, where);
  }
});

test('a quarter turn of grid and wind permutes the field exactly', () => {
  // The arbitrary-bearing test above resamples the surface, so its agreement is
  // to within a cell. A quarter turn maps cells onto cells, so this one demands
  // the numbers themselves — the same elevations, re-indexed, under a wind
  // turned by the same 90°.
  const grid = gridFrom(ridgeSurface(30));
  const n = grid.rows;
  const turned = {
    rows: n,
    cols: n,
    cellSizeM: grid.cellSizeM,
    // Rotating the scene 90° clockwise sends what lay to the north to the east.
    cells: Array.from({ length: n * n }, (_, k) => {
      const row = Math.floor(k / n);
      const col = k % n;
      return grid.cells[(n - 1 - col) * n + row];
    }),
  };

  const before = computeForcingField(grid, { windMph: 20, windFromDeg: 120 });
  const after = computeForcingField(turned, { windMph: 20, windFromDeg: 210 });

  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const here = after.cells[row * n + col];
      const there = before.cells[(n - 1 - col) * n + row];
      assert.equal(here.classId, there.classId, `cell ${row},${col}`);
      assert.equal(here.severity, there.severity);
      assert.ok(Math.abs((here.wStarMs ?? 0) - (there.wStarMs ?? 0)) < 1e-9);
    }
  }
  // A fixture that survived by being symmetric would prove nothing.
  assert.ok(before.meta.counts.byClass.uplift > 20);
  assert.ok(before.meta.counts.byClass.lee > 20);
});

/* ---------- gate 3: perturbation tests produce bounded sensitivity ---------- */

test('perturbation sensitivity is bounded on a ridge crossed by the wind', () => {
  const grid = gridFrom(ridgeSurface(90));
  const report = classificationSensitivity(grid, { windMph: 20, windFromDeg: 180 });

  // The envelope is the artifact's: direction ±20°, speed ±30%, all nine
  // combinations less the unperturbed one.
  assert.equal(report.members, 8);
  assert.equal(report.classifiedCells, N * N);
  assert.ok(report.changedFraction != null);

  // The bound: a quarter of the classified cells. It is a chosen number, not a
  // derived one, and the argument for it is where the movement is. A hard
  // threshold at 0.5 m/s means the cells that flip are the cells sitting within
  // ±30% of it — the outer fringe of the windward and lee fields, plus the
  // boundary between them — and on a barrier the wind actually crosses that
  // fringe is a small share of the map. The measured figure for this fixture is
  // ≈0.10, so the bound is a regression guard with room, not a fitted line.
  assert.ok(report.changedFraction <= 0.25,
    `changedFraction ${report.changedFraction}`);
  assert.ok(report.worstMemberFraction <= report.changedFraction);

  for (const member of report.byMember) {
    assert.ok(member.changedFraction >= 0 && member.changedFraction <= 1);
  }
});

test('the core of a feature keeps its class across the whole envelope', () => {
  // Boundedness in aggregate could still hide a fixture whose *findings* move.
  // The cells that carry the advisory — well up the windward flank, well down
  // the lee one, and the crest — have to survive every member intact.
  const grid = gridFrom(ridgeSurface(90));
  const wind = { windMph: 20, windFromDeg: 180 };
  const base = computeForcingField(grid, wind);
  const probes = [
    cellAt(grid, 180, 4 * CELL_M), cellAt(grid, 180, 6 * CELL_M),
    cellAt(grid, 0, 0),
    cellAt(grid, 0, 4 * CELL_M), cellAt(grid, 0, 6 * CELL_M),
  ];

  for (const directionDeg of DEFAULT_PERTURBATIONS.directionDeg) {
    for (const speedFrac of DEFAULT_PERTURBATIONS.speedFrac) {
      const member = computeForcingField(grid, {
        windMph: wind.windMph * (1 + speedFrac),
        windFromDeg: wind.windFromDeg + directionDeg,
      });
      for (const i of probes) {
        assert.equal(member.cells[i].classId, base.cells[i].classId,
          `cell ${i} at ${directionDeg}° / ${speedFrac}`);
      }
    }
  }
});

test('sensitivity is zero when nothing is perturbed and on flat ground', () => {
  const grid = gridFrom(ridgeSurface(90));
  const still = classificationSensitivity(grid, { windMph: 20, windFromDeg: 180 }, {
    directionDeg: [0], speedFrac: [0],
  });
  assert.equal(still.members, 0);
  assert.equal(still.changedFraction, 0);
  assert.equal(still.worstMemberFraction, null);

  const flat = classificationSensitivity(gridFrom(() => 1200), { windMph: 20, windFromDeg: 180 });
  assert.equal(flat.changedFraction, 0);
});

test('wind along a ridge line reports the sensitivity that makes it low confidence', () => {
  // The artifact lists "near-parallel ridge wind" among the triggers for a
  // confidence warning, and this is the metric earning its keep: a wind blowing
  // along the crest produces almost no forcing, so the map is quiet — but a 20°
  // error in the forecast direction rewrites most of it. Quiet and unstable is
  // not the same as quiet, and the number says which one this is.
  const grid = gridFrom(ridgeSurface(90));
  const along = computeForcingField(grid, { windMph: 20, windFromDeg: 270 });
  assert.equal(along.meta.counts.byClass.low, N * N);

  const report = classificationSensitivity(grid, { windMph: 20, windFromDeg: 270 });
  assert.ok(report.changedFraction > 0.4, `changedFraction ${report.changedFraction}`);
  assert.ok(report.changedFraction <= 1);
});

/* ---------- gate 4: missing data never becomes a classification ---------- */

test('flat terrain is low forcing everywhere, and never calm', () => {
  const grid = gridFrom(() => 1200);
  const field = computeForcingField(grid, { windMph: 35, windFromDeg: 240 });

  assert.equal(field.meta.counts.byClass.low, N * N);
  assert.equal(field.meta.counts.unknown, 0);
  for (const cell of field.cells) {
    assert.equal(cell.classId, 'low');
    // ADR 0008: rendered and worded as "low modeled forcing", never "safe".
    assert.equal(cell.severity, 'low-forcing');
    assert.ok(cell.wStarMs === 0);
  }
});

test('a cell with no elevation is unknown, never classified', () => {
  const hole = 7 * N + 7;
  const grid = gridFrom(ridgeSurface(90));
  grid.cells[hole] = { ...grid.cells[hole], elevM: null };
  const field = computeForcingField(grid, { windMph: 20, windFromDeg: 180 });

  assert.equal(field.cells[hole].classId, 'unknown');
  assert.equal(field.cells[hole].severity, 'unknown');
  assert.equal(field.cells[hole].wStarMs, null);
  assert.equal(field.meta.counts.unknown, 1);
  assert.equal(field.meta.counts.classified, N * N - 1);

  // Its neighbours keep a one-sided gradient — a hole is not contagious — but
  // they lose the complete 3×3 the shape tests need, and the count says so.
  assert.notEqual(field.cells[hole - 1].classId, 'unknown');
  assert.notEqual(field.cells[hole + N].classId, 'unknown');
  assert.equal(field.meta.counts.shapeUnavailable, 4 * N - 4 + 8);
});

test('a cell with no neighbours to difference against is unknown, not flat', () => {
  // The east–west neighbourhood is entirely missing, so there is no east–west
  // slope. Reporting zero there would be the module calling a hole flat ground.
  const grid = {
    rows: 3,
    cols: 3,
    cellSizeM: CELL_M,
    cells: [
      { lat: 45, lng: -110, elevM: null }, { lat: 45, lng: -110, elevM: 1000 }, { lat: 45, lng: -110, elevM: null },
      { lat: 45, lng: -110, elevM: null }, { lat: 45, lng: -110, elevM: 1100 }, { lat: 45, lng: -110, elevM: null },
      { lat: 45, lng: -110, elevM: null }, { lat: 45, lng: -110, elevM: 1200 }, { lat: 45, lng: -110, elevM: null },
    ],
  };
  const field = computeForcingField(grid, { windMph: 20, windFromDeg: 180 });
  for (const cell of field.cells) {
    assert.equal(cell.classId, 'unknown');
    assert.equal(cell.wStarMs, null);
  }
  assert.equal(field.meta.counts.classified, 0);

  // Nothing was classifiable, so there is nothing whose stability could have
  // been measured. Zero would claim a stability that was never tested.
  const report = classificationSensitivity(grid, { windMph: 20, windFromDeg: 180 });
  assert.equal(report.changedFraction, null);
  assert.equal(report.classifiedCells, 0);
});

/* ---------- shape classes ---------- */

test('a col across the flow is a gap; the foot of a slope is not', () => {
  // Two summits north and south of a saddle, wind out of the west straight
  // through it. The saddle is the one place the ground rises on both sides of
  // the flow.
  const col = (x, y) => {
    const peak = (dy) => 400 * Math.exp(-((x * x) + (y - dy) * (y - dy)) / (2 * 400 * 400));
    return peak(700) + peak(-700);
  };
  const grid = gridFrom(col);
  const field = computeForcingField(grid, { windMph: 20, windFromDeg: 270 });
  const map = classMap(grid, field);

  const saddle = field.cells[cellAt(grid, 0, 0)];
  assert.equal(saddle.classId, 'gap', map);
  assert.equal(saddle.severity, 'caution');

  // Flow *along* the same ridge line, where the only cross-flow shape is the
  // concave foot of a single slope. Concavity is not confinement, and a hundred
  // gap cells at the feet of a ridge was the bug this asserts against.
  const parallel = computeForcingField(gridFrom(ridgeSurface(90)), {
    windMph: 20, windFromDeg: 270,
  });
  assert.equal(parallel.meta.counts.byClass.gap, 0, classMap(grid, parallel));
});

test('a shape in near-calm air is scenery, not a caution', () => {
  const grid = gridFrom(ridgeSurface(90));
  const breeze = computeForcingField(grid, { windMph: 0.5, windFromDeg: 180 });
  assert.equal(breeze.meta.counts.byClass.ridge, 0);
  assert.equal(breeze.meta.counts.byClass.low, N * N);
});

/* ---------- contracts ---------- */

test('every severity this module emits is in ADR 0008 taxonomy', () => {
  // The domain layer may not import the application layer (ADR 0009), so the
  // warning taxonomy is declared twice and held in lockstep here instead.
  for (const classId of FORCING_CLASS_IDS) {
    assert.ok(SEVERITIES.includes(CLASS_SEVERITY[classId]), classId);
  }
  // B1 alone can never reach red. ADR 0008 reserves it for violations and the
  // rotor-prone advisory, and rotor-prone needs stability and shear evidence a
  // terrain gradient does not have.
  assert.ok(!Object.values(CLASS_SEVERITY).includes('critical'));
  assert.equal(Object.keys(CLASS_SEVERITY).length, FORCING_CLASS_IDS.length);
});

test('the field records the wind and the thresholds it actually used', () => {
  const grid = gridFrom(ridgeSurface(90));
  const field = computeForcingField(grid, { windMph: 20, windFromDeg: 190 }, {
    thresholds: { lowForcingMs: 1.5 },
    windSource: 'forecast-80m',
  });

  assert.equal(field.meta.baseline, 'B1-terrain-forcing');
  assert.equal(field.meta.quantity, 'relative-forcing-proxy');
  assert.equal(field.meta.wind.windFromDeg, 190);
  assert.equal(field.meta.wind.flowToDeg, 10);
  assert.equal(field.meta.wind.source, 'forecast-80m');
  assert.ok(Math.abs(field.meta.wind.speedMs - 20 * MS_PER_MPH) < 1e-12);
  assert.equal(field.meta.thresholds.lowForcingMs, 1.5);
  assert.equal(field.meta.thresholds.minCrestReliefM, DEFAULT_FORCING_THRESHOLDS.minCrestReliefM);
  assert.deepEqual(field.meta.grid, { rows: N, cols: N, cellSizeM: CELL_M });

  // A higher floor can only quieten the map, never enlarge it.
  const base = computeForcingField(grid, { windMph: 20, windFromDeg: 190 });
  assert.ok(field.meta.counts.byClass.low > base.meta.counts.byClass.low);
});

/* ---------- B2: the stability-aware regime ---------- */

/**
 * A sounding with a chosen potential-temperature gradient, which is what
 * stability *is*: `θ(z) = θ₀ + γz`, converted back to the temperatures a
 * provider would publish at each pressure level.
 *
 * @param {number} gammaKPerM potential temperature gradient
 * @param {number} windMph
 * @param {{ levels?: number[], windFromDeg?: number }} [opts]
 */
function sounding(gammaKPerM, windMph, { levels = [0, 400, 800, 1200], windFromDeg = 270 } = {}) {
  return levels.map((heightM) => {
    const hPa = 1000 * Math.exp(-heightM / 8400);
    const thetaK = 293.15 + gammaKPerM * heightM;
    return {
      hPa,
      heightM,
      tempC: thetaK * Math.pow(hPa / 1000, 0.2857) - 273.15,
      windMph,
      windFromDeg,
    };
  });
}

test('a missing sounding is unknown, not a guess', () => {
  for (const missing of [undefined, null, [], [{ hPa: 900 }]]) {
    const result = computeRegime({ sounding: missing, wind: { windMph: 25, windFromDeg: 270 }, reliefM: 800 });
    assert.equal(result.regime, 'unknown');
    assert.equal(result.froude, null);
    assert.equal(result.brunt, null);
    assert.deepEqual(result.band.regimes, []);
  }
  // A strong background wind is not a substitute for stability: with no
  // sounding there is no N, and N cannot be inferred from a surface reading.
  const noRelief = computeRegime({ sounding: sounding(0.004, 20), reliefM: 0 });
  assert.equal(noRelief.regime, 'unknown');
  assert.equal(noRelief.basis.reason, 'no-relief');
});

test('stronger stratification lowers the Froude number toward blocked', () => {
  const gammas = [0.0005, 0.001, 0.002, 0.004, 0.008];
  const results = gammas.map((g) => computeRegime({ sounding: sounding(g, 8), reliefM: 800 }));

  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i].brunt > results[i - 1].brunt, `N at γ=${gammas[i]}`);
    assert.ok(results[i].froude < results[i - 1].froude, `Fr at γ=${gammas[i]}`);
  }
  // Both ends of the taxonomy are reachable: a nocturnal inversion in light wind
  // blocks, a weakly stratified gale goes over.
  assert.equal(computeRegime({ sounding: sounding(0.012, 5), reliefM: 800 }).regime, 'blocked');
  assert.equal(computeRegime({ sounding: sounding(0.001, 50), reliefM: 800 }).regime, 'flow-over');
  // And the whole ordering is monotone in the wind too.
  const light = computeRegime({ sounding: sounding(0.004, 5), reliefM: 800 });
  const strong = computeRegime({ sounding: sounding(0.004, 40), reliefM: 800 });
  assert.ok(strong.froude > light.froude);
  assert.equal(light.regime, 'blocked');
});

test('a regime the perturbation band overturns is reported as transition', () => {
  // Fr sits just under the blocked threshold, so the central value alone would
  // say 'blocked'. A ±30% forecast error crosses the line, and that is a
  // sensitivity finding rather than a regime finding.
  const near = computeRegime({ sounding: sounding(0.004, 10), reliefM: 800 });
  assert.ok(near.froude < REGIME_THRESHOLDS.blockedBelow);
  assert.equal(near.regime, 'transition');
  assert.deepEqual(near.band.regimes, ['blocked', 'transition']);
  assert.ok(near.band.froudeMin < near.froude && near.band.froudeMax > near.froude);
  assert.ok(near.band.agreement > 0 && near.band.agreement < 1);
  assert.equal(near.band.members, 9);

  // Every answer carries its band, including the decisive ones.
  const decided = computeRegime({ sounding: sounding(0.012, 5), reliefM: 800 });
  assert.deepEqual(decided.band.regimes, ['blocked']);
  assert.equal(decided.band.agreement, 1);
  assert.ok(decided.band.froudeMin > 0);
});

test('an unstable layer is unknown rather than quietly promoted to flow-over', () => {
  const result = computeRegime({ sounding: sounding(-0.005, 20), reliefM: 800 });
  assert.equal(result.regime, 'unknown');
  assert.equal(result.basis.reason, 'unstable-or-neutral-layer');
  assert.equal(result.froude, null);
  assert.equal(result.brunt, null);
  assert.ok(result.basis.n2PerS2 < 0);
});

test('the background wind stands in for a sounding with no winds', () => {
  const bare = sounding(0.004, 20).map(({ hPa, heightM, tempC }) => ({ hPa, heightM, tempC }));
  const fallback = computeRegime({
    sounding: bare, wind: { windMph: 20, windFromDeg: 270 }, reliefM: 800,
  });
  const full = computeRegime({ sounding: sounding(0.004, 20), reliefM: 800 });

  assert.equal(fallback.basis.windSource, 'fallback');
  assert.equal(full.basis.windSource, 'sounding');
  assert.ok(Math.abs(fallback.froude - full.froude) < 1e-9);

  // No wind anywhere is a missing input, not a calm one.
  const none = computeRegime({ sounding: bare, reliefM: 800 });
  assert.equal(none.regime, 'unknown');
  assert.equal(none.basis.reason, 'no-wind');
  assert.ok(none.brunt > 0, 'stability was known even though the wind was not');
});

test('the barrier layer is the sounding levels that span the relief', () => {
  const deep = computeRegime({ sounding: sounding(0.004, 20), reliefM: 800 });
  assert.equal(deep.basis.levelsUsed, 3);
  assert.equal(deep.basis.layerDepthM, 800);

  // A barrier shorter than the level spacing measures the layer the sounding
  // actually resolves, and reports that depth rather than inventing a gradient.
  const shallow = computeRegime({
    sounding: sounding(0.004, 20, { levels: [0, 1000, 2000] }), reliefM: 300,
  });
  assert.equal(shallow.basis.levelsUsed, 2);
  assert.equal(shallow.basis.layerDepthM, 1000);
  assert.equal(shallow.basis.hM, 300);
});

test('grid relief is the barrier height the grid implies', () => {
  const grid = gridFrom(ridgeSurface(90, 300, 250));
  const relief = gridReliefM(grid);
  assert.ok(relief > 299 && relief <= 300);

  assert.equal(gridReliefM({ cells: [] }), null);
  assert.equal(gridReliefM({ cells: [{ elevM: 100 }, { elevM: null }] }), null);
  assert.equal(gridReliefM({ cells: [{ elevM: 100 }, { elevM: 250 }, { elevM: null }] }), 150);
});
