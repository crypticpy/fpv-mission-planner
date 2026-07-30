// geo.js — spherical earth geometry, extracted from map.js so the modules that
// need coordinates without a map (terrain profiles, the saved-spot roster) don't
// have to import Leaflet to get them. Pure, node-testable, no dependencies.

const EARTH_R_KM = 6371;

/** Longitude folded back into (−180, 180]. */
export function wrapLng(lng) {
  return ((lng % 360) + 540) % 360 - 180;
}

/** Great-circle distance between two { lat, lng } points, in km. */
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

/** Bearing folded into [0, 360). */
export function wrapBearing(deg) {
  return ((deg % 360) + 360) % 360;
}

/**
 * Smallest absolute angle between two bearings, in degrees (0…180) — how far a
 * cached profile's bearing is from the one the plan now wants.
 */
export function bearingDelta(a, b) {
  const d = Math.abs(wrapBearing(a) - wrapBearing(b));
  return d > 180 ? 360 - d : d;
}
