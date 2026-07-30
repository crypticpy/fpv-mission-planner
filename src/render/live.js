// render/live.js — live weather mode: fetch the sky at the launch point, say
// whose sky it is, and keep the status line honest while it loads.
import { loadMapState, saveMapState } from '../store.js';
import { setLaunchPoint } from '../map.js';
import {
  fetchLiveEnv, launchPoint, isDefaultLaunch, DEFAULT_LAUNCH_NAME,
} from '../weather.js';
import { state, units } from '../state.js';
import { setWindLevels, activeWindAt, activeLevelPatch, launchWind } from '../windprofile.js';
import { f0, compass } from './format.js';
import { $ } from './dom.js';
import { populateControls } from './controls.js';
import { setForecast } from './forecast.js';
import { pushLaunch } from '../mission-commands.js';

let deps = null; // injected by app.js: { update, revision, accept }
export function setupLive(d) { deps = d; }

/* ---------- live weather mode ---------- */

let liveSeq = 0;       // stale-response guard: only the latest fetch may apply
let liveFetching = false;
let liveData = null;   // { patch, gust10Mph, at } of the last successful fetch
let liveErr = null;
let geoMsg = null;     // geolocation progress/denial, shown in the same status line

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
 */
export function useMyLocation() {
  if (!navigator.geolocation) {
    geoMsg = 'This browser won’t share a location — move the pin on the Map tab instead.';
    updateLiveUI();
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
    },
    (err) => {
      geoMsg = err.code === err.TIMEOUT
        ? 'Location timed out — try again, or drop the pin yourself on the Map tab.'
        : err.code === err.POSITION_UNAVAILABLE
          ? 'Location unavailable — drop the pin yourself on the Map tab.'
          : 'Location denied — the launch point is unchanged. Drop the pin yourself on the Map tab.';
      updateLiveUI();
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
  let stale = false;
  try {
    const { patch, gust10Mph, levels, forecast } = await fetchLiveEnv(where);
    if (seq !== liveSeq || state.weatherId !== 'live') return; // superseded meanwhile
    stale = !deps.accept(asked, 'live weather fetch');
    if (stale) return;
    // The whole wind profile, latched before the patch is applied so the level the
    // pilot picked is the one that lands on the rail (Phase 4 item 9).
    setWindLevels(levels, gust10Mph);
    const planned = { ...patch, ...(activeLevelPatch(state.cruiseAltM) || {}) };
    state.env = { ...state.env, ...planned };
    // The fetch resolves the elevation of the spot it was made for, and the
    // launch elevation belongs to the mission document, not the rail (ADR 0002).
    pushLaunch(where);
    // The scrubber keeps the raw current-conditions patch: its Now step re-applies
    // whichever level is selected at the time, so stashing a level-shifted patch
    // here would bake today's choice into tomorrow's hour.
    setForecast(forecast, patch); // hourly scrubber + sun times for this launch point
    liveData = {
      // The raw fetch, not the level-shifted copy: the status line reads its own
      // level off the profile, so this stays a record of what came back.
      patch, gust10Mph,
      at: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    };
  } catch (err) {
    if (seq !== liveSeq || state.weatherId !== 'live') return;
    stale = !deps.accept(asked, 'live weather fetch');
    if (stale) return;
    liveErr = err.message;
    // A failed refetch must not leave the previous point's wind profile behind as
    // if it described this one — the same rule the forecast strip follows.
    setWindLevels(null, null);
  } finally {
    if (seq === liveSeq) {
      liveFetching = false;
      if (stale) {
        // Dropped, so nothing was applied and nothing rendered. Ask again for the
        // mission as it now stands — the status line is waiting on an answer, and
        // this one already came and went describing somewhere else.
        void goLive(pt);
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
