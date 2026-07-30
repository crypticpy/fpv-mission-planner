// terrain.js — the ground under the outbound leg (Phase 4 item 5).
//
// The model plans at one elevation, the launch point's, and over the Hill
// Country a mission climbs: the air at the turnaround is thinner than the air the
// pilot is standing in, and a ridge between the two can be higher than the
// altitude they meant to cruise at. Open-Meteo's elevation endpoint takes
// coordinate arrays, so the whole profile along a bearing is one keyless request.
//
// What lives here: the sample geometry, that one request with its boundary
// validation, the pure profile arithmetic, and the latch holding the active
// profile for the render pass. What does not: any wording (render/terrain.js owns
// the sentences) and any change to physics.js, which stays pure — the terrain
// reaches the model as an elevation on the way in, like every other input.

import { destination, distanceKm, bearingDelta } from './geo.js';
import { U } from './physics.js';

/** How many points along the leg one request samples. */
export const PROFILE_SAMPLES = 28;

/** Sampled span, as a multiple of the planned radius — a little past the turn. */
const SPAN_FACTOR = 1.15;
const SPAN_MIN_KM = 0.5;
const SPAN_MAX_KM = 60;

/**
 * How far the elevation the plan is running can sit from the profile's own launch
 * elevation before the profile stops being a description of this plan's ground
 * (metres). A preset ("Mountain — Colorado, 10,000 ft") with the pin still in
 * Austin is the case that matters: the profile is real, the elevation is
 * hypothetical, and quietly replacing 10,000 ft with Austin's 180 m would throw
 * away the scenario the pilot asked for.
 */
const ELEV_AGREE_M = 150;

/** Clearance below this (metres) is close enough to the ground to say so. */
export const CLEARANCE_WARN_M = 30;

/**
 * The bearing the terrain profile follows: the course the dashboard's plan flies
 * out on, from the relative wind mode and the wind direction. `headOut` climbs
 * straight into the wind, `tailOut` runs with it, `cross` takes the +90° leg —
 * the same choice map.js pins its "planned" marker on, so the two views agree
 * about which direction the pilot said they were going.
 */
export function plannedCourseDeg(windFromDeg, windMode) {
  const up = ((Math.round(windFromDeg) % 360) + 360) % 360;
  if (windMode === 'tailOut') return (up + 180) % 360;
  if (windMode === 'cross') return (up + 90) % 360;
  return up; // headOut — into the wind
}

/** The span to sample for a plan of this radius, in km. */
export function profileSpanKm(radiusKm) {
  const r = Number.isFinite(radiusKm) && radiusKm > 0 ? radiusKm : 0;
  return Math.min(SPAN_MAX_KM, Math.max(SPAN_MIN_KM, r * SPAN_FACTOR));
}

/**
 * Evenly spaced sample points from the launch point along a bearing, launch point
 * included as the first one (distKm 0) so the profile carries its own reference
 * elevation rather than borrowing the rail's.
 */
export function profileCoords(launch, bearingDeg, spanKm, n = PROFILE_SAMPLES) {
  const count = Math.max(2, Math.round(n));
  const out = [];
  for (let i = 0; i < count; i++) {
    const distKm = spanKm * i / (count - 1);
    const [lat, lng] = i === 0
      ? [launch.lat, launch.lng]
      : destination(launch.lat, launch.lng, bearingDeg, distKm);
    out.push({ lat, lng, distKm });
  }
  return out;
}

/**
 * One batched elevation request for a list of sample points. Throws on network
 * trouble or a payload that isn't the array of numbers it claims to be — every
 * caller is expected to carry on without a profile, because a field tool that
 * degrades to what it did yesterday is working correctly.
 */
export async function fetchElevationProfile(coords) {
  const lat = coords.map(c => c.lat.toFixed(4)).join(',');
  const lng = coords.map(c => c.lng.toFixed(4)).join(',');
  const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const el = data && data.elevation;
  // Network input: the length has to match the points we asked about (an offset
  // profile would draw a ridge in the wrong place) and every entry has to be a
  // real number — Number.isFinite, not global isFinite, so a null stays a gap
  // instead of becoming sea level.
  if (!Array.isArray(el) || el.length !== coords.length || !el.every(v => Number.isFinite(v))) {
    throw new Error('malformed elevation response');
  }
  return el.slice();
}

/**
 * Fold sample points and their elevations into a profile record. Pure.
 * `points` is distance-ordered, which elevAtKm relies on.
 */
export function buildProfile({ launch, bearingDeg, coords, elevsM }) {
  const points = coords.map((c, i) => ({ distKm: c.distKm, elevM: elevsM[i] }));
  return {
    launch: { lat: launch.lat, lng: launch.lng },
    bearingDeg,
    spanKm: points[points.length - 1].distKm,
    launchElevM: points[0].elevM,
    points,
  };
}

/** Ground elevation at a distance along the profile, interpolated and clamped. */
export function elevAtKm(profile, km) {
  const pts = profile && profile.points;
  if (!Array.isArray(pts) || pts.length === 0) return null;
  if (!(km > pts[0].distKm)) return pts[0].elevM;
  const last = pts[pts.length - 1];
  if (km >= last.distKm) return last.elevM;
  for (let i = 1; i < pts.length; i++) {
    if (km <= pts[i].distKm) {
      const a = pts[i - 1], b = pts[i];
      const span = b.distKm - a.distKm;
      const f = span > 0 ? (km - a.distKm) / span : 0;
      return a.elevM + f * (b.elevM - a.elevM);
    }
  }
  return last.elevM;
}

/**
 * The profile read against one plan: what the ground does out to the turnaround,
 * and how much air is under the aircraft while it gets there. Pure.
 *
 * The cruise altitude is AGL *at the launch point*, because that is what an FPV
 * altitude reading is — the OSD counts up from where the props spun up, not from
 * the terrain underneath. So the plan holds a constant altitude above sea level
 * (`planAltM`) and the clearance is what the rising ground leaves of it.
 *
 * Stats stop at the turnaround: ground past the point the mission turns around at
 * is not being flown over, and letting it drive a warning would ground missions
 * over terrain the aircraft never reaches.
 */
export function terrainStats(profile, { cruiseAltM, radiusKm }) {
  if (!profile || !Array.isArray(profile.points) || profile.points.length === 0) return null;
  const legKm = Number.isFinite(radiusKm) && radiusKm > 0
    ? Math.min(radiusKm, profile.spanKm)
    : profile.spanKm;
  const launchElevM = profile.launchElevM;
  const planAltM = launchElevM + cruiseAltM;
  // Every sample inside the leg, plus the turnaround itself (interpolated when it
  // falls between two samples, so the figure the plan runs on is the one drawn).
  const inLeg = profile.points.filter(p => p.distKm <= legKm + 1e-9);
  const turnaroundElevM = elevAtKm(profile, legKm);
  const samples = [...inLeg, { distKm: legKm, elevM: turnaroundElevM }]
    .map(p => ({ ...p, clearanceM: planAltM - p.elevM }));
  let worst = samples[0];
  let highest = samples[0];
  for (const s of samples) {
    if (s.clearanceM < worst.clearanceM) worst = s;
    if (s.elevM > highest.elevM) highest = s;
  }
  return {
    legKm,
    launchElevM,
    turnaroundElevM,
    planAltM,
    cruiseAltM,
    climbM: turnaroundElevM - launchElevM,
    minClearanceM: worst.clearanceM,
    minClearanceAtKm: worst.distKm,
    maxElevM: highest.elevM,
    maxElevAtKm: highest.distKm,
    // The clearance at the turnaround is its own figure: it is where the pilot is
    // furthest from home and lowest on energy, whether or not it is the worst
    // point on the leg.
    turnClearanceM: planAltM - turnaroundElevM,
  };
}

/* ---------- the active profile ---------- */

let profile = null;  // the last successful fetch, or null
let turnKm = 0;      // the plan's turnaround distance, latched per render pass

/** Hand over a fresh profile (or null to forget the one we had). */
export function setProfile(p) {
  profile = p && Array.isArray(p.points) && p.points.length > 1 ? p : null;
}

export function activeProfile() { return profile; }

/**
 * Latch how far out the plan turns around. Called once per render, before the
 * plan that reads planElevM() is built — the turnaround elevation depends on the
 * radius and the radius depends (weakly, through air density) on the elevation,
 * so the render pass probes for a radius first and plans on the result. One pass
 * is enough: a hundred metres of elevation moves the radius by well under a
 * percent, and that percent moves the elevation by metres.
 */
export function setTurnaroundKm(km) {
  turnKm = Number.isFinite(km) && km > 0 ? km : 0;
}

export function turnaroundKm() { return turnKm; }

/**
 * The elevation the plan should run its air density at, in metres: the ground
 * under the turnaround when a profile describes this launch point, and the rail's
 * own launch elevation otherwise. The one seam between terrain data and the
 * model — missionInputs() calls this and physics.js never hears about terrain.
 */
export function planElevM(launchElevFt) {
  const launchM = U.ftToM(launchElevFt);
  if (!profile || !(turnKm > 0)) return launchM;
  // The profile has to be describing the ground the plan says it is standing on.
  if (Math.abs(profile.launchElevM - launchM) > ELEV_AGREE_M) return launchM;
  const elev = elevAtKm(profile, turnKm);
  return Number.isFinite(elev) ? elev : launchM;
}

/** True while planElevM() is answering with terrain rather than the rail figure. */
export function usingTerrainElev(launchElevFt) {
  return !!profile && turnKm > 0
    && Math.abs(profile.launchElevM - U.ftToM(launchElevFt)) <= ELEV_AGREE_M;
}

/**
 * Whether a cached profile still answers the question being asked: same launch
 * point, same bearing, and a span that still covers the leg. Anything else is a
 * refetch — a profile drawn on the wrong bearing is worse than none.
 */
export function profileMatches(p, { launch, bearingDeg, spanKm }) {
  if (!p) return false;
  if (distanceKm(p.launch, launch) > 0.05) return false;
  if (bearingDelta(p.bearingDeg, bearingDeg) > 5) return false;
  // Short is a problem (the leg runs off the end of the data); long is not.
  return p.spanKm >= spanKm * 0.85;
}
