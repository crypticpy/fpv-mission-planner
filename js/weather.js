// weather.js — Open-Meteo weather client (keyless, CORS-open), shared by the
// Weather rail's Live mode, the map's launch-point button, and the flight log's
// historical prefill. Two endpoints: /v1/forecast for now and the next three
// days, and the ERA5 archive for an hour that has already happened.
import { loadMapState } from './store.js';

export const DEFAULT_LAUNCH = { lat: 30.2672, lng: -97.7431 }; // Austin
export const DEFAULT_LAUNCH_NAME = 'Austin, TX';

/** Best-known launch point without requiring the map to be initialized. */
export function launchPoint() {
  const saved = loadMapState();
  return saved ? { lat: saved.lat, lng: saved.lng } : { ...DEFAULT_LAUNCH };
}

/**
 * True while the launch point is still the built-in default — the UI must say
 * so rather than presenting someone else's wind as the pilot's own. Compared
 * by value, since panning the map persists the unmoved default coordinates.
 */
export function isDefaultLaunch(pt = launchPoint()) {
  return Math.abs(pt.lat - DEFAULT_LAUNCH.lat) < 1e-4
    && Math.abs(pt.lng - DEFAULT_LAUNCH.lng) < 1e-4;
}

/**
 * Fetch current conditions for a point. Returns { patch, gust10Mph, forecast }
 * where patch is ready to merge into state.env and forecast is the shaped
 * hourly/daily outlook (see shapeForecast). Throws on network/malformed data.
 */
export async function fetchLiveEnv({ lat, lng }) {
  // 80 m wind, not 10 m: FPV cruise happens at 30–120 m AGL, where the wind
  // typically runs well above the surface reading. Gusts only exist at 10 m.
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}`
    + '&current=temperature_2m,relative_humidity_2m,wind_speed_80m,wind_direction_80m,wind_gusts_10m'
    + '&hourly=wind_speed_80m,wind_direction_80m,wind_gusts_10m,temperature_2m,relative_humidity_2m,precipitation_probability'
    + '&daily=sunrise,sunset,wind_speed_10m_max,wind_gusts_10m_max,precipitation_probability_max'
    + '&forecast_days=3&timezone=auto'
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
  return { patch, gust10Mph: Math.round(c.wind_gusts_10m || 0), forecast: shapeForecast(data) };
}

/**
 * Wind and temperature at one hour that has already happened, from Open-Meteo's
 * ERA5 reanalysis archive (keyless and CORS-open like the forecast endpoint, on
 * a different host, and roughly a day behind — today's flight is not in it yet).
 *
 * `whenLocal` is a local wall-clock `YYYY-MM-DDTHH:mm` string, the same frame
 * the logbook stores and the same frame `timezone=auto` answers in, so the hour
 * is matched by string rather than by building a Date that would be parsed in
 * the browser's zone instead of the launch site's.
 *
 * One difference from fetchLiveEnv worth knowing: the reanalysis publishes wind
 * at 10 m and 100 m, not the forecast API's 80 m. This reads 100 m — the nearest
 * level to the height the plan flies, and closer to it than the 10 m surface
 * reading by a wide margin.
 *
 * Throws on network trouble, a malformed payload, or an hour the archive has no
 * data for. Prefilling a form is a convenience, so every caller is expected to
 * carry on without it.
 */
export async function fetchArchiveEnv({ lat, lng }, whenLocal) {
  const stamp = String(whenLocal);
  const date = stamp.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(stamp)) throw new Error('bad timestamp');
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}`
    + `&start_date=${date}&end_date=${date}`
    + '&hourly=temperature_2m,relative_humidity_2m,wind_speed_100m,wind_direction_100m'
    + '&timezone=auto&temperature_unit=fahrenheit&wind_speed_unit=mph';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const h = data && data.hourly;
  if (!h || !Array.isArray(h.time)) throw new Error('malformed response');
  const wanted = `${date}T${stamp.slice(11, 13)}:00`;
  const i = h.time.indexOf(wanted);
  // Number.isFinite, not global isFinite: a null from Open-Meteo means "no
  // reading", and coercing it to 0 would prefill a fabricated dead calm.
  if (i < 0 || !Number.isFinite(at(h.wind_speed_100m, i)) || !Number.isFinite(at(h.temperature_2m, i))) {
    throw new Error('no archived weather for that hour yet');
  }
  return {
    windMph: Math.round(h.wind_speed_100m[i]),
    windFromDeg: numOrNull(h.wind_direction_100m, i, (v) => ((Math.round(v) % 360) + 360) % 360),
    tempF: Math.round(h.temperature_2m[i]),
    rhPct: numOrNull(h.relative_humidity_2m, i, Math.round),
    elevM: Number.isFinite(data.elevation) ? data.elevation : null,
  };
}

/**
 * Shape a raw Open-Meteo /v1/forecast response (with hourly + daily blocks,
 * already in fahrenheit/mph units per the request above) into the app's
 * imperial-canonical forecast shape. Pure — no network, safe to unit test.
 * Guards against Open-Meteo's per-field nulls (a sensor/model gap for one
 * hour doesn't have to invalidate the whole entry).
 *
 * Returns { hours: [...], days: [...] }.
 *
 * Timezone note: timezone=auto makes Open-Meteo return offset-less local
 * wall-clock strings (e.g. "2026-07-29T18:00") for the launch site, not
 * UTC. `new Date(iso)` on an offset-less string is parsed in the *runtime's*
 * local zone, not the site's — the two only coincide when the pilot is
 * browsing from the same timezone as the launch point (the common case).
 * These Date objects are therefore wall-clock tokens, not true instants:
 * only compare them to other values built the same way (e.g. envAtHour's
 * `when`), never against a UTC timestamp from elsewhere.
 */
export function shapeForecast(apiJson) {
  const h = apiJson && apiJson.hourly;
  const d = apiJson && apiJson.daily;
  const hours = (h && Array.isArray(h.time)) ? h.time.map((iso, i) => ({
    time: new Date(iso),
    windMph: numOrNull(h.wind_speed_80m, i, Math.round),
    windFromDeg: numOrNull(h.wind_direction_80m, i, (v) => ((Math.round(v) % 360) + 360) % 360),
    // Same gust-floor treatment as the current patch: gusts only publish at
    // 10 m, so never report a gust below the 80 m sustained wind.
    gustMph: gustFloor(at(h.wind_gusts_10m, i), at(h.wind_speed_80m, i)),
    tempF: numOrNull(h.temperature_2m, i, Math.round),
    rhPct: numOrNull(h.relative_humidity_2m, i, Math.round),
    precipPct: numOrNull(h.precipitation_probability, i, Math.round),
  })) : [];
  const days = (d && Array.isArray(d.time)) ? d.time.map((date, i) => ({
    date,
    sunrise: at(d.sunrise, i) ? new Date(d.sunrise[i]) : null,
    sunset: at(d.sunset, i) ? new Date(d.sunset[i]) : null,
    windMaxMph: numOrNull(d.wind_speed_10m_max, i, Math.round),
    gustMaxMph: gustFloor(at(d.wind_gusts_10m_max, i), at(d.wind_speed_10m_max, i)),
    precipMaxPct: numOrNull(d.precipitation_probability_max, i, Math.round),
  })) : [];
  return { hours, days };
}

function at(arr, i) {
  return Array.isArray(arr) ? arr[i] : undefined;
}

function numOrNull(arr, i, round) {
  const v = at(arr, i);
  return Number.isFinite(v) ? round(v) : null;
}

/** Gust never reported below the sustained wind it rides on top of. */
function gustFloor(gust, sustained) {
  const g = Number.isFinite(gust) ? gust : 0;
  const s = Number.isFinite(sustained) ? sustained : 0;
  if (!Number.isFinite(gust) && !Number.isFinite(sustained)) return null;
  return Math.round(Math.max(g, s));
}

/**
 * Index into forecast.hours of the hour nearest `when`, or -1 when there is
 * no usable hour. Pure. A scrubber needs the index (to position its slider and
 * read the hour's own fields like precipPct), not just the env patch, so the
 * search lives here and envAtHour reads through it.
 *
 * Ties resolve to the earlier hour. `when` may be a Date or anything
 * `new Date()` accepts. Same wall-clock caveat as shapeForecast: `when` must be
 * built in the same frame as hours[].time, never a UTC instant from elsewhere.
 */
export function nearestHourIndex(forecast, when) {
  const hours = forecast && forecast.hours;
  if (!Array.isArray(hours) || hours.length === 0) return -1;
  const target = (when instanceof Date ? when : new Date(when)).getTime();
  if (!Number.isFinite(target)) return -1;
  let best = -1;
  let bestDelta = Infinity;
  for (let i = 0; i < hours.length; i++) {
    const hr = hours[i];
    const t = hr && hr.time instanceof Date ? hr.time.getTime() : new Date(hr && hr.time).getTime();
    if (!Number.isFinite(t)) continue;
    const delta = Math.abs(t - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    }
  }
  return best;
}

/**
 * Weather patch (windMph, windFromDeg, gustMph, tempF, rhPct) for the
 * forecast hour nearest `when`. Pure. Returns null when forecast has no
 * usable hours. `when` may be a Date or anything `new Date()` accepts.
 * Individual fields may be null where Open-Meteo reported a gap — callers
 * merging this into a live env must drop those rather than write a null.
 */
export function envAtHour(forecast, when) {
  const i = nearestHourIndex(forecast, when);
  if (i < 0) return null;
  const best = forecast.hours[i];
  return {
    windMph: best.windMph,
    windFromDeg: best.windFromDeg,
    gustMph: best.gustMph,
    tempF: best.tempF,
    rhPct: best.rhPct,
  };
}

/**
 * Golden-hour window for a shaped forecast day: the hour before sunset.
 * Pure. Returns null when the day has no sunset. `day` is one entry from
 * shapeForecast(...).days (or any { sunset } with a Date/ISO sunset).
 */
export function goldenHour(day) {
  const sunset = day && day.sunset instanceof Date ? day.sunset
    : (day && day.sunset ? new Date(day.sunset) : null);
  if (!sunset || !Number.isFinite(sunset.getTime())) return null;
  const goldenStart = new Date(sunset.getTime() - 60 * 60 * 1000);
  return { goldenStart, sunset };
}
