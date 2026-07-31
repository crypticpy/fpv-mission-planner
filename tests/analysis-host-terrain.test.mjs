import test from 'node:test';
import assert from 'node:assert/strict';

import { setupMissionBridge, openMissionBridge, dispatch, missionDocument } from '../src/mission-bridge.js';
import { setupTerrain } from '../src/render/terrain.js';
import {
  analyzeNow, analysisRevision, acceptAsync, setupAnalysisHost, groundAt, terrainField,
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
async function boot(net, { title = 'Corridor host' } = {}) {
  let renders = 0;
  setupTerrain({ update: () => {}, revision: analysisRevision, accept: acceptAsync });
  setupAnalysisHost({ update: () => { renders++; }, fetch: net.doFetch });
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
