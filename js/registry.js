// registry.js — the one merge point for built-in and user-added hardware, and
// the one answer to "does this pack fit this rig?". Persistence of the custom
// records lives here too (moved out of data.js): the store and the merge are a
// single concern, and every consumer wants the merged list, never one half.
//
// Compatibility is computed rather than looked up, so a drone the catalog has
// never heard of is answered by the same code path as a catalog one.

import { get as storeGet, set as storeSet } from './store.js';
import { MANUFACTURERS } from './catalog/manufacturers.js';
import { BATTERIES } from './catalog/batteries.js';

/**
 * Built-ins first, in catalog order, with a custom record of the same id
 * substituted in place — the pilot's own measurements of a pack we ship
 * estimates for must win, without jumping the list. Genuinely new customs
 * append after the catalog.
 */
function mergeById(builtIn, custom) {
  if (!custom.length) return [...builtIn];
  const overrides = new Map(custom.map(r => [r.id, r]));
  const builtInIds = new Set(builtIn.map(r => r.id));
  return [
    ...builtIn.map(r => overrides.get(r.id) || r),
    ...custom.filter(r => !builtInIds.has(r.id)),
  ];
}

/* ---------- custom manufacturers ---------- */

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
  return mergeById(MANUFACTURERS, loadCustomManufacturers());
}

/* ---------- custom batteries ---------- */

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
  return mergeById(BATTERIES, loadCustomBatteries());
}

/* ---------- compatibility ---------- */

/**
 * A drone's electrical mounting spec, defensively normalized. A drone written
 * before the `power` block existed (or a user record missing it) is read as
 * accepting exactly its own connector and cell count — the same answer the old
 * hardcoded `fits` lists gave.
 */
export function dronePower(drone) {
  const p = (drone && drone.power) || {};
  return {
    connectors: Array.isArray(p.connectors) && p.connectors.length
      ? p.connectors
      : [drone && drone.connector],
    sMin: Number.isFinite(p.sMin) ? p.sMin : drone && drone.s,
    sMax: Number.isFinite(p.sMax) ? p.sMax : drone && drone.s,
    // null means unbounded: we refuse to invent a mounting limit we have no
    // source for.
    maxPackMassG: Number.isFinite(p.maxPackMassG) ? p.maxPackMassG : null,
  };
}

/**
 * Whether `battery` can be flown on `drone`.
 *
 * Deliberately says nothing about lift. `liftEnvelope()` already reports
 * WILL NOT FLY honestly, and a pack the rig cannot lift belongs in the list
 * wearing that label rather than silently vanishing — the pilot who bought it
 * needs to see why it is a bad idea. `maxPackMassG` is the one mass test, and
 * it is a *mounting* limit (nowhere to strap it), not a thrust one.
 */
export function compatible(drone, battery) {
  if (!drone || !battery) return false;
  // An explicit fits pin is the record's author saying "I verified this" — it
  // wins outright, so a hand-checked odd pairing survives the computed rules.
  if (Array.isArray(battery.fits) && battery.fits.includes(drone.id)) return true;
  const power = dronePower(drone);
  if (!power.connectors.includes(battery.connector)) return false;
  if (!(battery.s >= power.sMin && battery.s <= power.sMax)) return false;
  if (power.maxPackMassG != null && !(battery.massG <= power.maxPackMassG)) return false;
  return true;
}

/** Every pack — catalog or custom — that fits this rig, in merged list order. */
export function compatibleBatteries(drone) {
  return allBatteries().filter(b => compatible(drone, b));
}
