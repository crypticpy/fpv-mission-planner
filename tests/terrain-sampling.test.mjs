import test from 'node:test';
import assert from 'node:assert/strict';

import { createElevationCache, DEFAULT_CACHE_LIMIT } from '../src/application/terrain/elevation-cache.js';
import {
  LATERAL_LEFT_SUFFIX, LATERAL_RIGHT_SUFFIX, elevationKey, lateralSampleId, stationOf,
} from '../src/application/terrain/terrain-contracts.js';
import {
  createTerrainSampler, nearestGroundSampler, sampleCorridor,
} from '../src/application/terrain/sample-corridor.js';
import { createOpenMeteoElevationProvider } from '../src/infrastructure/elevation/open-meteo-elevation.js';
import { resolveMissionAltitudes } from '../src/domain/mission/altitude.js';
import { createMission } from '../src/domain/mission/mission-schema.js';
import { missionReduce } from '../src/domain/mission/mission-reducer.js';
import {
  FIXTURE_ORIGIN, cliffDem, corridorAlong, corridorThroughOrigin, demProvider, failingProvider,
  flatDem, missingTile, openMeteoFetchStub, pointAt, ridgeDem, saddleDem, valleyDem,
} from './fixtures/synthetic-dem.mjs';

/* The sampling service: a CorridorRequest in, a frozen TerrainField out.
 *
 * Three things these tests are really defending. The corridor's own sample ids
 * survive intact, because M3's exit gate says terrain, physics, RF, wind and
 * the renderer must all be talking about the same metre of ground. A hole in
 * the data stays a hole all the way out to the provenance block. And nothing a
 * provider can do — failing, half-failing, answering nonsense, not existing —
 * turns into an exception that takes the rest of the analysis down. */

const NOW = () => '2026-07-30T12:00:00.000Z';

/** @param {object} [spec] */
const northAcrossRidge = (spec = {}) => corridorThroughOrigin({ bearingDeg: 0, ...spec });

/* ---------- 1. the ids are the corridor's, not ours ---------- */

test('every corridor sample comes back under its own id, launch first, in order', async () => {
  const corridor = northAcrossRidge();
  const field = await sampleCorridor(corridor, { provider: demProvider(ridgeDem()), now: NOW });

  assert.deepEqual(field.samples.map((s) => s.id), corridor.samples.map((s) => s.id));
  assert.equal(field.samples[0].id, 'launch:0', 'launch is the first sample of a corridor');
  assert.equal(field.samples[0].distanceKm, 0);
  for (const sample of corridor.samples) {
    assert.ok(field.byId[sample.id], `${sample.id} is missing from the field`);
    assert.equal(field.byId[sample.id].lat, sample.latitude);
    assert.equal(field.byId[sample.id].lng, sample.longitude);
    assert.equal(field.byId[sample.id].segmentId, sample.segmentId);
  }
  assert.equal(Object.keys(field.byId).length, corridor.samples.length, 'no id was invented');
  assert.equal(field.missionId, corridor.missionId);
  assert.equal(field.revision, corridor.revision, 'the revision travels through untouched');
});

test('lateral samples derive their ids from the station they belong to', async () => {
  const corridor = northAcrossRidge({ corridorWidthM: 300, steps: 4 });
  const field = await sampleCorridor(corridor, { provider: demProvider(ridgeDem()), now: NOW });

  assert.equal(field.samples.length, corridor.samples.length * 3);
  assert.deepEqual(field.samples.slice(0, 3).map((s) => s.id),
    ['launch:0', `launch:0${LATERAL_LEFT_SUFFIX}`, `launch:0${LATERAL_RIGHT_SUFFIX}`],
    'a station is followed by its own two sides');
  assert.deepEqual(field.samples.slice(0, 3).map((s) => s.track), ['centre', 'left', 'right']);

  for (const sample of field.samples) {
    assert.equal(stationOf(sample.id).stationId, sample.stationId);
    assert.equal(stationOf(sample.id).track, sample.track);
    assert.equal(lateralSampleId(sample.stationId, sample.track), sample.id);
  }
  const left = field.byId[`seg_1:2${LATERAL_LEFT_SUFFIX}`];
  const right = field.byId[`seg_1:2${LATERAL_RIGHT_SUFFIX}`];
  const centre = field.byId['seg_1:2'];
  assert.equal(left.distanceKm, centre.distanceKm, 'a side sample is the same station, sideways');
  assert.notEqual(left.lng, right.lng);
  assert.equal(left.slopeDeg, null, 'a lateral sample is evidence, not a station of its own');
  assert.equal(left.gradientBasis, null);
  assert.equal(centre.gradientBasis, 'cross-track', 'and the station it feeds says so');
});

test('a corridor that states no width can still be asked for one', async () => {
  // M2's CorridorRequest carries corridorWidthM: 0. Cross-track evidence is the
  // only thing that separates a pass from a ridge, so the host may ask for it —
  // and the field reports the width it actually sampled, never the one it was
  // told about.
  const corridor = northAcrossRidge({ steps: 4 });
  assert.equal(corridor.corridorWidthM, 0);
  const field = await sampleCorridor(corridor, {
    provider: demProvider(ridgeDem()), crossTrackOffsetM: 250, now: NOW,
  });
  assert.equal(field.provenance.corridorWidthM, 250);
  assert.equal(field.samples.length, corridor.samples.length * 3);

  const stated = await sampleCorridor({ ...corridor, corridorWidthM: 400 }, {
    provider: demProvider(ridgeDem()), crossTrackOffsetM: 250, now: NOW,
  });
  assert.equal(stated.provenance.corridorWidthM, 400, 'a corridor that states a width wins');
});

/* ---------- 2. the ground, and the holes in it ---------- */

test('a sampled corridor carries elevations, slope and aspect on every station', async () => {
  const field = await sampleCorridor(northAcrossRidge(), {
    provider: demProvider(ridgeDem({ base: 200, heightM: 150 })), now: NOW,
  });
  const crest = field.byId['seg_1:6'];
  assert.ok(Math.abs(crest.groundMslM - 350) < 1, `crest reads ${crest.groundMslM}`);
  assert.equal(crest.source, 'provider');
  assert.ok(field.samples.every((s) => typeof s.groundMslM === 'number'));
  assert.equal(field.provenance.coverage, 'complete');
  assert.equal(field.provenance.missing, 0);
  assert.equal(field.launchGroundMslM, field.samples[0].groundMslM);

  // Climbing north out of the corridor's start, the aspect points back south.
  const climbing = field.byId['seg_1:4'];
  assert.ok(climbing.slopeDeg > 0);
  assert.ok(Math.abs(climbing.aspectDeg - 180) < 1, `aspect reads ${climbing.aspectDeg}`);
});

test('a missing tile is a null elevation and a stated hole, never an interpolation', async () => {
  const dem = missingTile(ridgeDem(), {
    eastFromM: -5000, eastToM: 5000, northFromM: -100, northToM: 100,
  });
  const field = await sampleCorridor(northAcrossRidge(), { provider: demProvider(dem), now: NOW });

  const gap = field.byId['seg_1:6'];
  assert.equal(gap.groundMslM, null, 'a tile nobody has is not sea level');
  assert.equal(gap.source, 'missing');
  assert.equal(gap.slopeDeg, null);
  assert.equal(gap.aspectDeg, null);
  assert.equal(field.provenance.missing, 1);
  assert.equal(field.provenance.coverage, 'partial');
  assert.deepEqual(field.features, [], 'no ridge is manufactured across the hole');

  // The neighbours are still answered from their own ground, not from the gap.
  assert.ok(field.byId['seg_1:5'].groundMslM > 200);
  assert.ok(field.byId['seg_1:7'].groundMslM > 200);
});

test('a provider that falls over produces a field that says so', async () => {
  const field = await sampleCorridor(northAcrossRidge(), {
    provider: failingProvider('DNS is having a day'), now: NOW,
  });
  assert.equal(field.provenance.coverage, 'empty');
  assert.equal(field.provenance.fetched, 0);
  assert.equal(field.provenance.missing, field.samples.length);
  assert.match(field.provenance.notes.join(' '), /DNS is having a day/);
  assert.ok(field.samples.every((s) => s.groundMslM === null && s.source === 'missing'));
  assert.deepEqual(field.features, []);
});

test('no provider at all is a stated absence, not a crash', async () => {
  const field = await sampleCorridor(northAcrossRidge(), { now: NOW });
  assert.equal(field.provenance.coverage, 'empty');
  assert.equal(field.provenance.source, null);
  assert.match(field.provenance.notes.join(' '), /No elevation provider is wired up/);
});

test('an answer that does not line up with the question is discarded whole', async () => {
  // With no coordinates in the payload, alignment is positional and
  // unverifiable. A short list means the elevations no longer identify the
  // points they came back for, and half a shifted profile is worse than none.
  const field = await sampleCorridor(northAcrossRidge(), {
    provider: demProvider(ridgeDem(), { misalign: true }), now: NOW,
  });
  assert.equal(field.provenance.coverage, 'empty');
  assert.match(field.provenance.notes.join(' '), /does not match the points it was asked about/);
});

test('the same corridor and the same answers produce the same field', async () => {
  const runs = await Promise.all([0, 1].map(() => sampleCorridor(northAcrossRidge(), {
    provider: demProvider(ridgeDem()), cache: createElevationCache(), now: NOW,
  })));
  assert.deepEqual(runs[0], runs[1]);
});

test('the field is frozen all the way down', async () => {
  const field = await sampleCorridor(northAcrossRidge({ corridorWidthM: 200, steps: 4 }), {
    provider: demProvider(ridgeDem()), now: NOW,
  });
  assert.ok(Object.isFrozen(field));
  assert.ok(Object.isFrozen(field.samples));
  assert.ok(Object.isFrozen(field.byId));
  assert.ok(Object.isFrozen(field.features));
  assert.ok(Object.isFrozen(field.provenance));
  assert.ok(field.samples.every((s) => Object.isFrozen(s)));
});

test('a malformed corridor is a programming error, not a degraded field', async () => {
  await assert.rejects(() => sampleCorridor(null), TypeError);
  await assert.rejects(() => sampleCorridor({ samples: 'nope' }), TypeError);
});

/* ---------- 3. provenance: who answered, and how ---------- */

test('provenance separates what was cached from what was fetched', async () => {
  const cache = createElevationCache();
  const provider = demProvider(ridgeDem(), { source: 'fixture DEM', resolutionM: 30 });
  const corridor = northAcrossRidge({ steps: 6 });

  const first = await sampleCorridor(corridor, { provider, cache, now: NOW });
  assert.equal(first.provenance.requested, 7);
  assert.equal(first.provenance.cacheHits, 0);
  assert.equal(first.provenance.fetched, 7);
  assert.equal(first.provenance.source, 'fixture DEM');
  assert.equal(first.provenance.resolutionM, 30);
  assert.equal(first.provenance.spacingM, corridor.spacingM);
  assert.equal(first.provenance.retrievedAt, '2026-07-30T12:00:00.000Z');
  assert.equal(provider.calls.length, 1);

  const second = await sampleCorridor(corridor, { provider, cache, now: NOW });
  assert.equal(second.provenance.cacheHits, 7, 'the ground does not move');
  assert.equal(second.provenance.fetched, 0);
  assert.equal(provider.calls.length, 1, 'and it was not asked twice');
  assert.deepEqual(second.samples.map((s) => s.groundMslM), first.samples.map((s) => s.groundMslM));
  assert.ok(second.samples.every((s) => s.source === 'cache'));
  assert.equal(second.provenance.source, 'fixture DEM',
    'a field served from cache still names who supplied the ground');
});

test('one place is asked about once, however many times the route crosses it', async () => {
  const corridor = northAcrossRidge({ steps: 4 });
  const doubled = {
    ...corridor,
    samples: [...corridor.samples, { ...corridor.samples[2], id: 'seg_2:1' }],
  };
  const provider = demProvider(ridgeDem());
  const field = await sampleCorridor(doubled, { provider, now: NOW });

  assert.equal(field.samples.length, 6);
  assert.equal(field.provenance.requested, 5, 'the repeated point is one question');
  assert.equal(provider.calls[0].length, 5);
  assert.equal(field.byId['seg_2:1'].groundMslM, field.byId['seg_1:2'].groundMslM);
});

test('a provider’s own notes reach the field', async () => {
  const field = await sampleCorridor(northAcrossRidge({ steps: 3 }), {
    provider: demProvider(ridgeDem(), { notes: ['batch 2 of 3: HTTP 429'] }), now: NOW,
  });
  assert.deepEqual(field.provenance.notes, ['batch 2 of 3: HTTP 429']);
});

/* ---------- 4. the seven surfaces, end to end ---------- */

test('every gate fixture produces the feature it is named after', async () => {
  const sampler = (spec) => createTerrainSampler({
    provider: demProvider(spec.dem), now: NOW, ...spec.deps,
  });

  const flat = await sampler({ dem: flatDem() })(northAcrossRidge());
  assert.deepEqual(flat.features, []);

  const ridge = await sampler({ dem: ridgeDem() })(northAcrossRidge());
  assert.deepEqual(ridge.features.map((f) => [f.kind, f.sampleId]), [['ridge', 'seg_1:6']]);

  const valley = await sampler({ dem: valleyDem() })(northAcrossRidge());
  assert.deepEqual(valley.features.map((f) => [f.kind, f.sampleId]), [['valley', 'seg_1:6']]);

  const saddle = await sampler({ dem: saddleDem() })(
    corridorThroughOrigin({ bearingDeg: 90, steps: 6, corridorWidthM: 400 }));
  assert.deepEqual(saddle.features.map((f) => [f.kind, f.sampleId]), [['saddle', 'seg_1:3']]);

  const pass = await sampler({ dem: saddleDem() })(
    corridorThroughOrigin({ bearingDeg: 0, steps: 6, corridorWidthM: 400 }));
  assert.deepEqual(pass.features.map((f) => [f.kind, f.sampleId]), [['pass', 'seg_1:3']]);

  const cliff = await sampler({ dem: cliffDem({ dropM: 80, atEastM: 25 }) })(
    corridorThroughOrigin({ bearingDeg: 90, lengthM: 600, steps: 12 }));
  assert.deepEqual(cliff.features.map((f) => [f.kind, f.sampleId, f.throughId]),
    [['cliff', 'seg_1:6', 'seg_1:7']]);

  const holed = await sampler({
    dem: missingTile(ridgeDem(), { eastFromM: -5000, eastToM: 5000, northFromM: -100, northToM: 100 }),
  })(northAcrossRidge());
  assert.deepEqual(holed.features, []);
  assert.equal(holed.provenance.coverage, 'partial');
});

/* ---------- 5. the real adapter, over a synthetic surface ---------- */

test('the Open-Meteo adapter drops straight into the sampler', async () => {
  // The pin against drift: the port typedef lives in the application layer and
  // the adapter restates it, so something has to run the two together.
  const fetchStub = openMeteoFetchStub(ridgeDem());
  const provider = createOpenMeteoElevationProvider({ fetch: fetchStub, now: NOW });
  const field = await sampleCorridor(northAcrossRidge(), { provider, now: NOW });

  assert.equal(field.provenance.coverage, 'complete');
  assert.equal(field.provenance.source, 'Open-Meteo elevation API');
  assert.equal(field.provenance.dataset, 'Copernicus DEM GLO-90');
  assert.equal(field.provenance.resolutionM, 90);
  assert.match(field.provenance.attribution, /CC BY 4\.0/);
  assert.equal(field.provenance.retrievedAt, '2026-07-30T12:00:00.000Z');
  assert.equal(fetchStub.urls.length, 1, '13 points is one batch');
  assert.deepEqual(field.features.map((f) => f.kind), ['ridge']);
});

/* ---------- 6. the cache ---------- */

test('the cache keys on quantised coordinates, so a metre of drift still hits', () => {
  const cache = createElevationCache();
  cache.set({ lat: 30.26721, lng: -97.74312 }, 187);
  assert.equal(cache.get({ lat: 30.267213, lng: -97.743118 }), 187);
  assert.equal(cache.get({ lat: 30.2685, lng: -97.74312 }), null, 'a different place is a miss');
  assert.equal(elevationKey({ lat: 30.26721, lng: -97.74312 }), '30.2672,-97.7431');
  assert.equal(elevationKey({ lat: -0.00001, lng: -0.00001 }), '0.0000,0.0000',
    'and a negative zero is a zero');
});

test('the cache never remembers a missing answer', async () => {
  const cache = createElevationCache();
  const dem = missingTile(ridgeDem(), {
    eastFromM: -5000, eastToM: 5000, northFromM: -100, northToM: 100,
  });
  const corridor = northAcrossRidge({ steps: 6 });
  const first = await sampleCorridor(corridor, { provider: demProvider(dem), cache, now: NOW });
  assert.equal(first.provenance.missing, 1);

  // A hole is often a permanent DEM gap, but it can equally be a batch that
  // failed. Re-asking costs one point; freezing a transient failure into the
  // session costs the pilot a ridge.
  const healed = await sampleCorridor(corridor, { provider: demProvider(ridgeDem()), cache, now: NOW });
  assert.equal(healed.provenance.missing, 0);
  assert.equal(healed.provenance.fetched, 1, 'only the hole was asked about again');
  assert.equal(healed.provenance.cacheHits, 6);
});

test('the cache is bounded, and evicts what has gone longest unused', () => {
  const cache = createElevationCache({ limit: 2 });
  cache.set({ lat: 1, lng: 1 }, 10);
  cache.set({ lat: 2, lng: 2 }, 20);
  assert.equal(cache.get({ lat: 1, lng: 1 }), 10, 'touching 1 makes 2 the oldest');
  cache.set({ lat: 3, lng: 3 }, 30);
  assert.equal(cache.size(), 2);
  assert.equal(cache.get({ lat: 2, lng: 2 }), null, 'the least recently used one went');
  assert.equal(cache.get({ lat: 1, lng: 1 }), 10);
  assert.equal(cache.get({ lat: 3, lng: 3 }), 30);

  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(DEFAULT_CACHE_LIMIT, 4096);
});

test('the cache refuses anything that is not a real elevation', () => {
  const cache = createElevationCache();
  for (const value of [null, undefined, NaN, Infinity, '100']) {
    cache.set({ lat: 5, lng: 5 }, /** @type {never} */ (value));
  }
  assert.equal(cache.size(), 0);
});

/* ---------- 7. the field as a ground sampler ---------- */

test('a field answers the altitude module’s question at the stations it sampled', () => {
  const corridor = corridorAlong({ from: FIXTURE_ORIGIN, bearingDeg: 45, lengthM: 1000, steps: 5 });
  const field = {
    samples: corridor.samples.map((s, i) => ({
      id: s.id, stationId: s.id, track: 'centre',
      lat: s.latitude, lng: s.longitude, distanceKm: s.distanceKm, bearingDeg: s.bearingDeg,
      segmentId: s.segmentId, groundMslM: i === 3 ? null : 200 + i,
      slopeDeg: null, aspectDeg: null, gradientBasis: null, source: 'provider',
    })),
  };
  const ground = nearestGroundSampler(/** @type {never} */ (field), { toleranceM: 120 });

  const at = corridor.samples[2];
  assert.equal(ground(at.latitude, at.longitude), 202);
  const gap = corridor.samples[3];
  assert.equal(ground(gap.latitude, gap.longitude), null,
    'the nearest station with no ground is not borrowed from');

  const away = pointAt(FIXTURE_ORIGIN, 225, 3000);
  assert.equal(ground(away.lat, away.lng), null, 'a point the corridor never looked at is unknown');
  assert.equal(ground(NaN, NaN), null);
  assert.equal(nearestGroundSampler(null)(FIXTURE_ORIGIN.lat, FIXTURE_ORIGIN.lng), null);
});

test('an AGL segment resolves through a sampled field', async () => {
  // The loop M3 closes: ground out of the corridor, in through ADR 0003's one
  // conversion site, back onto the document as a metres-MSL figure.
  let ids = 0;
  let ticks = 0;
  const deps = {
    idgen: (/** @type {string} */ prefix) => `${prefix}_${++ids}`,
    now: () => new Date(Date.UTC(2026, 6, 30, 12, 0, ticks++)).toISOString(),
  };
  const corridor = corridorAlong({ from: FIXTURE_ORIGIN, bearingDeg: 0, lengthM: 400, steps: 4 });
  const target = corridor.samples[2];
  const doc = missionReduce(
    createMission({
      launch: { latitude: FIXTURE_ORIGIN.lat, longitude: FIXTURE_ORIGIN.lng, elevationMslM: 200 },
      title: 'AGL through terrain',
    }, deps),
    {
      type: 'addWaypoint',
      payload: {
        latitude: target.latitude, longitude: target.longitude,
        altitude: { authored: 60, reference: 'agl' },
      },
    },
    deps,
  );

  const field = await sampleCorridor(corridor, {
    provider: demProvider(flatDem({ elevM: 512 })), now: NOW,
  });
  const resolved = resolveMissionAltitudes(doc, nearestGroundSampler(field));
  assert.equal(resolved.doc.route.segments[0].altitude.resolvedMslM, 572);
  assert.deepEqual(resolved.unresolved, []);

  // And with no field, the same segment is unresolved rather than sea level.
  const blind = resolveMissionAltitudes(doc, nearestGroundSampler(null));
  assert.equal(blind.doc.route.segments[0].altitude.resolvedMslM, null);
  assert.equal(blind.unresolved[0].reason, 'missing-terrain-sample');
});
