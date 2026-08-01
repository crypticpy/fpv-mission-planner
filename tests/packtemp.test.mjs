import test from 'node:test';
import assert from 'node:assert/strict';

import { DRONES, BATTERIES } from '../src/data.js';
import { planMission, isColdPack, U } from '../src/domain/physics.js';

/* Phase 4 item 3: the pack's temperature, apart from the air's.
 *
 * Two claims are worth a test each. The default has to be inert — a pack that
 * cold-soaked in a bag is at air temperature, and a plan that never touches the
 * new input must be the plan the app produced before the input existed. And the
 * override has to land on exactly one half of the model: the chemistry curves,
 * never the air density. */

const moz7 = DRONES.find(d => d.id === 'moz7v2');
const nav5000 = BATTERIES.find(b => b.id === 'nav5000');       // 6S Li-Ion
const cinelog = DRONES.find(d => d.id === 'cinelog30v3');
const gnb850lr = BATTERIES.find(b => b.id === 'gnb850lr');     // 4S LiHV

const MILD = {
  elevM: U.ftToM(800), tempC: U.fToC(75), rhPct: 40,
  windAvgMs: U.mphToMs(8), windGustMs: U.mphToMs(16), windMode: 'headOut', windFromDeg: 170,
};
// −5 °C: freezing air, which is the case the whole item exists for. Below the
// LiPo/LiHV threshold and below the Li-Ion one.
const WINTER = { ...MILD, tempC: -5, rhPct: 60 };

function inputs(drone, battery, env = MILD, overrides = {}) {
  return {
    drone, battery, payloadG: 0, payloadCdA: 0, extraG: 0,
    env: { ...env },
    landFloorPct: 20, gustFactor: 0.35, cruiseMode: 'real', realVMs: drone.cruiseMs, overheadF: 1.05,
    ...overrides,
  };
}

const coldWarnings = (r) => r.warnings.filter(w => /cold|Cold|Preheated/.test(w.text));

/* ---------- 1. the default is inert ---------- */

test('with no pack temperature given, the pack is at air temperature', () => {
  for (const [drone, battery] of [[moz7, nav5000], [cinelog, gnb850lr]]) {
    for (const env of [MILD, WINTER]) {
      const implicit = planMission(inputs(drone, battery, env));
      const explicit = planMission(inputs(drone, battery, env, { packTempC: env.tempC }));
      // Same number, arrived at two ways: the whole plan has to agree, down to
      // the timeline and the power curve.
      assert.deepEqual(explicit, implicit);
      assert.equal(implicit.temps.packC, env.tempC);
      assert.equal(implicit.temps.airC, env.tempC);
      // Saying "the pack is at air temperature" claims nothing, so nothing on
      // screen announces an override.
      assert.equal(implicit.temps.packOverride, false);
    }
  }
});

test('the untouched winter plan is the same figure it was before the split', () => {
  // Pinned against b1d198f (the commit before pack temperature existed), same
  // fixture, same env: MOZ7 V2 + NAV 5000 at −5 °C in an 8/16 mph headwind-out.
  // If the pack/air split ever leaks into the default path, this moves.
  const r = planMission(inputs(moz7, nav5000, WINTER));
  assert.equal(r.radiusKm.toFixed(6), '4.194421');
  assert.equal(r.energy.deliveredWh.toFixed(6), '68.518144');
  assert.equal(r.energy.capF.toFixed(6), '0.905000');
  assert.equal(r.rho.toFixed(6), '1.277488');
  assert.equal(r.timeMin.toFixed(6), '10.856362');
});

/* ---------- 2. the override moves the chemistry, and only the chemistry ---------- */

test('a warmer pack in the same air buys energy without touching the air', () => {
  const cold = planMission(inputs(moz7, nav5000, WINTER));
  const warm = planMission(inputs(moz7, nav5000, WINTER, { packTempC: 25 }));

  // The air is untouched: density, and everything that is only density and mass.
  assert.equal(warm.rho, cold.rho);
  assert.equal(warm.densityAltM, cold.densityAltM);
  assert.equal(warm.massKg, cold.massKg);
  // Hover power is ρ, mass and disc area — no chemistry in it at any point.
  assert.equal(warm.hover.pW, cold.hover.pW);
  // Same for the whole power curve: a warm pack does not make the aircraft
  // cheaper to fly, only cheaper to feed.
  assert.deepEqual(warm.curve, cold.curve);
  // At a fixed airspeed, then, the cost of a kilometre is identical — the one
  // figure that isolates air density from everything the pack does.
  const at = (r) => r.legs.out.whPerKm;
  const fixed = (packTempC) => planMission(
    inputs(moz7, nav5000, WINTER, { cruiseMode: 'manual', manualVMs: 15, packTempC })
  );
  assert.equal(at(fixed(25)), at(fixed(undefined)));
  assert.equal(fixed(25).legs.pOut, fixed(undefined).legs.pOut);
  // What does move at the pilot's chosen cruise is the *ceiling*: a cold pack's
  // resistance is what caps current, so the usable top speed comes back with the
  // pack, and 'real' cruise is clamped to a share of it. Chemistry, not air.
  assert.ok(warm.speedLimitMs >= cold.speedLimitMs);

  // The pack, though, is a different pack: more capacity out of the same cells…
  assert.ok(warm.energy.capF > cold.energy.capF);
  assert.ok(warm.energy.deliveredWh > cold.energy.deliveredWh);
  // …and less resistance, which is the sag ceiling liftEnvelope inverts.
  assert.ok(warm.flight.maxCurrentA > cold.flight.maxCurrentA);
  // Which buys radius and flight time on identical air.
  assert.ok(warm.radiusKm > cold.radiusKm);
  assert.ok(warm.hoverTimeMin > cold.hoverTimeMin);
  assert.equal(warm.temps.packOverride, true);
  assert.equal(warm.temps.airC, WINTER.tempC);
  assert.equal(warm.temps.packC, 25);
});

test('a pack colder than the air is just as expressible, and costs energy', () => {
  // The car left out overnight: the air warmed up this morning, the packs in the
  // boot did not.
  const tracking = planMission(inputs(cinelog, gnb850lr, { ...MILD, tempC: 12 }));
  const soaked = planMission(inputs(cinelog, gnb850lr, { ...MILD, tempC: 12 }, { packTempC: -8 }));
  assert.equal(soaked.rho, tracking.rho);
  assert.equal(soaked.hover.pW, tracking.hover.pW);
  assert.ok(soaked.energy.deliveredWh < tracking.energy.deliveredWh);
  assert.ok(soaked.radiusKm < tracking.radiusKm);
  assert.equal(soaked.temps.packOverride, true);
});

/* ---------- 3. the warnings follow the pack ---------- */

test('the cold warning clears when the pack has been preheated', () => {
  const cold = planMission(inputs(moz7, nav5000, WINTER));
  assert.ok(cold.temps.cold);
  assert.ok(coldWarnings(cold).some(w => /Cold Li-Ion pack/.test(w.text)));
  // What the doc's caveat has to say, where the penalty is: which way each half
  // of the cold table is wrong.
  const text = coldWarnings(cold).map(w => w.text).join(' ');
  assert.match(text, /under-state/);
  assert.match(text, /over-state/);

  const warm = planMission(inputs(moz7, nav5000, WINTER, { packTempC: 22 }));
  assert.equal(warm.temps.cold, false);
  assert.equal(coldWarnings(warm).filter(w => /Cold Li-Ion pack/.test(w.text)).length, 0);
  // …and the pack does not stay warm on its own, which is the honest half of
  // letting a pilot claim it started warm.
  assert.ok(coldWarnings(warm).some(w => /Preheated pack in cold air/.test(w.text)));
});

test('preheating a LiHV pack clears its own, higher threshold', () => {
  // 3 °C is cold for a LiPo/LiHV pouch and not for Li-Ion — the two thresholds
  // isColdPack owns, now read off the pack rather than the air.
  assert.equal(isColdPack('lihv', 3), true);
  assert.equal(isColdPack('lipo', 3), true);
  assert.equal(isColdPack('liion', 3), false);
  const cold = planMission(inputs(cinelog, gnb850lr, { ...MILD, tempC: 3 }));
  assert.ok(coldWarnings(cold).some(w => /Cold LiHV pack/.test(w.text)));
  const warm = planMission(inputs(cinelog, gnb850lr, { ...MILD, tempC: 3 }, { packTempC: 20 }));
  assert.equal(coldWarnings(warm).filter(w => /Cold LiHV pack/.test(w.text)).length, 0);
});

test('a warm pack in warm air says nothing at all', () => {
  const r = planMission(inputs(moz7, nav5000, MILD, { packTempC: 30 }));
  assert.equal(coldWarnings(r).length, 0);
  assert.equal(r.temps.packOverride, true);
});

/* ---------- 4. the session persists it, tolerantly ---------- */

// The same Map-backed localStorage stub tests/store.test.mjs uses, and the same
// cache-busting import: `state` is a module singleton, so each case needs its own
// instance of the module to restore into.
function makeStorage(session = undefined) {
  const map = new Map();
  if (session !== undefined) map.set('fpv:v1:session', JSON.stringify(session));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}
let seq = 0;
const freshState = () => import(`../src/state.js?packtemp=${seq++}`);

// A blob this version would write, taken from the module itself rather than typed
// out here, so it can't drift away from what saveSession() actually stores.
async function savedBlob(mutate = (s) => s) {
  const ls = globalThis.localStorage = makeStorage();
  const mod = await freshState();
  mutate(mod.state);
  mod.saveSession();
  return JSON.parse(ls.getItem('fpv:v1:session'));
}

test('a pack temperature survives a save/restore round trip', async () => {
  const blob = await savedBlob((s) => { s.packTempF = 95; });
  assert.equal(blob.packTempF, 95);
  globalThis.localStorage = makeStorage(blob);
  const mod = await freshState();
  assert.equal(mod.state.packTempF, null, 'a fresh boot tracks the air');
  assert.equal(mod.restoreSession(), '2d');
  assert.equal(mod.state.packTempF, 95);
  assert.equal(mod.packTemp().overridden, true);
  assert.equal(mod.missionInputs().packTempC.toFixed(6), '35.000000');
});

test('a session written before pack temperature existed restores unharmed', async () => {
  // The key simply absent, which is every blob in the wild right now.
  const blob = await savedBlob();
  delete blob.packTempF;
  globalThis.localStorage = makeStorage(blob);
  const mod = await freshState();
  assert.equal(mod.restoreSession(), '2d', 'a missing knob must not void the loadout');
  assert.equal(mod.state.packTempF, null);
  // And the plan it hands back is the air-temperature one.
  const inp = mod.missionInputs();
  assert.equal(inp.packTempC, inp.env.tempC);
  assert.equal(planMission(inp).temps.packOverride, false);
});

test('a stored null is a real value, not a missing one', async () => {
  const blob = await savedBlob((s) => { s.packTempF = null; });
  assert.equal(blob.packTempF, null);
  globalThis.localStorage = makeStorage(blob);
  const mod = await freshState();
  assert.equal(mod.restoreSession(), '2d');
  assert.equal(mod.state.packTempF, null);
});

test('a pack temperature the control could never show voids the blob', async () => {
  // NaN is deliberately not in this list: JSON has no way to store it, so it
  // reaches restoreSession() as a null and means "tracks the air" — handled above.
  for (const bad of [400, -300, 'warm', true]) {
    const blob = await savedBlob((s) => { s.packTempF = 70; });
    blob.packTempF = bad;
    globalThis.localStorage = makeStorage(blob);
    const mod = await freshState();
    assert.equal(mod.restoreSession(), null, `${bad} should void the whole blob`);
    assert.equal(mod.state.packTempF, null, 'and leave the defaults alone');
  }
});
