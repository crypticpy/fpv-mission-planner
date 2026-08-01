// The O-03 readiness rows (components/readiness.js): the model is pure, so
// these tests pin the honesty of the wording — what each store state claims,
// and above all what the card must never claim (a downloaded basemap).
import test from 'node:test';
import assert from 'node:assert/strict';

import { readinessRows, fmtBytes } from '../src/components/readiness.js';

const NOW = Date.parse('2026-08-01T12:00:00Z');

/** A healthy baseline every test perturbs one input of. */
function inputs(over = {}) {
  return {
    onLine: true,
    sw: 'controlled',
    weather: { source: 'Live · Open-Meteo', at: '2026-08-01T11:36:00Z', state: 'current' },
    evidence: { savedAt: '2026-08-01T11:00:00Z' },
    storage: { adapter: 'indexeddb', durable: true, persisted: true, save: 'saved', message: '', nearFull: false },
    estimate: { usage: 12e6, quota: 2e9 },
    ...over,
  };
}

function row(rows, key) {
  const r = rows.find((x) => x.key === key);
  assert.ok(r, `row ${key} missing`);
  return r;
}

test('healthy baseline: signal, app, weather, terrain and missions all read ok', () => {
  const rows = readinessRows(inputs(), NOW);
  for (const key of ['signal', 'app', 'weather', 'terrain', 'missions']) {
    assert.equal(row(rows, key).state, 'ok', key);
  }
});

test('the tiles row is always present and never claims a stored map', () => {
  for (const over of [{}, { onLine: false }, { sw: 'unsupported' }]) {
    const r = row(readinessRows(inputs(over), NOW), 'tiles');
    assert.equal(r.state, 'info');
    assert.match(r.title, /never stored/i);
    assert.match(r.body, /needs coverage/i);
  }
});

test('offline flips the signal row to cached and says what that means', () => {
  const r = row(readinessRows(inputs({ onLine: false }), NOW), 'signal');
  assert.equal(r.state, 'cached');
  assert.equal(r.title, 'Offline');
  assert.match(r.body, /already on this device/i);
});

test('a browser with no opinion gets no claim about coverage', () => {
  const r = row(readinessRows(inputs({ onLine: null }), NOW), 'signal');
  assert.equal(r.state, 'info');
  assert.match(r.title, /unknown/i);
});

test('online wording stays modest — the browser reports, it does not promise', () => {
  const r = row(readinessRows(inputs(), NOW), 'signal');
  assert.match(r.body, /browser reports/i);
});

test('service worker states: controlled ok, pending warns, unsupported is bad', () => {
  assert.equal(row(readinessRows(inputs(), NOW), 'app').state, 'ok');
  const pending = row(readinessRows(inputs({ sw: 'pending' }), NOW), 'app');
  assert.equal(pending.state, 'warn');
  assert.match(pending.body, /reload once while online/i);
  const unsupported = row(readinessRows(inputs({ sw: 'unsupported' }), NOW), 'app');
  assert.equal(unsupported.state, 'bad');
  assert.match(unsupported.body, /needs coverage to open/i);
});

test('cached weather names its age and that it cannot refresh', () => {
  const r = row(readinessRows(inputs({
    weather: { source: 'Live · Open-Meteo', at: '2026-08-01T11:36:00Z', state: 'cached' },
  }), NOW), 'weather');
  assert.equal(r.state, 'cached');
  assert.match(r.body, /24 min ago/);
  assert.match(r.body, /cannot refresh/i);
});

test('preset weather is honestly offline-safe', () => {
  const r = row(readinessRows(inputs({
    weather: { source: 'Preset · Austin spring', at: null, state: 'current' },
  }), NOW), 'weather');
  assert.equal(r.state, 'ok');
  assert.match(r.body, /works offline/i);
});

test('stale and unavailable weather map to warn and bad', () => {
  assert.equal(row(readinessRows(inputs({
    weather: { source: 'Live · Open-Meteo', at: '2026-07-31T08:00:00Z', state: 'stale' },
  }), NOW), 'weather').state, 'warn');
  assert.equal(row(readinessRows(inputs({
    weather: { source: 'Live', at: null, state: 'unavailable' },
  }), NOW), 'weather').state, 'bad');
});

test('terrain: saved names its age; missing says how to fix it; no mission says so', () => {
  const saved = row(readinessRows(inputs(), NOW), 'terrain');
  assert.equal(saved.state, 'ok');
  assert.match(saved.body, /1 h ago/);
  const missing = row(readinessRows(inputs({ evidence: null }), NOW), 'terrain');
  assert.equal(missing.state, 'warn');
  assert.match(missing.body, /Plan map while online/i);
  const none = row(readinessRows(inputs({ evidence: 'no-mission' }), NOW), 'terrain');
  assert.equal(none.state, 'info');
});

test('memory-only missions are a loud warning to export', () => {
  const r = row(readinessRows(inputs({
    storage: { adapter: 'memory', durable: false, persisted: null, save: 'saved', message: '', nearFull: null },
  }), NOW), 'missions');
  assert.equal(r.state, 'bad');
  assert.match(r.body, /this tab alone/i);
  assert.match(r.body, /export/i);
});

test('the missions row shows usage when the browser answered, and no claim when it did not', () => {
  const withRoom = row(readinessRows(inputs(), NOW), 'missions');
  assert.match(withRoom.body, /12 MB of 2\.0 GB/);
  const noClaim = row(readinessRows(inputs({ estimate: null }), NOW), 'missions');
  assert.ok(!/using/i.test(noClaim.body));
});

test('near-full storage warns before writes start failing', () => {
  const r = row(readinessRows(inputs({
    storage: { adapter: 'indexeddb', durable: true, persisted: true, save: 'saved', message: '', nearFull: true },
  }), NOW), 'missions');
  assert.equal(r.state, 'warn');
  assert.match(r.body, /may start failing/i);
});

test('fmtBytes is coarse and honest at each magnitude', () => {
  assert.equal(fmtBytes(840e3), '840 kB');
  assert.equal(fmtBytes(12e6), '12 MB');
  assert.equal(fmtBytes(2e9), '2.0 GB');
  assert.equal(fmtBytes(NaN), null);
  assert.equal(fmtBytes(-1), null);
});
