import test from 'node:test';
import assert from 'node:assert/strict';

import { profileCoords, buildProfile } from '../js/terrain.js';
import {
  LINK_BANDS, LINK_BAND_DEFAULT, ANTENNA_HEIGHT_M, FRESNEL_CLEAR_FRAC,
  isLinkBand, linkBand, wavelengthM, fresnelRadiusM, earthBulgeM,
  linkProfile, bandReaches,
} from '../js/rf.js';

/* Phase 4 item 6: the radio over the terrain profile.
 *
 * Three claims. The Fresnel arithmetic has to match the field formula every RF
 * text prints; the blockage scan has to find the range where the link actually
 * quits, on the 60%-clearance rule rather than on bare line of sight; and the
 * whole thing has to say nothing at all when there is no profile behind it. */

const AUSTIN = { lat: 30.2672, lng: -97.7431 };

/** A synthetic profile: `elevsM` sampled evenly over `spanKm` from AUSTIN. */
function profile(elevsM, { spanKm = 10 } = {}) {
  const coords = profileCoords(AUSTIN, 0, spanKm, elevsM.length);
  return buildProfile({ launch: AUSTIN, bearingDeg: 0, coords, elevsM });
}

/** Flat ground, 60 m ridge at exactly 5 km, out to 10 km in 1 km steps. */
const ridge60 = () => profile([0, 0, 0, 0, 0, 60, 0, 0, 0, 0, 0]);
const flat = () => profile([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PLAN = { cruiseAltM: 100, radiusKm: 10 };

const ghzOf = (id) => linkBand(id).ghz;

/* ---------- 1. the Fresnel arithmetic ---------- */

test('the first Fresnel radius matches the field formula it is usually quoted as', () => {
  // r = 8.657·√(d_km / f_GHz) is the midpoint value of r = √(λ·d1·d2/d); every RF
  // handbook prints the first and this module computes the second.
  const midpoint = (dKm, ghz) => fresnelRadiusM(dKm * 500, dKm * 500, ghz);
  for (const [dKm, ghz] of [[1, 5.8], [5, 5.8], [5, 2.4], [12, 0.915], [0.4, 2.4]]) {
    assert.ok(Math.abs(midpoint(dKm, ghz) - 8.657 * Math.sqrt(dKm / ghz)) < 0.002,
      `${dKm} km at ${ghz} GHz`);
  }
  // And the hand-computed values behind those, so a change to the constant is a
  // failing test and not a rounding argument.
  assert.equal(midpoint(1, 5.8).toFixed(3), '3.595');
  assert.equal(midpoint(5, 5.8).toFixed(3), '8.038');
  assert.equal(midpoint(5, 0.915).toFixed(3), '20.237');
  assert.equal(wavelengthM(5.8).toFixed(5), '0.05169');

  // The zone is fattest in the middle and pinches to nothing at both ends — the
  // reason the ends of the chart's shaded wedge meet the line.
  assert.equal(fresnelRadiusM(0, 5000, 5.8), 0);
  assert.equal(fresnelRadiusM(5000, 0, 5.8), 0);
  assert.ok(midpoint(5, 5.8) > fresnelRadiusM(1000, 4000, 5.8));
  // Symmetric about the midpoint.
  assert.equal(fresnelRadiusM(1000, 4000, 5.8), fresnelRadiusM(4000, 1000, 5.8));
  // Lower band, fatter zone: √(5.8/0.915) = 2.517× the radius at 900 MHz.
  assert.ok(Math.abs(midpoint(5, 0.915) / midpoint(5, 5.8) - Math.sqrt(5.8 / 0.915)) < 1e-9);
  // Nonsense in, zero out — never a NaN into the clearance arithmetic.
  assert.equal(fresnelRadiusM(1000, 1000, 0), 0);
  assert.equal(fresnelRadiusM(0, 0, 5.8), 0);
});

test('the earth bulge is the 4/3-radius one, and it is small but real', () => {
  // d1·d2 / (2·R_eff) with R_eff = 4/3 × 6371 km: about 37 cm at the middle of a
  // 5 km link, growing with the square of the distance.
  assert.equal(earthBulgeM(2500, 2500).toFixed(3), '0.368');
  assert.equal(earthBulgeM(5000, 5000).toFixed(3), '1.472');
  assert.ok(Math.abs(earthBulgeM(5000, 5000) / earthBulgeM(2500, 2500) - 4) < 1e-9);
  assert.equal(earthBulgeM(0, 5000), 0);
});

/* ---------- 2. flat ground makes no claim ---------- */

test('flat ground under a 100 m cruise blocks nothing, on any band', () => {
  for (const b of LINK_BANDS) {
    const l = linkProfile(flat(), { ...PLAN, ghz: b.ghz });
    assert.equal(l.blocked, false, b.label);
    assert.equal(l.losBlockKm, null);
    assert.equal(l.fresnelBlockKm, null);
    assert.equal(l.clearKm, 10, 'the link holds the whole leg');
    // Nothing on this leg rises above the ground the pilot is standing on, so
    // there is no obstruction to quote a clearance ratio for. Not a coincidence:
    // the zone of a 1.5 m antenna grazes flat ground within the first few hundred
    // metres at every frequency, and treating that as a blockage would ground
    // every mission over a field. See obstaclesIn().
    assert.equal(l.worstFrac, null, b.label);
  }
  // The pilot's antenna stands on the launch ground, the aircraft holds a constant
  // altitude above sea level: the ray runs between the two.
  const l = linkProfile(flat(), { ...PLAN, ghz: ghzOf('5g8') });
  assert.equal(l.txElevM, ANTENNA_HEIGHT_M);
  assert.equal(l.planAltM, 100);
  assert.equal(l.ray[0].losM, ANTENNA_HEIGHT_M);
  assert.equal(l.ray[l.ray.length - 1].losM, 100);
  // The zone pinches to nothing at both ends, so the ratio is withheld there.
  assert.equal(l.ray[0].frac, null);
  assert.equal(l.ray[l.ray.length - 1].frac, null);
  // The chart's floor is always under the ray, by 60% of the zone plus the bulge.
  for (const s of l.ray) assert.ok(s.floorM <= s.losM + 1e-9);
  const mid = l.ray.find(s => s.distKm === 5);
  assert.ok(Math.abs((mid.losM - mid.floorM) - (FRESNEL_CLEAR_FRAC * mid.r1M + mid.bulgeM)) < 1e-9);
});

/* ---------- 3. a ridge, and where it cuts ---------- */

test('a ridge cuts the line of sight at the range the geometry says it does', () => {
  const l = linkProfile(ridge60(), { ...PLAN, ghz: ghzOf('5g8') });
  // Ray from a 1.5 m antenna to a 100 m cruise, 60 m ridge at 5 km: the ray grazes
  // the ridge when 1.5 + 98.5·(5/x) = 60, i.e. x = 492.5/58.5 = 8.419 km.
  const flatEarth = 492.5 / 58.5;
  assert.ok(l.losBlockKm != null);
  assert.ok(Math.abs(l.losBlockKm - flatEarth) < 0.2, `${l.losBlockKm} vs ${flatEarth}`);
  // Curvature always signs against the pilot: the real answer is a little shorter
  // than the flat-earth one, never longer.
  assert.ok(l.losBlockKm < flatEarth);
  assert.equal(l.losRidgeKm, 5, 'and it names the ridge doing it');

  // Self-consistent: at the reported range the ray sits on the effective ridge.
  const x = l.losBlockKm;
  const rayAtRidge = ANTENNA_HEIGHT_M + (100 - ANTENNA_HEIGHT_M) * (5 / x);
  assert.ok(Math.abs(rayAtRidge - (60 + earthBulgeM(5000, (x - 5) * 1000))) < 0.02);

  // The Fresnel zone closes well before the ray is cut — that is the whole point
  // of checking it, and it is where the picture actually starts breaking up.
  assert.ok(l.fresnelBlockKm < l.losBlockKm);
  assert.ok(l.fresnelBlockKm > 5, 'nothing is blocked before the ridge itself');
  assert.equal(l.clearKm, l.fresnelBlockKm, 'the usable range is the Fresnel one');
  assert.equal(l.blocked, true);
});

test('the 60% rule is what decides it, not bare line of sight', () => {
  const l = linkProfile(ridge60(), { ...PLAN, ghz: ghzOf('5g8') });
  const x = l.fresnelBlockKm;
  const d1 = 5000, d2 = (x - 5) * 1000;
  const rayAtRidge = ANTENNA_HEIGHT_M + (100 - ANTENNA_HEIGHT_M) * (5 / x);
  const clearanceM = rayAtRidge - 60 - earthBulgeM(d1, d2);
  // At the reported range the ridge is eating exactly 40% of the zone.
  assert.ok(clearanceM > 0, 'the ray itself is still clear here');
  assert.ok(Math.abs(clearanceM / fresnelRadiusM(d1, d2, ghzOf('5g8')) - FRESNEL_CLEAR_FRAC) < 0.005);
  // A metre closer in, the link is fine.
  const near = linkProfile(ridge60(), { ...PLAN, radiusKm: x - 0.05, ghz: ghzOf('5g8') });
  assert.equal(near.blocked, false);
});

test('the fatter low-band zone quits first over the same ridge', () => {
  const at = (id) => linkProfile(ridge60(), { ...PLAN, ghz: ghzOf(id) });
  const hi = at('5g8'), mid = at('2g4'), lo = at('900');
  assert.ok(lo.fresnelBlockKm < mid.fresnelBlockKm, '900 MHz needs the most clearance');
  assert.ok(mid.fresnelBlockKm < hi.fresnelBlockKm, 'and 2.4 GHz more than 5.8');
  // The band changes the zone, never the ray: bare line of sight is the same
  // geometry for all three.
  assert.equal(lo.losBlockKm, hi.losBlockKm);
  assert.equal(mid.losBlockKm, hi.losBlockKm);
  // Every band, in one pass, for the sentence that compares them.
  const bands = bandReaches(ridge60(), PLAN);
  assert.deepEqual(bands.map(b => b.id), LINK_BANDS.map(b => b.id));
  assert.equal(bands.find(b => b.id === '900').clearKm, lo.clearKm);
  assert.ok(bands.every(b => b.blocked));
});

test('a lower cruise is a shorter link, and a higher one buys range back', () => {
  const at = (cruiseAltM) => linkProfile(ridge60(), { ...PLAN, cruiseAltM, ghz: ghzOf('5g8') });
  assert.ok(at(80).clearKm < at(120).clearKm);
  // Climbing over the ridge entirely is the fix the warning tells them to make.
  assert.equal(at(180).blocked, false);
});

test('the leg stops where the plan stops, and the profile stops where the data does', () => {
  // The mission turns around before the ridge matters: no claim about ground it
  // never flies past.
  const near = linkProfile(ridge60(), { ...PLAN, radiusKm: 4, ghz: ghzOf('5g8') });
  assert.equal(near.legKm, 4);
  assert.equal(near.blocked, false);
  assert.equal(near.ray[near.ray.length - 1].distKm, 4);
  // A leg longer than the profile is read out to the data, not past it.
  const far = linkProfile(ridge60(), { ...PLAN, radiusKm: 50, ghz: ghzOf('5g8') });
  assert.equal(far.legKm, 10);
});

/* ---------- 4. no profile, no claim ---------- */

test('with no profile, or no mission, the radio says nothing', () => {
  assert.equal(linkProfile(null, { ...PLAN, ghz: 5.8 }), null);
  assert.equal(linkProfile(undefined, { ...PLAN, ghz: 5.8 }), null);
  assert.equal(linkProfile({ points: [] }, { ...PLAN, ghz: 5.8 }), null);
  assert.equal(linkProfile({ points: [{ distKm: 0, elevM: 200 }] }, { ...PLAN, ghz: 5.8 }), null);
  // A zero radius falls back to the profile's own span rather than dividing by it.
  assert.equal(linkProfile(flat(), { ...PLAN, radiusKm: 0, ghz: 5.8 }).legKm, 10);
  // And a band that isn't a frequency produces no analysis, not a NaN one.
  assert.equal(linkProfile(flat(), { ...PLAN, ghz: 0 }), null);
  assert.equal(linkProfile(flat(), { ...PLAN, ghz: undefined }), null);
});

/* ---------- 5. the band roster ---------- */

test('the band list is the pilot’s own kit, and the default is the video they fly by', () => {
  assert.deepEqual(LINK_BANDS.map(b => b.id), ['5g8', '2g4', '900']);
  assert.equal(LINK_BAND_DEFAULT, '5g8');
  assert.equal(linkBand(LINK_BAND_DEFAULT).ghz, 5.8);
  assert.equal(linkBand('900').ghz, 0.915, 'US ELRS is 915 MHz, not 900');
  for (const b of LINK_BANDS) assert.equal(isLinkBand(b.id), true);
  for (const bad of ['5.8', '', null, undefined, 'wifi']) assert.equal(isLinkBand(bad), false);
  // An id from nowhere reads as the default rather than throwing into a render.
  assert.equal(linkBand('wifi').id, LINK_BAND_DEFAULT);
});

/* ---------- 6. the session remembers the band, tolerantly ---------- */

// Same Map-backed localStorage stub and cache-busting import as the other state
// tests: `state` is a module singleton, so each case needs its own instance.
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
async function freshState(storage) {
  globalThis.localStorage = storage;
  return import(`../js/state.js?rf=${seq++}`);
}
async function savedBlob(mutate = (s) => s) {
  const ls = makeStorage();
  const mod = await freshState(ls);
  mutate(mod.state);
  mod.saveSession();
  return JSON.parse(ls.getItem('fpv:v1:session'));
}

test('a link band survives a save/restore round trip', async () => {
  const blob = await savedBlob((s) => { s.linkBand = '900'; });
  assert.equal(blob.linkBand, '900');
  const mod = await freshState(makeStorage(blob));
  assert.equal(mod.state.linkBand, LINK_BAND_DEFAULT, 'a fresh boot plans the video band');
  assert.equal(mod.restoreSession(), 'dash');
  assert.equal(mod.state.linkBand, '900');
});

test('a session written before the link check existed restores unharmed', async () => {
  const blob = await savedBlob();
  delete blob.linkBand;
  const mod = await freshState(makeStorage(blob));
  assert.equal(mod.restoreSession(), 'dash', 'a missing knob must not void the loadout');
  assert.equal(mod.state.linkBand, LINK_BAND_DEFAULT);
});

test('a band the control could never show voids the blob', async () => {
  for (const bad of ['5.8ghz', '', 0, null, true, 5.8]) {
    const blob = await savedBlob((s) => { s.linkBand = '2g4'; });
    blob.linkBand = bad;
    const mod = await freshState(makeStorage(blob));
    assert.equal(mod.restoreSession(), null, `${bad} should void the whole blob`);
    assert.equal(mod.state.linkBand, LINK_BAND_DEFAULT, 'and leave the default alone');
  }
});
