// elevation-cache.js — the ground does not move, so ask once.
//
// A pilot dragging the cruise-altitude slider re-analyses the same corridor a
// dozen times a second, and the mission's own edits move a handful of samples
// while leaving the rest exactly where they were. Every one of those points has
// the same answer it had a second ago: elevation is the one input in this app
// that is genuinely static. Caching it is what makes a route-wide sample set
// affordable at all.
//
// Three decisions worth stating:
//
//   *Keys are quantised, not exact.* elevationKey() rounds to four decimals,
//     the same precision the request itself carries, so two points a metre apart
//     are one cache entry — which is the intent, since the DEM behind them is
//     tens of metres coarse.
//
//   *Nulls are not cached.* A point the provider could not answer is asked
//     again next time. A missing tile is usually permanent and re-asking costs a
//     little; a rate-limited or half-failed batch is temporary, and caching its
//     nulls would freeze a transient hole into the session. The cheap mistake is
//     the one to make.
//
//   *Bounded, least-recently-used.* An unbounded map of every point a long
//     session ever looked at is a leak with a polite name. 4096 entries is about
//     thirty full corridors — enough that re-analysis is free, small enough that
//     the whole thing is a few hundred kilobytes.
//
// No module state: the host constructs one of these and owns it, so tests get a
// fresh cache per case and a second mission cannot inherit the first's answers.

import { elevationKey } from './terrain-contracts.js';

/** @typedef {import('./terrain-contracts.js').ElevationPoint} ElevationPoint */

/** About thirty corridors of ground. */
export const DEFAULT_CACHE_LIMIT = 4096;

/**
 * @typedef {object} ElevationCache
 * @property {(point: ElevationPoint) => number|null} get  the elevation, or null
 *   when this point has not been answered
 * @property {(point: ElevationPoint, elevationM: number) => void} set  ignores
 *   anything that is not a finite number
 * @property {() => number} size
 * @property {() => void} clear
 */

/**
 * @param {{ limit?: number }} [options]
 * @returns {ElevationCache}
 */
export function createElevationCache(options = {}) {
  const limit = Number.isFinite(options.limit) && Number(options.limit) > 0
    ? Math.floor(Number(options.limit))
    : DEFAULT_CACHE_LIMIT;
  /** @type {Map<string, number>} */
  const entries = new Map();

  return {
    get(point) {
      const key = elevationKey(point);
      const hit = entries.get(key);
      if (hit === undefined) return null;
      // Re-inserting moves the key to the end of the Map's insertion order,
      // which is what makes the eviction below least-recently-*used* rather
      // than least-recently-fetched.
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    },

    set(point, elevationM) {
      if (typeof elevationM !== 'number' || !Number.isFinite(elevationM)) return;
      const key = elevationKey(point);
      entries.delete(key);
      entries.set(key, elevationM);
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },

    size() { return entries.size; },
    clear() { entries.clear(); },
  };
}
