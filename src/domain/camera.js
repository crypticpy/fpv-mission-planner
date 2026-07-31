// camera.js — camera geometry (ADR 0011 §1): field of view, the shot a leg
// makes of a subject, the view pyramid, and the two scalars an orbit and a
// framing need. Pure trigonometry, imports nothing.
//
// Positions are local east/north/up displacements in metres — this module never
// sees a latitude. Callers resolve geography through domain/geo.js and hand it a
// flat frame, which is what lets every function here be exact rather than
// spherical-approximate at the scale a shot is composed on.
//
// Degrees at the boundary (the vocabulary the schema, the UI and the exports
// already speak), radians only inside a body. Headings are compass-style —
// 0 = north = +n, 90 = east = +e — matching domain/geo.js's bearingTo(), so a
// bearing computed there can be handed straight to frustumCorners() here.
//
// Nothing throws and nothing returns NaN. Every entry point screens its inputs
// and answers null — the whole record, or the one field that is genuinely
// unresolvable — so the only branch a bad input can reach in a caller is the
// null branch it already has to write (ADR 0003).

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/** A local east/north/up displacement in metres. @typedef {{ eM: number, nM: number, uM: number }} Point3 */

/** Horizontal and vertical field of view in degrees. @typedef {{ hDeg: number, vDeg: number }} Fov */

/**
 * The view pyramid's base, corner-ordered top-left, top-right, bottom-right,
 * bottom-left as seen from behind the camera.
 * @typedef {readonly [Point3, Point3, Point3, Point3]} FrustumCorners
 */

/**
 * Which way the subject sweeps the frame over a leg. See shotGeometry() for how
 * each value is decided; 'held' is the absence of a sweep, not a direction.
 * @typedef {'left-to-right'|'right-to-left'|'toward'|'away'|'held'} ScreenDirection
 */

/**
 * The lens numbers fovDeg() reads — the measurable half of `scene.cameraProfile`.
 * @typedef {object} CameraSpec
 * @property {number} sensorWidthMm
 * @property {number} sensorHeightMm
 * @property {number} focalLengthMm
 */

/**
 * One leg's shot of one subject. The two distances are slant ranges (3D), the
 * two angles are measured from the leg's midpoint, and each of the three
 * nullable fields is null exactly when the geometry does not define it.
 * @typedef {object} ShotGeometry
 * @property {number} distanceStartM slant range from the leg's start
 * @property {number} distanceEndM slant range from the leg's end
 * @property {number|null} bearingToSubjectDeg null when the subject is on the midpoint's own vertical
 * @property {number|null} elevationAngleDeg above (+) / below (−) horizontal; null when the subject is at the midpoint
 * @property {ScreenDirection|null} screenDirection null when the leg passes straight over the subject
 */

/**
 * A number this module will compute with: present, numeric and finite. Screening
 * every input through this is what makes "never NaN" a property of the module
 * rather than a habit of its authors.
 * @param {number|null|undefined} x
 * @returns {x is number}
 */
function num(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * @param {number|null|undefined} x
 * @returns {x is number}
 */
function pos(x) {
  return num(x) && x > 0;
}

/**
 * @param {Point3|null|undefined} p
 * @returns {p is Point3}
 */
function isPoint(p) {
  return !!p && num(p.eM) && num(p.nM) && num(p.uM);
}

/**
 * An angle that can subtend a frame: a pinhole camera's field of view is
 * strictly between nothing and a straight line, and tan() of its half runs to
 * infinity at the ends.
 * @param {number|null|undefined} deg
 * @returns {deg is number}
 */
function isFovAngle(deg) {
  return num(deg) && deg > 0 && deg < 180;
}

/**
 * @param {number} deg
 * @returns {number}
 */
function wrap360(deg) {
  return ((deg % 360) + 360) % 360;
}

/**
 * Half-angle of the cone around the direction of travel inside which a subject
 * reads as being flown *at* rather than past, in degrees.
 *
 * Tied to a real frame rather than picked round: an FPV lens carries roughly
 * 75–90° horizontally, so ±30° is about the middle two thirds of the picture —
 * the band a subject stays in while the shot still reads as an approach. Outside
 * it the subject is visibly drifting toward an edge, which is a pass.
 */
export const TOWARD_CONE_DEG = 30;

/**
 * The same half-angle measured off the *rear* of the travel direction — the
 * departure shot's mirror of TOWARD_CONE_DEG. A separate constant because the
 * two are free to differ: a subject falling behind is legible further off-axis
 * than one being approached, and if that ever gets tuned it is tuned here.
 */
export const AWAY_CONE_DEG = 30;

/**
 * Horizontal leg length below which a segment is station-keeping rather than
 * travel, in metres. Under a metre is inside the position error of the fix the
 * aircraft holds itself with, so the sweep such a leg implies is noise, not a
 * shot — 'held' is the honest answer for it.
 */
export const HELD_TRAVEL_M = 1;

/**
 * Field of view from the pinhole model: 2·atan(sensor / 2f), per axis.
 *
 * Takes the whole spec (rather than three arguments) because `scene.cameraProfile`
 * is nullable and arrives as one object; a null profile is a camera nobody has
 * described yet, so it answers null instead of making every caller guard.
 *
 * The result is always strictly inside (0°, 180°) for any positive spec, which is
 * exactly the range frustumCorners() and subjectFraming() accept — the two
 * compose without an intervening check.
 * @param {CameraSpec|null|undefined} spec
 * @returns {Fov|null} null when any of the three lengths is not positive-finite
 */
export function fovDeg(spec) {
  if (!spec) return null;
  const { sensorWidthMm, sensorHeightMm, focalLengthMm } = spec;
  if (!pos(sensorWidthMm) || !pos(sensorHeightMm) || !pos(focalLengthMm)) return null;
  return Object.freeze({
    hDeg: 2 * Math.atan(sensorWidthMm / (2 * focalLengthMm)) * DEG,
    vDeg: 2 * Math.atan(sensorHeightMm / (2 * focalLengthMm)) * DEG,
  });
}

/**
 * What one leg makes of one subject: how far the subject is at each end, where
 * it sits from the middle of the leg, and which way it crosses the frame.
 *
 * `start` and `end` are the leg's endpoints at their resolved altitudes and
 * `subject` the framed target; all three may be null (a segment with no subject,
 * an altitude that never resolved), and a null anywhere makes the whole record
 * null — a shot missing one of its three points is not a partially known shot.
 *
 * Both angles are taken from the leg's *midpoint* rather than either end: it is
 * the only point on the leg that describes the shot instead of one moment of it,
 * and it is where a locked gimbal would be aimed.
 *
 * ---- Which way the subject sweeps, worked through ----
 *
 * Northbound leg, subject due east of it — to the *right* of travel — framed by
 * a camera looking east at it. That is the view out the right-hand window of a
 * northbound car: the road ahead (north) is on your LEFT in that view, the road
 * behind (south) on your right, and the scenery slides front-to-back. So the
 * subject enters at frame left while it is still ahead of the aircraft, crosses
 * centre abeam, and leaves at frame right once it is behind — 'left-to-right'.
 * A subject to the left of travel is the mirror image, 'right-to-left'.
 *
 * Ahead and behind are the two cases where there is no side to cross to, and
 * they are decided by the cones above. Being inside the forward cone already
 * *is* the closing test, and not by approximation: with the subject an offset s
 * from the midpoint and the leg ±(T/2)·t̂ around it, the two end distances square
 * to |s|² ∓ T·(s·t̂) + T²/4, whose difference is 2T·(s·t̂). So the range shrinks
 * over the leg exactly when the subject's along-travel component is positive,
 * which every angle inside a sub-90° forward cone has. Same identity, mirrored,
 * for the rear cone and opening range.
 *
 * All of that is horizontal. A steep climb can grow the slant range while the
 * shot is still an approach in azimuth, and azimuth is what a screen direction
 * is about, so the two are allowed to disagree and the horizontal one wins here.
 * @param {{ start: Point3|null|undefined, end: Point3|null|undefined, subject: Point3|null|undefined }} leg
 * @returns {ShotGeometry|null} null when any of the three points is missing or non-finite
 */
export function shotGeometry({ start, end, subject }) {
  if (!isPoint(start) || !isPoint(end) || !isPoint(subject)) return null;

  const midE = (start.eM + end.eM) / 2;
  const midN = (start.nM + end.nM) / 2;
  const midU = (start.uM + end.uM) / 2;
  const sE = subject.eM - midE;
  const sN = subject.nM - midN;
  const sU = subject.uM - midU;
  const sHorizM = Math.hypot(sE, sN);

  const tE = end.eM - start.eM;
  const tN = end.nM - start.nM;
  const travelM = Math.hypot(tE, tN);

  /** @type {ScreenDirection|null} */
  let screenDirection;
  if (travelM < HELD_TRAVEL_M) {
    screenDirection = 'held';
  } else if (!(sHorizM > 0)) {
    // The leg passes straight over the subject: it crosses the frame through the
    // centre and sits on neither side of travel. There is no fifth answer for
    // that, and naming one of the four would be inventing one.
    screenDirection = null;
  } else {
    const cosOffAxis = (sE * tE + sN * tN) / (travelM * sHorizM);
    // Right of travel is the travel bearing plus 90°, i.e. (t̂.n, −t̂.e); only the
    // sign of the projection onto it is read, so the division is left out.
    const rightOfTravel = sE * tN - sN * tE;
    if (cosOffAxis >= Math.cos(TOWARD_CONE_DEG * RAD)) screenDirection = 'toward';
    else if (cosOffAxis <= -Math.cos(AWAY_CONE_DEG * RAD)) screenDirection = 'away';
    else screenDirection = rightOfTravel > 0 ? 'left-to-right' : 'right-to-left';
  }

  return Object.freeze({
    distanceStartM: Math.hypot(subject.eM - start.eM, subject.nM - start.nM, subject.uM - start.uM),
    distanceEndM: Math.hypot(subject.eM - end.eM, subject.nM - end.nM, subject.uM - end.uM),
    bearingToSubjectDeg: sHorizM > 0 ? wrap360(Math.atan2(sE, sN) * DEG) : null,
    elevationAngleDeg: sHorizM > 0 || sU !== 0 ? Math.atan2(sU, sHorizM) * DEG : null,
    screenDirection,
  });
}

/**
 * The four corners of the view pyramid's base — the rectangle the frame covers
 * at `rangeM` along the view axis.
 *
 * `headingDeg` is compass-style and `pitchDeg` is positive up, negative down.
 * Corner order is top-left, top-right, bottom-right, bottom-left as seen from
 * behind the camera, so a renderer can draw the outline by walking the array and
 * closing it.
 *
 * The camera's right axis is built from the heading alone rather than from
 * forward × up. The two agree wherever both exist, but the cross product has no
 * length for a camera pointed straight down — which is a nadir shot, not an
 * error, and the frame it sees is perfectly well defined. Roll is not modelled:
 * the frame's horizontal stays level with the ground, as a stabilized gimbal
 * holds it.
 * @param {Point3|null|undefined} position
 * @param {number|null|undefined} headingDeg
 * @param {number|null|undefined} pitchDeg
 * @param {Fov|null|undefined} fov
 * @param {number|null|undefined} rangeM
 * @returns {FrustumCorners|null} null for a missing/non-finite input, rangeM ≤ 0, or a field of view outside (0°, 180°)
 */
export function frustumCorners(position, headingDeg, pitchDeg, fov, rangeM) {
  if (!isPoint(position) || !num(headingDeg) || !num(pitchDeg) || !pos(rangeM)) return null;
  if (!fov || !isFovAngle(fov.hDeg) || !isFovAngle(fov.vDeg)) return null;

  const { eM, nM, uM } = position;
  const h = headingDeg * RAD;
  const p = pitchDeg * RAD;
  const sinH = Math.sin(h), cosH = Math.cos(h), sinP = Math.sin(p), cosP = Math.cos(p);

  const axisE = rangeM * sinH * cosP;
  const axisN = rangeM * cosH * cosP;
  const axisU = rangeM * sinP;

  const halfW = rangeM * Math.tan(fov.hDeg * RAD / 2);
  const rightE = halfW * cosH;
  const rightN = halfW * -sinH;

  const halfH = rangeM * Math.tan(fov.vDeg * RAD / 2);
  const upE = halfH * -sinH * sinP;
  const upN = halfH * -cosH * sinP;
  const upU = halfH * cosP;

  const corner = (/** @type {number} */ right, /** @type {number} */ up) => Object.freeze({
    eM: eM + axisE + right * rightE + up * upE,
    nM: nM + axisN + right * rightN + up * upN,
    uM: uM + axisU + up * upU,
  });

  return Object.freeze(/** @type {[Point3, Point3, Point3, Point3]} */ ([
    corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1),
  ]));
}

/**
 * The worst-case airspeed an orbit demands anywhere on the circle: tangential
 * speed plus the wind's own, which is what the quarter flown directly into the
 * wind costs.
 *
 * Deliberately a bound and not an average. The average around a full circle is
 * lower (the downwind quarter is cheaper by the same amount), but an aircraft
 * that cannot hold the worst quarter cannot fly the shot at all — an average
 * would quietly clear a circle that is unflyable for a quarter of its length.
 * Callers that charge energy against this figure read pessimistic for orbits in
 * wind and must say so (ADR 0011 §3).
 *
 * `windMs` is a magnitude: every direction has a worst quarter, so which way it
 * blows changes nothing here, and a negative is a caller error rather than a
 * reversed wind.
 * @param {number|null|undefined} tangentialMs
 * @param {number|null|undefined} windMs
 * @returns {number|null} null when either input is negative or non-finite
 */
export function orbitAirspeedMs(tangentialMs, windMs) {
  if (!num(tangentialMs) || !num(windMs)) return null;
  if (tangentialMs < 0 || windMs < 0) return null;
  return tangentialMs + windMs;
}

/**
 * How much of the frame's width the subject fills: its angular diameter
 * 2·atan(radius / distance) against the horizontal field of view, as a fraction
 * clamped to 1.
 *
 * A subject closer than its own radius has the camera inside it; the frame is
 * full whatever the arithmetic would say, so 1 comes back rather than the
 * arctangent of a ratio that has stopped meaning anything.
 *
 * The angular diameter is the one a sphere of that radius subtends about its
 * centre, so a wide flat subject read through its bounding radius frames larger
 * than it looks. That is the conservative direction for a framing warning.
 * @param {number|null|undefined} distanceM
 * @param {number|null|undefined} subjectRadiusM
 * @param {Fov|null|undefined} fov
 * @returns {number|null} 0..1, or null for a non-positive/non-finite distance or radius, or a field of view outside (0°, 180°)
 */
export function subjectFraming(distanceM, subjectRadiusM, fov) {
  if (!pos(distanceM) || !pos(subjectRadiusM)) return null;
  if (!fov || !isFovAngle(fov.hDeg)) return null;
  if (distanceM <= subjectRadiusM) return 1;
  const angularDeg = 2 * Math.atan(subjectRadiusM / distanceM) * DEG;
  return Math.min(1, angularDeg / fov.hDeg);
}
