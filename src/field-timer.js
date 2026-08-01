// field-timer.js — the flight clock behind Field's Timer tile (F-01, design
// evolution M13). A count-up timer the pilot starts at launch, kept as one
// wall-clock start instant in the store rather than an accumulator: elapsed
// time is recomputed from Date.now() on every read, so a reload, a locked
// phone, or a tab the browser froze cannot lose or slow the clock. The OSD
// timer this mirrors has no pause, and neither does this one — you cannot
// pause being in the air.
import { get as storeGet, set as storeSet, remove as storeRemove } from './store.js';

const KEY = 'fieldTimer';

/** @returns {number|null} epoch ms the running clock started at, or null when idle. */
export function timerStartedAt() {
  const t = storeGet(KEY, null);
  return t && typeof t.startedAt === 'number' && isFinite(t.startedAt) ? t.startedAt : null;
}

/**
 * Start (or restart) the clock at `now`.
 * @param {number} [now]
 */
export function startTimer(now = Date.now()) {
  storeSet(KEY, { startedAt: now });
}

/** Stop and clear — the tile goes back to its idle 0:00. */
export function resetTimer() {
  storeRemove(KEY);
}

/**
 * Minutes since launch, or null when the clock is idle. Clamped at zero so a
 * device clock stepping backwards reads as a fresh start, not a negative
 * flight.
 * @param {number} [now]
 * @returns {number|null}
 */
export function elapsedMin(now = Date.now()) {
  const started = timerStartedAt();
  return started == null ? null : Math.max(0, now - started) / 60000;
}
