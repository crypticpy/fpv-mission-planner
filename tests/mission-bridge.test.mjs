import test from 'node:test';
import assert from 'node:assert/strict';

import {
  setupMissionBridge, openMissionBridge, missionId, missionTitle, missionStorage,
  newMission, renameMission, exportMission, listMissions, restoreMissionVersion,
} from '../src/mission-bridge.js';

/* The bridge's promise under storage failure (module header): the in-memory
 * document stays usable and the export escape hatch stays reachable. These
 * tests drive the real bridge against a store whose every write fails — the
 * full-disk field scenario (R-OFFLINE F1) — and pin the two behaviors a
 * review found broken: a failed autosave must NOT re-arm itself into a
 * debounce-rate retry loop, and export/list must serve the open mission from
 * memory rather than from the store that is refusing it. */

const LAUNCH = { latitude: 30.2672, longitude: -97.7431, elevationMslM: 168 };

/** A repository whose disk is full: reads answer, every write rejects. */
function failingRepo() {
  const attempts = [];
  return {
    attempts,
    adapter: 'indexeddb',
    durable: true,
    async save(doc) {
      attempts.push(doc.updatedAt);
      throw new Error('The mission could not be written (disk full).');
    },
    async list() { return []; },
    async get() { return null; },
    async remove() { return false; },
    async duplicate() { return null; },
    async exportJson() { return null; },
    async importJson() { return { ok: false, errors: [] }; },
    async close() {},
  };
}

/* The caller's side of the bridge: a whole mission's worth of starting state on
   the way in, and a callback that puts the map pin back on the way out. */
const seed = () => ({ title: 'Field test', launch: { ...LAUNCH } });
const restored = [];
const onLaunchRestored = (launch) => restored.push(launch);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Storage events observed since the last call — the banner's point of view. */
const events = [];

const repo = failingRepo();

test('a persistently failing save does not become a retry loop', async () => {
  setupMissionBridge({
    seed,
    onLaunchRestored,
    requestRender: () => {},
    onStorage: (s) => events.push(s.save),
    repository: repo,
  });
  await openMissionBridge();
  assert.equal(restored.length, 0, 'a seeded mission is not a restored one');
  // Boot seeds a mission and schedules its first save (300 ms debounce). Give
  // a would-be loop ten debounce periods to show itself.
  await sleep(3000);
  assert.equal(repo.attempts.length, 1, 'exactly one attempt: the boot save, no self-re-arm');
  assert.equal(missionStorage().save, 'failed', 'the banner settles on failed, not blinking');
  assert.equal(events.at(-1), 'failed', 'the last storage event is the settled failure');

  // The next edit — not a timer — is what earns a retry.
  const before = repo.attempts.length;
  renameMission('Ridge sortie');
  await sleep(1000);
  assert.equal(repo.attempts.length, before + 1, 'one edit, one more attempt');
  assert.equal(missionStorage().save, 'failed');
});

test('the open mission exports from memory while the store is failing', async () => {
  // Every save so far has failed, so the store has never accepted this
  // mission — and the export must not care.
  const id = missionId();
  assert.ok(id, 'a mission is open');
  const json = await exportMission(id);
  assert.ok(json, 'export produced a file');
  const parsed = JSON.parse(json);
  assert.equal(parsed.id, id);
  assert.equal(parsed.title, missionTitle(), 'the export is the document on screen, not a stale store read');
});

test('the mission list serves the open mission a row when the store has none', async () => {
  const summaries = await listMissions();
  assert.equal(summaries.length, 1, 'the open mission is listed even though repo.list() is empty');
  assert.equal(summaries[0].id, missionId());
  assert.equal(summaries[0].title, missionTitle());
});

/* ADR 0012 §5: navigator.storage.estimate() feeds the same banner, refreshed
 * at bridge open and after every save receipt rather than polled. Each test
 * below opens its own fresh bridge over an in-memory repo that actually
 * accepts writes — unlike the full-disk repo above, this is about the
 * estimate, not the failure taxonomy — and every one of them runs its boot
 * mission's autosave debounce out (400 ms, past the 300 ms window) before
 * finishing, so no dangling timer from one test's seeded mission fires against
 * the next test's repository. */

/** A repository that actually keeps what it is given, so a save is a save. */
function workingRepo() {
  const missions = new Map();
  return {
    adapter: 'memory',
    durable: false,
    async save(saved) {
      missions.set(saved.id, saved);
      return { storage: { adapter: 'memory', durable: false, durability: 'strict', persisted: null } };
    },
    async list() {
      return [...missions.values()]
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .map((m) => ({ id: m.id, title: m.title, updatedAt: m.updatedAt }));
    },
    async get(id) { return missions.get(id) ?? null; },
    async remove(id) { return missions.delete(id); },
    async duplicate() { return null; },
    async exportJson() { return null; },
    async importJson() { return { ok: false, errors: [] }; },
    async close() {},
  };
}

// These two run before any test below establishes a real true/false reading:
// nearFull only ever changes on an estimate that actually answers, so once one
// has, "unavailable" no longer means "never asked" — it means "no new
// information", and the previous reading is left standing rather than erased.
// That is the honest behavior, but it means a check for the pristine
// "nothing has ever answered yet" null needs to run first, against the
// module's true initial state.

test('with no storage estimate available, the banner makes no claim', async () => {
  // No `storage` dep at all — Node's own `navigator.storage` has no `estimate`
  // either, the same shape a locked-down browser context takes.
  setupMissionBridge({ seed, requestRender: () => {}, repository: workingRepo() });
  await openMissionBridge();
  await sleep(400);
  assert.equal(missionStorage().nearFull, null, 'absent is not the same claim as "plenty of room"');
  assert.ok(missionId(), 'the bridge still opened a mission with no estimate to lean on');
});

test('a throwing storage estimate never breaks bridge open, and makes no claim', async () => {
  const storage = { async estimate() { throw new Error('locked down'); } };
  setupMissionBridge({ seed, requestRender: () => {}, repository: workingRepo(), storage });
  await assert.doesNotReject(() => openMissionBridge());
  await sleep(400);
  assert.equal(missionStorage().nearFull, null);
  assert.ok(missionId(), 'a throwing estimate is not a boot failure');
});

test('storage estimate at or above 80% of quota sets nearFull, and the banner hears about it', async () => {
  const heard = [];
  const storage = { async estimate() { return { usage: 81, quota: 100 }; } };
  setupMissionBridge({
    seed, requestRender: () => {}, onStorage: (s) => heard.push(s), repository: workingRepo(), storage,
  });
  await openMissionBridge();
  await sleep(400);
  assert.equal(missionStorage().nearFull, true);
  assert.ok(heard.some((s) => s.nearFull === true), 'the banner was told, not just the internal state');
});

test('storage estimate below 80% of quota reports not near full', async () => {
  const storage = { async estimate() { return { usage: 10, quota: 100 }; } };
  setupMissionBridge({ seed, requestRender: () => {}, repository: workingRepo(), storage });
  await openMissionBridge();
  await sleep(400);
  assert.equal(missionStorage().nearFull, false);
});

test('the estimate is refreshed again after a save receipt, not only at boot', async () => {
  let answer = { usage: 10, quota: 100 };
  const storage = { async estimate() { return answer; } };
  setupMissionBridge({ seed, requestRender: () => {}, repository: workingRepo(), storage });
  await openMissionBridge();
  await sleep(400);
  assert.equal(missionStorage().nearFull, false, 'the boot estimate says there is room');

  answer = { usage: 95, quota: 100 };
  renameMission('Nearly full now');
  await sleep(400); // past the edit's own save debounce, then the receipt-triggered refresh
  assert.equal(missionStorage().nearFull, true, 'a save receipt asked again, not just the boot');
});

/* M14 (L-01): the library's New Mission button. The one behavior worth a
 * bridge test is that starting fresh is not destructive — the open document is
 * flushed to the store before the fresh one takes over, so nothing rides on
 * whether a debounced save happened to have landed. */

test('New Mission flushes the open document and starts a fresh one beside it', async () => {
  setupMissionBridge({ seed, requestRender: () => {}, repository: workingRepo() });
  await openMissionBridge();
  await sleep(400); // the boot save lands
  const firstId = missionId();
  renameMission('The one being left');
  // No sleep: the rename's save is still inside its debounce window, which is
  // exactly what newMission's own flush must cover.
  const fresh = await newMission();
  assert.ok(fresh, 'a fresh mission opened');
  assert.notEqual(missionId(), firstId, 'with its own identity');
  assert.equal(missionTitle(), 'Field test', 'seeded, not a copy of the old document');
  await sleep(400); // the fresh mission's first save lands
  const summaries = await listMissions();
  assert.equal(summaries.length, 2, 'the old mission is still on the list');
  const old = summaries.find((s) => s.id === firstId);
  assert.equal(old?.title, 'The one being left', 'with the un-flushed rename kept');
});

/* M14 (L-04/H-04): restoring a version must not orphan the state being
 * navigated away from. The repository's own contract suite proves what
 * restoreVersion does; what only the bridge can prove is the order it makes
 * the calls in — the outgoing document's 'auto' checkpoint is awaited before
 * the repository's restore runs (which records the restore itself), so edits
 * made since the last cadence checkpoint stay reachable and two same-mission
 * checkpoints never race for one seq. */

test('restore checkpoints the outgoing document before the repository restores', async () => {
  const calls = [];
  let bootDoc = null;
  const base = workingRepo();
  const repo2 = {
    ...base,
    async save(saved) {
      bootDoc ??= structuredClone(saved);
      return base.save(saved);
    },
    async checkpoint(snapshot, kind) {
      calls.push(['checkpoint', kind, snapshot.title]);
      return { ok: true, id: `ver_${calls.length}`, seq: calls.length };
    },
    async restoreVersion(id, versionId) {
      calls.push(['restore', id, versionId]);
      return { ok: true, doc: structuredClone(bootDoc) };
    },
  };
  setupMissionBridge({ seed, requestRender: () => {}, repository: repo2 });
  await openMissionBridge();
  await sleep(400); // the boot save lands and records the first 'auto' checkpoint

  renameMission('Edited since the checkpoint');
  const result = await restoreMissionVersion(missionId(), 'ver_1');
  assert.equal(result.ok, true);
  assert.equal(missionTitle(), 'Field test', 'the stored version is the live document again');

  const restoreAt = calls.findIndex((c) => c[0] === 'restore');
  assert.ok(restoreAt > 0, 'the repository was asked to restore');
  assert.deepEqual(calls[restoreAt - 1], ['checkpoint', 'auto', 'Edited since the checkpoint'],
    'the document being replaced was checkpointed immediately before the restore, not after and not never');
  await sleep(400); // let any save debounce settle before the runner tears down
});
