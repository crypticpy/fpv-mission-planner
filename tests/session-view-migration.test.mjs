// The M10 session-view migration (src/state.js restoreSession).
//
// M10 renamed Plan's workspace modes: the Overview tab became Analyze, and the
// Map tab split into the 2D/3D pair. A session blob written before then says
// `view: 'dash'` or `view: 'map'` — and for 'map', which *engine* was on screen
// never lived in the session at all; it lived in the map-state blob (ADR 0004).
// The migration has to read it from there, or a pilot who reloaded in 3D comes
// back in 2D — a restore that used to work and silently stopped, which is
// exactly the loss the zero-feature-loss rule exists to catch.
//
// The store resolves `globalThis.localStorage` lazily on every call (store.js
// `backing()`), which is what lets each case here swap in its own storage under
// a cache-busted import of the state module.

import assert from 'node:assert/strict';
import test from 'node:test';

function makeStorage(/** @type {Record<string, unknown>} */ seed = {}) {
  const map = new Map();
  for (const [key, value] of Object.entries(seed)) map.set(key, JSON.stringify(value));
  return {
    getItem: (/** @type {string} */ k) => (map.has(k) ? map.get(k) : null),
    setItem: (/** @type {string} */ k, /** @type {*} */ v) => { map.set(k, String(v)); },
    removeItem: (/** @type {string} */ k) => { map.delete(k); },
  };
}

let seq = 0;
async function freshState(/** @type {*} */ storage) {
  globalThis.localStorage = storage;
  return import(`../src/state.js?viewmigration=${seq++}`);
}

/** A valid session blob, written by the current module itself, view overridden. */
async function blobWithView(/** @type {string} */ view) {
  const ls = makeStorage();
  const mod = await freshState(ls);
  mod.saveSession();
  const blob = JSON.parse(ls.getItem('fpv:v1:session'));
  blob.view = view;
  return blob;
}

/** The map-state blob the old scheme kept the engine choice in. */
const mapState = (/** @type {string} */ view) => ({
  lat: 47.6, lng: -122.1, zoom: 12, baseLayer: 'satellite', view,
});

test("a pre-M10 'dash' comes back as Analyze", async () => {
  const mod = await freshState(makeStorage({ 'fpv:v1:session': await blobWithView('dash') }));
  assert.equal(mod.restoreSession(), 'analyze');
});

test("a pre-M10 'map' with no map-state blob comes back as 2D", async () => {
  const mod = await freshState(makeStorage({ 'fpv:v1:session': await blobWithView('map') }));
  assert.equal(mod.restoreSession(), '2d');
});

test("a pre-M10 'map' follows the engine the map-state blob recorded", async () => {
  for (const [engine, want] of [['3d', '3d'], ['2d', '2d']]) {
    const mod = await freshState(makeStorage({
      'fpv:v1:session': await blobWithView('map'),
      'fpv:v1:map': mapState(engine),
    }));
    assert.equal(mod.restoreSession(), want, `engine ${engine} restored as ${want}`);
  }
});

test('the four current modes pass through unmigrated', async () => {
  for (const view of ['2d', '3d', 'analyze', 'review']) {
    const mod = await freshState(makeStorage({ 'fpv:v1:session': await blobWithView(view) }));
    assert.equal(mod.restoreSession(), view);
  }
});

test('a view no version ever wrote voids the blob', async () => {
  const mod = await freshState(makeStorage({ 'fpv:v1:session': await blobWithView('overview') }));
  assert.equal(mod.restoreSession(), null);
});
