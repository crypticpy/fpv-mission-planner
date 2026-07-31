import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AWAY_CONE_DEG, HELD_TRAVEL_M, TOWARD_CONE_DEG,
  fovDeg, frustumCorners, orbitAirspeedMs, shotGeometry, subjectFraming,
} from '../src/domain/camera.js';

/* M7 wave A: camera geometry, pinned analytically.
 *
 * Every expected number in this file was derived on paper from the model the
 * module states — a pinhole's 2·atan(sensor/2f), a 3-4-5 triangle's 36.87°, a
 * 45° half-angle's tan of 1 — and none of it was read off the implementation's
 * own output. That is the whole point of the exercise: a golden value copied
 * back from the code under test pins nothing except that the code has not
 * changed, and this module's job is to be *right*, not stable.
 *
 * The null contract gets the same treatment. Every entry point is fed the ways
 * an unresolved altitude, an unauthored radius or a missing camera profile
 * actually arrive (null, undefined, NaN, Infinity, zero, negative), and asked
 * for null rather than NaN. */

const TOL = 1e-6;

/** @type {(actual: unknown, expected: number, what: string) => void} */
function near(actual, expected, what) {
  assert.equal(typeof actual, 'number', `${what}: expected a number, got ${actual}`);
  assert.ok(Math.abs(Number(actual) - expected) < TOL,
    `${what}: ${actual} is not within ${TOL} of ${expected}`);
}

const p = (/** @type {number} */ eM, /** @type {number} */ nM, /** @type {number} */ uM) => ({ eM, nM, uM });

const SQRT2 = 1.4142135623730951;
// The 3-4-5 triangle's small angle, and the pinhole angle of a 36 mm sensor at
// 24 mm — the same arctangent (0.75) doubled, which is why one constant serves
// the elevation fixtures and the field-of-view ones.
const ATAN_3_4_DEG = 36.86989764584402;
const ATAN_1_2_DEG = 26.565051177077986;

/* ---------------- fovDeg: the pinhole model ---------------- */

test('a 36×24 sensor at 24 mm focal is 2·atan(0.75) wide and 2·atan(0.5) tall', () => {
  const fov = fovDeg({ sensorWidthMm: 36, sensorHeightMm: 24, focalLengthMm: 24 });
  assert.ok(fov);
  // By hand: half-angle = atan(18/24) = atan(0.75) = 36.8699°, so the full
  // horizontal angle is 73.7398°. ADR 0011's own "24 mm on a 36 mm sensor is
  // exactly 53.13°" is this same camera's *vertical* angle — 2·atan(12/24) =
  // 2·atan(0.5) — which is the cross-check that the pair is the right way round.
  near(fov.hDeg, 2 * ATAN_3_4_DEG, 'hDeg');
  near(fov.vDeg, 2 * ATAN_1_2_DEG, 'vDeg');
  near(fov.hDeg, 73.73979529168804, 'hDeg against the decimal expansion');
  near(fov.vDeg, 53.13010235415597, 'vDeg against the decimal expansion');
});

test('a square sensor is as wide as it is tall, to the bit', () => {
  const fov = fovDeg({ sensorWidthMm: 20, sensorHeightMm: 20, focalLengthMm: 15 });
  assert.ok(fov);
  assert.equal(fov.hDeg, fov.vDeg, 'one focal length, one sensor dimension, one angle');
  // 2·atan(10/15) = 2·atan(2/3) = 2 × 33.690067525979785°.
  near(fov.hDeg, 67.38013505195957, 'hDeg');
});

test('halving the focal length widens the view, and doubling it narrows it', () => {
  const wide = fovDeg({ sensorWidthMm: 36, sensorHeightMm: 24, focalLengthMm: 12 });
  const long = fovDeg({ sensorWidthMm: 36, sensorHeightMm: 24, focalLengthMm: 48 });
  assert.ok(wide && long);
  // 2·atan(1.5) = 112.6198649480°. And 2·atan(0.375), summed out of the arctan
  // series by hand — 0.375 − 0.375³/3 + 0.375⁵/5 − … = 0.35877067 rad — is
  // 2 × 20.5560452° = 41.1120904°.
  near(wide.hDeg, 112.6198649480, 'hDeg at 12 mm');
  near(long.hDeg, 41.1120904196, 'hDeg at 48 mm');
});

test('a field of view is always strictly inside (0°, 180°), so it composes', () => {
  // The pinhole angle approaches but never reaches a straight line, which is
  // exactly the range frustumCorners() and subjectFraming() accept — a profile
  // this module could describe is never a profile it then rejects.
  const absurd = fovDeg({ sensorWidthMm: 1e6, sensorHeightMm: 1e6, focalLengthMm: 1e-3 });
  assert.ok(absurd);
  assert.ok(absurd.hDeg > 179.9 && absurd.hDeg < 180, `${absurd.hDeg} should approach 180 from below`);
  assert.ok(frustumCorners(p(0, 0, 0), 0, 0, absurd, 10), 'still a usable frustum');
  assert.equal(subjectFraming(100, 1, absurd) !== null, true, 'still a usable framing');
});

test('fovDeg answers null for every unusable spec, never NaN', () => {
  for (const spec of [
    null, undefined,
    { sensorWidthMm: 0, sensorHeightMm: 24, focalLengthMm: 24 },
    { sensorWidthMm: 36, sensorHeightMm: 0, focalLengthMm: 24 },
    { sensorWidthMm: 36, sensorHeightMm: 24, focalLengthMm: 0 },
    { sensorWidthMm: -36, sensorHeightMm: 24, focalLengthMm: 24 },
    { sensorWidthMm: 36, sensorHeightMm: -24, focalLengthMm: 24 },
    { sensorWidthMm: 36, sensorHeightMm: 24, focalLengthMm: -24 },
    { sensorWidthMm: NaN, sensorHeightMm: 24, focalLengthMm: 24 },
    { sensorWidthMm: 36, sensorHeightMm: NaN, focalLengthMm: 24 },
    { sensorWidthMm: 36, sensorHeightMm: 24, focalLengthMm: NaN },
    { sensorWidthMm: Infinity, sensorHeightMm: 24, focalLengthMm: 24 },
    { sensorWidthMm: 36, sensorHeightMm: 24, focalLengthMm: Infinity },
    { sensorWidthMm: '36', sensorHeightMm: 24, focalLengthMm: 24 },
    { sensorHeightMm: 24, focalLengthMm: 24 },
  ]) {
    assert.equal(fovDeg(/** @type {never} */ (spec)), null, `${JSON.stringify(spec)} → null`);
  }
});

/* ---------------- shotGeometry: bearing, elevation, distance ---------------- */

test('a subject due east of a northbound leg bears 090 and sits on the horizon', () => {
  const shot = shotGeometry({ start: p(0, -100, 0), end: p(0, 100, 0), subject: p(50, 0, 0) });
  assert.ok(shot);
  near(shot.bearingToSubjectDeg, 90, 'bearing');
  near(shot.elevationAngleDeg, 0, 'elevation');
  // Both ends are 100 m up/down the leg from the abeam point, 50 m out:
  // √(50² + 100²) = √12500 = 111.80339887…
  near(shot.distanceStartM, 111.80339887498948, 'distanceStartM');
  near(shot.distanceEndM, 111.80339887498948, 'distanceEndM');
});

test('a subject due north of an eastbound leg bears 000', () => {
  const shot = shotGeometry({ start: p(-100, 0, 0), end: p(100, 0, 0), subject: p(0, 50, 0) });
  assert.ok(shot);
  near(shot.bearingToSubjectDeg, 0, 'bearing');
  near(shot.distanceStartM, 111.80339887498948, 'distanceStartM');
});

test('a subject due south of the midpoint bears 180, due west bears 270', () => {
  const leg = { start: p(0, -100, 0), end: p(0, 100, 0) };
  const south = shotGeometry({ ...leg, subject: p(0, -300, 0) });
  const west = shotGeometry({ ...leg, subject: p(-50, 0, 0) });
  assert.ok(south && west);
  near(south.bearingToSubjectDeg, 180, 'bearing south');
  near(west.bearingToSubjectDeg, 270, 'bearing west — wrapped into [0, 360), never negative');
});

test('elevation is the 3-4-5 triangle when the subject is 3 up at 4 out', () => {
  // A hold: start and end are the same point, so the midpoint is that point and
  // both slant ranges are the triangle's hypotenuse — 5, exactly.
  const shot = shotGeometry({ start: p(0, 0, 0), end: p(0, 0, 0), subject: p(4, 0, 3) });
  assert.ok(shot);
  near(shot.elevationAngleDeg, ATAN_3_4_DEG, 'elevation');
  assert.equal(shot.distanceStartM, 5, 'a 3-4-5 slant range is exact in binary');
  assert.equal(shot.distanceEndM, 5, 'and identical at both ends of a zero-length leg');
  near(shot.bearingToSubjectDeg, 90, 'bearing');
});

test('elevation is signed: below the aircraft is negative', () => {
  const shot = shotGeometry({ start: p(-3, 0, 0), end: p(3, 0, 0), subject: p(0, 4, -3) });
  assert.ok(shot);
  near(shot.elevationAngleDeg, -ATAN_3_4_DEG, 'elevation below horizontal');
  near(shot.bearingToSubjectDeg, 0, 'bearing');
  // Both ends: √(3² + 4² + 3²) = √34 = 5.8309518948…
  near(shot.distanceStartM, 5.830951894845301, 'distanceStartM');
  near(shot.distanceEndM, 5.830951894845301, 'distanceEndM');
});

test('a subject straight overhead reads +90° with no bearing at all', () => {
  const shot = shotGeometry({ start: p(0, -100, 0), end: p(0, 100, 0), subject: p(0, 0, 30) });
  assert.ok(shot);
  near(shot.elevationAngleDeg, 90, 'straight up');
  assert.equal(shot.bearingToSubjectDeg, null, 'a point on the midpoint\'s own vertical has no bearing');
  // √(100² + 30²) = √10900 = 104.40306508…
  near(shot.distanceStartM, 104.4030650891055, 'distanceStartM');
});

test('a subject exactly at the leg midpoint has neither angle', () => {
  const shot = shotGeometry({ start: p(0, -100, 0), end: p(0, 100, 0), subject: p(0, 0, 0) });
  assert.ok(shot);
  assert.equal(shot.bearingToSubjectDeg, null, 'no direction');
  assert.equal(shot.elevationAngleDeg, null, 'no direction, vertically either');
  assert.equal(shot.distanceStartM, 100, 'the distances are still perfectly well defined');
  assert.equal(shot.distanceEndM, 100);
});

test('the slant ranges are 3D and asymmetric when the leg closes on the subject', () => {
  const shot = shotGeometry({ start: p(0, 0, 0), end: p(0, 100, 0), subject: p(0, 300, 0) });
  assert.ok(shot);
  assert.equal(shot.distanceStartM, 300, 'exact');
  assert.equal(shot.distanceEndM, 200, 'exact, and closer — the leg flies at it');
});

/* ---------------- shotGeometry: screen direction ---------------- */

test('a subject to the RIGHT of travel sweeps left-to-right across the frame', () => {
  /* The worked example the module documents, checked here: a northbound leg with
   * the subject due east of it, framed by a camera looking east. That is the view
   * out the right-hand window of a northbound car — the road ahead (north) is on
   * the LEFT of that view — so the subject enters at frame left while it is still
   * ahead, crosses centre abeam, and exits at frame right once it is behind. */
  const shot = shotGeometry({ start: p(0, -100, 0), end: p(0, 100, 0), subject: p(50, 0, 0) });
  assert.ok(shot);
  assert.equal(shot.screenDirection, 'left-to-right');
});

test('a subject to the LEFT of travel is the mirror image, right-to-left', () => {
  const west = shotGeometry({ start: p(0, -100, 0), end: p(0, 100, 0), subject: p(-50, 0, 0) });
  assert.ok(west);
  assert.equal(west.screenDirection, 'right-to-left');
  // Same claim, rotated 90°: an eastbound leg with the subject to the north.
  const north = shotGeometry({ start: p(-100, 0, 0), end: p(100, 0, 0), subject: p(0, 50, 0) });
  assert.ok(north);
  assert.equal(north.screenDirection, 'right-to-left', 'north is the left window of an eastbound leg');
});

test('the two sides are exact mirrors of each other', () => {
  // Abeam the midpoint, so the cones never claim these — only the side does.
  for (const eM of [1, 7.5, 250, 5000]) {
    const right = shotGeometry({ start: p(0, -60, 10), end: p(0, 60, 10), subject: p(eM, 0, 3) });
    const left = shotGeometry({ start: p(0, -60, 10), end: p(0, 60, 10), subject: p(-eM, 0, 3) });
    assert.ok(right && left);
    assert.equal(right.screenDirection, 'left-to-right', `subject ${eM} m east`);
    assert.equal(left.screenDirection, 'right-to-left', `subject ${eM} m west`);
  }
});

test('a subject dead ahead is flown toward, a subject dead behind is flown away from', () => {
  const leg = { start: p(0, 0, 0), end: p(0, 100, 0) };
  const ahead = shotGeometry({ ...leg, subject: p(0, 300, 0) });
  const behind = shotGeometry({ ...leg, subject: p(0, -300, 0) });
  assert.ok(ahead && behind);
  assert.equal(ahead.screenDirection, 'toward');
  assert.equal(behind.screenDirection, 'away');
  // The cone test and the closing test are the same test, and this is the pair
  // that shows it: range shrinks over the leg for 'toward', grows for 'away'.
  assert.ok(ahead.distanceEndM < ahead.distanceStartM, 'toward closes');
  assert.ok(behind.distanceEndM > behind.distanceStartM, 'away opens');
});

test('the toward/away cones are the exported thresholds, a degree either side of them', () => {
  const start = p(0, 0, 0), end = p(0, 100, 0);
  const mid = p(0, 50, 0);
  /** @type {(deg: number) => { eM: number, nM: number, uM: number }} */
  const atAngle = (deg) => p(
    mid.eM + 1000 * Math.sin(deg * Math.PI / 180),
    mid.nM + 1000 * Math.cos(deg * Math.PI / 180),
    0,
  );
  const inside = shotGeometry({ start, end, subject: atAngle(TOWARD_CONE_DEG - 1) });
  const outside = shotGeometry({ start, end, subject: atAngle(TOWARD_CONE_DEG + 1) });
  assert.ok(inside && outside);
  assert.equal(inside.screenDirection, 'toward', `${TOWARD_CONE_DEG - 1}° off the nose is still an approach`);
  assert.equal(outside.screenDirection, 'left-to-right', `${TOWARD_CONE_DEG + 1}° off the nose is a pass`);

  const behind = shotGeometry({ start, end, subject: atAngle(180 - (AWAY_CONE_DEG - 1)) });
  const abeam = shotGeometry({ start, end, subject: atAngle(180 - (AWAY_CONE_DEG + 1)) });
  assert.ok(behind && abeam);
  assert.equal(behind.screenDirection, 'away');
  assert.equal(abeam.screenDirection, 'left-to-right', 'still east of the leg, so still the right-hand window');
});

test('a hold has no sweep at all', () => {
  const held = shotGeometry({ start: p(10, 20, 30), end: p(10, 20, 30), subject: p(110, 20, 30) });
  assert.ok(held);
  assert.equal(held.screenDirection, 'held');
});

test('a pure vertical climb is a hold as far as the frame is concerned', () => {
  const shot = shotGeometry({ start: p(0, 0, 0), end: p(0, 0, 50), subject: p(100, 0, 0) });
  assert.ok(shot);
  assert.equal(shot.screenDirection, 'held', 'no horizontal travel, no lateral sweep');
  near(shot.bearingToSubjectDeg, 90, 'bearing from the midpoint');
  // The midpoint is 25 m up, the subject 100 m out and on the ground:
  // atan(−25/100) = −14.036243°.
  near(shot.elevationAngleDeg, -14.036243467926479, 'elevation looking down from mid-climb');
});

test('HELD_TRAVEL_M is the line between station-keeping and travel', () => {
  const subject = p(50, 0, 0);
  const drift = shotGeometry({ start: p(0, 0, 0), end: p(0, HELD_TRAVEL_M / 2, 0), subject });
  const leg = shotGeometry({ start: p(0, 0, 0), end: p(0, HELD_TRAVEL_M * 2, 0), subject });
  assert.ok(drift && leg);
  assert.equal(drift.screenDirection, 'held', 'half the threshold is noise, not a move');
  assert.equal(leg.screenDirection, 'left-to-right', 'twice it is a move');
});

test('a leg straight over the subject has no side to sweep toward', () => {
  const shot = shotGeometry({ start: p(0, -100, 40), end: p(0, 100, 40), subject: p(0, 0, 0) });
  assert.ok(shot);
  assert.equal(shot.screenDirection, null, 'it crosses the frame centre, on neither side of travel');
  near(shot.elevationAngleDeg, -90, 'straight down');
  assert.equal(shot.bearingToSubjectDeg, null);
});

/* ---------------- shotGeometry: the null contract ---------------- */

test('one non-finite coordinate nulls the whole record', () => {
  const good = { start: p(0, 0, 0), end: p(0, 100, 0), subject: p(50, 50, 0) };
  assert.ok(shotGeometry(good), 'the control case resolves');
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(shotGeometry({ ...good, start: p(bad, 0, 0) }), null, `start.eM = ${bad}`);
    assert.equal(shotGeometry({ ...good, end: p(0, bad, 0) }), null, `end.nM = ${bad}`);
    assert.equal(shotGeometry({ ...good, subject: p(0, 0, bad) }), null, `subject.uM = ${bad}`);
  }
});

test('a missing point nulls the whole record — a shot short one point is not partly known', () => {
  const good = { start: p(0, 0, 0), end: p(0, 100, 0), subject: p(50, 50, 0) };
  assert.equal(shotGeometry({ ...good, subject: null }), null, 'no subject to frame');
  assert.equal(shotGeometry({ ...good, subject: undefined }), null);
  assert.equal(shotGeometry({ ...good, start: null }), null, 'an altitude that never resolved');
  assert.equal(shotGeometry({ ...good, end: null }), null);
  assert.equal(shotGeometry(/** @type {never} */ ({ ...good, subject: { eM: 1, nM: 2 } })), null,
    'a point missing a component is not a point');
});

test('across a grid of geometries nothing is ever NaN and the direction is always in the set', () => {
  const directions = new Set(['left-to-right', 'right-to-left', 'toward', 'away', 'held', null]);
  for (const dE of [-500, -1, 0, 1, 500]) {
    for (const dN of [-500, -1, 0, 1, 500]) {
      for (const dU of [-120, 0, 120]) {
        for (const legN of [0, 0.4, 3, 900]) {
          const shot = shotGeometry({
            start: p(0, 0, 0), end: p(0, legN, 5), subject: p(dE, dN, dU),
          });
          assert.ok(shot, `${dE},${dN},${dU} over a ${legN} m leg`);
          assert.ok(Number.isFinite(shot.distanceStartM) && Number.isFinite(shot.distanceEndM),
            'distances are finite');
          assert.ok(shot.bearingToSubjectDeg === null
            || (shot.bearingToSubjectDeg >= 0 && shot.bearingToSubjectDeg < 360), 'bearing in [0, 360)');
          assert.ok(shot.elevationAngleDeg === null
            || (shot.elevationAngleDeg >= -90 && shot.elevationAngleDeg <= 90), 'elevation in [−90, 90]');
          assert.ok(directions.has(shot.screenDirection), `${shot.screenDirection} is a named value`);
        }
      }
    }
  }
});

/* ---------------- frustumCorners ---------------- */

const FOV_90 = { hDeg: 90, vDeg: 90 };

test('level and north-facing at 90×90, the corners are ±range in each axis', () => {
  // tan(45°) = 1, so the half-width and half-height are the range itself.
  const corners = frustumCorners(p(0, 0, 0), 0, 0, FOV_90, 100);
  assert.ok(corners);
  assert.equal(corners.length, 4);
  const expected = [[-100, 100, 100], [100, 100, 100], [100, 100, -100], [-100, 100, -100]];
  const names = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
  corners.forEach((c, i) => {
    near(c.eM, expected[i][0], `${names[i]}.eM`);
    near(c.nM, expected[i][1], `${names[i]}.nM`);
    near(c.uM, expected[i][2], `${names[i]}.uM`);
  });
});

test('the corners are absolute points that travel with the camera', () => {
  const corners = frustumCorners(p(1000, -2000, 55), 0, 0, FOV_90, 100);
  assert.ok(corners);
  near(corners[0].eM, 900, 'top-left.eM');
  near(corners[0].nM, -1900, 'top-left.nM');
  near(corners[0].uM, 155, 'top-left.uM');
});

test('facing east, frame-left is north — the handedness, pinned', () => {
  const corners = frustumCorners(p(0, 0, 0), 90, 0, FOV_90, 100);
  assert.ok(corners);
  const [tl, tr, br, bl] = corners;
  near(tl.eM, 100, 'top-left.eM — the axis runs east');
  near(tl.nM, 100, 'top-left is 100 m north of the axis');
  near(tl.uM, 100, 'and 100 m above it');
  near(tr.nM, -100, 'top-right is south of the axis');
  near(br.nM, -100, 'bottom-right likewise');
  near(bl.nM, 100, 'bottom-left back to the north');
  assert.ok(tl.uM > bl.uM, 'the top pair is above the bottom pair');
});

test('pitched 45° down at 90×90, the top edge is level and the bottom edge is nadir', () => {
  /* Hand-derived. Heading 000, pitch −45°, range √2: the axis lands at
   * (0, 1, −1) — one metre ahead and one metre down. The frame's half-width and
   * half-height are √2·tan(45°) = √2, the right axis is due east, and the up
   * axis tilts to (0, 1, 1)/√2 · √2 = (0, 1, 1). So:
   *   top-left  = (0,1,−1) − (√2,0,0) + (0,1,1) = (−√2, 2, 0)
   *   top-right = (√2, 2, 0)
   *   bottom-right = (0,1,−1) + (√2,0,0) − (0,1,1) = (√2, 0, −2)
   *   bottom-left  = (−√2, 0, −2)
   * The two readings that make it checkable without the algebra: a 90° vertical
   * field pitched 45° down puts its top edge exactly on the horizontal (u = 0 at
   * the camera's own altitude) and its bottom edge exactly at nadir — the bottom
   * edge's midpoint, (0, 0, −2), is directly beneath the camera. */
  const corners = frustumCorners(p(0, 0, 0), 0, -45, FOV_90, SQRT2);
  assert.ok(corners);
  const [tl, tr, br, bl] = corners;
  near(tl.eM, -SQRT2, 'top-left.eM');
  near(tl.nM, 2, 'top-left.nM');
  near(tl.uM, 0, 'top-left.uM — the top edge is level with the camera');
  near(tr.eM, SQRT2, 'top-right.eM');
  near(tr.nM, 2, 'top-right.nM');
  near(tr.uM, 0, 'top-right.uM');
  near(br.eM, SQRT2, 'bottom-right.eM');
  near(br.nM, 0, 'bottom-right.nM');
  near(br.uM, -2, 'bottom-right.uM');
  near(bl.eM, -SQRT2, 'bottom-left.eM');
  near(bl.nM, 0, 'bottom-left.nM');
  near(bl.uM, -2, 'bottom-left.uM');
  near((br.eM + bl.eM) / 2, 0, 'the bottom edge midpoint is directly below the camera (east)');
  near((br.nM + bl.nM) / 2, 0, 'and directly below it (north)');
});

test('a camera pointed straight down still has a frame', () => {
  // The cross product that a forward×up construction would use has no length
  // here; the frame is built off the heading instead, so nadir is an ordinary
  // case rather than a hole in the domain.
  const corners = frustumCorners(p(0, 0, 100), 0, -90, FOV_90, 100);
  assert.ok(corners, 'nadir is a shot, not an error');
  for (const c of corners) {
    near(c.uM, 0, 'every corner lands on the ground 100 m below');
    assert.ok(Number.isFinite(c.eM) && Number.isFinite(c.nM), 'and nowhere near NaN');
  }
  // 100 m down with 45° half-angles either way: the footprint is 200 m square.
  near(Math.abs(corners[0].eM), 100, 'half-width');
  near(Math.abs(corners[0].nM), 100, 'half-height, projected onto the ground');
});

test('the axis and the corner distances are what an orthonormal frame gives', () => {
  const fov = { hDeg: 60, vDeg: 40 };
  const range = 250;
  const corners = frustumCorners(p(5, -5, 20), 123.4, -17.5, fov, range);
  assert.ok(corners);
  // The four corners average to the axis point (they are symmetric about it),
  // and each sits at range·√(1 + tan²(h/2) + tan²(v/2)) from the camera — both
  // identities hold only if the right/up axes are orthonormal and perpendicular
  // to the view direction.
  const tanH = Math.tan(fov.hDeg * Math.PI / 360);
  const tanV = Math.tan(fov.vDeg * Math.PI / 360);
  const expectDist = range * Math.sqrt(1 + tanH * tanH + tanV * tanV);
  let sumE = 0, sumN = 0, sumU = 0;
  for (const c of corners) {
    near(Math.hypot(c.eM - 5, c.nM + 5, c.uM - 20), expectDist, 'corner distance');
    sumE += c.eM; sumN += c.nM; sumU += c.uM;
  }
  const h = 123.4 * Math.PI / 180, pt = -17.5 * Math.PI / 180;
  near(sumE / 4, 5 + range * Math.sin(h) * Math.cos(pt), 'centroid.eM is the axis point');
  near(sumN / 4, -5 + range * Math.cos(h) * Math.cos(pt), 'centroid.nM is the axis point');
  near(sumU / 4, 20 + range * Math.sin(pt), 'centroid.uM is the axis point');
});

test('frustumCorners answers null for every unusable input', () => {
  const at = p(0, 0, 0);
  assert.equal(frustumCorners(at, 0, 0, FOV_90, 0), null, 'a zero range has no base');
  assert.equal(frustumCorners(at, 0, 0, FOV_90, -10), null, 'nor a negative one');
  assert.equal(frustumCorners(at, 0, 0, FOV_90, NaN), null);
  assert.equal(frustumCorners(at, 0, 0, FOV_90, null), null);
  assert.equal(frustumCorners(at, 0, 0, { hDeg: 180, vDeg: 90 }, 100), null, 'a straight line is not a frame');
  assert.equal(frustumCorners(at, 0, 0, { hDeg: 90, vDeg: 180 }, 100), null);
  assert.equal(frustumCorners(at, 0, 0, { hDeg: 200, vDeg: 90 }, 100), null);
  assert.equal(frustumCorners(at, 0, 0, { hDeg: 0, vDeg: 90 }, 100), null, 'nor is nothing');
  assert.equal(frustumCorners(at, 0, 0, { hDeg: 90, vDeg: -10 }, 100), null);
  assert.equal(frustumCorners(at, 0, 0, { hDeg: NaN, vDeg: 90 }, 100), null);
  assert.equal(frustumCorners(at, 0, 0, null, 100), null, 'no camera profile, no frame');
  assert.equal(frustumCorners(at, NaN, 0, FOV_90, 100), null, 'an unresolved heading');
  assert.equal(frustumCorners(at, 0, Infinity, FOV_90, 100), null);
  assert.equal(frustumCorners(null, 0, 0, FOV_90, 100), null, 'an unresolved position');
  assert.equal(frustumCorners(p(NaN, 0, 0), 0, 0, FOV_90, 100), null);
  assert.equal(frustumCorners(p(0, 0, Infinity), 0, 0, FOV_90, 100), null);
});

test('headings outside [0, 360) are still headings', () => {
  const wrapped = frustumCorners(p(0, 0, 0), 360, 0, FOV_90, 100);
  const negative = frustumCorners(p(0, 0, 0), -270, 0, FOV_90, 100);
  const plain = frustumCorners(p(0, 0, 0), 0, 0, FOV_90, 100);
  const east = frustumCorners(p(0, 0, 0), 90, 0, FOV_90, 100);
  assert.ok(wrapped && negative && plain && east);
  near(wrapped[0].eM, plain[0].eM, '360° is 0°');
  near(wrapped[0].nM, plain[0].nM, '360° is 0°');
  near(negative[0].eM, east[0].eM, '−270° is 090°');
  near(negative[0].nM, east[0].nM, '−270° is 090°');
});

/* ---------------- orbitAirspeedMs ---------------- */

test('an orbit costs its tangential speed plus the whole wind, on the worst quarter', () => {
  assert.equal(orbitAirspeedMs(10, 5), 15);
  assert.equal(orbitAirspeedMs(10, 0), 10, 'calm air is the tangential speed and nothing else');
  assert.equal(orbitAirspeedMs(0, 7), 7, 'a stationary circle still has to hold against the wind');
  assert.equal(orbitAirspeedMs(0, 0), 0);
});

test('the orbit figure is a bound, so it never reads below either input', () => {
  for (const t of [0, 3.5, 18]) {
    for (const w of [0, 2.5, 11]) {
      const v = orbitAirspeedMs(t, w);
      assert.ok(v !== null && v >= t && v >= w, `${t} + ${w} bounds both`);
    }
  }
});

test('orbitAirspeedMs answers null for negative or non-finite inputs', () => {
  assert.equal(orbitAirspeedMs(-1, 5), null, 'a negative tangential speed is a caller error');
  assert.equal(orbitAirspeedMs(10, -5), null, 'and so is a negative wind — the wind here is a magnitude');
  assert.equal(orbitAirspeedMs(NaN, 5), null);
  assert.equal(orbitAirspeedMs(10, NaN), null);
  assert.equal(orbitAirspeedMs(Infinity, 5), null);
  assert.equal(orbitAirspeedMs(10, Infinity), null);
  assert.equal(orbitAirspeedMs(null, 5), null, 'an unresolved orbit radius upstream');
  assert.equal(orbitAirspeedMs(10, undefined), null, 'no wind forecast yet');
});

/* ---------------- subjectFraming ---------------- */

test('a subject subtending half the horizontal field frames at 0.5', () => {
  // Half of a 90° field is 45°, so the half-angle is 22.5° and the distance is
  // r/tan(22.5°) = r·(1 + √2) = 2.41421356… radii.
  const framing = subjectFraming(1 + SQRT2, 1, { hDeg: 90, vDeg: 60 });
  near(framing, 0.5, 'framing');
});

test('framing scales with the field of view it is measured against', () => {
  // The same 45° subject against a 60° field is three quarters of the frame.
  near(subjectFraming(1 + SQRT2, 1, { hDeg: 60, vDeg: 40 }), 0.75, 'framing');
  // …and against 45° exactly, the frame is full.
  near(subjectFraming(1 + SQRT2, 1, { hDeg: 45, vDeg: 30 }), 1, 'framing');
});

test('a subject at its own radius or closer fills the frame', () => {
  assert.equal(subjectFraming(10, 10, { hDeg: 90, vDeg: 60 }), 1, 'exactly touching');
  assert.equal(subjectFraming(2, 10, { hDeg: 90, vDeg: 60 }), 1, 'the camera is inside the subject');
  assert.equal(subjectFraming(0.001, 10, { hDeg: 1, vDeg: 1 }), 1, 'still 1, never an arctangent of nonsense');
});

test('framing clamps at 1 and never exceeds it', () => {
  // 2·atan(1/2) = 53.13° of angular diameter against a 10° lens would be 5.3.
  assert.equal(subjectFraming(2, 1, { hDeg: 10, vDeg: 8 }), 1, 'clamped');
  for (const d of [1.0001, 1.5, 3, 50, 5000]) {
    const f = subjectFraming(d, 1, { hDeg: 20, vDeg: 15 });
    assert.ok(f !== null && f > 0 && f <= 1, `${d} m → ${f} stays inside 0..1`);
  }
});

test('framing shrinks monotonically with distance', () => {
  let previous = 1;
  for (const d of [2, 4, 8, 16, 32, 64]) {
    const f = subjectFraming(d, 1, { hDeg: 73.73979529168804, vDeg: 53.13010235415597 });
    assert.ok(f !== null && f < previous, `${d} m frames smaller than the step before`);
    previous = f;
  }
  // Far enough out the small-angle form applies: at 1000 radii the angular
  // diameter is 2/1000 rad = 0.11459…°, and against a 73.7398° field that is
  // 0.0015540… of the frame.
  near(subjectFraming(1000, 1, { hDeg: 73.73979529168804, vDeg: 53.13010235415597 }),
    0.001554029, 'the small-angle limit');
});

test('framing composes with fovDeg without a null check in between', () => {
  const fov = fovDeg({ sensorWidthMm: 36, sensorHeightMm: 24, focalLengthMm: 24 });
  const framing = subjectFraming(100, 10, fov);
  // 2·atan(0.1) = 11.42118627…°, against 73.73979529…° → 0.15488…
  near(framing, 11.421186274486338 / 73.73979529168804, 'framing');
});

test('subjectFraming answers null for every unusable input', () => {
  const fov = { hDeg: 90, vDeg: 60 };
  assert.equal(subjectFraming(0, 1, fov), null, 'a zero distance is not a viewpoint');
  assert.equal(subjectFraming(-10, 1, fov), null);
  assert.equal(subjectFraming(NaN, 1, fov), null);
  assert.equal(subjectFraming(Infinity, 1, fov), null);
  assert.equal(subjectFraming(null, 1, fov), null, 'an unresolved distance');
  assert.equal(subjectFraming(100, 0, fov), null, 'a subject with no size to frame');
  assert.equal(subjectFraming(100, -1, fov), null);
  assert.equal(subjectFraming(100, NaN, fov), null);
  assert.equal(subjectFraming(100, null, fov), null, 'radiusM is nullable in the schema');
  assert.equal(subjectFraming(100, 1, null), null, 'no camera profile');
  assert.equal(subjectFraming(100, 1, undefined), null);
  assert.equal(subjectFraming(100, 1, { hDeg: 0, vDeg: 60 }), null);
  assert.equal(subjectFraming(100, 1, { hDeg: 180, vDeg: 60 }), null);
  assert.equal(subjectFraming(100, 1, { hDeg: NaN, vDeg: 60 }), null);
});

/* ---------------- everything that comes back is frozen ---------------- */

test('every returned object is frozen', () => {
  const fov = fovDeg({ sensorWidthMm: 36, sensorHeightMm: 24, focalLengthMm: 24 });
  assert.ok(fov);
  assert.ok(Object.isFrozen(fov), 'fovDeg');

  const shot = shotGeometry({ start: p(0, -100, 0), end: p(0, 100, 0), subject: p(50, 0, 0) });
  assert.ok(shot);
  assert.ok(Object.isFrozen(shot), 'shotGeometry');

  const corners = frustumCorners(p(0, 0, 0), 0, 0, fov, 100);
  assert.ok(corners);
  assert.ok(Object.isFrozen(corners), 'frustumCorners array');
  for (const c of corners) assert.ok(Object.isFrozen(c), 'each corner point');
});
