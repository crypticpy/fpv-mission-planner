// weather.js — Open-Meteo live weather client (keyless, CORS-open), shared by
// the Weather rail's Live mode and the map's launch-point button.
import { loadMapState } from './data.js';

export const DEFAULT_LAUNCH = { lat: 30.2672, lng: -97.7431 }; // Austin

/** Best-known launch point without requiring the map to be initialized. */
export function launchPoint() {
  const saved = loadMapState();
  return saved ? { lat: saved.lat, lng: saved.lng } : { ...DEFAULT_LAUNCH };
}

/**
 * Fetch current conditions for a point. Returns { patch, gust10Mph } where
 * patch is ready to merge into state.env. Throws on network/malformed data.
 */
export async function fetchLiveEnv({ lat, lng }) {
  // 80 m wind, not 10 m: FPV cruise happens at 30–120 m AGL, where the wind
  // typically runs well above the surface reading. Gusts only exist at 10 m.
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}`
    + '&current=temperature_2m,relative_humidity_2m,wind_speed_80m,wind_direction_80m,wind_gusts_10m'
    + '&temperature_unit=fahrenheit&wind_speed_unit=mph';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const c = data.current;
  // Number.isFinite, not global isFinite: Open-Meteo reports unavailable values
  // as null, which global isFinite coerces to 0 — a fabricated dead calm.
  if (!c || !Number.isFinite(c.temperature_2m) || !Number.isFinite(c.wind_speed_80m)
    || !Number.isFinite(c.relative_humidity_2m) || !Number.isFinite(c.wind_direction_80m)) {
    throw new Error('malformed response');
  }
  const patch = {
    tempF: Math.round(c.temperature_2m),
    rhPct: Math.round(c.relative_humidity_2m),
    windMph: Math.round(c.wind_speed_80m),
    gustMph: Math.round(Math.max(c.wind_gusts_10m || 0, c.wind_speed_80m)),
    windFromDeg: ((Math.round(c.wind_direction_80m) % 360) + 360) % 360,
  };
  if (Number.isFinite(data.elevation)) patch.elevFt = Math.round(data.elevation * 3.28084);
  return { patch, gust10Mph: Math.round(c.wind_gusts_10m || 0) };
}
