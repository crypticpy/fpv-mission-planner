import test from 'node:test';
import assert from 'node:assert/strict';

import { DRONES } from '../js/catalog/drones.js';
import { BATTERIES } from '../js/catalog/batteries.js';
import { airDensity, discAreaM2, liftEnvelope, U } from '../js/physics.js';
import { DRONE_FIELDS, validate, serialize, parse } from '../js/schema.js';
import { parseThrustTable } from '../js/thrust.js';

// §6.1's escape hatch, in two halves: a tolerant parser, and the one number it
// keeps overriding the momentum-theory lift ceiling. §7.4 rules out storing the
// curve, so the parser's whole contract is "peak thrust per motor, or a sentence
// saying why not".

const moz7 = DRONES.find(d => d.id === 'moz7v2');
const pack = BATTERIES.find(b => b.fits.includes('moz7v2'));

/* ---------- the parser ---------- */

test('a labeled thrust column wins, whatever else is in the table', () => {
  const got = parseThrustTable([
    'Throttle (%)  Thrust (g)  Amps  Watts  RPM',
    '25%  180  2.4  53  8400',
    '50%  420  8.1  178  12100',
    '75%  690  15.4  339  15300',
    '100%  980  24.2  532  17600',
  ].join('\n'));
  assert.equal(got.ok, true, got.message);
  assert.equal(got.maxThrustG, 980);
  assert.equal(got.nRows, 4);
  assert.equal(got.source, 'header');
  assert.equal(got.columnIndex, 1);
  // Not the amps, the watts or the RPM — every one of those peaks higher.
  assert.match(got.message, /980 g of thrust per motor/);
});

test('tabs, commas and pipes all read as column breaks', () => {
  const rows = [['Throttle', 'Thrust (g)'], ['50', '400'], ['100', '900']];
  for (const sep of ['\t', ',', ' | ', '  ']) {
    const text = rows.map(r => r.join(sep)).join('\n');
    const got = parseThrustTable(text);
    assert.equal(got.ok, true, `${JSON.stringify(sep)}: ${got.message}`);
    assert.equal(got.maxThrustG, 900, JSON.stringify(sep));
  }
});

test('the table’s own units are converted, from the header or from the numbers', () => {
  const kgHeader = parseThrustTable('Throttle,Thrust (kg)\n50,0.82\n100,1.842');
  assert.equal(kgHeader.ok, true, kgHeader.message);
  assert.ok(Math.abs(kgHeader.maxThrustG - 1842) < 1e-6);
  assert.equal(kgHeader.unit, 'kg');

  const lbHeader = parseThrustTable('Throttle,Thrust (lb),Watts\n50,1.1,180\n100,2.5,530');
  assert.equal(lbHeader.ok, true, lbHeader.message);
  assert.ok(Math.abs(lbHeader.maxThrustG - 2.5 * 453.592) < 1e-6);

  // No header at all, but the numbers carry the unit — that is enough to know
  // which column is a mass.
  const unitOnly = parseThrustTable('25 2.4 180g\n50 8.1 420g\n100 24.2 980g');
  assert.equal(unitOnly.ok, true, unitOnly.message);
  assert.equal(unitOnly.maxThrustG, 980);
  assert.equal(unitOnly.source, 'unit');
});

test('the two commonest bare pastes are read without a header', () => {
  const two = parseThrustTable('50 420\n75 690\n100 980');
  assert.equal(two.ok, true, two.message);
  assert.equal(two.maxThrustG, 980);
  assert.equal(two.source, 'two-column');

  const one = parseThrustTable('180\n420\n690\n980');
  assert.equal(one.ok, true, one.message);
  assert.equal(one.maxThrustG, 980);
  assert.equal(one.source, 'one-column');
});

test('footnotes and unit rows are dropped, not argued with', () => {
  const got = parseThrustTable([
    'Throttle  Thrust (g)  Amps',
    '50%  420  8.1',
    '100%  980  24.2',
    'Tested on 6S at 22 C with a 7x4 prop',
  ].join('\n'));
  assert.equal(got.ok, true, got.message);
  assert.equal(got.nRows, 2);
  assert.equal(got.maxThrustG, 980);
});

test('an unlabeled wide table is refused rather than guessed at', () => {
  // Five bare columns: the largest is RPM and the second-largest is watts.
  // Picking one would happily report 17600 g of thrust.
  const got = parseThrustTable('25 180 2.4 53 8400\n100 980 24.2 532 17600');
  assert.equal(got.ok, false);
  assert.equal(got.maxThrustG, null);
  assert.match(got.message, /nothing says which column is thrust/);
});

test('every other failure is a sentence, and never a number', () => {
  for (const [why, text] of [
    ['nothing pasted', '   \n  '],
    ['prose', 'the manufacturer says it pulls hard'],
  ]) {
    const got = parseThrustTable(text);
    assert.equal(got.ok, false, why);
    assert.equal(got.maxThrustG, null, why);
  }
  assert.match(parseThrustTable('a b c\nd e f').message, /paste the table itself/);

  // Out of range in both directions: a units mix-up and a decimal in the wrong
  // place both land here.
  const huge = parseThrustTable('Thrust (g)\n500000');
  assert.equal(huge.ok, false);
  assert.match(huge.message, /not a thrust figure for one motor/);
  assert.equal(parseThrustTable('Thrust (g)\n2').ok, false);
});

/* ---------- what the record keeps ---------- */

test('the parsed peak round-trips as a drone field, and is judged like any number', () => {
  const parsed = parseThrustTable('Throttle,Thrust (g)\n50,690\n100,1420');
  const rec = {
    id: 'mine', name: 'My 7" long range',
    dryMassG: 980, propDiaIn: 7, numRotors: 4,
    s: 6, connector: 'XT60', etaProp: 0.5, cdA: 0.045, avionicsW: 9,
    maxSpeedMs: 32, cruiseMs: 17,
    maxThrustGPerRotor: parsed.maxThrustG,
  };
  assert.deepEqual(validate(rec, DRONE_FIELDS), { ok: true, errors: [] });
  assert.deepEqual(parse(serialize(rec, DRONE_FIELDS), DRONE_FIELDS), rec);
  // Absent stays absent: the override is opt-in, and a blank field must not
  // arrive at physics.js as a zero ceiling.
  const bare = { ...rec, maxThrustGPerRotor: undefined };
  assert.equal('maxThrustGPerRotor' in parse(serialize(bare, DRONE_FIELDS), DRONE_FIELDS), false);
  assert.deepEqual(
    validate({ ...rec, maxThrustGPerRotor: 2 }, DRONE_FIELDS).errors.map(e => e.key),
    ['maxThrustGPerRotor'],
  );
});

/* ---------- the override ---------- */

const envFor = (drone, battery, over = {}) => {
  const tempC = U.fToC(75);
  const { rho } = airDensity(U.ftToM(800), tempC, 40);
  return {
    drone, battery, rho, tempC,
    areaM2: discAreaM2(drone),
    massKg: (drone.dryMassG + battery.massG) / 1000,
    ...over,
  };
};

test('a pasted table answers the lift question for a rig with no electrical limits', () => {
  const bare = { ...moz7, propulsion: undefined };
  const unmodeled = liftEnvelope(envFor(bare, pack));
  assert.equal(unmodeled.code, 'unknown');
  assert.equal(unmodeled.maxThrustG, Infinity);

  const withTable = liftEnvelope(envFor({ ...bare, maxThrustGPerRotor: 1420 }, pack));
  assert.equal(withTable.maxThrustG, 1420 * moz7.numRotors);
  assert.equal(withTable.estimated, false);
  assert.equal(withTable.confidence, 'measured');
  assert.equal(withTable.limitingComponent, 'thrust table');
  assert.notEqual(withTable.code, 'unknown');
  assert.ok(withTable.thrustToWeight > 1);
  // The energy half of the plan is untouched: there is still no current chain to
  // put a ceiling on how fast it can go.
  assert.equal(withTable.maxElectricalW, Infinity);
});

test('the table replaces the momentum-theory ceiling outright, in both directions', () => {
  const model = liftEnvelope(envFor(moz7, pack));
  assert.equal(model.estimated, true);
  assert.ok(model.maxThrustG > 0 && isFinite(model.maxThrustG));

  const perRotor = model.maxThrustG / moz7.numRotors;
  for (const factor of [1.6, 0.6]) {
    const bench = Math.round(perRotor * factor);
    const got = liftEnvelope(envFor({ ...moz7, maxThrustGPerRotor: bench }, pack));
    assert.ok(Math.abs(got.maxThrustG - bench * moz7.numRotors) < 1e-6,
      `bench ${bench} g at ${factor}× did not win`);
    assert.equal(got.estimated, false);
    assert.equal(got.limitingComponent, 'thrust table');
    // Only the lift figure moves — the electrical ceiling the speed model reads
    // is still the battery/ESC/motor chain's.
    assert.equal(got.maxElectricalW, model.maxElectricalW);
  }
});

test('a measured ceiling can fail a heavy loadout the estimate would have passed', () => {
  const heavy = { massKg: (moz7.dryMassG + pack.massG + 1800) / 1000 };
  const estimated = liftEnvelope(envFor(moz7, pack, heavy));
  const perRotor = liftEnvelope(envFor(moz7, pack)).maxThrustG / moz7.numRotors;
  const measured = liftEnvelope(envFor({ ...moz7, maxThrustGPerRotor: Math.round(perRotor * 0.5) }, pack, heavy));
  assert.ok(estimated.thrustToWeight > measured.thrustToWeight);
  assert.equal(measured.code, 'no_lift');
  assert.equal(measured.viable, false);
  assert.ok(measured.payloadMarginG < 0);
});
