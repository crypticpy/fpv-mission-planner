// rf.js — radio line of sight over the terrain profile (Phase 4 item 6).
//
// The footprint ring is an energy answer: how far out the pack can push and still
// bring the aircraft home. It says nothing about whether the pilot can still see
// through the goggles or steer once they get there, and over any ground with a
// shape to it the link quits first. This module reads the same profile terrain.js
// already fetched and answers the other question: how far out does the radio hold?
//
// Two thresholds, because they fail differently:
//   • line of sight — the terrain is literally in the way. Video is gone.
//   • first Fresnel zone — the ray still passes over the ridge, but the beam's
//     inner lobe is clipped by it. The industry rule of thumb is that a link
//     degrades once an obstruction eats past ~40% of the first Fresnel radius,
//     i.e. once less than 60% of it is clear. That is where the picture starts
//     breaking up, well before the ridge cuts the ray.
//
// Everything here is pure and node-testable: no DOM, no state, no fetching. The
// render module reads it against the plan on screen, the same way it reads
// terrainStats().

import { elevAtKm } from './terrain.js';

/**
 * The bands this planner knows about. The user's own kit is the reason for all
 * three: a DJI O4 Pro air unit hops between 5.8 and 2.4 GHz on its own, and ELRS
 * control in the US sits at 915 MHz.
 *
 * Note which way the physics runs: the first Fresnel radius goes as √λ, so the
 * LOWER band has the FATTER zone and needs more clearance over the same ridge.
 * 900 MHz is therefore the geometrically demanding case and will flag first —
 * which is not the same as saying the control link fails first. A 915 MHz link
 * has both the diffraction behaviour and the link budget to keep working through
 * an intrusion that has already killed the video. That asymmetry is the honest
 * distinction the card and the warnings have to make out loud, because a pilot
 * who reads "900 MHz blocked at 1.2 km" as "I lose the sticks at 1.2 km" has been
 * misled by a geometry-only model.
 */
export const LINK_BANDS = [
  { id: '5g8', ghz: 5.8, label: '5.8 GHz', use: 'O4/O3 video, high band' },
  { id: '2g4', ghz: 2.4, label: '2.4 GHz', use: 'O4 video fallback, 2.4 control' },
  { id: '900', ghz: 0.915, label: '900 MHz', use: 'ELRS control, US 915 MHz' },
];

/**
 * 5.8 GHz: the band the O4 starts on and the one carrying the video the pilot is
 * flying by. Not the most conservative choice of the three — see LINK_BANDS — and
 * the card says so and quotes the other two beside it, rather than quietly
 * planning a band the pilot did not pick.
 */
export const LINK_BAND_DEFAULT = '5g8';

export const isLinkBand = (id) => LINK_BANDS.some(b => b.id === id);

export function linkBand(id) {
  return LINK_BANDS.find(b => b.id === id) || LINK_BANDS.find(b => b.id === LINK_BAND_DEFAULT);
}

/**
 * How high the pilot's antenna is above the ground they are standing on, in
 * metres. A goggle antenna at head height, standing, and a control transmitter
 * held in front of the chest — call the pair 1.5 m and be done. Deliberately a
 * constant and not another control: the number moves the blockage distance by
 * metres over a ridge that moves it by hundreds, and the tool does not need
 * another knob to be wrong about.
 */
export const ANTENNA_HEIGHT_M = 1.5;

/** The share of the first Fresnel radius that has to stay clear for a good link. */
export const FRESNEL_CLEAR_FRAC = 0.6;

const C_MS = 299792458;

/** Wavelength in metres for a frequency in GHz. */
export const wavelengthM = (ghz) => C_MS / (ghz * 1e9);

/**
 * First Fresnel zone radius at a point d1 from one end and d2 from the other, all
 * in metres: r = √(λ·d1·d2 / d). Everything is SI here so the dimensions check by
 * inspection — the familiar field form r = 8.657·√(d_km / f_GHz) is this same
 * expression evaluated at the midpoint, and the tests pin the two together.
 */
export function fresnelRadiusM(d1M, d2M, ghz) {
  const d = d1M + d2M;
  if (!(d > 0) || !(ghz > 0) || d1M < 0 || d2M < 0) return 0;
  return Math.sqrt(wavelengthM(ghz) * d1M * d2M / d);
}

/**
 * How much the earth's own curve lifts the ground between two points, in metres,
 * on the 4/3-radius effective earth that accounts for standard atmospheric
 * refraction bending the beam back down. Half a metre over 5 km — never the
 * headline, but it is two lines of arithmetic and it always signs the same way
 * (against the pilot), so there is no reason to leave it out.
 */
const EARTH_R_EFF_M = (4 / 3) * 6371000;
export const earthBulgeM = (d1M, d2M) => d1M * d2M / (2 * EARTH_R_EFF_M);

/**
 * The obstruction list for a leg: the profile's own samples inside it, and only
 * the ones on ground higher than the pilot is standing on. The DEM's spacing is
 * the resolution of any claim made here, and interpolating between two samples
 * cannot invent a ridge that isn't in the data.
 *
 * That second filter is the difference between a useful warning and a permanent
 * one. A Fresnel zone grows as √d1 while the ray from a 1.5 m antenna climbs
 * linearly, so within the first few hundred metres of the pilot the zone always
 * touches the ground — on a runway, on a lake, on anything. Worse, how badly
 * depends on how finely the DEM happens to be sampled near the launch point,
 * which is not a property of the flight. Grazing over open ground level with the
 * pilot's feet is a ground-reflection problem, not a blockage, and this tool does
 * not claim on it; ground that rises above the launch point is terrain in the way,
 * which is exactly what the feature is for. Line of sight is unaffected either
 * way: the ray runs from 1.5 m above the launch ground to a cruise altitude above
 * it, so nothing at or below the launch elevation can cut it.
 */
function obstaclesIn(profile, legKm) {
  return profile.points.filter(p =>
    p.distKm > 0 && p.distKm < legKm && p.elevM > profile.launchElevM);
}

/**
 * Worst margin along the ray to an aircraft at horizontal distance `x`: the
 * smallest (clearance − frac·r1) over every obstruction between the pilot and it.
 * Positive means the link holds by that many metres at the tightest point.
 */
function rayMargin(obstacles, x, ctx, frac) {
  let worstM = Infinity;
  let atKm = null;
  for (const o of obstacles) {
    if (!(o.distKm < x)) continue; // an obstruction past the aircraft is behind it
    const d1 = o.distKm * 1000;
    const d2 = (x - o.distKm) * 1000;
    const losM = ctx.txElevM + (ctx.planAltM - ctx.txElevM) * (o.distKm / x);
    const needM = frac * fresnelRadiusM(d1, d2, ctx.ghz);
    const m = losM - (o.elevM + earthBulgeM(d1, d2)) - needM;
    if (m < worstM) { worstM = m; atKm = o.distKm; }
  }
  return { m: worstM, atKm };
}

/**
 * How far out the aircraft gets before this criterion fails, or null if it holds
 * the whole leg.
 *
 * The scan is a scan and not a search because the margin is monotonic in `x`: the
 * aircraft holds one altitude, so pushing it further out only lowers the ray over
 * every ridge behind it, widens the Fresnel zone at each of them, and brings new
 * ridges into play. Once the link breaks it stays broken. So: walk the sample
 * distances until one fails, then bisect the interval it failed in — the answer
 * has to move continuously when the pilot changes bands, not jump a sample at a
 * time.
 */
function breakKm(obstacles, ctx, frac) {
  const stops = [...obstacles.map(o => o.distKm), ctx.legKm];
  let lastClear = 0;
  for (const x of stops) {
    if (!(x > 0)) continue;
    if (rayMargin(obstacles, x, ctx, frac).m >= 0) { lastClear = x; continue; }
    let lo = lastClear, hi = x;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (rayMargin(obstacles, mid, ctx, frac).m >= 0) lo = mid; else hi = mid;
    }
    return { km: hi, ridgeKm: rayMargin(obstacles, hi, ctx, frac).atKm };
  }
  return null;
}

function context(profile, { cruiseAltM, radiusKm, ghz, antennaM = ANTENNA_HEIGHT_M }) {
  const legKm = Number.isFinite(radiusKm) && radiusKm > 0
    ? Math.min(radiusKm, profile.spanKm)
    : profile.spanKm;
  return {
    legKm,
    ghz,
    antennaM,
    launchElevM: profile.launchElevM,
    // The pilot's antenna stands on the launch ground; the aircraft holds a
    // constant altitude above sea level, which is what an OSD altitude counting up
    // from the launch point actually means (see terrainStats()).
    txElevM: profile.launchElevM + antennaM,
    planAltM: profile.launchElevM + cruiseAltM,
    cruiseAltM,
  };
}

/**
 * The link read against one plan, on the bearing the profile describes. Pure.
 *
 * `ray` is the geometry drawn on the chart: the line of sight to the aircraft at
 * the *planned* turnaround, with the Fresnel floor under it — the highest the
 * ground may be at each point and still leave the link a clear zone. `losBlockKm`
 * and `fresnelBlockKm` are the scan: how far out the aircraft gets before the
 * ridge cuts the ray, and before it eats into the zone.
 */
export function linkProfile(profile, opts) {
  if (!profile || !Array.isArray(profile.points) || profile.points.length < 2) return null;
  if (!(opts.ghz > 0)) return null;
  const ctx = context(profile, opts);
  if (!(ctx.legKm > 0)) return null;
  const obstacles = obstaclesIn(profile, ctx.legKm);

  const legM = ctx.legKm * 1000;
  const ray = [...profile.points.filter(p => p.distKm <= ctx.legKm + 1e-9), { distKm: ctx.legKm, elevM: elevAtKm(profile, ctx.legKm) }]
    // The interpolated turnaround point is a duplicate whenever the leg lands on a
    // sample; drop it rather than draw the chart's last segment twice.
    .filter((p, i, all) => i === 0 || p.distKm - all[i - 1].distKm > 1e-9)
    .map(p => {
      const d1 = p.distKm * 1000;
      const d2 = Math.max(0, legM - d1);
      const losM = ctx.txElevM + (ctx.planAltM - ctx.txElevM) * (legM > 0 ? d1 / legM : 0);
      const r1M = fresnelRadiusM(d1, d2, ctx.ghz);
      const bulgeM = earthBulgeM(d1, d2);
      const clearanceM = losM - (p.elevM + bulgeM);
      return {
        distKm: p.distKm,
        elevM: p.elevM,
        losM,
        r1M,
        bulgeM,
        clearanceM,
        // The highest the ground may be here and still leave the zone clear — the
        // line the chart draws, directly comparable to the ground line beside it.
        floorM: losM - FRESNEL_CLEAR_FRAC * r1M - bulgeM,
        // What fraction of the first Fresnel radius is clear. Null at the two ends,
        // where the zone pinches to nothing and the ratio means nothing.
        frac: r1M > 0 ? clearanceM / r1M : null,
      };
    });

  // The tightest point, over the same obstructions the scan counts — quoting a
  // ratio the verdict has already declined to act on would be two answers.
  const counted = new Set(obstacles.map(o => o.distKm));
  let worstFrac = null, worstAtKm = null;
  for (const s of ray) {
    if (s.frac == null || !counted.has(s.distKm)) continue;
    if (worstFrac == null || s.frac < worstFrac) { worstFrac = s.frac; worstAtKm = s.distKm; }
  }

  const los = breakKm(obstacles, ctx, 0);
  const fresnel = breakKm(obstacles, ctx, FRESNEL_CLEAR_FRAC);
  return {
    legKm: ctx.legKm,
    ghz: ctx.ghz,
    antennaM: ctx.antennaM,
    txElevM: ctx.txElevM,
    planAltM: ctx.planAltM,
    launchElevM: ctx.launchElevM,
    cruiseAltM: ctx.cruiseAltM,
    ray,
    worstFrac,
    worstAtKm,
    losBlockKm: los ? los.km : null,
    losRidgeKm: los ? los.ridgeKm : null,
    fresnelBlockKm: fresnel ? fresnel.km : null,
    fresnelRidgeKm: fresnel ? fresnel.ridgeKm : null,
    // How far the link is worth trusting: where the zone first closes up, or the
    // whole leg when it never does.
    clearKm: fresnel ? fresnel.km : ctx.legKm,
    blocked: !!fresnel,
  };
}

/**
 * The same scan for every band, for the one sentence that has to be said out loud:
 * the video and the control link do not quit in the same place. Cheap — a few
 * hundred multiplications over the profile already in hand — and it is the only
 * way the card can be honest about a band the pilot did not select.
 */
export function bandReaches(profile, opts) {
  return LINK_BANDS.map(b => {
    const l = linkProfile(profile, { ...opts, ghz: b.ghz });
    return {
      ...b,
      clearKm: l ? l.clearKm : null,
      blocked: l ? l.blocked : false,
      losBlockKm: l ? l.losBlockKm : null,
    };
  });
}
