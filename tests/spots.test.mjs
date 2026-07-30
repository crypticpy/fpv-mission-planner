import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSpot } from '../src/data.js';

const base = {
  id: 'spot-mabry',
  name: 'Camp Mabry',
  lat: 30.3195,
  lng: -97.7654,
  elevFt: 550,
  notes: 'park on the north side',
  loadout: { droneId: 'moz7v2', batteryId: 'nav5000', parallelPacks: false, payloadId: 'naked', extraG: 0 },
  savedAt: 1_700_000_000_000,
};

test('a well-formed spot survives normalization unchanged', () => {
  assert.deepEqual(normalizeSpot(base), base);
});

test('a spot without an id, a name, or real coordinates is discarded', () => {
  assert.equal(normalizeSpot(null), null);
  assert.equal(normalizeSpot({ ...base, id: '   ' }), null);
  assert.equal(normalizeSpot({ ...base, name: '' }), null);
  assert.equal(normalizeSpot({ ...base, lat: 91 }), null);
  assert.equal(normalizeSpot({ ...base, lng: 'west' }), null);
  // never coerce: null must not become a spot at 0°/0°
  assert.equal(normalizeSpot({ ...base, lat: null }), null);
  assert.equal(normalizeSpot({ ...base, lng: undefined }), null);
});

test('a malformed loadout degrades to null without losing the place', () => {
  const noRig = normalizeSpot({ ...base, loadout: { droneId: 'moz7v2' } });
  assert.equal(noRig.loadout, null);
  assert.equal(noRig.lat, base.lat);
  assert.equal(normalizeSpot({ ...base, loadout: undefined }).loadout, null);
});

test('loadout snapshots keep booleans strict and clamp out-of-range ballast', () => {
  const l = normalizeSpot({
    ...base,
    loadout: { ...base.loadout, parallelPacks: 'yes', extraG: 9000 },
  }).loadout;
  assert.equal(l.parallelPacks, false); // only a real true means two packs
  assert.equal(l.extraG, 0);
});

test('elevation outside the model range is dropped rather than trusted', () => {
  assert.equal(normalizeSpot({ ...base, elevFt: 99000 }).elevFt, null);
  assert.equal(normalizeSpot({ ...base, elevFt: null }).elevFt, null);
  assert.equal(normalizeSpot({ ...base, elevFt: 550.4 }).elevFt, 550);
});

test('text fields are trimmed and bounded', () => {
  const s = normalizeSpot({ ...base, name: '  Mansfield Dam  ', notes: '  ' + 'x'.repeat(300) });
  assert.equal(s.name, 'Mansfield Dam');
  assert.equal(s.notes.length, 240);
});
