import test from 'node:test';
import assert from 'node:assert/strict';

import { setupMissionBridge, openMissionBridge, dispatch, missionDocument } from '../src/mission-bridge.js';
import { setupTerrain } from '../src/render/terrain.js';
import {
  analyzeNow, analysisRevision, acceptAsync, setupAnalysisHost, groundAt, terrainField,
  restoreEvidenceFor,
} from '../src/analysis-host.js';

/* M3b §3: the host owns the corridor sampler, and the pipeline reads it as a port.
 *
 * analyze.js is pure and synchronous, so it can never await ground. The host
 * samples the corridor *after* a snapshot exists (the snapshot is what publishes
 * the corridor), holds the newest TerrainField, and hands the pipeline an
 * accessor. Four properties are load-bearing and are what this file drives
 * through the real bridge, the real sampler and the real adapter:
 *
 *   an unwired port is "nobody asked" and a wired one with nothing back is
 *     "asked, no answer" — neither may read as clear ground;
 *   a landed field triggers a re-render, or the numbers it produced never reach
 *     the screen;
 *   a field asked for one mission is dropped when the mission has moved on;
 *   the ground the field carries is what resolves an `agl` waypoint altitude.
 *
 * This lives apart from tests/analysis-host.test.mjs because that file counts
 * every fetch the app makes and is counting the single-bearing profile's.
 * Wiring the corridor sampler into it would change what it is measuring. */

const LAUNCH = { latitude: 30.2672, longitude: -97.7431, elevationMslM: 168 };
const OVER_THERE = { latitude: 30.3172, longitude: -97.7431 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Past the host's 500 ms sample debounce, with room for the adapter. */
const settle = () => sleep(750);

const emptyRepo = {
  adapter: 'memory',
  durable: false,
  async save() { return { storage: { adapter: 'memory', durable: false } }; },
  async list() { return []; },
  async get() { return null; },
  async remove() { return false; },
  async duplicate() { return null; },
  async exportJson() { return null; },
  async importJson() { return { ok: false, errors: [] }; },
  async close() {},
};

/**
 * An elevation endpoint that answers a flat plateau, counting the calls and
 * letting the test hold an answer open. `held` keeps every response pending
 * until releaseAll(); otherwise they resolve immediately.
 */
function stubElevation({ held = false, groundM = 300 } = {}) {
  const calls = [];
  /** @type {(() => void)[]} */
  const waiting = [];
  const doFetch = (url) => {
    calls.push(String(url));
    const n = (String(url).match(/latitude=([^&]*)/)?.[1] ?? '').split(',').length;
    const body = { ok: true, status: 200, json: async () => ({ elevation: Array.from({ length: n }, () => groundM) }) };
    if (!held) return Promise.resolve(body);
    return new Promise((resolve) => waiting.push(() => resolve(body)));
  };
  return { calls, doFetch, releaseAll: () => { for (const done of waiting.splice(0)) done(); } };
}

/**
 * Boot the bridge and the host together over one stubbed endpoint.
 *
 * The corridor sampler's provider takes its fetch injected, so `net.calls`
 * counts elevation requests the host made. The legacy single-bearing profile
 * still runs beside it off globalThis.fetch — it is wired here only so it does
 * not throw, and its answers are deliberately not what any assertion reads.
 *
 * Since M5 the host samples an advisory area grid through that same provider and
 * that same cache, deliberately (the grid blankets the ground the corridor draws
 * a line through, so the sharing is most of the point). Its requests land in
 * `net.calls` too, which is why the assertions below are written as movements in
 * the count — "another ask went out", "no further ask went out" — rather than as
 * absolute totals. That is what each of them was ever really asserting.
 */
async function boot(net, { title = 'Corridor host', onUpdate = null } = {}) {
  let renders = 0;
  setupTerrain({ update: () => {}, revision: analysisRevision, accept: acceptAsync });
  setupAnalysisHost({ update: () => { renders++; onUpdate?.(); }, fetch: net.doFetch });
  setupMissionBridge({
    seed: () => ({ title, launch: { ...LAUNCH } }),
    requestRender: () => {},
    repository: emptyRepo,
    terrainSampler: groundAt,
  });
  await openMissionBridge();
  return { renders: () => renders };
}

test.beforeEach(() => {
  globalThis.fetch = (url) => {
    const n = (String(url).match(/latitude=([^&]*)/)?.[1] ?? '').split(',').length;
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ elevation: Array.from({ length: n }, () => 168) }) });
  };
});

test('the corridor is sampled once a snapshot has published it, and the field lands on the port', async () => {
  const net = stubElevation();
  const host = await boot(net);
  dispatch({ type: 'addWaypoint', payload: { ...OVER_THERE } }, { render: false });

  // Pass one: the port is wired but nothing has come back. That is "asked, not
  // answered", and it may not read as clear ground.
  const first = analyzeNow();
  assert.ok(first, 'the seeded mission analyses');
  assert.ok(first.corridor.samples.length > 0, 'a route with a waypoint has a corridor to sample');
  assert.equal(terrainField(), null, 'no field yet');
  assert.equal(
    first.constraints.some((c) => c.code.startsWith('W-TERR-CLEARANCE')), false,
    'nothing is claimed clear off a field that has not arrived',
  );
  const rendersBefore = host.renders();

  await settle();
  assert.ok(net.calls.length >= 1, 'the corridor went out to the elevation endpoint');
  assert.ok(host.renders() > rendersBefore, 'the landing asked for a re-render, or it never reaches the screen');

  const field = terrainField();
  assert.ok(field, 'the field is held on the host');
  assert.equal(field.missionId, missionDocument()?.id);
  assert.equal(field.provenance.coverage, 'complete');
  assert.match(field.provenance.attribution ?? '', /CC BY 4\.0/, 'the licence travels with the data');

  // Pass two reads the field through the port: same request, different answer,
  // which is what the terrain signature in the memo key is there for.
  const second = analyzeNow();
  assert.notEqual(second, first, 'a landed field is a new question, not a memo hit');
  assert.equal(second.provenance.terrainAttribution, field.provenance.attribution);
  const clearance = second.constraints.filter((c) => c.code.startsWith('W-TERR-'));
  assert.ok(clearance.length > 0 || second.route, 'the route-wide checks ran against real ground');
});

test('the ground the field carries is what resolves an above-ground-level altitude', async () => {
  const net = stubElevation({ groundM: 412 });
  await boot(net, { title: 'AGL resolve' });
  dispatch({ type: 'addWaypoint', payload: { ...OVER_THERE } }, { render: false });
  analyzeNow();
  await settle();

  assert.equal(groundAt(OVER_THERE.latitude, OVER_THERE.longitude), 412,
    'the nearest sampled post is the ground under that point');
  assert.equal(groundAt(0, 0), null, 'and somewhere the corridor never looked is a stated nothing');
});

test('a corridor field for a mission that has moved on is dropped, and the current one re-asked', async () => {
  const net = stubElevation({ held: true });
  await boot(net, { title: 'Stale field' });
  dispatch({ type: 'addWaypoint', payload: { ...OVER_THERE } }, { render: false });
  analyzeNow();
  await settle();
  assert.ok(net.calls.length >= 1, 'the corridor sample is in flight');
  const inFlight = net.calls.length;
  const asked = analysisRevision();

  // The route changes while that sample is out. Its answer describes ground
  // under a corridor the mission no longer flies.
  dispatch({ type: 'addWaypoint', payload: { latitude: 30.35, longitude: -97.80 } }, { render: false });
  assert.notEqual(analysisRevision().missionUpdatedAt, asked.missionUpdatedAt,
    'a new waypoint is a new revision to be stale against');
  analyzeNow();

  net.releaseAll();
  await sleep(50);
  assert.equal(terrainField(), null, 'the stale field never became the held one');

  // …and the question has to be back on the wire, or the route would sit on
  // "not sampled" forever with no fetch outstanding to change it.
  await settle();
  assert.ok(net.calls.length > inFlight, 'the dropped sample re-asked for the corridor that is current');
  net.releaseAll();
  await sleep(50);
  assert.ok(terrainField(), 'and the answer for the current route is kept');
});

test('a corridor superseded inside the debounce window is never fetched', async () => {
  const net = stubElevation();
  await boot(net, { title: 'Superseded ask' });
  dispatch({ type: 'addWaypoint', payload: { ...OVER_THERE } }, { render: false });
  analyzeNow();
  await settle();
  const settled = net.calls.length;
  assert.ok(settled >= 1, 'the first corridor was sampled');
  assert.ok(terrainField(), 'and its field is in hand');

  // A second waypoint schedules an ask; removing it again before the debounce
  // fires makes the field in hand the whole answer once more. The scheduled ask
  // now describes a corridor nobody flies — it must die with it. Left armed, it
  // fetches anyway, and its landing self-certifies as fresh (runSample reads
  // the revision at fire time), evicting the good field for a stale one.
  dispatch({ type: 'addWaypoint', payload: { latitude: 30.35, longitude: -97.80 } }, { render: false });
  analyzeNow();
  const added = missionDocument()?.route.waypoints.at(-1);
  assert.ok(added, 'the second waypoint exists to be removed');
  dispatch({ type: 'removeWaypoint', payload: { id: added.id } }, { render: false });
  analyzeNow();

  await settle();
  assert.equal(net.calls.length, settled, 'no fetch went out for the corridor that was superseded');
  assert.ok(terrainField(), 'the field in hand still answers the route');
});

test('a grid follow-up for a moved route is asked once, however many hands re-arm it', async () => {
  // Production's update() re-enters the analysis, and analyzeNow() runs
  // refreshGrid() — so a grid sample landing for a route that moved arms the
  // follow-up twice: once through that re-entry, once through its own finally.
  // Left uncleared, both timers fire and the same batches go out twice. The
  // invariant that pins it: with answers cached and signatures held, no
  // elevation URL is ever put on the wire a second time.
  const net = stubElevation({ held: true });
  await boot(net, { title: 'Grid re-arm', onUpdate: () => { analyzeNow(); } });
  dispatch({ type: 'addWaypoint', payload: { ...OVER_THERE } }, { render: false });
  analyzeNow();
  await settle();
  assert.ok(net.calls.length >= 1, 'asks for the first route are in flight');

  // The route moves while those samples are out…
  dispatch({ type: 'addWaypoint', payload: { latitude: 30.35, longitude: -97.80 } }, { render: false });
  analyzeNow();

  // …then everything is allowed to land, follow-ups to fire, and their own
  // answers to land, until the wire goes quiet.
  for (let round = 0; round < 3; round++) {
    for (let spin = 0; spin < 30; spin++) {
      const before = net.calls.length;
      net.releaseAll();
      await sleep(25);
      if (net.calls.length === before) break;
    }
    await settle();
    net.releaseAll();
    await sleep(25);
  }

  const dupes = [...new Set(net.calls.filter((u, i) => net.calls.indexOf(u) !== i))];
  assert.deepEqual(dupes, [], 'an elevation ask went out twice — two grid timers raced for one route');
});

/* ADR 0012 §3: the correctness layer above (analysisRevision/acceptAsync,
 * proven by the four tests above) never lets a stale answer land. What it does
 * not do is stop the stale request from sitting on the wire until it fails or
 * times out on its own. The AbortController layer is the resource-hygiene
 * fix for that: refreshField/refreshGrid hold the controller for whatever
 * they last asked for, and a genuinely new corridor or grid arriving while
 * the old one is still in flight cuts it loose immediately rather than
 * waiting for it to land and be thrown away.
 *
 * `stubElevation()` above ignores the options object fetch is called with, so
 * it cannot see whether a signal was handed through — these two tests use
 * their own held-open stub that records it. */

test('a corridor that genuinely changes while a sample is in flight aborts the stale request', async () => {
  const calls = [];
  const signals = [];
  const waiting = [];
  const doFetch = (url, opts) => {
    calls.push(String(url));
    signals.push(opts?.signal);
    const n = (String(url).match(/latitude=([^&]*)/)?.[1] ?? '').split(',').length;
    const body = { ok: true, status: 200, json: async () => ({ elevation: Array.from({ length: n }, () => 300) }) };
    return new Promise((resolve) => waiting.push(() => resolve(body)));
  };
  const releaseAll = () => { for (const done of waiting.splice(0)) done(); };

  await boot({ doFetch }, { title: 'Corridor abort plumbing' });
  dispatch({ type: 'addWaypoint', payload: { ...OVER_THERE } }, { render: false });
  analyzeNow();
  await settle();

  assert.ok(calls.length >= 1, 'the first corridor sample is in flight (its fetch is held open)');
  const firstSignal = signals[0];
  assert.ok(firstSignal, 'the sampler was handed a signal for the first request');
  assert.equal(firstSignal.aborted, false, 'nothing has changed yet');

  // A re-render of the exact same corridor must not cancel the request
  // already out for it — only a route that has actually moved earns that.
  analyzeNow();
  assert.equal(firstSignal.aborted, false, 're-analysing the same route does not abort its own request');

  // The route changes while the first sample is still out (held). refreshField
  // sees `sampling` still true and a signature that no longer matches what is
  // in flight, and must cut the stale request loose right there rather than
  // let it land on top of whatever answers the new corridor.
  dispatch({ type: 'addWaypoint', payload: { latitude: 30.35, longitude: -97.80 } }, { render: false });
  analyzeNow();

  assert.equal(firstSignal.aborted, true, 'a genuinely different corridor aborts the stale in-flight request');

  releaseAll();
  await sleep(50);
});

test('a grid request that genuinely changes while a sample is in flight aborts the stale request', async () => {
  const calls = [];
  const signals = [];
  const waiting = [];
  const doFetch = (url, opts) => {
    calls.push(String(url));
    signals.push(opts?.signal);
    const n = (String(url).match(/latitude=([^&]*)/)?.[1] ?? '').split(',').length;
    const body = { ok: true, status: 200, json: async () => ({ elevation: Array.from({ length: n }, () => 300) }) };
    return new Promise((resolve) => waiting.push(() => resolve(body)));
  };
  const releaseAll = () => { for (const done of waiting.splice(0)) done(); };

  // No waypoint is ever added in this test, so the corridor stays empty
  // (samples.length === 0) throughout and refreshField never engages — every
  // fetch below belongs to the grid alone, which is seeded from the launch
  // point on its own (gridPointsFor always includes it).
  await boot({ doFetch }, { title: 'Grid abort plumbing' });
  analyzeNow();
  await settle();

  assert.ok(calls.length >= 1, 'the first grid sample is in flight (its fetch is held open)');
  const firstSignal = signals[0];
  assert.ok(firstSignal, 'the grid sampler was handed a signal for the first request');
  assert.equal(firstSignal.aborted, false, 'nothing has changed yet');

  // Re-analysing the same launch point must not cancel the grid's own request.
  analyzeNow();
  assert.equal(firstSignal.aborted, false, 're-analysing the same area does not abort its own request');

  // Move the launch far enough that the grid around it is a genuinely
  // different request while the first is still out (held).
  dispatch({ type: 'setLaunch', payload: { latitude: 30.35, longitude: -97.80 } }, { render: false });
  analyzeNow();

  assert.equal(firstSignal.aborted, true, 'a genuinely different grid area aborts the stale in-flight request');

  releaseAll();
  await sleep(50);
});

/* ADR 0012 §2: restored evidence is admitted on the same test a live sample
 * must pass — usableField(), read against whatever corridor the current pass
 * is actually asking about — never on trust that the mission id alone is
 * enough. These three pin that rule at the seam it is wired: refreshField()
 * inside analyzeNow(). */

test('restored evidence whose signature matches the current corridor is admitted without a fetch', async () => {
  const net = stubElevation();
  await boot(net, { title: 'Evidence admitted' });
  dispatch({ type: 'addWaypoint', payload: { ...OVER_THERE } }, { render: false });
  const snap = analyzeNow();
  const corridor = snap.corridor;
  assert.ok(corridor.samples.length > 0, 'a route with a waypoint has a corridor to sample');

  // Shaped exactly like the corridor this pass is asking about — same mission,
  // same sample ids, same coordinates — so usableField() admits it on sight,
  // the identical test a live sample must pass.
  const restoredField = {
    missionId: corridor.missionId,
    revision: 'restored',
    samples: corridor.samples.map((s) => ({
      id: s.id, stationId: s.id, track: 'centre', lat: s.latitude, lng: s.longitude,
      distanceKm: s.distanceKm, bearingDeg: s.bearingDeg, segmentId: null,
      groundMslM: 250, slopeDeg: null, aspectDeg: null, gradientBasis: null, source: 'cache',
    })),
    byId: Object.fromEntries(corridor.samples.map((s) => [s.id, { lat: s.latitude, lng: s.longitude }])),
    features: [],
    launchGroundMslM: 250,
    provenance: {
      source: 'restored', dataset: null, resolutionM: null, attribution: null,
      retrievedAt: '2026-07-20T00:00:00.000Z', spacingM: corridor.spacingM,
      corridorWidthM: corridor.corridorWidthM, requested: corridor.samples.length,
      cacheHits: 0, fetched: corridor.samples.length, missing: 0, coverage: 'complete', notes: [],
    },
  };
  const evidenceRepository = {
    async get() {
      return {
        id: missionDocument().id, savedAt: '2026-07-20T00:00:05.000Z',
        terrainField: restoredField, advisoryGrid: null, profile: null,
      };
    },
    async save() {}, async remove() {}, close() {},
  };
  // A fresh host composition, the same as a reopened tab would build, with the
  // evidence store this test controls injected in place of a real one.
  setupAnalysisHost({ update: () => {}, fetch: net.doFetch, evidenceRepository });
  restoreEvidenceFor(missionDocument());
  await sleep(0); // let restoreEvidenceFor's own async read land

  const callsBefore = net.calls.length;
  analyzeNow();
  assert.equal(terrainField(), restoredField, 'the restored field was admitted, by reference, not re-derived');
  assert.equal(groundAt(OVER_THERE.latitude, OVER_THERE.longitude), 250, 'and it is what answers ground');
  assert.equal(net.calls.length, callsBefore, 'a signature match never touches the network');
});

test('restored evidence whose signature does not match the current corridor is declined, and a fresh sample is asked for', async () => {
  const net = stubElevation({ groundM: 300 });
  await boot(net, { title: 'Evidence declined' });
  dispatch({ type: 'addWaypoint', payload: { ...OVER_THERE } }, { render: false });
  analyzeNow();

  // Same mission id — so this is genuinely a stale-geometry case, not a
  // different-mission case — but a sample id the current corridor never asked
  // for, so usableField() cannot find it in byId and declines the record.
  const staleField = {
    missionId: missionDocument().id,
    revision: 'restored-stale',
    samples: [{
      id: 'smp_nonexistent', stationId: 'x', track: 'centre', lat: 0, lng: 0,
      distanceKm: 0, bearingDeg: 0, segmentId: null, groundMslM: 999, slopeDeg: null,
      aspectDeg: null, gradientBasis: null, source: 'cache',
    }],
    byId: { smp_nonexistent: { lat: 0, lng: 0 } },
    features: [],
    launchGroundMslM: 999,
    provenance: {
      source: 'restored', dataset: null, resolutionM: null, attribution: null,
      retrievedAt: '2026-07-20T00:00:00.000Z', spacingM: 50, corridorWidthM: 100,
      requested: 1, cacheHits: 0, fetched: 1, missing: 0, coverage: 'complete', notes: [],
    },
  };
  const evidenceRepository = {
    async get() {
      return {
        id: missionDocument().id, savedAt: '2026-07-20T00:00:05.000Z',
        terrainField: staleField, advisoryGrid: null, profile: null,
      };
    },
    async save() {}, async remove() {}, close() {},
  };
  setupAnalysisHost({ update: () => {}, fetch: net.doFetch, evidenceRepository });
  restoreEvidenceFor(missionDocument());
  await sleep(0);

  analyzeNow();
  assert.notEqual(terrainField(), staleField, 'a record that does not describe this corridor is never admitted');

  await settle();
  assert.ok(net.calls.length > 0, 'the mismatch fell through to a live sample, on the wire');
  assert.ok(terrainField(), 'and the live sample landed');
  assert.notEqual(terrainField(), staleField);
  assert.equal(groundAt(OVER_THERE.latitude, OVER_THERE.longitude), 300, 'ground came from the live sample, not the stale one');
});

test('a restored field too malformed to compare is declined without throwing into the boot path', async () => {
  const net = stubElevation({ groundM: 301 });
  await boot(net, { title: 'Evidence malformed' });
  dispatch({ type: 'addWaypoint', payload: { ...OVER_THERE } }, { render: false });
  analyzeNow();

  // Same mission id and a samples array non-empty enough to pass usableField()'s
  // first guard, but byId is not an object — the shape a real corrupt record
  // read straight off disk could take. The rule under test is ADR 0012 §2 rule
  // b: this must be declined, not thrown into the boot path.
  const malformedField = { missionId: missionDocument().id, samples: [{ id: 'whatever' }], byId: null };
  const evidenceRepository = {
    async get() {
      return {
        id: missionDocument().id, savedAt: '2026-07-20T00:00:05.000Z',
        terrainField: malformedField, advisoryGrid: null, profile: null,
      };
    },
    async save() {}, async remove() {}, close() {},
  };
  setupAnalysisHost({ update: () => {}, fetch: net.doFetch, evidenceRepository });
  restoreEvidenceFor(missionDocument());
  await sleep(0);

  assert.doesNotThrow(() => analyzeNow());
  await settle();
  assert.ok(terrainField(), 'the pipeline recovered and a live sample landed');
  assert.equal(groundAt(OVER_THERE.latitude, OVER_THERE.longitude), 301);
});
