import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRID_BATCH_MAX, GRID_MAX_CELLS, GRID_MAX_DIM, GRID_MIN_CELL_SIZE_M, GRID_MIN_PADDING_M,
  createGridSampler, gridRequestFor, sampleGrid,
} from '../src/application/terrain/sample-grid.js';
import { createElevationCache } from '../src/application/terrain/elevation-cache.js';
import { distanceKm } from '../src/domain/geo.js';
import {
  FIXTURE_ORIGIN, demProvider, failingProvider, flatDem, missingTile, pointAt,
} from './fixtures/synthetic-dem.mjs';

/* Two functions, two kinds of test.
 *
 * gridRequestFor() is pure geometry: same points in, same rows/cols/cellSizeM/
 * cells out, every time. That is what lets these tests assert exact numbers
 * rather than "roughly the right shape".
 *
 * createGridSampler()/sampleGrid() is the impure half, and the properties that
 * matter are the ones sample-corridor.js is already held to: a cell nobody
 * could answer stays null, a provider batch never exceeds GRID_BATCH_MAX, and
 * nothing the network or a provider can do turns into a thrown exception. */

const NOW = () => '2026-07-30T12:00:00.000Z';

const eastOf = (from, distM) => pointAt(from, 90, distM);

/* ---------- gridRequestFor: pure geometry ---------- */

test('gridRequestFor throws on empty or invalid points, not a silent empty grid', () => {
  assert.throws(() => gridRequestFor([]), TypeError);
  assert.throws(() => gridRequestFor(null), TypeError);
  assert.throws(() => gridRequestFor([{ lat: NaN, lng: -97 }]), TypeError);
  assert.throws(() => gridRequestFor([{ lat: 30 }]), TypeError, 'a point missing lng is not a point');
});

test('gridRequestFor on one point: minimum padding, floor cell size, dims well under the cap', () => {
  const req = gridRequestFor([FIXTURE_ORIGIN]);
  // A single point has zero span, so padding is the GRID_MIN_PADDING_M floor on
  // every side: a 2 km box, quantised at the 120 m floor since nothing about a
  // point this small needs a coarser cell.
  assert.equal(req.cellSizeM, GRID_MIN_CELL_SIZE_M);
  assert.ok(req.rows < GRID_MAX_DIM && req.cols < GRID_MAX_DIM, 'a small mission shrinks the dims, not the cap');
  assert.equal(req.rows * req.cols, req.cells.length);
  assert.ok(req.rows * req.cols <= GRID_MAX_CELLS);

  // Odd dims put a true centre cell on the bounding-box centre, which for one
  // point is the point itself.
  assert.equal(req.rows % 2, 1);
  assert.equal(req.cols % 2, 1);
  const mid = req.cells[((req.rows * req.cols) - 1) / 2];
  assert.ok(Math.abs(mid.lat - FIXTURE_ORIGIN.lat) < 1e-6, `mid cell lat drifted: ${mid.lat}`);
  assert.ok(Math.abs(mid.lng - FIXTURE_ORIGIN.lng) < 1e-6, `mid cell lng drifted: ${mid.lng}`);
});

test('gridRequestFor on a long east-west route: cell size grows past the floor, the wide axis hits the cap', () => {
  const launch = FIXTURE_ORIGIN;
  const waypoint = eastOf(FIXTURE_ORIGIN, 50000);
  const req = gridRequestFor([launch, waypoint]);

  assert.ok(req.cellSizeM > GRID_MIN_CELL_SIZE_M, 'a 50 km route must not sample at the 90 m DEM floor');
  assert.equal(req.cols, GRID_MAX_DIM, 'the long axis is clamped at the 24-wide cap');
  assert.ok(req.rows < GRID_MAX_DIM, 'the short (north-south) axis stays well under the cap');
  assert.equal(req.rows * req.cols, req.cells.length);
  assert.ok(req.cells.length <= GRID_MAX_CELLS, 'the 576-cell cap holds even on a route this long');
});

test('gridRequestFor never exceeds the 576-cell cap, even on an extreme span', () => {
  const req = gridRequestFor([FIXTURE_ORIGIN, eastOf(FIXTURE_ORIGIN, 500000)]);
  assert.ok(req.rows <= GRID_MAX_DIM);
  assert.ok(req.cols <= GRID_MAX_DIM);
  assert.ok(req.cells.length <= GRID_MAX_CELLS, `${req.rows}x${req.cols} exceeds the cap`);
});

test('gridRequestFor is deterministic: identical points produce an identical request', () => {
  const points = [FIXTURE_ORIGIN, eastOf(FIXTURE_ORIGIN, 4000), pointAt(FIXTURE_ORIGIN, 0, 2500)];
  const a = gridRequestFor(points);
  const b = gridRequestFor(points.map((p) => ({ ...p })));
  assert.deepEqual(a, b);
  assert.ok(Object.isFrozen(a));
  assert.ok(Object.isFrozen(a.cells));
});

test('gridRequestFor lays cells out row-major, row 0 northernmost, col 0 westernmost', () => {
  const req = gridRequestFor([FIXTURE_ORIGIN, pointAt(FIXTURE_ORIGIN, 0, 3000), eastOf(FIXTURE_ORIGIN, 3000)]);
  assert.ok(req.rows > 1 && req.cols > 1, 'need at least a 2x2 grid to compare rows/cols');

  const firstRowLat = req.cells[0].lat;
  const lastRowLat = req.cells[(req.rows - 1) * req.cols].lat;
  assert.ok(firstRowLat > lastRowLat, 'row 0 must be north of the last row');

  const firstColLng = req.cells[0].lng;
  const secondColLng = req.cells[1].lng;
  assert.ok(firstColLng < secondColLng, 'col 0 must be west of col 1');

  // Index math: row*cols + col.
  const r = req.rows - 1, c = req.cols - 1;
  assert.deepEqual(req.cells[r * req.cols + c], req.cells[req.cells.length - 1]);
});

test('gridRequestFor spaces adjacent cell centres about cellSizeM apart', () => {
  const req = gridRequestFor([FIXTURE_ORIGIN, eastOf(FIXTURE_ORIGIN, 6000), pointAt(FIXTURE_ORIGIN, 0, 4000)]);
  assert.ok(req.rows > 1 && req.cols > 1);
  const a = req.cells[0];
  const b = req.cells[1]; // one column east
  const c = req.cells[req.cols]; // one row south
  const eastGapM = distanceKm(a, b) * 1000;
  const southGapM = distanceKm(a, c) * 1000;
  assert.ok(Math.abs(eastGapM - req.cellSizeM) < 1, `east gap ${eastGapM} vs cellSizeM ${req.cellSizeM}`);
  assert.ok(Math.abs(southGapM - req.cellSizeM) < 1, `south gap ${southGapM} vs cellSizeM ${req.cellSizeM}`);
});

test('gridRequestFor honours an explicit paddingM instead of the default rule', () => {
  const points = [FIXTURE_ORIGIN, eastOf(FIXTURE_ORIGIN, 50000)];
  const padded = gridRequestFor(points); // default: max(1000, 25% of 50 km) pad
  const unpadded = gridRequestFor(points, { paddingM: 0 });
  assert.ok(unpadded.cells.length < padded.cells.length, 'no padding must cover less ground, so fewer/coarser cells');
  // With no padding, the north-south span collapses to zero (both points share
  // a latitude), so the short axis floors at a single row.
  assert.equal(unpadded.rows, 1);
});

test('gridRequestFor still pads a small mission to at least GRID_MIN_PADDING_M on a side', () => {
  const req = gridRequestFor([FIXTURE_ORIGIN, eastOf(FIXTURE_ORIGIN, 200)]); // a 200 m hop
  // Half the padded east-west span must be at least the padding floor plus half
  // the (tiny) route itself.
  const halfSpanM = distanceKm(req.cells[0], req.cells[req.cols - 1]) * 1000 / 2;
  assert.ok(halfSpanM >= GRID_MIN_PADDING_M - 1, `half span ${halfSpanM} looks unpadded`);
});

/* ---------- createGridSampler / sampleGrid: the impure half ---------- */

test('sampleGrid throws on a malformed request, the one input error worth throwing on', async () => {
  await assert.rejects(() => sampleGrid(null), TypeError);
  await assert.rejects(() => sampleGrid({}), TypeError);
  await assert.rejects(() => sampleGrid({ rows: 1, cols: 1, cellSizeM: 120, cells: 'nope' }), TypeError);
  await assert.rejects(() => sampleGrid({ rows: 1, cols: 1, cells: [] }), TypeError, 'missing cellSizeM');
});

test('sampleGrid with no provider wired: every cell null, a note, empty coverage — never a crash', async () => {
  const request = gridRequestFor([FIXTURE_ORIGIN]);
  const field = await sampleGrid(request, { now: NOW });

  assert.ok(field.grid.cells.every((c) => c.elevM === null));
  assert.equal(field.provenance.coverage, 'empty');
  assert.equal(field.provenance.fetched, 0);
  assert.equal(field.provenance.missing, field.grid.cells.length);
  assert.ok(field.provenance.notes.some((n) => /no elevation provider/i.test(n)));
  assert.equal(field.provenance.source, null);
});

test('createGridSampler mirrors sampleGrid: deps in, one function of the request out', async () => {
  const sampler = createGridSampler({ provider: demProvider(flatDem({ elevM: 250 })), now: NOW });
  const request = gridRequestFor([FIXTURE_ORIGIN]);
  const field = await sampler(request);
  assert.ok(field.grid.cells.every((c) => c.elevM === 250));
  assert.equal(field.provenance.coverage, 'complete');
});

test('sampleGrid samples a flat surface via the provider and carries its provenance through', async () => {
  const provider = demProvider(flatDem({ elevM: 380 }), {
    source: 'synthetic DEM', dataset: 'fixture surface', resolutionM: 30,
    attribution: 'CC BY 4.0 fixture', retrievedAt: '2026-07-30T09:00:00.000Z',
  });
  const request = gridRequestFor([FIXTURE_ORIGIN]);
  const field = await sampleGrid(request, { provider, now: NOW });

  assert.ok(field.grid.cells.every((c) => c.elevM === 380));
  assert.equal(field.provenance.coverage, 'complete');
  assert.equal(field.provenance.missing, 0);
  assert.equal(field.provenance.fetched, request.cells.length);
  assert.equal(field.provenance.requested, request.cells.length);
  assert.equal(field.provenance.cacheHits, 0);
  assert.equal(field.provenance.source, 'synthetic DEM');
  assert.equal(field.provenance.dataset, 'fixture surface');
  assert.equal(field.provenance.resolutionM, 30);
  assert.equal(field.provenance.attribution, 'CC BY 4.0 fixture');
  assert.equal(field.provenance.retrievedAt, '2026-07-30T09:00:00.000Z');

  // Frozen all the way down, the way TerrainField is.
  assert.ok(Object.isFrozen(field));
  assert.ok(Object.isFrozen(field.grid));
  assert.ok(Object.isFrozen(field.grid.cells));
  assert.ok(Object.isFrozen(field.provenance));
  assert.ok(Object.isFrozen(field.provenance.notes));
});

test('sampleGrid chunks provider calls at GRID_BATCH_MAX, never asking for more at once', async () => {
  // A 50 km east-west route grids out to 8 x 24 = 192 cells — comfortably past
  // one GRID_BATCH_MAX (100) batch, forcing exactly two.
  const request = gridRequestFor([FIXTURE_ORIGIN, eastOf(FIXTURE_ORIGIN, 50000)]);
  assert.ok(request.cells.length > GRID_BATCH_MAX, 'fixture must actually exercise chunking');

  const provider = demProvider(flatDem({ elevM: 300 }));
  const field = await sampleGrid(request, { provider, now: NOW });

  assert.equal(provider.calls.length, Math.ceil(request.cells.length / GRID_BATCH_MAX));
  for (const call of provider.calls) assert.ok(call.length <= GRID_BATCH_MAX, `a batch of ${call.length} exceeds the cap`);
  assert.equal(provider.calls.reduce((sum, c) => sum + c.length, 0), request.cells.length);
  assert.equal(field.provenance.fetched, request.cells.length);
  assert.equal(field.provenance.coverage, 'complete');
});

test('sampleGrid tolerates a provider that cannot answer part of the grid: null stays null', async () => {
  const east = pointAt(FIXTURE_ORIGIN, 90, 500);
  const west = pointAt(FIXTURE_ORIGIN, 270, 500);
  const north = pointAt(FIXTURE_ORIGIN, 0, 500);
  const south = pointAt(FIXTURE_ORIGIN, 180, 500);
  const request = Object.freeze({
    rows: 1, cols: 4, cellSizeM: 500, cells: Object.freeze([east, west, north, south]),
  });
  // A hole covering only the eastward cell's neighbourhood.
  const dem = missingTile(flatDem({ elevM: 200 }), { eastFromM: 400, eastToM: 600 });
  const provider = demProvider(dem);
  const field = await sampleGrid(request, { provider, now: NOW });

  assert.equal(field.grid.cells[0].elevM, null, 'the cell over the hole stays null');
  assert.equal(field.grid.cells[1].elevM, 200);
  assert.equal(field.grid.cells[2].elevM, 200);
  assert.equal(field.grid.cells[3].elevM, 200);
  assert.equal(field.provenance.missing, 1);
  assert.equal(field.provenance.fetched, 3);
  assert.equal(field.provenance.coverage, 'partial');
});

test('sampleGrid turns a provider that throws into a stated absence, never an exception', async () => {
  const request = gridRequestFor([FIXTURE_ORIGIN]);
  const provider = failingProvider('network is down');
  const field = await sampleGrid(request, { provider, now: NOW });

  assert.ok(field.grid.cells.every((c) => c.elevM === null));
  assert.equal(field.provenance.coverage, 'empty');
  assert.ok(field.provenance.notes.some((n) => n.includes('network is down')), field.provenance.notes.join(' | '));
});

test('sampleGrid treats a misaligned provider answer as unusable, not silently shifted', async () => {
  const request = gridRequestFor([FIXTURE_ORIGIN]);
  const provider = demProvider(flatDem({ elevM: 200 }), { misalign: true });
  const field = await sampleGrid(request, { provider, now: NOW });

  assert.ok(field.grid.cells.every((c) => c.elevM === null), 'a shifted answer must not be applied at all');
  assert.equal(field.provenance.coverage, 'empty');
  assert.ok(field.provenance.notes.some((n) => /does not/i.test(n)));
});

test('sampleGrid caches answers: a second call over the same ground makes no further provider calls', async () => {
  const cache = createElevationCache();
  const provider = demProvider(flatDem({ elevM: 210 }));
  // A handful of cells, not a full gridRequestFor() grid — this is about the
  // cache, not about chunking, and a 289-cell single-point grid would spend
  // three provider batches before the assertions below even start.
  const request = Object.freeze({
    rows: 1, cols: 3, cellSizeM: 500, cells: Object.freeze([
      FIXTURE_ORIGIN, eastOf(FIXTURE_ORIGIN, 500), pointAt(FIXTURE_ORIGIN, 0, 500),
    ]),
  });

  const first = await sampleGrid(request, { provider, cache, now: NOW });
  assert.equal(first.provenance.cacheHits, 0);
  assert.equal(first.provenance.fetched, request.cells.length);
  assert.equal(provider.calls.length, 1);

  const second = await sampleGrid(request, { provider, cache, now: NOW });
  assert.equal(second.provenance.cacheHits, request.cells.length);
  assert.equal(second.provenance.fetched, 0);
  assert.equal(provider.calls.length, 1, 'the cache must have satisfied the whole second request');
  assert.ok(second.grid.cells.every((c) => c.elevM === 210));
});

test('sampleGrid dedups repeated cells within one request before asking the provider', async () => {
  const a = FIXTURE_ORIGIN;
  const b = eastOf(FIXTURE_ORIGIN, 1000);
  const provider = demProvider(flatDem({ elevM: 260 }));
  const request = Object.freeze({
    rows: 1, cols: 3, cellSizeM: 1000, cells: Object.freeze([a, { ...a }, b]),
  });
  const field = await sampleGrid(request, { provider, now: NOW });

  assert.equal(field.provenance.requested, 2, 'two distinct places, three cells');
  assert.equal(provider.calls[0].length, 2, 'the provider is only asked about the distinct places');
  assert.equal(field.grid.cells[0].elevM, field.grid.cells[1].elevM, 'both copies get the same answer');
  assert.equal(field.grid.cells.length, 3, 'the output still has one entry per requested cell');
});

test('GRID_MIN_PADDING_M, GRID_MAX_DIM and GRID_BATCH_MAX are the frozen rule, not incidental numbers', () => {
  assert.equal(GRID_MIN_PADDING_M, 1000);
  assert.equal(GRID_MAX_DIM, 24);
  assert.equal(GRID_MAX_CELLS, 576);
  assert.equal(GRID_BATCH_MAX, 100);
  assert.equal(GRID_MIN_CELL_SIZE_M, 120);
});
