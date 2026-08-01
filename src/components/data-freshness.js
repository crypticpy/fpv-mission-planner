// components/data-freshness.js — the DataFreshness chip of the round-2 design
// system: where a figure came from and how old it is, in one of four states —
// current / cached / stale / unavailable. M9 mounts it in the wind ribbon;
// the same chip belongs beside any fetched figure (terrain, calibration,
// imports) as those surfaces are reworked.
//
// `cached` means "served from a store, not the network" — numbers that are
// real at their stated age but cannot refresh. M13 wires it to the one signal
// a page has for that: navigator.onLine === false while a fetched bag is
// still on screen.
import { icon } from './icons.js';
import { state } from '../state.js';
import { WEATHER } from '../data.js';
import { liveProvenance, liveError } from '../render/live.js';

/** @typedef {'current'|'cached'|'stale'|'unavailable'} FreshnessState */
/**
 * @typedef {object} FreshnessModel
 * @property {string} source       'Live · Open-Meteo', 'Preset · Austin spring', …
 * @property {string|null} at      ISO instant of the fetch; null when nothing was fetched
 * @property {FreshnessState} state
 */

/**
 * "just now" / "24 min ago" / "5 h ago" / "2 d ago". Coarse on purpose: the
 * chip answers "should I trust this", not "when exactly", and the two coded
 * age constraints (6 h / 24 h) are what decide the color.
 * @param {string} iso
 * @param {number} [nowMs]
 */
export function ageText(iso, nowMs = Date.now()) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const min = Math.max(0, (nowMs - then) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.round(min)} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / (24 * 60))} d ago`;
}

/**
 * The environment's freshness: the fetch instant from the live module's own
 * bag (see the live-mode comment below), staleness from the snapshot every
 * other surface draws from. Stale is not re-decided here: the two forecast-age constraints
 * (ADR 0012 §1) are the decision, and the chip only reflects whether one is
 * on the stack — the chip and the warning it sits beside cannot disagree.
 * @param {import('../application/analysis/analysis-contracts.js').AnalysisSnapshot|null} snapshot
 * @param {{onLine?: boolean}} [nav]  injectable for tests; defaults to the real navigator
 * @returns {FreshnessModel}
 */
export function freshnessModelFrom(snapshot, nav = globalThis.navigator) {
  if (state.weatherId === 'live') {
    // Not the snapshot's retrievedAt: that field falls back to env.capturedAt
    // — a push time, re-stamped by every rail edit (analyze.js) — so a FAILED
    // live fetch still yields a plausible instant and the chip would claim
    // "Open-Meteo · just now" beside a rail saying live weather is down.
    // liveProvenance() is null until a real fetch lands, and after a failed
    // refetch it still holds the last successful bag — which is honest: those
    // ARE the values on screen, at their true age.
    const at = liveProvenance()?.retrievedAt ?? null;
    if (!at) return { source: 'Live', at: null, state: 'unavailable' };
    // A refresh that is currently failing outranks age: on Plan the rail's
    // status line says "using last values" right beside the chip, but on the
    // other three destinations this chip is the only provenance on screen —
    // it must not read healthy while the sky it shows can only get older.
    // Same signal the rail prints (liveErr), so the two cannot disagree.
    const aged = (snapshot?.constraints ?? []).some((c) =>
      c.code === 'W-DATA-FORECAST-AGE' || c.code === 'W-DATA-FORECAST-STALE');
    // Offline interposes before the failure check, not the age check: a fetch
    // that failed because there is no network is not a provider outage — the
    // numbers on screen are the store's, at their true age, which is exactly
    // what `cached` means. Age still outranks it, because cached data past
    // the trust constraints is stale wherever it came from. Online, the
    // precedence is unchanged from M9.
    const offline = nav?.onLine === false;
    const state = offline ? (aged ? 'stale' : 'cached')
      : liveError() ? 'unavailable' : aged ? 'stale' : 'current';
    return { source: 'Live · Open-Meteo', at, state };
  }
  if (state.weatherId === 'custom') {
    return { source: 'Manual conditions', at: null, state: 'current' };
  }
  const w = WEATHER.find((p) => p.id === state.weatherId);
  return { source: w ? `Preset · ${w.name}` : 'Preset', at: null, state: 'current' };
}

/**
 * @param {HTMLElement} host
 * @param {FreshnessModel} m
 */
export function renderDataFreshness(host, m) {
  // The chip owns only its own class family — a mount like the wind ribbon's
  // `.windrib-fresh` slot keeps its layout class across renders.
  const kept = [...host.classList].filter((c) => !c.startsWith('freshness'));
  host.className = [...kept, 'freshness', `freshness-${m.state}`].join(' ');
  const label = document.createElement('span');
  label.className = 'freshness-text';
  const age = m.at ? ageText(m.at) : null;
  label.textContent = m.state === 'unavailable' && !age
    ? `${m.source} · no fetch yet`
    : age ? `${m.source} · ${age}` : m.source;
  host.replaceChildren(icon('clock', 'freshness-glyph'), label);
}
