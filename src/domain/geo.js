// geo.js — spherical earth geometry, extracted from map.js so the modules that
// need coordinates without a map (terrain profiles, the saved-spot roster) don't
// have to import Leaflet to get them. Pure, node-testable, no dependencies.

const EARTH_R_KM = 6371;

/**
 * A geographic point in the shape Leaflet hands back and the app passes around.
 *
 * @typedef {{ lat: number, lng: number }} LatLng
 */

/**
 * Longitude folded back into (−180, 180].
 *
 * @param {number} lng
 * @returns {number}
 */
export function wrapLng(lng) {
  return ((lng % 360) + 540) % 360 - 180;
}

/**
 * Great-circle distance between two { lat, lng } points, in km.
 *
 * @param {LatLng} a
 * @param {LatLng} b
 * @returns {number}
 */
export function distanceKm(a, b) {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Destination point from { lat, lng } along a bearing, in km. Returns
 * `[lat, lng]` — the tuple Leaflet's polygon/marker constructors take, which is
 * why it is not an object.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {number} bearingDeg
 * @param {number} distKm
 * @returns {[number, number]}
 */
export function destination(lat, lng, bearingDeg, distKm) {
  const br = bearingDeg * Math.PI / 180;
  const d = distKm / EARTH_R_KM;
  const la1 = lat * Math.PI / 180, lo1 = lng * Math.PI / 180;
  const sinLa2 = Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br);
  const la2 = Math.asin(sinLa2);
  const lo2 = lo1 + Math.atan2(
    Math.sin(br) * Math.sin(d) * Math.cos(la1),
    Math.cos(d) - Math.sin(la1) * sinLa2,
  );
  return [la2 * 180 / Math.PI, wrapLng(lo2 * 180 / Math.PI)];
}

/**
 * Bearing folded into [0, 360).
 *
 * @param {number} deg
 * @returns {number}
 */
export function wrapBearing(deg) {
  return ((deg % 360) + 360) % 360;
}

/**
 * Initial great-circle bearing from one { lat, lng } to another, in degrees —
 * the exact inverse of `destination()`, so a point placed on a course comes back
 * reading that course. Route legs need it: the pilot drops a waypoint and the
 * wind decomposition wants the heading they just drew.
 *
 * "Initial" is the honest word — a great circle's bearing turns as you fly it,
 * and the reverse leg is not the forward bearing plus 180°. Over the few
 * kilometres a battery buys, the meridian convergence is a few hundredths of a
 * degree, far under the wind forecast's own resolution. Two identical points
 * have no bearing at all; 0 comes back, which costs nothing on a zero-length leg.
 *
 * @param {LatLng} a
 * @param {LatLng} b
 * @returns {number}
 */
export function bearingTo(a, b) {
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return wrapBearing(Math.atan2(y, x) * 180 / Math.PI);
}

/**
 * Smallest absolute angle between two bearings, in degrees (0…180) — how far a
 * cached profile's bearing is from the one the plan now wants.
 *
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function bearingDelta(a, b) {
  const d = Math.abs(wrapBearing(a) - wrapBearing(b));
  return d > 180 ? 360 - d : d;
}

/**
 * Where a point falls relative to the great circle from `from` to `to`:
 * `alongKm` is its projection onto that course (negative behind the start), and
 * `crossKm` is how far off the course it lies, signed positive to the right of
 * the direction of travel.
 *
 * The radio needs this. A sightline from the pilot to the aircraft runs straight
 * from one to the other, and the only ground this app has sampled is the ground
 * under the *route* — which on a dogleg is somewhere else entirely. Projecting
 * each sampled point onto the sightline is what says whether it is genuinely in
 * the way or merely somewhere near, and `crossKm` is the number that decides.
 *
 * Standard spherical cross-track/along-track, exact for the sphere geo.js
 * already models. `from` and `to` at the same place have no course, so both
 * figures come back 0 — there is no sightline to be off.
 *
 * @param {LatLng} from
 * @param {LatLng} to
 * @param {LatLng} point
 * @returns {{ alongKm: number, crossKm: number }}
 */
export function trackOffsetKm(from, to, point) {
  const legKm = distanceKm(from, to);
  if (!(legKm > 0)) return { alongKm: 0, crossKm: 0 };
  const d13 = distanceKm(from, point) / EARTH_R_KM;
  if (!(d13 > 0)) return { alongKm: 0, crossKm: 0 };
  const t13 = bearingTo(from, point) * Math.PI / 180;
  const t12 = bearingTo(from, to) * Math.PI / 180;
  const xt = Math.asin(Math.max(-1, Math.min(1, Math.sin(d13) * Math.sin(t13 - t12))));
  const at = Math.acos(Math.max(-1, Math.min(1, Math.cos(d13) / Math.cos(xt))));
  // acos loses the sign, and a point behind the start is not on this leg at all.
  const turn = Math.abs(((t13 - t12 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
  return { alongKm: (turn > Math.PI / 2 ? -1 : 1) * at * EARTH_R_KM, crossKm: xt * EARTH_R_KM };
}
