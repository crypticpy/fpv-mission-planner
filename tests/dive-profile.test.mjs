// dive-profile.js turns an authored dive plan into the numbers an elevation
// strip draws, and its whole reason to exist is the two places it refuses to
// guess (M16, 3D-06's bottom edge):
//
//  - an unknown pad height (`launchMslM: null`) does not get a sea-level pad
//    invented under it — the leg that would have started there is dropped, and
//    the line starts at the first gate instead, at x = 0;
//  - ground the terrain sampler could not answer stays `null` — a hole in the
//    silhouette, counted in `missing`, never interpolated across, and never
//    allowed to widen or shrink `minMslM`/`maxMslM`.
//
// Everything else here — leg order, leg lengths, gate ordinals, sample counts
// — is scaffolding that has to be right for those two refusals to be visible
// on a real chart.

import test from 'node:test';
import assert from 'node:assert/strict';

import { distanceKm } from '../src/domain/geo.js';
import { diveProfileFrom } from '../src/presentation/map/dive-profile.js';

function close(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) < eps, msg ?? `${a} !~ ${b} (±${eps})`);
}

/* A small ridge line: a pad above an approach gate, a dive down to a bench,
 * a recovery lower still, and an abort pin off to the side of the flown line. */
const LAUNCH = { lat: 30.59, lng: -98.09 };
const LAUNCH_MSL = 3460;

const gate = (kind, lat, lng, altitudeMslM, radiusM = 30) => ({
  id: `gat_${kind}`, kind, lat, lng, altitudeMslM, radiusM,
});

const APPROACH = gate('approach', 30.60, -98.10, 3300);
const DIVE = gate('dive', 30.61, -98.11, 2758);
const RECOVERY = gate('recovery', 30.62, -98.12, 2560);
const ABORT = gate('abort', 30.615, -98.125, 2600);

const noGround = () => null;

/* ---------- the flown line ---------- */

test('a full plan draws three legs in flight order, continuous, at their true lengths', () => {
  const profile = diveProfileFrom({
    launch: LAUNCH, launchMslM: LAUNCH_MSL, gates: [APPROACH, DIVE, RECOVERY, ABORT], groundAt: noGround,
  });
  assert.ok(profile);
  assert.equal(profile.fromLaunch, true);
  const { legs } = profile;
  assert.deepEqual(legs.map((l) => l.kind), ['approach', 'dive', 'recovery']);

  assert.equal(legs[0].x0, 0, 'the line starts at the pad');
  assert.equal(legs[0].x1, legs[1].x0, 'approach hands off to dive with no gap or overlap');
  assert.equal(legs[1].x1, legs[2].x0, 'dive hands off to recovery the same way');
  assert.equal(profile.totalM, legs[2].x1, 'totalM is where the line actually ends');

  assert.equal(legs[0].y0, LAUNCH_MSL);
  assert.equal(legs[0].y1, APPROACH.altitudeMslM);
  assert.equal(legs[1].y0, APPROACH.altitudeMslM);
  assert.equal(legs[1].y1, DIVE.altitudeMslM);
  assert.equal(legs[2].y0, DIVE.altitudeMslM);
  assert.equal(legs[2].y1, RECOVERY.altitudeMslM);

  const points = [LAUNCH, APPROACH, DIVE, RECOVERY];
  for (const [i, leg] of legs.entries()) {
    const spanM = distanceKm(points[i], points[i + 1]) * 1000;
    close(leg.x1 - leg.x0, spanM, 1e-6, `leg ${i} (${leg.kind}) span should be the great-circle distance`);
  }
});

test('an unknown pad height drops the approach leg instead of inventing a pad altitude', () => {
  const profile = diveProfileFrom({
    launch: LAUNCH, launchMslM: null, gates: [APPROACH, DIVE, RECOVERY], groundAt: noGround,
  });
  assert.ok(profile);
  assert.equal(profile.fromLaunch, false);
  assert.deepEqual(profile.legs.map((l) => l.kind), ['dive', 'recovery'], 'the pad leg is gone, not zeroed');

  assert.equal(profile.legs[0].x0, 0, 'the first surviving gate becomes the start of the line');
  assert.equal(
    profile.legs[0].y0, APPROACH.altitudeMslM,
    'the line starts at the first gate\'s own altitude, never a guessed pad height',
  );

  assert.equal(profile.gates[0].kind, 'approach');
  assert.equal(profile.gates[0].x, 0);
  assert.equal(profile.gates[0].altitudeMslM, APPROACH.altitudeMslM);

  for (const leg of profile.legs) {
    assert.ok(Number.isFinite(leg.y0) && Number.isFinite(leg.y1), 'no NaN leaked in from the unknown pad height');
  }
});

/* ---------- gate ordinals ---------- */

test('gate ordinals match the map pins\' flight-order numbering, and the abort gate never reaches the profile', () => {
  const full = diveProfileFrom({
    launch: LAUNCH, launchMslM: LAUNCH_MSL, gates: [APPROACH, DIVE, RECOVERY, ABORT], groundAt: noGround,
  });
  assert.deepEqual(
    full.gates.map((g) => [g.kind, g.ordinal]),
    [['approach', 1], ['dive', 2], ['recovery', 3]],
  );
  assert.ok(!full.gates.some((g) => g.kind === 'abort'), 'the abort gate is off the flown line, so it is not drawn');

  const noApproach = diveProfileFrom({
    launch: LAUNCH, launchMslM: LAUNCH_MSL, gates: [DIVE, RECOVERY, ABORT], groundAt: noGround,
  });
  assert.deepEqual(
    noApproach.gates.map((g) => [g.kind, g.ordinal]),
    [['dive', 1], ['recovery', 2]],
    'with approach missing, dive becomes the first gate the pilot flies',
  );
});

/* ---------- the ground ---------- */

test('ground the sampler could not answer stays a hole, counted and excluded from the range', () => {
  let calls = 0;
  const groundAt = () => {
    const c = calls++;
    return (c === 1 || c === 2) ? null : 2000; // a hole in the middle of the leg
  };
  const profile = diveProfileFrom({
    launch: LAUNCH, launchMslM: LAUNCH_MSL, gates: [RECOVERY], groundAt, samplesPerLeg: 4,
  });
  assert.ok(profile);
  assert.equal(profile.ground.length, 5, 'four steps, endpoints included');
  assert.equal(profile.ground[1].groundMslM, null);
  assert.equal(profile.ground[2].groundMslM, null);
  assert.equal(profile.missing, 2, 'exactly the two stations the sampler could not answer');
  assert.equal(profile.minMslM, 2000, 'the low ground, not a value dragged down by a null hole');
  assert.equal(profile.maxMslM, LAUNCH_MSL, 'the pad is still the high point; holes contribute nothing either way');
});

test('a constant ground below the line sets the low end of the range; the pad sets the high end', () => {
  const profile = diveProfileFrom({
    launch: LAUNCH, launchMslM: LAUNCH_MSL, gates: [APPROACH, DIVE, RECOVERY], groundAt: () => 1800,
  });
  assert.ok(profile);
  assert.equal(profile.missing, 0);
  assert.equal(profile.minMslM, 1800, 'ground sampled everywhere, below every gate and the pad');
  assert.equal(profile.maxMslM, LAUNCH_MSL, 'the pad is the highest point on this line');
});

/* ---------- degenerate plans ---------- */

test('no line to draw returns null: no gates at all, or a single gate stranded by an unknown pad height', () => {
  assert.equal(
    diveProfileFrom({ launch: LAUNCH, launchMslM: LAUNCH_MSL, gates: [], groundAt: noGround }),
    null,
  );
  assert.equal(
    diveProfileFrom({ launch: LAUNCH, launchMslM: null, gates: [APPROACH], groundAt: noGround }),
    null,
    'the only leg this plan had started at the pad, and that leg is what an unknown height drops',
  );
});

/* ---------- sampling density ---------- */

test('samplesPerLeg sets the ground station count, and the seam between two legs is sampled once', () => {
  const gates = [DIVE, RECOVERY];
  const coarse = diveProfileFrom({
    launch: LAUNCH, launchMslM: LAUNCH_MSL, gates, groundAt: noGround, samplesPerLeg: 2,
  });
  const fine = diveProfileFrom({
    launch: LAUNCH, launchMslM: LAUNCH_MSL, gates, groundAt: noGround, samplesPerLeg: 4,
  });
  assert.ok(fine.ground.length > coarse.ground.length, 'a bigger samplesPerLeg draws a finer ground line');

  for (const profile of [coarse, fine]) {
    const xs = profile.ground.map((g) => g.x);
    assert.equal(new Set(xs).size, xs.length, 'no two ground stations share an x — the seam is sampled once');
  }
});
