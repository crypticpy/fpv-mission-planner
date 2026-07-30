// windprofile.js — the wind at more than one height (Phase 4 item 9).
//
// Open-Meteo returns wind at 10, 80, 120 and 180 m in the same forecast call the
// app already makes; until now the planner read one of them (80 m) and threw the
// rest away. This module owns three things:
//
//   the levels the pilot may choose between, and the default (80 m — what every
//     plan before this feature existed flew, so choosing nothing changes nothing);
//   the shaped per-level wind from the last fetch, latched here rather than in
//     `state` because it is fetched data, not a control setting, and has no
//     business in the session blob;
//   the pure "which number does this level mean" helpers the rail label, the
//     hourly scrubber and the live patch all need.
//
// Leaf module: no imports, no DOM, no fetch. weather.js builds the levels shape
// from the API response; this decides what to do with it.

/** The heights Open-Meteo publishes wind at, in m AGL, low to high. */
export const CRUISE_ALTS_M = [10, 80, 120, 180];

/**
 * The level the planner has always flown. Every pinned number in the test suite
 * is an 80 m number, and beginner mode pins the control here, so the default has
 * to stay 80 for "changed nothing" to keep meaning what it says.
 */
export const CRUISE_ALT_DEFAULT_M = 80;

export const isCruiseAlt = (m) => CRUISE_ALTS_M.includes(m);

/** "80 m" — the label that says which level a wind figure came off. */
export const levelLabel = (m) => `${m} m`;

/* ---------- the pure level lookup ---------- */

/**
 * The wind at one level out of a levels shape, or null when that level has no
 * usable reading. Validated here as well as at the fetch boundary, because a
 * cached payload from an older deploy can be missing levels this version asks
 * for.
 */
export function windAtLevel(levels, altM) {
  const lvl = levels && levels[altM];
  if (!lvl || !Number.isFinite(lvl.windMph) || !Number.isFinite(lvl.windFromDeg)) return null;
  return { windMph: lvl.windMph, windFromDeg: lvl.windFromDeg };
}

/**
 * The env patch for planning on one level: that level's speed and direction,
 * with the gust re-floored onto it.
 *
 * The gust floor matters more here than it looks. Open-Meteo only publishes
 * gusts at 10 m, and the app's rule has always been "never report a gust below
 * the sustained wind it rides on" — a rule that has to be re-applied per level,
 * or planning the 180 m wind would produce a gust *below* the average.
 *
 * Returns null when the level has no reading, which leaves the caller on
 * whatever wind it already had.
 */
export function levelWindPatch(levels, altM, gust10Mph) {
  const lvl = windAtLevel(levels, altM);
  if (!lvl) return null;
  const g = Number.isFinite(gust10Mph) ? gust10Mph : 0;
  return { ...lvl, gustMph: Math.round(Math.max(g, lvl.windMph)) };
}

/* ---------- the latched levels from the last fetch ---------- */

let levels = null;     // { 10: { windMph, windFromDeg }, 80: …} from the last fetch
let gust10Mph = null;  // that fetch's 10 m gust, the floor every level re-uses

/** Hand over a fresh fetch's wind profile. Null clears it (a failed refetch). */
export function setWindLevels(next, gust) {
  levels = next && typeof next === 'object' ? next : null;
  gust10Mph = Number.isFinite(gust) ? gust : null;
}

export function windLevels() { return levels; }

/** The active profile's wind at one level, or null — see windAtLevel. */
export function activeWindAt(altM) { return windAtLevel(levels, altM); }

/** The active profile's env patch for one level, or null — see levelWindPatch. */
export function activeLevelPatch(altM) { return levelWindPatch(levels, altM, gust10Mph); }

/**
 * What the pilot stands in for the launch and the landing, in mph, and whether
 * anyone measured it.
 *
 * The 10 m wind is the one number in the profile that is not about cruise: it is
 * the air the aircraft climbs out through and comes back down into, and it stays
 * on screen whichever level the plan flies. With a live profile it is a real
 * reading; without one it falls back to the rule of thumb the app has always
 * printed (roughly half the wind aloft), labeled as one.
 */
export function launchWind(planningMph) {
  const surface = windAtLevel(levels, 10);
  return surface
    ? { mph: surface.windMph, measured: true }
    : { mph: planningMph / 2, measured: false };
}
