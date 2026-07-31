// components/wind-ribbon.js — the persistent WindRibbon of the round-2 design
// system: speed, compass direction, gust, freshness, and impact in one strip
// under the masthead, on every destination. Compact two-row card under 900px,
// single-row bar above it — the same DOM, two CSS postures, like the destnav.
//
// M9 ships the collapsed ribbon only; the per-task expansion states (wind by
// altitude, the hourly strip) are M11's work and mount inside the same host.
import { icon } from './icons.js';
import { state, units } from '../state.js';
import { compass, f0 } from '../render/format.js';
import { U } from '../domain/physics.js';
import { GUST_SHARE_CAUTION } from '../render/dashboard.js';
import { renderDataFreshness, freshnessModelFrom } from './data-freshness.js';

/**
 * @typedef {object} WindRibbonModel
 * @property {'normal'|'stale'|'gust'|'critical'} state
 * @property {string} windText  '9 mph · SSW · 170°'
 * @property {string} note      the impact slot — gust figure, or why it's critical
 * @property {import('./data-freshness.js').FreshnessModel} fresh
 */

/**
 * The ribbon's state, read off the snapshot rather than re-decided:
 * critical is the coded no-way-home constraint, gust is the same share of the
 * usable top speed the verdict plans its gust caution on, stale is the
 * freshness chip's own verdict. Worst wins, in that order — one label, so the
 * strip stays readable at arm's length in a field.
 * @param {import('../application/analysis/analysis-contracts.js').AnalysisSnapshot|null} snapshot
 * @returns {WindRibbonModel}
 */
export function windModelFrom(snapshot) {
  const u = units();
  const env = state.env;
  const windText = `${f0(u.speedFromMph(env.windMph))} ${u.speedUnit}`
    + ` · ${compass(env.windFromDeg)} · ${f0(env.windFromDeg)}°`;
  const gustText = `Gust ${f0(u.speedFromMph(env.gustMph))}`;
  const fresh = freshnessModelFrom(snapshot);
  const r = snapshot?.plan ?? null;
  const critical = (snapshot?.constraints ?? []).some((c) => c.code === 'W-WIND-NO-CLOSE');
  const gusty = !!r && r.speedLimitMs > 0
    && U.mphToMs(env.gustMph) / r.speedLimitMs > GUST_SHARE_CAUTION;
  const stale = fresh.state === 'stale' || fresh.state === 'unavailable';
  if (critical && r) {
    const kind = env.windMode === 'cross' ? 'crosswind' : 'headwind';
    return {
      state: 'critical', windText, fresh,
      note: `${f0(u.speedFromMs(r.wind.planningMs))} ${u.speedUnit} ${kind} — no way home`,
    };
  }
  return { state: gusty ? 'gust' : stale ? 'stale' : 'normal', windText, note: gustText, fresh };
}

function ensure(host) {
  if (host.firstChild) return;
  // Two lines of meaning, one strip: the sky (state, wind, impact) and its
  // provenance (the freshness chip). Desktop lays them out as one row with the
  // chip pushed right; under 900px they stack — same DOM, two CSS postures.
  const main = document.createElement('span');
  main.className = 'windrib-main';
  const stateEl = document.createElement('span');
  stateEl.className = 'windrib-state';
  const wind = document.createElement('span');
  wind.className = 'windrib-wind';
  const note = document.createElement('span');
  note.className = 'windrib-note';
  main.append(stateEl, icon('wind', 'windrib-glyph'), wind, note);
  const freshSlot = document.createElement('span');
  freshSlot.className = 'windrib-fresh';
  host.append(main, freshSlot);
}

const STATE_WORD = { normal: 'Normal', stale: 'Stale', gust: 'Gust', critical: 'Critical' };

/**
 * @param {HTMLElement} host
 * @param {WindRibbonModel|null} m  null hides the ribbon (no snapshot yet)
 */
export function renderWindRibbon(host, m) {
  host.hidden = !m;
  if (!m) return;
  ensure(host);
  host.className = `windrib windrib-${m.state}`;
  host.querySelector('.windrib-state').textContent = STATE_WORD[m.state];
  host.querySelector('.windrib-wind').textContent = m.windText;
  host.querySelector('.windrib-note').textContent = m.note;
  renderDataFreshness(host.querySelector('.windrib-fresh'), m.fresh);
}
