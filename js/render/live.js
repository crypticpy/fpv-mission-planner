// render/live.js — live weather mode: fetch the sky at the launch point, say
// whose sky it is, and keep the status line honest while it loads.
import { loadMapState, saveMapState } from '../store.js';
import { setLaunchPoint } from '../map.js';
import {
  fetchLiveEnv, launchPoint, isDefaultLaunch, DEFAULT_LAUNCH_NAME,
} from '../weather.js';
import { state, units } from '../state.js';
import { f0, compass, surfaceMph } from './format.js';
import { $ } from './dom.js';
import { populateControls } from './controls.js';
import { setForecast } from './forecast.js';

let deps = null; // injected by app.js: { update }
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
  return `${where}\n`
    + `surface ~${f0(u.speedFromMph(surfaceMph(p.windMph)))} / aloft ${f0(u.speedFromMph(p.windMph))} ${u.speedUnit} `
    + `from ${p.windFromDeg}° (${compass(p.windFromDeg)}) · `
    + `gusts ${f0(u.speedFromMph(Math.max(liveData.gust10Mph, p.windMph)))} ${u.speedUnit} · `
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
  try {
    const { patch, gust10Mph, forecast } = await fetchLiveEnv(pt ?? launchPoint());
    if (seq !== liveSeq || state.weatherId !== 'live') return; // superseded meanwhile
    state.env = { ...state.env, ...patch };
    setForecast(forecast, patch); // hourly scrubber + sun times for this launch point
    liveData = {
      patch, gust10Mph,
      at: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    };
  } catch (err) {
    if (seq !== liveSeq || state.weatherId !== 'live') return;
    liveErr = err.message;
  } finally {
    if (seq === liveSeq) {
      liveFetching = false;
      // Re-render only while still live: after a dropout the preset/custom
      // handler already rendered, and rewriting inputs would steal the caret.
      if (state.weatherId === 'live') {
        populateControls();
        deps.update();
      }
    }
  }
}

/** The last live-fetch failure, or null — the forecast strip gates on it. */
export function liveError() { return liveErr; }
