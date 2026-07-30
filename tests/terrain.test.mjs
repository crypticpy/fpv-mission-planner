import test from 'node:test';
import assert from 'node:assert/strict';

import { distanceKm, bearingDelta } from '../src/geo.js';
import { DRONES, BATTERIES } from '../src/data.js';
import { planMission, U } from '../src/physics.js';
import {
  PROFILE_SAMPLES, CLEARANCE_WARN_M,
  plannedCourseDeg, profileSpanKm, profileCoords, fetchElevationProfile, buildProfile,
  elevAtKm, terrainStats, setProfile, activeProfile, setTurnaroundKm, planElevM,
  usingTerrainElev, profileMatches,
} from '../src/terrain.js';

/* Phase 4 item 5: the ground under the outbound leg.
 *
 * Three claims carry this feature. The geometry has to sample the leg the plan
 * actually flies; the one network call has to refuse a payload it cannot trust;
 * and the elevation it produces has to reach the model the same way every other
 * input does — through missionInputs(), with the pre-feature answer intact
 * whenever no profile describes this launch point. */

const AUSTIN = { lat: 30.2672, lng: -97.7431 };

/** A synthetic profile: `elevsM` sampled evenly over `spanKm` from AUSTIN. */
function profile(elevsM, { launch = AUSTIN, bearingDeg = 0, spanKm = 5 } = {}) {
  const coords = profileCoords(launch, bearingDeg, spanKm, elevsM.length);
  return buildProfile({ launch, bearingDeg, coords, elevsM });
}

test.afterEach(() => { setProfile(null); setTurnaroundKm(0); });

/* ---------- 1. which way the leg points ---------- */

test('the profiled bearing is the course the plan flies out on', () => {
  // Wind from 350°: into it is 350°, downwind out is 170°, the cross leg is 80°.
  assert.equal(plannedCourseDeg(350, 'headOut'), 350);
  assert.equal(plannedCourseDeg(350, 'tailOut'), 170);
  assert.equal(plannedCourseDeg(350, 'cross'), 80);
  // Unknown modes plan into the wind, which is what physics.js treats as the
  // conservative default.
  assert.equal(plannedCourseDeg(350, undefined), 350);
  // And every answer is a compass bearing, whatever the input was.
  assert.equal(plannedCourseDeg(-10, 'headOut'), 350);
  assert.equal(plannedCourseDeg(710, 'tailOut'), 170);
  assert.equal(plannedCourseDeg(300, 'cross'), 30);
});

/* ---------- 2. the sample geometry ---------- */

test('the span covers the turnaround and stays inside one sane request', () => {
  assert.ok(profileSpanKm(10) > 10, 'sampling has to reach past the turn');
  assert.equal(profileSpanKm(0), 0.5, 'a zero-radius plan still profiles something');
  assert.equal(profileSpanKm(NaN), 0.5);
  assert.equal(profileSpanKm(1e6), 60, 'and a runaway radius cannot ask for the planet');
});

test('samples run from the launch point outward along the bearing', () => {
  const spanKm = 7;
  const coords = profileCoords(AUSTIN, 42, spanKm, PROFILE_SAMPLES);
  assert.equal(coords.length, PROFILE_SAMPLES);
  // The first sample is the launch point itself, so the profile carries its own
  // reference elevation instead of borrowing the rail's.
  assert.deepEqual({ lat: coords[0].lat, lng: coords[0].lng }, AUSTIN);
  assert.equal(coords[0].distKm, 0);
  assert.equal(coords[PROFILE_SAMPLES - 1].distKm, spanKm);
  for (const c of coords.slice(1)) {
    // Each point is where it says it is, on the bearing it was asked for.
    assert.ok(Math.abs(distanceKm(AUSTIN, c) - c.distKm) < 0.01);
  }
  const last = coords[PROFILE_SAMPLES - 1];
  assert.ok(distanceKm(AUSTIN, last) - spanKm < 0.01);
  assert.ok(last.lat > AUSTIN.lat && last.lng > AUSTIN.lng, '42° is north-east of here');
});

/* ---------- 3. one request, and what it refuses ---------- */

test('the whole profile is one request, and the answer is checked before use', async () => {
  const coords = profileCoords(AUSTIN, 0, 5, 8);
  const calls = [];
  const withFetch = async (impl, run) => {
    const prev = globalThis.fetch;
    globalThis.fetch = impl;
    try { return await run(); } finally { globalThis.fetch = prev; }
  };
  const ok = (body) => async (url) => {
    calls.push(url);
    return { ok: true, json: async () => body };
  };

  const elevs = [180, 190, 205, 230, 260, 300, 310, 305];
  const got = await withFetch(ok({ elevation: elevs }), () => fetchElevationProfile(coords));
  assert.deepEqual(got, elevs);
  assert.equal(calls.length, 1, 'one batched call, not one per point');
  // Both coordinate arrays go in the same request, in sample order.
  assert.match(calls[0], /latitude=([\d.,-]+)&longitude=([\d.,-]+)/);
  assert.equal(calls[0].match(/latitude=([\d.,-]+)/)[1].split(',').length, coords.length);
  assert.equal(calls[0].match(/longitude=([\d.,-]+)/)[1].split(',').length, coords.length);

  // A short array would draw the ridge in the wrong place.
  await assert.rejects(
    withFetch(ok({ elevation: elevs.slice(0, 4) }), () => fetchElevationProfile(coords)),
    /malformed/,
  );
  // A null is a gap, not sea level.
  await assert.rejects(
    withFetch(ok({ elevation: [180, null, 205, 230, 260, 300, 310, 305] }), () => fetchElevationProfile(coords)),
    /malformed/,
  );
  await assert.rejects(
    withFetch(ok({ elevation: 'flat' }), () => fetchElevationProfile(coords)),
    /malformed/,
  );
  await assert.rejects(
    withFetch(async () => ({ ok: false, status: 503 }), () => fetchElevationProfile(coords)),
    /HTTP 503/,
  );
  // And a dead connection is a rejection, not a profile of zeros.
  await assert.rejects(
    withFetch(async () => { throw new Error('Failed to fetch'); }, () => fetchElevationProfile(coords)),
    /Failed to fetch/,
  );
});

/* ---------- 4. reading the ground ---------- */

test('ground elevation between samples is interpolated, and clamped past the ends', () => {
  const p = profile([100, 200, 300], { spanKm: 4 }); // samples at 0, 2 and 4 km
  assert.equal(elevAtKm(p, 0), 100);
  assert.equal(elevAtKm(p, 2), 200);
  assert.equal(elevAtKm(p, 1), 150);
  assert.equal(elevAtKm(p, 3), 250);
  assert.equal(elevAtKm(p, -5), 100, 'behind the launch point is the launch point');
  assert.equal(elevAtKm(p, 99), 300, 'and past the last sample is the last sample');
});

test('the stats describe the leg being flown, and stop at the turnaround', () => {
  // Flat to 2 km, a 400 m ridge at 3 km, back down, then a mountain at 5 km that
  // this mission never reaches.
  const p = profile([200, 200, 200, 600, 220, 2000], { spanKm: 5 });
  const s = terrainStats(p, { cruiseAltM: 120, radiusKm: 4 });
  assert.equal(s.legKm, 4);
  assert.equal(s.launchElevM, 200);
  assert.equal(s.planAltM, 320, 'cruise altitude is AGL at the launch point');
  assert.equal(s.turnaroundElevM, 220);
  assert.equal(s.climbM, 20);
  // The ridge at 3 km is 280 m above the planned altitude — the mission is flying
  // into the hill, and that is the number the warning quotes.
  assert.equal(s.minClearanceM, -280);
  assert.equal(s.minClearanceAtKm, 3);
  assert.equal(s.maxElevM, 600, 'the 2000 m mountain past the turn is not on this flight');
  assert.equal(s.turnClearanceM, 100);
});

test('the turnaround figure is interpolated when the plan turns between samples', () => {
  const p = profile([100, 200, 300], { spanKm: 4 });
  const s = terrainStats(p, { cruiseAltM: 100, radiusKm: 3 });
  assert.equal(s.legKm, 3);
  assert.equal(s.turnaroundElevM, 250);
  assert.equal(s.climbM, 150);
  // Clearance is measured against that same interpolated point, so the sentence
  // under the chart and the line on it are the same figure.
  assert.equal(s.turnClearanceM, -50);
  assert.equal(s.minClearanceM, -50);
});

test('a leg longer than the profile is read out to the data, not past it', () => {
  const p = profile([100, 120, 140], { spanKm: 2 });
  const s = terrainStats(p, { cruiseAltM: 80, radiusKm: 50 });
  assert.equal(s.legKm, 2);
  assert.equal(s.turnaroundElevM, 140);
});

test('flat ground under a cruise altitude is exactly that much clearance', () => {
  const p = profile([300, 300, 300, 300], { spanKm: 3 });
  const s = terrainStats(p, { cruiseAltM: 80, radiusKm: 3 });
  assert.equal(s.climbM, 0);
  assert.equal(s.minClearanceM, 80);
  assert.ok(s.minClearanceM > CLEARANCE_WARN_M, 'and nothing to say about it');
});

/* ---------- 5. when a cached profile still answers ---------- */

test('a profile is reused for the same question and refetched for another', () => {
  const p = profile([200, 210, 220], { bearingDeg: 90, spanKm: 6 });
  assert.equal(profileMatches(p, { launch: AUSTIN, bearingDeg: 90, spanKm: 6 }), true);
  assert.equal(profileMatches(null, { launch: AUSTIN, bearingDeg: 90, spanKm: 6 }), false);
  // A shrinking plan keeps its profile: the post-fetch re-plan comes back with a
  // slightly different radius, and chasing it would fetch forever.
  assert.equal(profileMatches(p, { launch: AUSTIN, bearingDeg: 90, spanKm: 5.6 }), true);
  // A growing one does not — the leg would run off the end of the data.
  assert.equal(profileMatches(p, { launch: AUSTIN, bearingDeg: 90, spanKm: 9 }), false);
  // The wind swinging the leg around is a different question.
  assert.equal(profileMatches(p, { launch: AUSTIN, bearingDeg: 120, spanKm: 6 }), false);
  assert.ok(bearingDelta(90, 92) <= 5);
  assert.equal(profileMatches(p, { launch: AUSTIN, bearingDeg: 92, spanKm: 6 }), true, 'a nudge is not');
  // And so is moving the pin.
  const moved = { lat: AUSTIN.lat + 0.05, lng: AUSTIN.lng };
  assert.equal(profileMatches(p, { launch: moved, bearingDeg: 90, spanKm: 6 }), false);
});

test('a profile of one point is not a profile', () => {
  setProfile({ launch: AUSTIN, bearingDeg: 0, spanKm: 0, launchElevM: 200, points: [{ distKm: 0, elevM: 200 }] });
  assert.equal(activeProfile(), null);
});

/* ---------- 6. the one seam into the model ---------- */

test('with no profile the plan runs the elevation on the rail', () => {
  assert.equal(planElevM(1000), U.ftToM(1000));
  assert.equal(usingTerrainElev(1000), false);
  // A profile with no turnaround latched yet is the same case — the first render
  // after a fetch lands, before the probe pass has run.
  setProfile(profile([180, 240, 300], { spanKm: 4 }));
  const launchFt = U.mToFt(180);
  assert.equal(planElevM(launchFt), U.ftToM(launchFt));
  assert.equal(usingTerrainElev(launchFt), false);
});

test('the plan runs the air at the turnaround, not the air at the launch point', () => {
  const launchFt = 180 / 0.3048; // the profile's own launch elevation, in feet
  setProfile(profile([180, 260, 340, 420], { spanKm: 3 }));
  setTurnaroundKm(3);
  assert.equal(usingTerrainElev(launchFt), true);
  assert.equal(planElevM(launchFt), 420);
  // Halfway out is halfway up.
  setTurnaroundKm(1.5);
  assert.equal(planElevM(launchFt), 300);
});

test('a preset sky over a real map keeps the preset elevation', () => {
  // "Mountain — Colorado, 10,000 ft" with the pin still in Austin: the profile is
  // real, the elevation is hypothetical, and replacing one with the other would
  // throw away the scenario the pilot asked for.
  setProfile(profile([180, 260, 340], { spanKm: 3 }));
  setTurnaroundKm(3);
  assert.equal(usingTerrainElev(10000), false);
  assert.equal(planElevM(10000), U.ftToM(10000));
});

/* ---------- 7. what it does to the plan ---------- */

const moz7 = DRONES.find(d => d.id === 'moz7v2');
const nav5000 = BATTERIES.find(b => b.id === 'nav5000');

function inputs(elevM) {
  return {
    drone: moz7, battery: nav5000, payloadG: 0, payloadCdA: 0, extraG: 0,
    env: {
      elevM, tempC: U.fToC(85), rhPct: 45,
      windAvgMs: U.mphToMs(10), windGustMs: U.mphToMs(18), windMode: 'headOut', windFromDeg: 170,
    },
    landFloorPct: 20, gustFactor: 0.35, cruiseMode: 'real', realVMs: moz7.cruiseMs, overheadF: 1.05,
  };
}

test('planning the turnaround climbs the density altitude and thins the margins', () => {
  const atLaunch = planMission(inputs(180));
  const atTurn = planMission(inputs(600)); // 420 m of climb into the Hill Country
  assert.ok(atTurn.densityAltM > atLaunch.densityAltM, 'thinner air at the turnaround');
  assert.ok(atTurn.densityAltM - atLaunch.densityAltM > 400);
  assert.ok(atTurn.rho < atLaunch.rho);
  // Thinner air is more hover power for the same mass, which is the whole reason
  // the turnaround is the elevation worth planning at: it is where the thrust
  // margin has to hold and where it is thinnest.
  assert.ok(atTurn.hover.pW > atLaunch.hover.pW);
  assert.ok(atTurn.flight.thrustToWeight < atLaunch.flight.thrustToWeight);
  assert.ok(atTurn.flight.maxHoverMassG < atLaunch.flight.maxHoverMassG);
  assert.ok(atTurn.hoverTimeMin < atLaunch.hoverTimeMin);
  // Range is the one figure that goes the other way, and it is not a bug: at a
  // fixed cruise speed the parasitic drag falls with ρ faster than the induced
  // power rises, so the thin-air mission reaches slightly further while having
  // less left over to save itself with. The hover-margin figures above are what
  // the pilot is being warned about.
  assert.ok(atTurn.radiusKm > atLaunch.radiusKm);
});

test('a plan with no terrain behind it is the plan this app already made', () => {
  // The whole feature has to be inert offline: same launch elevation in, same
  // plan out, down to the timeline and the power curve.
  setProfile(null);
  setTurnaroundKm(0);
  const rail = planMission(inputs(U.ftToM(600)));
  const seam = planMission(inputs(planElevM(600)));
  assert.deepEqual(seam, rail);
});
