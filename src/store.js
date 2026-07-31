// store.js — namespaced, versioned localStorage wrapper. Every persisted key
// in the app lives under `fpv:v1:*` so a future schema break can bump the
// version without colliding with what came before. This is the only module
// that touches `localStorage` directly; everything else goes through get/set.

const NS = 'fpv:v1:';

// Resolved lazily on every call, never cached at module scope: private-mode
// browsers can make localStorage throw or vanish mid-session, and the Node
// test suite swaps globalThis.localStorage in and out between test groups.
function backing() {
  return globalThis.localStorage;
}

/**
 * Parsed value for `name`, or `fallback` when missing, corrupt, or storage is unavailable.
 *
 * @param {string} name
 * @param {*} fallback
 * @returns {*}
 */
export function get(name, fallback) {
  const ls = backing();
  if (!ls) return fallback;
  try {
    const raw = ls.getItem(NS + name);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Persist `value` under `name`. Quota errors and no-storage environments are swallowed.
 *
 * @param {string} name
 * @param {*} value
 */
export function set(name, value) {
  const ls = backing();
  if (!ls) return;
  try { ls.setItem(NS + name, JSON.stringify(value)); } catch { /* quota / private mode */ }
}

/**
 * Remove `name`. Swallows storage errors the same way get/set do.
 *
 * @param {string} name
 */
export function remove(name) {
  const ls = backing();
  if (!ls) return;
  try { ls.removeItem(NS + name); } catch { /* private mode */ }
}

// legacy key -> namespaced name. `fpv-mission-theme-v1` is the one raw
// (non-JSON) value in the old scheme — everything else was already JSON.
const LEGACY_KEYS = [
  ['fpv-session', 'session'],
  ['fpv-spots', 'spots'],
  ['fpv-map', 'map'],
  ['fpv-custom-batteries', 'custom-batteries'],
  ['fpv-custom-manufacturers', 'custom-manufacturers'],
  ['fpv-mission-theme-v1', 'theme'],
];

/**
 * Copy any legacy `fpv-*` keys into their namespaced `fpv:v1:*` home and
 * remove the originals. Idempotent, and never clobbers a namespaced key that
 * already exists. Each key is handled independently so one bad value can't
 * block the rest of the migration.
 */
export function migrateLegacy() {
  const ls = backing();
  if (!ls) return;
  for (const [legacyKey, name] of LEGACY_KEYS) {
    try {
      const nsKey = NS + name;
      if (ls.getItem(nsKey) != null) continue;
      const raw = ls.getItem(legacyKey);
      if (raw == null) continue;
      let encoded;
      try {
        JSON.parse(raw);
        encoded = raw; // already valid JSON — copy verbatim
      } catch {
        encoded = JSON.stringify(raw); // raw string (e.g. the old theme key)
      }
      ls.setItem(nsKey, encoded);
      ls.removeItem(legacyKey);
    } catch { /* per-key best effort */ }
  }
}

if (globalThis.localStorage) migrateLegacy();

/* ---------- map view state ---------- */
// Moved from data.js: the map's own persistence, so weather.js (which only
// needs the launch point) doesn't have to import the whole catalog module.

export function loadMapState() {
  const raw = get('map', null);
  if (!raw || !isFinite(raw.lat) || !isFinite(raw.lng)) return null;
  return {
    lat: Math.max(-85, Math.min(85, +raw.lat)),
    lng: Math.max(-180, Math.min(180, +raw.lng)),
    zoom: isFinite(raw.zoom) ? Math.max(3, Math.min(21, Math.round(+raw.zoom))) : 12,
    baseLayer: raw.baseLayer === 'streets' ? 'streets' : 'satellite',
    /* Which engine was on screen (ADR 0004). Anything that is not the explicit
     * opt-in is 2D — including every record written before 3D existed, and any
     * value a hand-edited store might hold. */
    view: raw.view === '3d' ? '3d' : '2d',
  };
}

/** @param {{ lat: number, lng: number, zoom: number, baseLayer: string, view?: string }} s */
export function saveMapState(s) {
  // Fires on every pan/zoom via Leaflet events — never let quota/private-mode
  // storage errors escape into the map's event dispatch.
  set('map', s);
}
