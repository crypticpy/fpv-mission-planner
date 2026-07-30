import test from 'node:test';
import assert from 'node:assert/strict';

import { BATTERIES } from '../js/catalog/batteries.js';
import { CHEMISTRY } from '../js/physics.js';
import {
  packCrossChecks, packIrFromCells, resolvePackIr, WH_PER_G_RANGE,
} from '../js/render/batterychecks.js';

// The form's own arithmetic, tested where it lives: these are the numbers the
// pilot reads back while typing a pack in, and the bounds a typo has to trip.

const nav5000 = BATTERIES.find(b => b.id === 'nav5000');

const asForm = (b) => ({
  chem: b.chem, s: b.s, p: b.p, capAh: b.capAh, massG: b.massG, maxContA: b.maxContA,
});

/* ---------- Wh/g and implied C ---------- */

test('pack Wh/g is the chemistry’s own nominal voltage times capacity, per gram', () => {
  const c = packCrossChecks(asForm(nav5000));
  const expectWh = CHEMISTRY[nav5000.chem].vNom * nav5000.s * nav5000.capAh;
  assert.equal(c.packWh, expectWh);
  assert.equal(c.whPerG, expectWh / nav5000.massG);
  assert.equal(c.impliedC, nav5000.maxContA / nav5000.capAh);
  assert.deepEqual(c.warnings, []);
});

test('nothing is computed until cells, capacity and weight are all there', () => {
  assert.equal(packCrossChecks(), null);
  assert.equal(packCrossChecks({ chem: 'liion', s: 6, capAh: 5 }), null);       // no weight
  assert.equal(packCrossChecks({ chem: 'liion', s: 6, massG: 700 }), null);     // no capacity
  assert.equal(packCrossChecks({ chem: 'liion', capAh: 5, massG: 700 }), null); // no cells
  // A blank parallel count is one group, not zero.
  assert.equal(packCrossChecks({ chem: 'liion', s: 6, capAh: 5, massG: 700 }).groups, 1);
});

test('every shipped pack sits inside the plausible Wh/g band', () => {
  const [lo, hi] = WH_PER_G_RANGE;
  for (const b of BATTERIES) {
    const c = packCrossChecks(asForm(b));
    assert.ok(c.whPerG > lo && c.whPerG < hi, `${b.id}: ${c.whPerG.toFixed(3)} Wh/g outside ${lo}–${hi}`);
    assert.deepEqual(c.warnings, [], `${b.id} warned: ${c.warnings.join(' ')}`);
  }
});

test('§6.1’s example typo is caught, softly', () => {
  // "A pack claiming 0.4 Wh/g is a typo": the same 6S 5000 with a weight a
  // factor out.
  const c = packCrossChecks({ chem: 'liion', s: 6, p: 1, capAh: 5, massG: 250 });
  assert.ok(c.whPerG > 0.4);
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0], /Wh\/g/);
  // Soft: the figures still come back, so the save still goes through.
  assert.ok(c.packWh > 0);
});

test('an implausibly heavy pack warns the other way', () => {
  const c = packCrossChecks({ chem: 'lipo', s: 6, p: 1, capAh: 1.3, massG: 900 });
  assert.ok(c.whPerG < WH_PER_G_RANGE[0]);
  assert.equal(c.warnings.length, 1);
});

test('a burst current entered as continuous warns, a real one does not', () => {
  const burst = packCrossChecks({ chem: 'lipo', s: 6, p: 1, capAh: 1.3, massG: 200, maxContA: 385 });
  assert.ok(burst.impliedC > 290);
  assert.equal(burst.warnings.length, 1);
  assert.match(burst.warnings[0], /burst/);
  const real = packCrossChecks({ chem: 'lipo', s: 6, p: 1, capAh: 1.3, massG: 200, maxContA: 78 });
  assert.deepEqual(real.warnings, []);
  // No current on the form is not a warning — the field is optional and pack sag
  // sets the limit instead.
  assert.equal(packCrossChecks({ chem: 'lipo', s: 6, p: 1, capAh: 1.3, massG: 200 }).impliedC, null);
});

/* ---------- per-cell IR (§6.1) ---------- */

test('per-cell resistance multiplies up the series and divides by the groups', () => {
  assert.equal(packIrFromCells(15, 6, 1), 90);
  assert.equal(packIrFromCells(15, 6, 2), 45);
  assert.equal(packIrFromCells(4.7, 6, 1), 28.2);
  assert.equal(packIrFromCells(15, 6, 0), 90, 'a blank parallel count is one group');
  assert.equal(packIrFromCells(0, 6, 1), null);
  assert.equal(packIrFromCells(15, null, 1), null);
  assert.equal(packIrFromCells(null, 6, 1), null);
  // Reported on the cross-check line, from the same call.
  assert.equal(
    packCrossChecks({ chem: 'liion', s: 6, p: 1, capAh: 5, massG: 700, irCellMilliOhm: 15 }).packIrMilliOhm,
    90,
  );
});

test('the stored figure is always pack-level, whichever mode the form is in', () => {
  // Whole-pack mode stores the field as typed.
  assert.equal(resolvePackIr({ irMode: 'pack', ir: 22, irCell: 15, s: 6, p: 1 }), 22);
  // Per-cell mode stores the product — computed at submit, not read back off the
  // input the live readout wrote.
  assert.equal(resolvePackIr({ irMode: 'cell', ir: 22, irCell: 15, s: 6, p: 1 }), 90);
  // Per-cell mode with nothing in the cell field falls back rather than storing
  // nonsense.
  assert.equal(resolvePackIr({ irMode: 'cell', ir: 22, irCell: null, s: 6, p: 1 }), 22);
  assert.equal(resolvePackIr({ irMode: 'pack', ir: null }), null);
});
