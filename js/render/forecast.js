// render/forecast.js — the hourly scrubber: audition a forecast hour, and the
// launch/turn/land clock plan against the light that hour has left.
import { envAtHour, goldenHour, nearestHourIndex } from '../weather.js';
import { activeLevelPatch } from '../windprofile.js';
import { state, units } from '../state.js';
import { f0, compass } from './format.js';
import { $ } from './dom.js';
import { populateControls } from './controls.js';
import { legTimes } from './dashboard.js';

// injected by app.js: { update, liveError }. liveError arrives this way because
// live.js imports setForecast from here — the dependency only runs one way.
let deps = null;
export function setupForecast(d) { deps = d; }

/* ---------- hourly forecast scrubber + sun times ---------- */

// Ephemeral on purpose. Which hour the pilot is auditioning is a question being
// asked right now ("what about Saturday at 3?"), not part of the saved loadout,
// so it never enters `state` and never reaches the session blob.
let fcForecast = null; // shaped forecast from the last successful live fetch
let fcPatch = null;    // that fetch's current-conditions patch, for the Now step
let fcIdx = null;      // selected hour index; null means "Now"

/** Stash a fresh fetch's outlook. A new fetch always lands back on Now. */
export function setForecast(forecast, patch) {
  fcForecast = forecast && forecast.hours && forecast.hours.length ? forecast : null;
  fcPatch = patch || null;
  fcIdx = null;
}

/**
 * The hours the scrubber may select, or null when there is nothing to scrub.
 * Gated on live mode: a preset or hand-entered sky is not a forecast, so the
 * strip disappears rather than implying the preset has hours behind it. Gated on
 * liveErr too: a failed refetch (launch point moved, no signal) must not leave
 * the previous point's outlook on screen as if it belonged to this one.
 */
function forecastHours() {
  return fcForecast && !deps.liveError() && state.weatherId === 'live' ? fcForecast.hours : null;
}

// hours[].time and sunrise/sunset were parsed from Open-Meteo's offset-less
// local strings, so they are wall-clock tokens in the *runtime's* zone that
// happen to read as the launch point's clock. Formatting them with the runtime
// locale therefore round-trips the launch point's wall clock exactly. Comparing
// them to `new Date()` (below, for "which hour is now") additionally assumes the
// pilot is browsing from the launch point's timezone — true for any spot they
// can drive to, and the only wrong-by-an-offset case is planning another zone.
const hourName = (d) => d.toLocaleString([], { weekday: 'short', hour: 'numeric' });
const clockTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// "7:49 PM" → "7:49" once an earlier time in the same line established the
// meridiem. No-op in 24-hour locales, where there is no suffix to match.
function trimMeridiem(label, ref) {
  const m = /\s(\S+)$/.exec(label);
  const r = /\s(\S+)$/.exec(ref);
  return m && r && m[1] === r[1] ? label.slice(0, m.index) : label;
}

function nowIdx(hours) {
  const i = nearestHourIndex({ hours }, new Date());
  return i < 0 ? 0 : i;
}

function selectedIdx(hours) {
  if (fcIdx == null) return nowIdx(hours);
  return Math.min(Math.max(fcIdx, 0), hours.length - 1);
}

/** The forecast day covering a given hour, matched on its local calendar date. */
function dayFor(when) {
  const key = ymd(when);
  const days = (fcForecast && fcForecast.days) || [];
  return days.find(d => d.date === key) || null;
}

// Open-Meteo publishes per-field nulls for model gaps; merging one into
// state.env would fabricate a dead calm and void the session blob's range
// validation. Missing fields keep whatever the live fetch already set.
function definedOnly(patch) {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => Number.isFinite(v)));
}

function hourSummary(hr) {
  const u = units();
  const bits = [];
  if (hr.windMph != null) {
    const wind = f0(u.speedFromMph(hr.windMph));
    bits.push(hr.gustMph != null && hr.gustMph > hr.windMph
      ? `${wind} gusting ${f0(u.speedFromMph(hr.gustMph))} ${u.speedUnit}`
      : `${wind} ${u.speedUnit}`);
  }
  if (hr.windFromDeg != null) bits.push(`from ${compass(hr.windFromDeg)}`);
  if (hr.tempF != null) bits.push(`${hr.tempF}°F`);
  if (hr.precipPct != null) bits.push(`${hr.precipPct}% rain`);
  return bits.length ? bits.join(', ') : 'no forecast data for this hour';
}

/**
 * Re-plan for the scrubbed hour. Mirrors goLive's merge so the whole app —
 * physics, verdict, footprint — recomputes against that hour's sky while
 * staying in live mode. Back on the Now step, the fetched current conditions
 * win over the hourly model that only approximates them.
 */
function applyForecastHour() {
  const hours = forecastHours();
  if (!hours) return;
  const i = selectedIdx(hours);
  // Whichever step is showing, the wind comes off the cruise altitude the pilot
  // picked (Phase 4 item 9): the Now step off the current-conditions profile the
  // live fetch latched, the other hours off that hour's own profile.
  const patch = (i === nowIdx(hours) && fcPatch)
    ? { ...fcPatch, ...(activeLevelPatch(state.cruiseAltM) || {}) }
    : envAtHour(fcForecast, hours[i].time, state.cruiseAltM);
  if (patch) state.env = { ...state.env, ...definedOnly(patch) };
  populateControls();
  deps.update();
}

/** The scrubber's own handler: select an hour by index, then re-plan for it. */
export function setForecastHour(i) {
  fcIdx = i;
  applyForecastHour();
}

/**
 * Re-plan the hour already on screen — the cruise-altitude control's hook, so
 * changing levels while auditioning Saturday at 3 re-reads *that* hour's profile
 * rather than dropping back to now. False when there is no forecast to re-read
 * (preset sky, failed fetch), which leaves the caller to apply the level itself.
 */
export function reapplyForecastHour() {
  if (!forecastHours()) return false;
  applyForecastHour();
  return true;
}

/**
 * "launch → turn → land vs sunset." The turnaround and landing clock times the
 * pilot actually flies, checked against the light they will have left. Ten
 * minutes of margin is the warn threshold: landing in the last of the light is
 * landing in the dark by the time the props stop.
 */
function renderClockPlan(r, launch, golden) {
  const el = $('forecast-clock');
  el.replaceChildren();
  const times = legTimes(r);
  if (!times || !isFinite(r.timeMin)) { el.hidden = true; return; }
  el.hidden = false;
  const at = (min) => new Date(launch.getTime() + min * 60000);
  const land = at(r.timeMin);
  const launchLbl = clockTime(launch);
  el.append(document.createTextNode(
    `Launch ${launchLbl} → turn ${trimMeridiem(clockTime(at(times.outMin)), launchLbl)}`
    + ` → land ${trimMeridiem(clockTime(land), launchLbl)}`
    + (golden ? ` · sunset ${clockTime(golden.sunset)}` : '')
  ));
  if (!golden) return;
  const marginMin = (golden.sunset.getTime() - land.getTime()) / 60000;
  if (marginMin >= 10) return;
  const warn = document.createElement('span');
  warn.className = 'forecast-late';
  warn.textContent = marginMin < 0
    ? ` — lands ${f0(-marginMin)} min after sunset. Launch earlier.`
    : ` — only ${f0(marginMin)} min of light left at landing. Launch earlier.`;
  el.appendChild(warn);
}

export function renderForecastStrip(r) {
  const hours = forecastHours();
  $('forecast-strip').hidden = !hours;
  if (!hours) return;
  const i = selectedIdx(hours);
  const isNow = i === nowIdx(hours);
  const hr = hours[i];
  const when = isNow ? 'Now' : hourName(hr.time);

  const slider = $('in-forecast-hour');
  slider.max = hours.length - 1;
  slider.value = i;
  slider.setAttribute('aria-valuetext', when);
  $('forecast-when').textContent = when;

  // The plan is only honest if it says which sky it planned against — the tiles
  // and the verdict card look identical either way.
  const banner = $('forecast-banner');
  banner.hidden = isNow;
  banner.textContent = isNow ? '' : `Planning for ${when} — forecast, not current conditions.`;

  $('forecast-readout').textContent = isNow
    ? `Now — flying the live conditions above.${hr.precipPct != null ? ` ${hr.precipPct}% rain this hour.` : ''}`
    : `${when} — ${hourSummary(hr)}`;

  const golden = goldenHour(dayFor(hr.time));
  const sun = $('forecast-sun');
  sun.hidden = !golden;
  sun.textContent = golden
    ? `Sunset ${clockTime(golden.sunset)} · golden hour from ${clockTime(golden.goldenStart)}`
    : '';
  // On the Now step the real clock beats the hour bucket: a 7:41 launch should
  // read 7:41, not 7:00.
  renderClockPlan(r, isNow ? new Date() : hr.time, golden);
}
