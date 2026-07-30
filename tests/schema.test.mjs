import test from 'node:test';
import assert from 'node:assert/strict';

import { DRONES } from '../js/catalog/drones.js';
import { BATTERIES } from '../js/catalog/batteries.js';
import {
  BATTERY_FIELDS, DRONE_FIELDS, CONFIDENCE_OPTIONS,
  normalizeConfidence, validate, serialize, parse,
} from '../js/schema.js';

const moz7 = DRONES.find(d => d.id === 'moz7v2');
const nav5000 = BATTERIES.find(b => b.id === 'nav5000');

// Keys a record only ever grows at runtime, never on a form: the custom-record
// flag, and the synthetic fields parallelBattery() bolts on. Nothing in the
// catalog literals carries them, so the completeness check below is exact.
const RUNTIME_ONLY = ['custom', 'packCount', 'extraCdA', 'harnessMassG', 'baseBatteryId'];

const keysOf = (fields) => fields.map(f => f.key);

/* ---------- descriptor completeness ---------- */

test('every field on a catalog battery has a descriptor', () => {
  const covered = new Set([...keysOf(BATTERY_FIELDS), ...RUNTIME_ONLY]);
  const missing = Object.keys(nav5000).filter(k => !covered.has(k));
  assert.deepEqual(missing, []);
});

test('every field on a catalog drone has a descriptor, nested groups included', () => {
  const covered = new Set([...keysOf(DRONE_FIELDS), ...RUNTIME_ONLY]);
  assert.deepEqual(Object.keys(moz7).filter(k => !covered.has(k)), []);

  const group = (key) => DRONE_FIELDS.find(f => f.key === key);
  assert.equal(group('propulsion').type, 'group');
  assert.deepEqual(Object.keys(moz7.propulsion).filter(k => !keysOf(group('propulsion').fields).includes(k)), []);
  assert.equal(group('power').type, 'group');
  assert.deepEqual(Object.keys(moz7.power).filter(k => !keysOf(group('power').fields).includes(k)), []);
});

test('every descriptor carries a key, a label, and a known type', () => {
  const types = ['text', 'number', 'select', 'checkbox', 'url', 'tags', 'group'];
  const check = (fields, where) => {
    for (const f of fields) {
      assert.ok(f.key, `${where}: descriptor without a key`);
      assert.ok(f.label, `${where}.${f.key}: no label`);
      assert.ok(types.includes(f.type), `${where}.${f.key}: unknown type ${f.type}`);
      if (f.type === 'group') check(f.fields, `${where}.${f.key}`);
      if (f.type === 'select') assert.ok(Array.isArray(f.options), `${where}.${f.key}: select without options`);
    }
  };
  check(BATTERY_FIELDS, 'battery');
  check(DRONE_FIELDS, 'drone');
});

/* ---------- validate ---------- */

test('every shipped catalog record validates against its descriptors', () => {
  for (const b of BATTERIES) {
    const { ok, errors } = validate(b, BATTERY_FIELDS);
    assert.ok(ok, `${b.id}: ${JSON.stringify(errors)}`);
  }
  for (const d of DRONES) {
    const { ok, errors } = validate(d, DRONE_FIELDS);
    assert.ok(ok, `${d.id}: ${JSON.stringify(errors)}`);
  }
});

// The smallest record a form could submit: every required descriptor filled,
// nothing else.
const minimalBattery = {
  id: 'custom-mine', name: 'My 6S 4000', chem: 'liion',
  s: 6, p: 1, capAh: 4, massG: 420, irPackMilliOhm: 45,
  connector: 'XT60', manufacturerId: 'custom',
};

const minimalDrone = {
  id: 'mine', name: 'My 5" freestyle',
  dryMassG: 480, propDiaIn: 5, numRotors: 4,
  s: 6, connector: 'XT60', etaProp: 0.5, cdA: 0.03, avionicsW: 8,
  maxSpeedMs: 35, cruiseMs: 16,
  propulsion: { motorMaxW: 600, motorMaxA: 40, escMaxA: 55 },
};

test('a minimal record with only the required fields validates', () => {
  assert.deepEqual(validate(minimalBattery, BATTERY_FIELDS), { ok: true, errors: [] });
  // the power block is optional — registry.js falls back to connector + s
  assert.deepEqual(validate(minimalDrone, DRONE_FIELDS), { ok: true, errors: [] });
});

test('a missing required field fails, naming the key that is missing', () => {
  const { ok, errors } = validate({ ...minimalBattery, massG: undefined, connector: '' }, BATTERY_FIELDS);
  assert.equal(ok, false);
  assert.deepEqual(errors.map(e => e.key).sort(), ['connector', 'massG']);
});

test('an out-of-range number fails on its own key', () => {
  const { ok, errors } = validate({ ...minimalBattery, s: 99, capAh: 0 }, BATTERY_FIELDS);
  assert.equal(ok, false);
  assert.deepEqual(errors.map(e => e.key).sort(), ['capAh', 's']);
  assert.match(errors.find(e => e.key === 's').msg, /at most 12/);
});

test('a bad chemistry, a non-number, and a bad url each fail', () => {
  const bad = validate({ ...minimalBattery, chem: 'lifepo4', massG: 'heavy' }, BATTERY_FIELDS);
  assert.deepEqual(bad.errors.map(e => e.key).sort(), ['chem', 'massG']);
  const url = validate(
    { ...minimalDrone, propulsion: { ...minimalDrone.propulsion, sourceUrl: 'geprc.com' } },
    DRONE_FIELDS,
  );
  assert.deepEqual(url.errors.map(e => e.key), ['propulsion.sourceUrl']);
});

test('a required nested group is reported on the group key when absent', () => {
  // Neither of the drone's groups is required in the shipped list — `power` has a
  // documented default and `propulsion` is absent on any airframe without a
  // thrust stand behind it — so this pins the group-level required rule itself.
  const withRequiredPower = DRONE_FIELDS.map(f => (f.key === 'power' ? { ...f, required: true } : f));
  const { ok, errors } = validate({ ...minimalDrone, power: undefined }, withRequiredPower);
  assert.equal(ok, false);
  assert.deepEqual(errors.map(e => e.key), ['power']);
});

test('an absent propulsion group is allowed — an unmeasured airframe still validates', () => {
  const { ok } = validate({ ...minimalDrone, propulsion: undefined }, DRONE_FIELDS);
  assert.equal(ok, true);
});

test('a required field inside a present group is reported by its dotted path', () => {
  const { errors } = validate(
    { ...minimalDrone, propulsion: { motorMaxW: 600, escMaxA: 55 } },
    DRONE_FIELDS,
  );
  assert.deepEqual(errors.map(e => e.key), ['propulsion.motorMaxA']);
});

test('the pasted thrust ceiling is an optional drone field nothing shipped uses', () => {
  const f = DRONE_FIELDS.find(x => x.key === 'maxThrustGPerRotor');
  assert.ok(f, 'no descriptor for the pasted thrust ceiling');
  assert.equal(f.type, 'number');
  assert.equal(f.required, undefined, 'nobody who builds their own rig owns a thrust stand');
  // Every shipped airframe still gets its ceiling from momentum theory — the
  // override exists for the pilot's own bench sheet, not for the catalog.
  assert.deepEqual(DRONES.filter(d => 'maxThrustGPerRotor' in d).map(d => d.id), []);
});

/* ---------- serialize / parse ---------- */

test('serialize flattens nested groups to dotted keys of strings', () => {
  const raw = serialize(moz7, DRONE_FIELDS);
  assert.equal(raw['power.connectors'], 'XT60');
  assert.equal(raw['propulsion.motorMaxW'], '1148.9');
  assert.equal(raw.ducted, 'false');
  assert.equal(raw['power.maxPackMassG'], ''); // null reads as blank
  for (const v of Object.values(raw)) assert.equal(typeof v, 'string');
});

test('parse ∘ serialize is identity for every shipped catalog record', () => {
  for (const b of BATTERIES) {
    assert.deepEqual(parse(serialize(b, BATTERY_FIELDS), BATTERY_FIELDS), b, b.id);
  }
  for (const d of DRONES) {
    assert.deepEqual(parse(serialize(d, DRONE_FIELDS), DRONE_FIELDS), d, d.id);
  }
});

test('parse ∘ serialize is identity for the minimal records too', () => {
  assert.deepEqual(parse(serialize(minimalBattery, BATTERY_FIELDS), BATTERY_FIELDS), minimalBattery);
  assert.deepEqual(parse(serialize(minimalDrone, DRONE_FIELDS), DRONE_FIELDS), minimalDrone);
});

test('parse is lenient: blanks become null and junk numbers become NaN', () => {
  const r = parse({ ...serialize(minimalBattery, BATTERY_FIELDS), priceUsd: '', maxContA: 'lots' }, BATTERY_FIELDS);
  assert.equal(r.priceUsd, null);
  assert.ok(Number.isNaN(r.maxContA));
  // and validate is the thing that judges it
  assert.deepEqual(validate(r, BATTERY_FIELDS).errors.map(e => e.key), ['maxContA']);
});

// §6.1's "per-cell IR at a stated temperature": the temperature rides on the
// record as optional provenance, and adding it must not break the identity above
// for a pack that doesn't state one.
test('irTempC round-trips as an optional number', () => {
  const withTemp = { ...minimalBattery, irTempC: 21.5 };
  assert.deepEqual(parse(serialize(withTemp, BATTERY_FIELDS), BATTERY_FIELDS), withTemp);
  assert.ok(validate(withTemp, BATTERY_FIELDS).ok);
  // Absent stays absent — not spelled out as null, which is what would have
  // broken the catalog identity pin.
  assert.ok(!('irTempC' in serialize(minimalBattery, BATTERY_FIELDS)));
  assert.ok(validate(minimalBattery, BATTERY_FIELDS).ok);
  // Out of range is a soft-typo guard, not a silent accept.
  assert.deepEqual(
    validate({ ...minimalBattery, irTempC: 300 }, BATTERY_FIELDS).errors.map(e => e.key),
    ['irTempC'],
  );
});

/* ---------- the three confidence tiers (§6.1) ---------- */

test('confidence is a three-tier field everywhere it appears', () => {
  const tiers = CONFIDENCE_OPTIONS.map(o => o.value);
  assert.deepEqual(tiers, ['estimated', 'datasheet', 'measured']);
  const airframe = DRONE_FIELDS.find(f => f.key === 'confidence');
  const prop = DRONE_FIELDS.find(f => f.key === 'propulsion').fields.find(f => f.key === 'confidence');
  for (const f of [airframe, prop]) assert.deepEqual(f.options.map(o => o.value), tiers);
  // 'datasheet' has to survive validate() on both, or an imported record that
  // states it would be rejected by the gate share.js runs.
  assert.ok(validate({ ...minimalDrone, confidence: 'datasheet' }, DRONE_FIELDS).ok);
  assert.ok(validate(
    { ...minimalDrone, propulsion: { ...minimalDrone.propulsion, confidence: 'datasheet' } },
    DRONE_FIELDS,
  ).ok);
});

test('normalizeConfidence keeps the three tiers and reads anything else as a guess', () => {
  assert.equal(normalizeConfidence('measured'), 'measured');
  assert.equal(normalizeConfidence('datasheet'), 'datasheet');
  assert.equal(normalizeConfidence('estimated'), 'estimated');
  for (const junk of [undefined, null, '', 'calibrated', 'MEASURED', 42]) {
    assert.equal(normalizeConfidence(junk), 'estimated');
  }
});

test('tags round-trip through a comma-separated string', () => {
  const raw = serialize({ ...minimalBattery, fits: ['moz7v2', 'mine'], estimated: [] }, BATTERY_FIELDS);
  assert.equal(raw.fits, 'moz7v2, mine');
  assert.equal(raw.estimated, '');
  const back = parse(raw, BATTERY_FIELDS);
  assert.deepEqual(back.fits, ['moz7v2', 'mine']);
  assert.deepEqual(back.estimated, []);
});
