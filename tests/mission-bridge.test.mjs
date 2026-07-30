import test from 'node:test';
import assert from 'node:assert/strict';

import {
  setupMissionBridge, openMissionBridge, missionId, missionTitle, missionStorage,
  renameMission, exportMission, listMissions,
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

const rail = {
  readLaunch: () => ({ ...LAUNCH }),
  writeLaunch: () => {},
  seed: () => ({ title: 'Field test' }),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Storage events observed since the last call — the banner's point of view. */
const events = [];

const repo = failingRepo();

test('a persistently failing save does not become a retry loop', async () => {
  setupMissionBridge({
    rail,
    requestRender: () => {},
    onStorage: (s) => events.push(s.save),
    repository: repo,
  });
  await openMissionBridge();
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
