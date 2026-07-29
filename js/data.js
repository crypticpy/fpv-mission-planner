// data.js — domain module: re-exports the hardware/scenario catalogs, plus
// custom-item persistence and saved-spots. Catalog literals live in
// js/catalog/* (see those files for sourcing notes).

import { get as storeGet, set as storeSet } from './store.js';
import { DRONES } from './catalog/drones.js';
import { MANUFACTURERS } from './catalog/manufacturers.js';
import { BATTERIES } from './catalog/batteries.js';
import { PAYLOADS } from './catalog/payloads.js';
import { WEATHER } from './catalog/weather.js';
import { SCENARIOS } from './catalog/scenarios.js';

export { DRONES, MANUFACTURERS, BATTERIES, PAYLOADS, WEATHER, SCENARIOS };

export function loadCustomManufacturers() {
  const raw = storeGet('custom-manufacturers', []);
  return Array.isArray(raw)
    ? raw.filter(m => m && m.id && m.name).map(m => ({
        ...m, custom: true, kind: 'custom-builder',
        url: typeof m.url === 'string' && /^https?:\/\//i.test(m.url) ? m.url : null,
      }))
    : [];
}

export function saveCustomManufacturer(manufacturer) {
  const list = loadCustomManufacturers().filter(m => m.id !== manufacturer.id);
  list.push({ ...manufacturer, custom: true, kind: 'custom-builder' });
  storeSet('custom-manufacturers', list);
}

export function deleteCustomManufacturer(id) {
  storeSet('custom-manufacturers', loadCustomManufacturers().filter(m => m.id !== id));
}

export function allManufacturers() {
  return [...MANUFACTURERS, ...loadCustomManufacturers()];
}

export function loadCustomBatteries() {
  const raw = storeGet('custom-batteries', []);
  return Array.isArray(raw) ? raw.filter(b => b && b.id && b.capAh > 0 && b.massG > 0
    && b.s >= 1 && Array.isArray(b.fits) && ['liion', 'lipo', 'lihv'].includes(b.chem))
    .map(b => ({
      ...b,
      manufacturerId: b.manufacturerId || 'custom',
      config: b.config || `${b.s}S${b.p || 1}P`,
    })) : [];
}

export function saveCustomBattery(batt) {
  const list = loadCustomBatteries().filter(b => b.id !== batt.id);
  list.push(batt);
  storeSet('custom-batteries', list);
}

export function deleteCustomBattery(id) {
  storeSet('custom-batteries', loadCustomBatteries().filter(b => b.id !== id));
}

export function allBatteries() {
  return [...BATTERIES, ...loadCustomBatteries()];
}

/* ---------- saved spots ---------- */
// Named launch points, so moving the pin stops being destructive. elevFt is the
// elevation cached at save time (the field it was measured at, not a lookup);
// loadout is a snapshot of the rig flown there, or null when it wasn't recorded.

/**
 * Shape-only loadout check — whether the ids still exist in the catalog is the
 * caller's business, because the answer changes as custom packs come and go.
 */
function normalizeSpotLoadout(l) {
  if (!l || typeof l !== 'object') return null;
  if (typeof l.droneId !== 'string' || !l.droneId) return null;
  if (typeof l.batteryId !== 'string' || !l.batteryId) return null;
  if (typeof l.payloadId !== 'string' || !l.payloadId) return null;
  const extraG = typeof l.extraG === 'number' ? l.extraG : NaN;
  return {
    droneId: l.droneId,
    batteryId: l.batteryId,
    parallelPacks: l.parallelPacks === true,
    payloadId: l.payloadId,
    extraG: extraG >= 0 && extraG <= 500 ? extraG : 0,
  };
}

/**
 * Sanitize one stored spot; returns null when the record could not be a launch
 * point at all (no id/name, or coordinates that aren't on the globe). Unlike the
 * session blob this is per-record rather than all-or-nothing: a spot whose
 * loadout snapshot is malformed is still worth keeping for its location, so the
 * loadout degrades to null instead of discarding the place.
 */
export function normalizeSpot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // Numbers only, never coerced: +null is 0, and a spot silently placed at
  // 0°/0° with an elevation of sea level is worse than no spot at all.
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const lat = num(raw.lat), lng = num(raw.lng);
  if (!id || !name) return null;
  if (!(lat >= -85 && lat <= 85) || !(lng >= -180 && lng <= 180)) return null;
  const elev = num(raw.elevFt);
  const savedAt = num(raw.savedAt);
  return {
    id,
    name: name.slice(0, 60),
    lat, lng,
    elevFt: elev >= -1500 && elev <= 30000 ? Math.round(elev) : null,
    notes: typeof raw.notes === 'string' ? raw.notes.trim().slice(0, 240) : '',
    loadout: normalizeSpotLoadout(raw.loadout),
    savedAt: savedAt >= 0 ? savedAt : 0,
  };
}

/** Saved spots, name-sorted — the list is read as a roster, not a track log. */
export function loadSpots() {
  const raw = storeGet('spots', []);
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeSpot).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Upsert by id. Returns the stored record, or null if it wasn't a valid spot. */
export function saveSpot(spot) {
  const clean = normalizeSpot(spot);
  if (!clean) return null;
  const list = loadSpots().filter(s => s.id !== clean.id);
  list.push(clean);
  storeSet('spots', list);
  return clean;
}

export function deleteSpot(id) {
  storeSet('spots', loadSpots().filter(s => s.id !== id));
}
