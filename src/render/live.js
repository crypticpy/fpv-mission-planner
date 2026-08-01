// render/live.js — live weather mode: fetch the sky at the launch point, say
// whose sky it is, and keep the status line honest while it loads.
import { loadMapState, saveMapState } from '../store.js';
import { setLaunchPoint } from '../presentation/map/map-view.js';
import {
  fetchLiveEnv, launchPoint, isDefaultLaunch, DEFAULT_LAUNCH_NAME,
} from '../weather.js';
import { state, units } from '../state.js';
import {
  setWindLevels, setSounding, activeWindAt, activeLevelPatch, launchWind,
} from '../windprofile.js';
import { f0, compass } from './format.js';
import { $ } from './dom.js';
import { populateControls } from './controls.js';
import { setForecast } from './forecast.js';
import { pushLaunch, pushEnvironment } from '../mission-commands.js';

let deps = null; // injected by app.js: { update, revision, accept }
export function setupLive(d) { deps = d; }

/* ---------- live weather mode ---------- */

let liveSeq = 0;       // stale-response guard: only the latest fetch may apply
let liveFetching = false;
let liveData = null;   // { patch, gust10Mph, at } of the last successful fetch
let liveErr = null;
let geoMsg = null;     // geolocation progress/denial, shown in the same status line
// Resource layer beside liveSeq (ADR 0012 §3): a superseded fetch is aborted
// rather than merely ignored, so a pilot who taps the launch point three
// times in a row doesn't leave two dead requests running to completion.
let liveController = null;

/**
 * The provenance of the weather the rail is currently showing, for push sites
 * outside this module (ADR 0012 §1). While the live fetch is the source, its
 * bag is the answer; any other source is pilot-authored and has no fetch to be
 * honest about. Without this, a rail edit that re-pushes the environment while
 * live mode is active — the wind-level select, say — would overwrite the
 * document's provenance with null while the source still read 'live'.
 */
export function liveProvenance() {
  return state.weatherId === 'live' ? (liveData?.provenance ?? null) : null;
}

/** Never show live numbers without saying whose sky they came from. */
function launchLabel() {
  const pt = launchPoint();
  return isDefaultLaunch(pt)
    ? `${DEFAULT_LAUNCH_NAME} · default spot, not your location. Use “Use my location”, or move the pin on the Map tab.`
    : `${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)}`;
}

function liveStatusText() {
  if (state.weatherId !== 'live') return geoMsg || '';
  const where = `${liveErr ? 'Launch point' : 'Live'} — ${launchLabel()}`;
  if (geoMsg) return `${where}\n${geoMsg}`;
  if (liveErr) return `${where}\nLive weather unavailable (${liveErr}) — using last values, or pick a preset.`;
  if (liveFetching || !liveData) return `${where}\nFetching live weather at the launch point…`;
  const u = units();
  const p = liveData.patch;
  // The conditions this fetch found, read at the height the plan is flying
  // (Phase 4 item 9) — from the profile rather than the patch, so switching
  // levels moves this line without refetching. Without a profile it stays the
  // one wind the fetch returned, which is what it always was.
  const aloft = activeWindAt(state.cruiseAltM)
    || { windMph: p.windMph, windFromDeg: p.windFromDeg };
  // …and whether the surface number beside it was measured at 10 m or is the
  // old halve-it rule of thumb.
  const surface = launchWind(aloft.windMph);
  const surfaceFig = f0(u.speedFromMph(surface.mph));
  return `${where}\n`
    + `${surface.measured ? `10 m ${surfaceFig}` : `surface ~${surfaceFig}`}`
    + ` / ${state.cruiseAltM} m ${f0(u.speedFromMph(aloft.windMph))} ${u.speedUnit} `
    + `from ${aloft.windFromDeg}° (${compass(aloft.windFromDeg)}) · `
    + `gusts ${f0(u.speedFromMph(Math.max(liveData.gust10Mph, aloft.windMph)))} ${u.speedUnit} · `
    + `${p.tempF}°F · ${p.rhPct}% humidity · fetched ${liveData.at}`;
}

/**
 * Move the launch point to the device's position and refetch. The map reads the
 * saved point when it initializes, so a pin placed here survives the tab switch.
 * The optional observer hears how it went — null on success, the same sentence
 * the rail shows on failure — so a surface away from the rail (the onboarding
 * location step, M13) can say it in place without a second geolocation path.
 * @param {(err: string|null) => void} [onResult]
 */
export function useMyLocation(onResult) {
  if (!navigator.geolocation) {
    geoMsg = 'This browser won’t share a location — move the pin on the Map tab instead.';
    updateLiveUI();
    onResult?.(geoMsg);
    return;
  }
  geoMsg = 'Getting your location…';
  updateLiveUI();
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const saved = loadMapState();
      const pt = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      saveMapState({ ...pt, zoom: saved?.zoom ?? 13, baseLayer: saved?.baseLayer ?? 'satellite' });
      setLaunchPoint(pt); // sync the on-screen pin if the map is already up
      pushLaunch(pt);     // …and the mission document, which is where the plan reads it
      geoMsg = null;
      goLive(pt);
      onResult?.(null);
    },
    (err) => {
      geoMsg = err.code === err.TIMEOUT
        ? 'Location timed out — try again, or drop the pin yourself on the Map tab.'
        : err.code === err.POSITION_UNAVAILABLE
          ? 'Location unavailable — drop the pin yourself on the Map tab.'
          : 'Location denied — the launch point is unchanged. Drop the pin yourself on the Map tab.';
      updateLiveUI();
      onResult?.(geoMsg);
    },
    { enableHighAccuracy: true, timeout: 8000 },
  );
}

export function updateLiveUI() {
  const active = state.weatherId === 'live';
  const btn = $('btn-live');
  btn.classList.toggle('active', active);
  btn.setAttribute('aria-pressed', active);
  const msg = liveStatusText();
  const st = $('live-status');
  st.textContent = msg;
  st.hidden = !msg;
}

export async function goLive(pt) {
  const seq = ++liveSeq;
  // The correctness layer (seq) already keeps a superseded answer from
  // applying; this closes the request itself rather than letting it run to
  // completion for nobody.
  liveController?.abort();
  const controller = new AbortController();
  liveController = controller;
  state.weatherId = 'live';
  liveFetching = true;
  liveErr = null;
  geoMsg = null; // a stale denial/timeout note must not outlive the next fetch
  populateControls();
  deps.update();
  // Captured after that render, so it names the same mission and rail the pass
  // just analysed: anything that moves between here and the response has
  // overtaken this fetch (src/analysis-host.js).
  const asked = deps.revision();
  const where = pt ?? launchPoint();
  /* The revision guard below has a deliberate boot exemption — a fetch asked
   * before the repository opened has no mission to be stale against — so it
   * cannot catch the one move that matters here: a mission imported or opened
   * while the fetch was in flight. That mission's launch is the launch now, and
   * this answer describes somewhere else; letting it apply would pushLaunch the
   * old point onto the new document. Moved means superseded, exactly as stale. */
  const moved = () => {
    const at = launchPoint();
    return Math.abs(at.lat - where.lat) > 1e-6 || Math.abs(at.lng - where.lng) > 1e-6;
  };
  let stale = false;
  try {
    const { patch, gust10Mph, levels, sounding, forecast, provenance } =
      await fetchLiveEnv(where, { signal: controller.signal });
    if (seq !== liveSeq || state.weatherId !== 'live') return; // superseded meanwhile
    stale = moved() || !deps.accept(asked, 'live weather fetch');
    if (stale) return;
    // The whole wind profile, latched before the patch is applied so the level the
    // pilot picked is the one that lands on the rail (Phase 4 item 9).
    setWindLevels(levels, gust10Mph);
    // …and the pressure-level sounding beside it, with the point it was fetched
    // for. `where`, not launchPoint(): this is a record of what was asked, and
    // M5's regime check compares it against wherever the mission launches now.
    setSounding(sounding, where);
    const planned = { ...patch, ...(activeLevelPatch(state.cruiseAltM) || {}) };
    state.env = { ...state.env, ...planned };
    // The fetch resolves the elevation of the spot it was made for, and the
    // launch elevation belongs to the mission document, not the rail (ADR 0002).
    pushLaunch(where);
    // The document's environmentReference gets the same fetch's provenance
    // (ADR 0012 §1) — the one write site that used to hardcode `provenance:
    // null` for every source now hears from the source that actually has one.
    pushEnvironment(provenance);
    // The scrubber keeps the raw current-conditions patch: its Now step re-applies
    // whichever level is selected at the time, so stashing a level-shifted patch
    // here would bake today's choice into tomorrow's hour.
    setForecast(forecast, patch); // hourly scrubber + sun times for this launch point
    liveData = {
      // The raw fetch, not the level-shifted copy: the status line reads its own
      // level off the profile, so this stays a record of what came back.
      patch, gust10Mph, provenance,
      at: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    };
  } catch (err) {
    // Silence, not failure (ADR 0012 §3): a request this file cancelled itself
    // — because a newer one already took over — is not a live-weather outage.
    if (err?.name === 'AbortError') return;
    if (seq !== liveSeq || state.weatherId !== 'live') return;
    stale = moved() || !deps.accept(asked, 'live weather fetch');
    if (stale) return;
    liveErr = err.message;
    // A failed refetch must not leave the previous point's wind profile behind as
    // if it described this one — the same rule the forecast strip follows. The
    // sounding goes with it, and for the same reason.
    setWindLevels(null, null);
    setSounding(null, null);
  } finally {
    if (seq === liveSeq) {
      liveFetching = false;
      if (stale) {
        // Dropped, so nothing was applied and nothing rendered. Ask again for the
        // mission as it now stands — the status line is waiting on an answer, and
        // this one already came and went describing somewhere else. Without `pt`,
        // deliberately: every live caller sets the document's launch before
        // calling here, so recapturing launchPoint() asks for the same spot —
        // and re-asking a moved launch at the old `pt` would never converge.
        void goLive();
      } else if (state.weatherId === 'live') {
        // Re-render only while still live: after a dropout the preset/custom
        // handler already rendered, and rewriting inputs would steal the caret.
        populateControls();
        deps.update();
      }
    }
  }
}

/** The last live-fetch failure, or null — the forecast strip gates on it. */
export function liveError() { return liveErr; }
