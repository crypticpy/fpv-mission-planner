import test from 'node:test';
import assert from 'node:assert/strict';

import { setupMissionBridge, openMissionBridge, dispatch } from '../src/mission-bridge.js';
import { setupTerrain } from '../src/render/terrain.js';
import { activeProfile } from '../src/terrain.js';
import { state } from '../src/state.js';
import { analyzeNow, analysisRevision, acceptAsync } from '../src/analysis-host.js';

/* M2b §5: an answer that arrives after the question changed must not be applied.
 *
 * The terrain profile is fetched over the network, and a fetch started for one
 * launch point can land after the pilot has moved to another. Before the guard
 * there were only per-module sequence counters, which could see a newer fetch
 * but not a newer *mission* — so a slow first response repainted the app with
 * ground from somewhere the aircraft is no longer flying from.
 *
 * This drives the real wiring: the real bridge, the real render/terrain.js fetch
 * path, and the analysis host's own guard between them. Only the network is a
 * stub, and only so its landing can be held open. */

const LAUNCH = { latitude: 30.2672, longitude: -97.7431, elevationMslM: 168 };
const MOVED = { latitude: 30.4, longitude: -97.9, elevationMslM: 200 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Enough of a repository to make openMissionBridge() seed a document. */
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

/** A fetch that never answers until the test says so. */
function heldFetch() {
  /** @type {((v: unknown) => void)[]} */
  const waiting = [];
  const calls = [];
  globalThis.fetch = (url) => {
    calls.push(String(url));
    return new Promise((resolve) => {
      waiting.push(() => resolve({
        ok: true,
        // 28 points, all at the same height: the profile's shape is irrelevant
        // here, only whether it is allowed to land.
        json: async () => ({ elevation: Array.from({ length: 28 }, () => 150) }),
      }));
    });
  };
  return { calls, releaseAll: () => { for (const done of waiting.splice(0)) done(); } };
}

test('a terrain profile fetched for a launch point the mission has left is dropped', async () => {
  const net = heldFetch();
  setupTerrain({ update: () => {}, revision: analysisRevision, accept: acceptAsync });
  setupMissionBridge({
    seed: () => ({ title: 'Stale drop', launch: { ...LAUNCH } }),
    requestRender: () => {},
    repository: emptyRepo,
  });
  await openMissionBridge();

  // Pass one asks for the ground at LAUNCH. refreshTerrain debounces 500 ms.
  assert.ok(analyzeNow(), 'the seeded mission analyses');
  await sleep(700);
  assert.equal(net.calls.length, 1, 'one fetch went out for the first launch point');
  const asked = analysisRevision();

  // The pilot moves the pin while that fetch is still in flight, and the next
  // render pass analyses the mission where it now is.
  assert.ok(dispatch({ type: 'setLaunch', payload: MOVED }, { render: false }), 'the launch moved');
  assert.notEqual(
    analysisRevision().missionUpdatedAt, asked.missionUpdatedAt,
    'moving the launch is a new revision to be stale against',
  );
  assert.ok(analyzeNow(), 're-analysed at the new launch point');

  // Now the first answer arrives. It describes ground under a point the mission
  // has left, so nothing may be applied from it.
  net.releaseAll();
  await sleep(50);
  assert.equal(activeProfile(), null, 'the stale profile never became the active one');

  // …and the question is back on the wire for where the mission actually is: a
  // drop that rendered nothing and asked nothing would strand the terrain card.
  await sleep(700);
  assert.equal(net.calls.length, 2, 'the dropped fetch re-asked for the current launch point');
  net.releaseAll();
  await sleep(50);
  assert.ok(activeProfile(), 'the answer for the current mission is kept');
});

test('a result for the revision that asked for it is accepted', () => {
  const now = analysisRevision();
  assert.equal(acceptAsync(now, 'terrain profile'), true);
  assert.equal(
    acceptAsync({ missionId: now.missionId, missionUpdatedAt: '1999-01-01T00:00:00.000Z' }, 'terrain profile'),
    false,
    'a revision that was never the newest one begun is stale',
  );
});

/* M2 review: the injected warning ports format their sentences through the
 * display-unit system, so flipping units changes the snapshot's text without
 * moving a single physics input. The memo must treat that as a new question —
 * before the fix it returned the identical object and the rail kept the old
 * units' wording until an unrelated input moved. */
test('flipping display units is a new analysis, not a memo hit', () => {
  const first = analyzeNow();
  assert.equal(analyzeNow(), first, 'unchanged inputs return the identical memoized snapshot');
  const before = analysisRevision().missionUpdatedAt;
  state.units = state.units === 'imperial' ? 'metric' : 'imperial';
  try {
    assert.notEqual(analysisRevision().missionUpdatedAt, before,
      'the units flip moves the revision the async guard keys on');
    assert.notEqual(analyzeNow(), first,
      'the units flip reaches the memo key — provider text re-formats');
  } finally {
    state.units = state.units === 'imperial' ? 'metric' : 'imperial';
  }
});

/* M2 review (non-blocker): the snapshot used to carry a bare doc.updatedAt
 * while the guard keyed on the composite token, so handing snapshot.revision
 * to acceptAsync reported stale for the very pass that produced it. */
test("the snapshot's own revision is a valid answer to acceptAsync", () => {
  const snap = analyzeNow();
  assert.equal(snap.revision.missionUpdatedAt, analysisRevision().missionUpdatedAt,
    'the snapshot is stamped with the same token the guard begins');
  assert.equal(acceptAsync(snap.revision, 'self-check'), true,
    'a snapshot is never stale against the pass that produced it');
});
