// dive.js is closed-form mechanics, so these tests pin identities as
// identities — exact equality against the formula, no fitted tolerance — and
// pin every stated policy for the *direction* it errs in: against the pilot.
// Fixture numbers are the M16 mockup's own line (10,820 ft launch, dive to
// 9,050, recovery 8,400) converted to metres, so a figure that drifts from
// the sheet is visible in the diff.

import test from 'node:test';
import assert from 'node:assert/strict';

import { G } from '../src/domain/physics.js';
import { climbEnergyWh } from '../src/domain/vertical.js';
import { distanceKm } from '../src/domain/geo.js';
import {
  diveLeg, diveVerticalSpeedMs, terminalDiveSpeedMs,
  pulloutArc, pulloutLoadG, pulloutClearance,
  pulloutPowerW, pulloutSag, electricalMargins,
  rthEnergyWh, recoveryReserveFrac,
} from '../src/domain/dive.js';

/* A 7.5" long-range quad, all-up: the class of airframe the dive screens plan. */
const MASS_KG = 1.4;
const CDA = 0.042;
const RHO = 1.0; // thin mountain air, roughly 2,100 m density altitude

const ENTRY = { latitude: 30.61, longitude: -98.11, altitudeMslM: 2758 }; // DIVE 9,050 ft
const EXIT = { latitude: 30.62, longitude: -98.12, altitudeMslM: 2560 }; // RECOVERY 8,400 ft

/* ---------- the line ---------- */

test('diveLeg is plane trigonometry over the same spherical ground distance as every other leg', () => {
  const leg = diveLeg(ENTRY, EXIT);
  const horizontalM = distanceKm(
    { lat: ENTRY.latitude, lng: ENTRY.longitude },
    { lat: EXIT.latitude, lng: EXIT.longitude },
  ) * 1000;
  assert.equal(leg.horizontalM, horizontalM, 'one ground-distance model, not two');
  assert.equal(leg.dropM, 198);
  assert.equal(leg.pathM, Math.hypot(198, horizontalM));
  assert.equal(leg.pitchDeg, -Math.atan2(198, horizontalM) * 180 / Math.PI);
  assert.ok(leg.pitchDeg < 0, 'a dive reads negative, like the sheet');
});

test('diveLeg reads a climbing leg with a positive pitch and a zero-length leg as level', () => {
  const up = diveLeg(EXIT, ENTRY);
  assert.equal(up.dropM, -198);
  assert.ok(up.pitchDeg > 0);
  const still = diveLeg(ENTRY, ENTRY);
  assert.deepEqual(still, { dropM: 0, horizontalM: 0, pathM: 0, pitchDeg: 0 });
});

test('vertical speed is the sine component, signed like the pitch', () => {
  assert.equal(diveVerticalSpeedMs(26, -52), 26 * Math.sin(-52 * Math.PI / 180));
  assert.ok(diveVerticalSpeedMs(26, -52) < 0);
  assert.equal(diveVerticalSpeedMs(0, -52), 0);
  assert.equal(diveVerticalSpeedMs(26, Number.NaN), 0);
});

/* ---------- terminal speed ---------- */

test('at terminal speed, drag along the path exactly balances the gravity component', () => {
  const pitchDeg = -52;
  const v = terminalDiveSpeedMs({ massKg: MASS_KG, rho: RHO, cdA: CDA, pitchDeg });
  const drag = 0.5 * RHO * v * v * CDA;
  const gravity = MASS_KG * G * Math.sin(52 * Math.PI / 180);
  assert.ok(Math.abs(drag - gravity) < 1e-9, 'the defining balance, not a fitted number');
  // ~23 m/s (~51 mph) idle terminal for this airframe on this slope: the
  // sheet's 58 mph dive leg is therefore a throttle-in claim, which is
  // exactly what this reference figure exists to say.
  assert.ok(v > 21 && v < 25, `${v.toFixed(1)} m/s — sanity, not precision`);
});

test('terminal speed grows with steepness and does not exist off a descent', () => {
  const shallow = terminalDiveSpeedMs({ massKg: MASS_KG, rho: RHO, cdA: CDA, pitchDeg: -20 });
  const steep = terminalDiveSpeedMs({ massKg: MASS_KG, rho: RHO, cdA: CDA, pitchDeg: -70 });
  assert.ok(steep > shallow);
  assert.equal(terminalDiveSpeedMs({ massKg: MASS_KG, rho: RHO, cdA: CDA, pitchDeg: 0 }), null);
  assert.equal(terminalDiveSpeedMs({ massKg: MASS_KG, rho: RHO, cdA: CDA, pitchDeg: 10 }), null);
  assert.equal(terminalDiveSpeedMs({ massKg: MASS_KG, rho: 0, cdA: CDA, pitchDeg: -52 }), null);
});

/* ---------- the pullout ---------- */

test('pullout radius is the load-factor identity, and the inverse reading round-trips it', () => {
  const speedMs = 26;
  const loadG = 3.8; // the sheet's own pullout load
  const arc = pulloutArc({ speedMs, pitchDeg: -52, loadG });
  assert.equal(arc.radiusM, speedMs * speedMs / (G * (loadG - 1)));
  assert.ok(Math.abs(pulloutLoadG({ speedMs, radiusM: arc.radiusM }) - loadG) < 1e-12, 'r(n) and n(r) are one identity');
});

test('a 60° dive sinks exactly half the arc radius before flying level', () => {
  const arc = pulloutArc({ speedMs: 30, pitchDeg: -60, loadG: 3 });
  assert.ok(Math.abs(arc.sinkM - arc.radiusM / 2) < 1e-9, 'r·(1 − cos 60°) = r/2');
});

test('no arc exists at 1 g or less, and a non-descending pitch sinks nothing', () => {
  assert.equal(pulloutArc({ speedMs: 26, pitchDeg: -52, loadG: 1 }), null);
  assert.equal(pulloutArc({ speedMs: 26, pitchDeg: -52, loadG: 0.5 }), null);
  assert.equal(pulloutArc({ speedMs: 0, pitchDeg: -52, loadG: 3 }), null);
  assert.equal(pulloutArc({ speedMs: 26, pitchDeg: 5, loadG: 3 }).sinkM, 0);
});

test('clearance is measured from the latest defensible pull — starting at the gate itself', () => {
  const { lowestMslM, clearanceM } = pulloutClearance({ gateMslM: 2560, groundMslM: 2500, sinkM: 24 });
  assert.equal(lowestMslM, 2536);
  assert.equal(clearanceM, 36);
  // A junk sink never inflates the floor above the gate.
  assert.equal(pulloutClearance({ gateMslM: 2560, groundMslM: 2500, sinkM: Number.NaN }).lowestMslM, 2560);
});

/* ---------- what the pull asks of the machine ---------- */

test('pullout power is hover power scaled by n^1.5 — the momentum-theory thrust exponent', () => {
  assert.equal(pulloutPowerW(300, 1), 300, 'a 1 g pull is a hover');
  assert.equal(pulloutPowerW(300, 4), 2400, '4^1.5 = 8, no fudge factor');
  assert.equal(pulloutPowerW(0, 4), 0);
  assert.equal(pulloutPowerW(300, 0), 0);
});

const PACK = { chem: 'liion', s: 6, capAh: 5, irPackMilliOhm: 118 };

test('pullout sag is a reading of the one IR model, at the stated power', () => {
  // Both figures sit inside this pack's deliverable envelope (V²/4R ≈ 1 kW):
  // the comparison is about sag under load, not about hitting the IR ceiling.
  const sag = pulloutSag({ batt: PACK, tempC: 20, powerW: 400, soc: 60 });
  assert.equal(sag.deliverable, true);
  assert.ok(sag.vLoad < sag.vOcv, 'delivering power sags the terminals');
  assert.ok(Math.abs(sag.I * sag.vLoad - 400) < 1e-6, 'P = I·V_load, the model\'s own definition');
  const harder = pulloutSag({ batt: PACK, tempC: 20, powerW: 800, soc: 60 });
  assert.ok(harder.vLoad < sag.vLoad, 'more power, more sag');
});

test('a power the pack cannot deliver reads undeliverable, never a made-up voltage', () => {
  const sag = pulloutSag({ batt: PACK, tempC: 20, powerW: 50_000, soc: 60 });
  assert.equal(sag.deliverable, false);
  assert.ok(Number.isNaN(sag.vLoad));
});

test('electrical margins compare the pack draw against limit × rotors, per stated limit only', () => {
  const m = electricalMargins({ currentA: 100, numRotors: 4, motorMaxA: 49.35, escMaxA: null });
  assert.equal(m.motorMarginFrac, (49.35 * 4 - 100) / (49.35 * 4));
  assert.equal(m.escMarginFrac, null, 'no stated limit, no invented margin');
  const over = electricalMargins({ currentA: 300, numRotors: 4, motorMaxA: 50, escMaxA: 65 });
  assert.ok(over.motorMarginFrac < 0, 'exceeding the ceiling is a statement, not an error');
  assert.deepEqual(
    electricalMargins({ currentA: Number.NaN, numRotors: 4, motorMaxA: 50, escMaxA: 65 }),
    { motorMarginFrac: null, escMarginFrac: null },
    'an undeliverable draw has no margin to quote',
  );
});

/* ---------- getting home ---------- */

test('RTH energy is the one climb model plus cruise at the stated power and speed', () => {
  const spec = { massKg: MASS_KG, etaProp: 0.55, climbM: 220, distanceM: 1800, levelPowerW: 260, speedMs: 15 };
  assert.equal(
    rthEnergyWh(spec),
    climbEnergyWh(MASS_KG, 0.55, 220) + 260 * (1800 / 15) / 3600,
  );
  assert.equal(rthEnergyWh({ ...spec, climbM: -50, distanceM: 0 }), 0, 'already home, already high enough');
  assert.equal(rthEnergyWh({ ...spec, speedMs: 0 }), null, 'distance with no speed has no time, not zero Wh');
});

test('recovery reserve is plain arithmetic, negative when the plan does not close', () => {
  assert.equal(recoveryReserveFrac({ packWh: 100, spentWh: 56, rthWh: 20 }), 0.24);
  assert.ok(recoveryReserveFrac({ packWh: 100, spentWh: 90, rthWh: 20 }) < 0);
  assert.equal(recoveryReserveFrac({ packWh: 0, spentWh: 10, rthWh: 5 }), null);
});
