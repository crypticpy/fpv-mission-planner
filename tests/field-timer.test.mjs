// field-timer.test.mjs — the Field flight clock (F-01, design evolution M13).
// The contract under test: elapsed time derives from one persisted wall-clock
// start instant, so it survives a reload and never depends on an interval
// having been alive to accumulate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTimer, resetTimer, timerStartedAt, elapsedMin } from '../src/field-timer.js';

// Same Map-backed localStorage stub the store and registry tests use. store.js
// resolves globalThis.localStorage lazily on every call, so swapping this in
// between tests is enough.
function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

test('idle until started: no start instant, no elapsed time', () => {
  globalThis.localStorage = makeStorage();
  assert.equal(timerStartedAt(), null);
  assert.equal(elapsedMin(), null);
});

test('elapsed minutes derive from the persisted start instant', () => {
  globalThis.localStorage = makeStorage();
  startTimer(1_000_000);
  assert.equal(timerStartedAt(), 1_000_000);
  assert.equal(elapsedMin(1_000_000), 0);
  assert.equal(elapsedMin(1_000_000 + 90_000), 1.5);
});

test('a reload sees the same clock: the start instant reads back from storage', () => {
  // A fresh document holds no module state — everything the tile needs is
  // what a previous session wrote under the store's namespaced key.
  globalThis.localStorage = makeStorage({ 'fpv:v1:fieldTimer': { startedAt: 5_000 } });
  assert.equal(timerStartedAt(), 5_000);
  assert.equal(elapsedMin(65_000), 1);
});

test('restart overwrites: the clock counts from the newest launch', () => {
  globalThis.localStorage = makeStorage();
  startTimer(10_000);
  startTimer(70_000);
  assert.equal(elapsedMin(130_000), 1);
});

test('reset clears back to idle', () => {
  globalThis.localStorage = makeStorage();
  startTimer(10_000);
  resetTimer();
  assert.equal(timerStartedAt(), null);
  assert.equal(elapsedMin(999_999), null);
});

test('a device clock stepping backwards clamps at zero, never negative', () => {
  globalThis.localStorage = makeStorage();
  startTimer(100_000);
  assert.equal(elapsedMin(40_000), 0);
});

test('corrupt or foreign stored shapes read as idle, not a crash', () => {
  for (const bad of ['nonsense', 42, { startedAt: 'noon' }, { startedAt: Infinity }, null]) {
    globalThis.localStorage = makeStorage({ 'fpv:v1:fieldTimer': bad });
    assert.equal(timerStartedAt(), null, `shape ${JSON.stringify(bad)} should read as idle`);
    assert.equal(elapsedMin(), null);
  }
});
