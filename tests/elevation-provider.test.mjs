import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ELEVATION_BATCH_MAX, OPEN_METEO_ATTRIBUTION, OPEN_METEO_DATASET, OPEN_METEO_ELEVATION_URL,
  OPEN_METEO_RESOLUTION_M, OPEN_METEO_SOURCE, createOpenMeteoElevationProvider,
} from '../src/infrastructure/elevation/open-meteo-elevation.js';
import { FIXTURE_ORIGIN, flatDem, missingTile, openMeteoFetchStub, ridgeDem } from './fixtures/synthetic-dem.mjs';

/* The Open-Meteo adapter. Everything here is the port's two promises under
 * pressure: one answer per point in the order asked, and a failure that comes
 * back as nulls and a note rather than an exception. The endpoint returns a
 * bare array of numbers with no coordinates in it, so a batch whose length is
 * wrong is unusable rather than partly usable — that is the case worth most of
 * the tests below. */

const NOW = () => '2026-07-30T12:00:00.000Z';

/** n points marching north from the fixture origin, ~11 m apart. */
const points = (n) => Array.from({ length: n }, (_, i) => ({
  lat: FIXTURE_ORIGIN.lat + i * 0.0001,
  lng: FIXTURE_ORIGIN.lng,
}));

/** @param {object} [options] */
function harness(dem = flatDem({ elevM: 300 }), options = {}) {
  const fetchStub = openMeteoFetchStub(dem, options);
  return {
    fetchStub,
    provider: createOpenMeteoElevationProvider({ fetch: fetchStub, now: NOW, ...options.provider }),
  };
}

/* ---------- batching ---------- */

test('the documented ceiling is 100 coordinates and one batch stops there', async () => {
  assert.equal(ELEVATION_BATCH_MAX, 100);
  const { provider, fetchStub } = harness();
  const out = await provider.elevations(points(100));
  assert.equal(fetchStub.calls.length, 1);
  assert.equal(fetchStub.calls[0].length, 100);
  assert.equal(out.provenance.batches, 1);
  assert.equal(out.elevationsM.length, 100);
});

test('one point over the ceiling is two requests, and 250 is three', async () => {
  const over = harness();
  await over.provider.elevations(points(101));
  assert.deepEqual(over.fetchStub.calls.map((c) => c.length), [100, 1]);

  const long = harness();
  const out = await long.provider.elevations(points(250));
  assert.deepEqual(long.fetchStub.calls.map((c) => c.length), [100, 100, 50]);
  assert.equal(out.provenance.batches, 3);
  assert.equal(out.provenance.answered, 250);
});

test('the answers keep the order they were asked in, across batch boundaries', async () => {
  const { provider } = harness(ridgeDem({ base: 100, heightM: 400, halfWidthM: 2000 }));
  const asked = points(150);
  const out = await provider.elevations(asked);
  assert.equal(out.elevationsM.length, 150);
  const dem = ridgeDem({ base: 100, heightM: 400, halfWidthM: 2000 });
  for (const index of [0, 99, 100, 149]) {
    const expected = dem(asked[index].lat, asked[index].lng);
    assert.ok(Math.abs(out.elevationsM[index] - expected) < 1e-6,
      `point ${index} came back as ${out.elevationsM[index]}, expected ${expected}`);
  }
});

test('a smaller batch size is honoured; a larger one is clamped to the ceiling', async () => {
  const small = openMeteoFetchStub(flatDem());
  await createOpenMeteoElevationProvider({ fetch: small, now: NOW, batchSize: 20 })
    .elevations(points(45));
  assert.deepEqual(small.calls.map((c) => c.length), [20, 20, 5]);

  const huge = openMeteoFetchStub(flatDem());
  await createOpenMeteoElevationProvider({ fetch: huge, now: NOW, batchSize: 5000 })
    .elevations(points(120));
  assert.deepEqual(huge.calls.map((c) => c.length), [100, 20], 'the endpoint sets the limit, not us');

  for (const batchSize of [0, -10, Number.NaN, /** @type {never} */ ('50')]) {
    const odd = openMeteoFetchStub(flatDem());
    await createOpenMeteoElevationProvider({ fetch: odd, now: NOW, batchSize }).elevations(points(101));
    assert.deepEqual(odd.calls.map((c) => c.length), [100, 1], `batchSize ${String(batchSize)}`);
  }
});

/* ---------- the request itself ---------- */

test('the request is one URL with comma-joined coordinates at four decimals', async () => {
  const { provider, fetchStub } = harness();
  await provider.elevations([
    { lat: 30.267123, lng: -97.743188 },
    { lat: 30.5, lng: -97.5 },
  ]);
  const url = new URL(fetchStub.urls[0]);
  assert.equal(`${url.origin}${url.pathname}`, OPEN_METEO_ELEVATION_URL);
  assert.equal(url.searchParams.get('latitude'), '30.2671,30.5000');
  assert.equal(url.searchParams.get('longitude'), '-97.7432,-97.5000');
  // Four decimals is ~11 m, comfortably finer than the 90 m DEM behind the
  // endpoint, and it keeps the URL short enough for a 100-point batch.
  assert.ok(fetchStub.urls[0].length < 2000);
});

test('an empty list is answered without asking anybody', async () => {
  const { provider, fetchStub } = harness();
  const out = await provider.elevations([]);
  assert.deepEqual(out.elevationsM, []);
  assert.equal(fetchStub.calls.length, 0);
  assert.equal(out.provenance.batches, 0);
  assert.equal(out.provenance.requested, 0);
  assert.deepEqual(out.provenance.notes, []);
});

test('anything that is not a list of points is a programming error', async () => {
  const { provider } = harness();
  for (const bad of [null, undefined, 'points', { lat: 1, lng: 2 }, 7]) {
    await assert.rejects(() => provider.elevations(/** @type {never} */ (bad)), TypeError);
  }
});

/* ---------- failure, in its several shapes ---------- */

test('a batch that fails takes only its own points down', async () => {
  const { provider, fetchStub } = harness(flatDem({ elevM: 300 }), { failBatches: [1] });
  const out = await provider.elevations(points(250));

  assert.equal(fetchStub.calls.length, 3, 'the remaining batches were still sent');
  assert.equal(out.elevationsM[0], 300);
  assert.equal(out.elevationsM[99], 300);
  assert.equal(out.elevationsM[100], null, 'the failed batch is a hole');
  assert.equal(out.elevationsM[199], null);
  assert.equal(out.elevationsM[200], 300);
  assert.equal(out.provenance.answered, 150);
  assert.equal(out.provenance.missing, 100);
  assert.equal(out.provenance.notes.length, 1);
  assert.match(out.provenance.notes[0], /batch 2 of 3.*HTTP 429.*100 point/);
});

test('a batch of the wrong length is thrown away whole', async () => {
  // 99 elevations for 100 points cannot be aligned — there are no coordinates
  // in the payload to align against, and a one-place shift draws a ridge
  // through flat ground.
  const { provider } = harness(flatDem({ elevM: 300 }), { malformedBatches: [0] });
  const out = await provider.elevations(points(120));
  assert.ok(out.elevationsM.slice(0, 100).every((v) => v === null));
  assert.ok(out.elevationsM.slice(100).every((v) => v === 300));
  assert.equal(out.provenance.answered, 20);
  assert.match(out.provenance.notes[0], /99 elevation\(s\) for 100 point\(s\)/);
});

test('a payload with no elevation list at all is a note, not a crash', async () => {
  for (const [label, body] of [
    ['an object', { elevation: { 0: 300 } }],
    ['a string', { elevation: 'three hundred' }],
    ['nothing', {}],
    ['an error envelope', { error: true, reason: 'rate limited' }],
  ]) {
    const provider = createOpenMeteoElevationProvider({
      now: NOW,
      fetch: async () => ({ ok: true, status: 200, async json() { return body; } }),
    });
    const out = await provider.elevations(points(3));
    assert.deepEqual(out.elevationsM, [null, null, null], label);
    assert.equal(out.provenance.notes.length, 1, label);
    assert.match(out.provenance.notes[0], /none of that batch was used/, label);
  }
});

test('a hole in the DEM comes back as a null with a note that says why', async () => {
  const dem = missingTile(flatDem({ elevM: 300 }), {
    eastFromM: -50, eastToM: 50, northFromM: 20, northToM: 40,
  });
  const { provider } = harness(dem);
  const out = await provider.elevations(points(8));
  const holes = out.elevationsM.filter((v) => v === null).length;
  assert.ok(holes > 0 && holes < 8, `expected a partial hole, got ${holes} of 8`);
  assert.equal(out.provenance.missing, holes);
  assert.match(out.provenance.notes[0], /the DEM has no value there/);
});

test('a fetch that throws is a hole, not an exception the caller has to catch', async () => {
  const provider = createOpenMeteoElevationProvider({
    now: NOW,
    fetch: async () => { throw new Error('ECONNRESET'); },
  });
  const out = await provider.elevations(points(4));
  assert.deepEqual(out.elevationsM, [null, null, null, null]);
  assert.equal(out.provenance.answered, 0);
  assert.match(out.provenance.notes[0], /the elevation request failed \(ECONNRESET\)/);
});

test('a fetch that throws something that is not an Error still names a reason', async () => {
  const provider = createOpenMeteoElevationProvider({
    now: NOW,
    fetch: async () => { throw 'the tab went to sleep'; },
  });
  const out = await provider.elevations(points(2));
  assert.match(out.provenance.notes[0], /the tab went to sleep/);

  const mute = createOpenMeteoElevationProvider({
    now: NOW,
    fetch: async () => { throw new Error(''); },
  });
  assert.match((await mute.elevations(points(2))).provenance.notes[0], /no reason given/);
});

test('a response object that is not a response is treated as a failed batch', async () => {
  for (const body of [null, undefined, { status: 503 }]) {
    const provider = createOpenMeteoElevationProvider({ now: NOW, fetch: async () => body });
    const out = await provider.elevations(points(2));
    assert.deepEqual(out.elevationsM, [null, null]);
    assert.match(out.provenance.notes[0], /answered HTTP (503|nothing)/);
  }
});

test('with no fetch anywhere, nothing is requested and the answer says so', async () => {
  const realFetch = globalThis.fetch;
  try {
    Reflect.deleteProperty(globalThis, 'fetch');
    const provider = createOpenMeteoElevationProvider({ now: NOW });
    const out = await provider.elevations(points(3));
    assert.deepEqual(out.elevationsM, [null, null, null]);
    assert.equal(out.provenance.batches, 0);
    assert.match(out.provenance.notes[0], /No fetch implementation is available/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ---------- provenance ---------- */

test('every answer names its source, its DEM and the licence it travels under', async () => {
  const { provider } = harness();
  assert.equal(provider.source, OPEN_METEO_SOURCE);
  assert.equal(provider.dataset, OPEN_METEO_DATASET);
  assert.equal(provider.resolutionM, OPEN_METEO_RESOLUTION_M);
  assert.equal(provider.attribution, OPEN_METEO_ATTRIBUTION);
  assert.match(OPEN_METEO_ATTRIBUTION, /Open-Meteo\.com \(CC BY 4\.0\)/,
    'CC BY 4.0 requires the credit line to travel with the data');

  const out = await provider.elevations(points(5));
  assert.equal(out.provenance.source, OPEN_METEO_SOURCE);
  assert.equal(out.provenance.dataset, OPEN_METEO_DATASET);
  assert.equal(out.provenance.resolutionM, OPEN_METEO_RESOLUTION_M);
  assert.equal(out.provenance.attribution, OPEN_METEO_ATTRIBUTION);
  assert.equal(out.provenance.retrievedAt, '2026-07-30T12:00:00.000Z',
    'the clock is injected, so a snapshot is reproducible');
  assert.deepEqual(
    [out.provenance.requested, out.provenance.answered, out.provenance.missing],
    [5, 5, 0]);
  assert.ok(Object.isFrozen(out.provenance));
  assert.ok(Object.isFrozen(out.provenance.notes));
});

test('the default clock is a real instant', async () => {
  const provider = createOpenMeteoElevationProvider({ fetch: openMeteoFetchStub(flatDem()) });
  const out = await provider.elevations(points(1));
  assert.ok(!Number.isNaN(Date.parse(out.provenance.retrievedAt)));
});
