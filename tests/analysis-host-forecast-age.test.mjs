import test from 'node:test';
import assert from 'node:assert/strict';

import { setupMissionBridge, openMissionBridge, dispatch } from '../src/mission-bridge.js';
import { setupTerrain } from '../src/render/terrain.js';
import { analyzeNow, analysisRevision, acceptAsync, setupAnalysisHost } from '../src/analysis-host.js';

/* ADR 0012 §1, the re-evaluation half: a forecast ages while every other input
 * holds still, and the app only re-analyses when something moves. The host
 * owns the fix — one timer armed for the next 6 h / 24 h boundary from the
 * fetch instant (prov.retrievedAt, never validAt or capturedAt), asking for
 * one render when it fires. The pipeline's memo key carries the coarse age
 * bucket, so that pass is a fresh compute rather than a cache hit. At most two
 * firings per fetch; never a per-minute recompute.
 *
 * These tests run on the real wall clock rather than an injected one, on
 * purpose: the timer's delay and the pipeline's bucket must agree about "now",
 * and that agreement is part of what is being driven. The fixtures anchor
 * retrievedAt a few seconds short of a boundary so the wait is seconds, not
 * hours. tests/analysis-pipeline.test.mjs pins the exact thresholds and the
 * memo-bucket behaviour with an injected clock.
 *
 * A separate file for the same reason analysis-host-terrain.test.mjs is one:
 * tests/analysis-host.test.mjs counts every fetch the app makes, and the env
 * dispatches here would change what it is measuring. */

const LAUNCH = { latitude: 30.2672, longitude: -97.7431, elevationMslM: 168 };
const HOUR_MS = 60 * 60 * 1000;

/* How far short of a boundary the fixtures anchor the fetch. Wide enough that
 * the samplers (500 ms debounce plus the adapter) land and are re-checked well
 * inside the near side; the timer then fires ~1 s after the boundary. */
const SHORT_OF_BOUNDARY_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const codes = (snap) => snap.constraints.map((c) => c.code);

/** Poll until the host asked for another render, or fail loudly. */
async function waitFor(cond, why) {
  const t0 = Date.now();
  while (!cond()) {
    assert.ok(Date.now() - t0 < 10_000, `timed out waiting: ${why}`);
    await sleep(50);
  }
}

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

/** A flat plateau for both elevation paths — the ground is irrelevant here. */
const flatElevation = (url) => {
  const n = (String(url).match(/latitude=([^&]*)/)?.[1] ?? '').split(',').length;
  return Promise.resolve({
    ok: true, status: 200,
    json: async () => ({ elevation: Array.from({ length: n }, () => 168) }),
  });
};

async function boot(title) {
  let renders = 0;
  globalThis.fetch = flatElevation;
  setupTerrain({ update: () => {}, revision: analysisRevision, accept: acceptAsync });
  setupAnalysisHost({ update: () => { renders++; }, fetch: flatElevation });
  setupMissionBridge({
    seed: () => ({ title, launch: { ...LAUNCH } }),
    requestRender: () => {},
    repository: emptyRepo,
  });
  await openMissionBridge();
  return { renders: () => renders };
}

// The exact shape mission-commands.js's environmentReference() fills in — the
// reducer's own validation rejects a fixture with a hole in it.
const ENV_VALUES = {
  temperatureC: 24, relativeHumidityPct: 40, windAvgMs: 5, windGustMs: 8, windFromDeg: 170,
};

/** A live environment whose fetch landed `ageMs` before the real now. */
function fetchedEnvAge(ageMs) {
  const retrievedAt = new Date(Date.now() - ageMs).toISOString();
  return {
    type: 'setEnvironmentReference',
    payload: {
      source: 'live',
      capturedAt: retrievedAt,
      values: ENV_VALUES,
      provenance: { source: 'open-meteo-forecast', retrievedAt, validAt: retrievedAt },
    },
  };
}

test('a planner left open re-analyses on its own when the forecast crosses 6 h', async () => {
  const host = await boot('Ages past six hours');
  dispatch(fetchedEnvAge(HOUR_MS * 6 - SHORT_OF_BOUNDARY_MS), { render: false });

  const first = analyzeNow();
  assert.ok(first, 'the seeded mission analyses');
  assert.ok(!codes(first).includes('W-DATA-FORECAST-AGE'), 'under 6 h: no caution yet');
  assert.equal(analyzeNow(), first, 'untouched inputs inside the bucket still hit the memo');

  // Let the samplers land and be counted; the forecast is still on the near
  // side of the boundary, so a pass here still carries no caution.
  await sleep(900);
  const settled = analyzeNow();
  assert.ok(!codes(settled).includes('W-DATA-FORECAST-AGE'), 'still under 6 h once the samplers settle');
  const settledRenders = host.renders();

  // No input moves from here on — the next update() can only be the age
  // timer's, armed for the boundary plus its slack.
  await waitFor(() => host.renders() > settledRenders, 'the 6 h crossing never asked for a render');
  const after = analyzeNow();
  assert.notEqual(after, settled, 'the crossing busts the memo with every input untouched');
  assert.ok(codes(after).includes('W-DATA-FORECAST-AGE'), 'the caution reached the snapshot');
  assert.ok(!codes(after).includes('W-DATA-FORECAST-STALE'));
});

test('an open planner escalates from caution to warning when the forecast crosses 24 h', async () => {
  const host = await boot('Ages past a day');
  dispatch(fetchedEnvAge(HOUR_MS * 24 - SHORT_OF_BOUNDARY_MS), { render: false });

  const first = analyzeNow();
  assert.ok(first, 'the seeded mission analyses');
  assert.ok(codes(first).includes('W-DATA-FORECAST-AGE'), 'between 6 h and 24 h the caution is already up');
  assert.ok(!codes(first).includes('W-DATA-FORECAST-STALE'), 'not yet the warning');

  await sleep(900);
  const settled = analyzeNow();
  assert.ok(!codes(settled).includes('W-DATA-FORECAST-STALE'), 'still short of 24 h once the samplers settle');
  const settledRenders = host.renders();

  await waitFor(() => host.renders() > settledRenders, 'the 24 h crossing never asked for a render');
  const after = analyzeNow();
  assert.ok(codes(after).includes('W-DATA-FORECAST-STALE'), 'the warning reached the snapshot');
  assert.ok(!codes(after).includes('W-DATA-FORECAST-AGE'), 'the caution stepped aside rather than doubling up');
});
