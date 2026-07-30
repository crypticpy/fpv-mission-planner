import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal Map-backed localStorage stub matching the Web Storage API surface
// store.js touches (getItem/setItem/removeItem). `throwOnSet` simulates a
// quota-exceeded / private-mode browser.
function makeStorage({ throwOnSet = false } = {}) {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (throwOnSet) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem: (k) => { map.delete(k); },
  };
}

// Each call imports a fresh module instance (cache-busting query string) so
// store.js's module-top-level migrateLegacy() runs against whatever stub is
// installed on globalThis.localStorage at that moment.
let seq = 0;
function freshStore() {
  return import(`../src/store.js?fresh=${seq++}`);
}

test('set/get round-trips a value under the fpv:v1: namespace', async () => {
  const ls = globalThis.localStorage = makeStorage();
  const store = await freshStore();
  store.set('foo', { a: 1, b: [2, 3] });
  assert.deepEqual(store.get('foo', null), { a: 1, b: [2, 3] });
  assert.equal(ls.getItem('fpv:v1:foo'), '{"a":1,"b":[2,3]}');
});

test('get returns the fallback when the key is missing', async () => {
  globalThis.localStorage = makeStorage();
  const store = await freshStore();
  assert.equal(store.get('missing', 'fallback'), 'fallback');
});

test('get returns the fallback on corrupt JSON instead of throwing', async () => {
  const ls = globalThis.localStorage = makeStorage();
  const store = await freshStore();
  ls.setItem('fpv:v1:bad', '{not json');
  assert.deepEqual(store.get('bad', { ok: true }), { ok: true });
});

test('set swallows quota-exceeded errors', async () => {
  globalThis.localStorage = makeStorage({ throwOnSet: true });
  const store = await freshStore();
  assert.doesNotThrow(() => store.set('foo', 'bar'));
});

test('get/set/remove no-op gracefully when localStorage is unavailable', async () => {
  delete globalThis.localStorage;
  const store = await freshStore();
  assert.equal(store.get('foo', 'fallback'), 'fallback');
  assert.doesNotThrow(() => store.set('foo', 'bar'));
  assert.doesNotThrow(() => store.remove('foo'));
});

test('migrateLegacy copies a JSON legacy value verbatim and removes the legacy key', async () => {
  const ls = globalThis.localStorage = makeStorage();
  ls.setItem('fpv-spots', JSON.stringify([{ id: 's1' }]));
  const store = await freshStore(); // migration runs at module import time
  assert.deepEqual(store.get('spots', null), [{ id: 's1' }]);
  assert.equal(ls.getItem('fpv-spots'), null);
});

test('migrateLegacy JSON-encodes the raw (non-JSON) theme string', async () => {
  const ls = globalThis.localStorage = makeStorage();
  ls.setItem('fpv-mission-theme-v1', 'auto');
  const store = await freshStore();
  assert.equal(store.get('theme', null), 'auto');
  assert.equal(ls.getItem('fpv:v1:theme'), '"auto"');
  assert.equal(ls.getItem('fpv-mission-theme-v1'), null);
});

test('migrateLegacy moves all six legacy keys in one pass', async () => {
  const ls = globalThis.localStorage = makeStorage();
  ls.setItem('fpv-session', JSON.stringify({ view: 'dash' }));
  ls.setItem('fpv-spots', JSON.stringify([]));
  ls.setItem('fpv-map', JSON.stringify({ lat: 1, lng: 2 }));
  ls.setItem('fpv-custom-batteries', JSON.stringify([]));
  ls.setItem('fpv-custom-manufacturers', JSON.stringify([]));
  ls.setItem('fpv-mission-theme-v1', 'night-ops');

  await freshStore();

  const legacyKeys = [
    'fpv-session', 'fpv-spots', 'fpv-map',
    'fpv-custom-batteries', 'fpv-custom-manufacturers', 'fpv-mission-theme-v1',
  ];
  for (const key of legacyKeys) assert.equal(ls.getItem(key), null);

  const namespacedKeys = [
    'fpv:v1:session', 'fpv:v1:spots', 'fpv:v1:map',
    'fpv:v1:custom-batteries', 'fpv:v1:custom-manufacturers', 'fpv:v1:theme',
  ];
  for (const key of namespacedKeys) assert.notEqual(ls.getItem(key), null);
});

test('migrateLegacy is idempotent', async () => {
  const ls = globalThis.localStorage = makeStorage();
  ls.setItem('fpv-spots', JSON.stringify([{ id: 's1' }]));
  const store = await freshStore();
  store.migrateLegacy();
  store.migrateLegacy();
  assert.deepEqual(store.get('spots', null), [{ id: 's1' }]);
});

test('migrateLegacy does not clobber an existing namespaced key', async () => {
  const ls = globalThis.localStorage = makeStorage();
  ls.setItem('fpv:v1:spots', JSON.stringify([{ id: 'existing' }]));
  ls.setItem('fpv-spots', JSON.stringify([{ id: 'legacy' }]));
  const store = await freshStore();
  assert.deepEqual(store.get('spots', null), [{ id: 'existing' }]);
  // the legacy key is left alone since the namespaced key already existed
  assert.notEqual(ls.getItem('fpv-spots'), null);
});
