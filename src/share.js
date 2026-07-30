// share.js — JSON export/import of the pilot's own hardware and logbook (§6.3).
// A file, not an account: no backend, no ids minted on a server, nothing that
// needs a stranger to be online at the same time as you (§7.4).
//
// The payload:
//   { version: 1, manufacturers: [...], drones: [...], batteries: [...],
//     flightLogs: [...] }
//
// Custom manufacturers ride along whether or not the pilot thinks of them as
// something they authored: a shared pack whose `manufacturerId` names a brand
// the receiving planner has never heard of would otherwise arrive orphaned, and
// the brand row is three fields.
//
// What is deliberately *not* in the payload:
//   - coordinates. Saved spots (the only records that carry any) are not shared
//     at all, and `scrubCoords` below is the belt to the braces: a record that
//     ever grows a lat/lng field cannot leak one through this file by accident.
//   - timestamps, unless asked for. A flight log's `at` is the one timestamp in
//     the app's own records; the checkbox opts it back in, and nothing here adds
//     an export date — an `importedAt` would put a timestamp back into a file
//     whose whole point is not carrying one.
//
// Import treats every byte as hostile. `validate()` judges hardware against the
// same descriptors the forms are generated from, `normalizeLog()` gates every
// flight, and the id of an incoming record never overwrites anything: a collision
// with *any* existing record, built-in or custom, renames the newcomer and every
// reference to it inside the same payload is rewritten to match. Nothing touches
// storage until `applyPlan()`, which is only ever called by a confirm button.

import { BATTERY_FIELDS, DRONE_FIELDS, validate } from './schema.js';
import {
  allBatteries, allDrones, allManufacturers,
  loadCustomBatteries, loadCustomDrones, loadCustomManufacturers,
  saveCustomBattery, saveCustomDrone, saveCustomManufacturer,
} from './registry.js';
import { loadFlightLogs, normalizeLog, saveFlightLog } from './flightlog.js';

export const SHARE_VERSION = 1;

/* ---------- field picking ---------- */

/**
 * Copy only the keys a descriptor list names, recursing into groups. Used on the
 * way out (a file with nothing in it the pilot did not author) and on the way in
 * (an unknown key in a shared file never reaches storage). Provenance survives
 * because provenance is descriptor-backed: `estimated`, `confidence`,
 * `propulsion.sourceUrl` and `maxThrustGPerRotor` are all fields.
 */
export function pickFields(record, fields) {
  const out = {};
  const src = record && typeof record === 'object' ? record : {};
  for (const f of fields) {
    const v = src[f.key];
    if (v === undefined) continue;
    if (f.type === 'group') {
      out[f.key] = v && typeof v === 'object' && !Array.isArray(v) ? pickFields(v, f.fields) : v;
      continue;
    }
    out[f.key] = v;
  }
  return out;
}

const COORD_KEYS = new Set([
  'lat', 'lng', 'lon', 'long', 'latitude', 'longitude', 'coords', 'coordinates',
]);

/** Drop any coordinate-shaped key, at any depth. */
function scrubCoords(value) {
  if (Array.isArray(value)) return value.map(scrubCoords);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (COORD_KEYS.has(k)) continue;
      out[k] = scrubCoords(v);
    }
    return out;
  }
  return value;
}

/* ---------- export ---------- */

const shareManufacturer = (m) => ({ id: m.id, name: m.name, url: m.url ?? null });

/**
 * Everything this planner has that a stranger could use. Built-ins are never in
 * the file — the receiving planner already ships them, and a catalog record in a
 * shared file would collide with itself on the way in.
 *
 * `includeLogs` is §6.3's "include my flight logs": the logs are what makes a
 * shared airframe's `etaProp` distinguishable from a hand-typed one, and they are
 * also a record of when and how much somebody flew, so they are a choice.
 */
export function buildPayload({ includeLogs = true, includeTimestamps = false } = {}) {
  const payload = {
    version: SHARE_VERSION,
    manufacturers: loadCustomManufacturers().map(shareManufacturer),
    drones: loadCustomDrones().map(d => ({ ...pickFields(d, DRONE_FIELDS), custom: true })),
    batteries: loadCustomBatteries().map(b => ({ ...pickFields(b, BATTERY_FIELDS), custom: true })),
    flightLogs: includeLogs
      ? loadFlightLogs().map(l => (includeTimestamps ? l : { ...l, at: null }))
      : [],
  };
  return scrubCoords(payload);
}

/* ---------- reading a file ---------- */

const versionPhrase = (v) => (
  v === undefined || v === null ? 'no version at all'
    : typeof v === 'number' && Number.isFinite(v) ? `version ${v}`
    : `version ${JSON.stringify(v)}`
);

/**
 * Parse and version-check one file's text. Returns `{ ok: true, payload }` or
 * `{ ok: false, error }` — a sentence naming what was wrong, because the pilot
 * holding a file this planner won't read needs to know which of the two things
 * happened (it isn't a share file at all vs. it is a newer one).
 */
export function readPayload(text) {
  let raw;
  try {
    raw = JSON.parse(String(text));
  } catch (err) {
    return { ok: false, error: `That file isn’t valid JSON (${err.message}) — nothing was read.` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'That file is JSON, but not a shared hangar — it has no version and no records.' };
  }
  if (raw.version !== SHARE_VERSION) {
    return {
      ok: false,
      error: `That file carries ${versionPhrase(raw.version)}; this planner reads version ${SHARE_VERSION} only. `
        + 'Nothing was imported — update the planner, or ask for a version 1 export.',
    };
  }
  return { ok: true, payload: raw };
}

/* ---------- per-record gates ---------- */

const idOf = (raw) => (raw && typeof raw === 'object' && typeof raw.id === 'string' ? raw.id.trim() : '');

function gateBySchema(raw, fields, what) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `not a ${what} record at all.` };
  }
  const record = pickFields(raw, fields);
  const { ok, errors } = validate(record, fields);
  if (!ok) return { error: `${errors.slice(0, 3).map(e => e.msg).join('; ')}.` };
  // Everything imported is the pilot's own record from here on: it lives in the
  // custom store, it is deletable, and the UI labels it as theirs.
  return { record: { ...record, custom: true } };
}

const gateDrone = (raw) => gateBySchema(raw, DRONE_FIELDS, 'drone');
const gateBattery = (raw) => gateBySchema(raw, BATTERY_FIELDS, 'battery');

// Manufacturers have no descriptor list (nobody generates a form from them), so
// the gate is loadCustomManufacturers()'s own rule, applied to one record.
function gateManufacturer(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'not a brand record at all.' };
  const id = idOf(raw);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!id || !name) return { error: 'a brand needs an id and a name.' };
  return {
    record: {
      id,
      name: name.slice(0, 60),
      url: typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url) ? raw.url : null,
      custom: true,
      kind: 'custom-builder',
    },
  };
}

// The untrusted-log gate is the one the app already uses on its own storage —
// same solver contract, same refusals, no second definition of "a flight".
function gateLog(raw) {
  const record = normalizeLog(raw);
  if (!record) {
    return {
      error: 'not a usable flight — a log needs an id, a drone, a pack, a kind, a flight time, '
        + 'an air temperature and one charge reading.',
    };
  }
  return { record };
}

/* ---------- planning an import ---------- */

/**
 * A free id derived from `id`. `-imported` first (it says where the record came
 * from, which is exactly what the diff panel then shows), numbered after that so
 * importing the same file three times cannot collapse two rigs into one.
 */
function freeId(id, taken) {
  if (!taken.has(id)) return id;
  const base = `${id}-imported`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Run one kind through its gate. Skips carry a reason and never reserve an id;
 * kept records carry the id they will be stored under and whether that is the id
 * they arrived with. `map` is original id → new id, for the reference rewrite.
 */
function takeAll(raws, taken, gate) {
  const kept = [];
  const skipped = [];
  const map = new Map();
  const list = Array.isArray(raws) ? raws : [];
  list.forEach((raw, i) => {
    const got = gate(raw);
    if (!got.record) {
      skipped.push({ originalId: idOf(raw) || `record ${i + 1}`, reason: got.error });
      return;
    }
    const originalId = got.record.id;
    const id = freeId(originalId, taken);
    taken.add(id);
    if (id !== originalId) map.set(originalId, id);
    kept.push({ originalId, id, renamed: id !== originalId, record: { ...got.record, id } });
  });
  return { kept, skipped, map };
}

/**
 * What importing `payload` would do, decided against the hangar as it stands and
 * saving nothing. One bad record never blocks the rest: every kind is gated
 * per-record, and the skips come back with the reason to show next to them.
 *
 * Reference rewriting is why the kinds are planned in this order — brands, then
 * airframes, then packs (which point at both), then logs (which point at an
 * airframe and a pack). A reference to something *outside* the payload is left
 * alone: a shared pack pinned to `moz7v2` means the built-in MOZ7.
 */
export function planImport(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const manufacturers = takeAll(src.manufacturers,
    new Set(allManufacturers().map(m => m.id)), gateManufacturer);
  const drones = takeAll(src.drones, new Set(allDrones().map(d => d.id)), gateDrone);
  const batteries = takeAll(src.batteries, new Set(allBatteries().map(b => b.id)), gateBattery);
  const logs = takeAll(src.flightLogs, new Set(loadFlightLogs().map(l => l.id)), gateLog);

  for (const entry of batteries.kept) {
    const r = entry.record;
    if (manufacturers.map.has(r.manufacturerId)) r.manufacturerId = manufacturers.map.get(r.manufacturerId);
    if (Array.isArray(r.fits)) r.fits = r.fits.map(id => drones.map.get(id) ?? id);
  }
  for (const entry of logs.kept) {
    const r = entry.record;
    r.droneId = drones.map.get(r.droneId) ?? r.droneId;
    r.batteryId = batteries.map.get(r.batteryId) ?? r.batteryId;
  }

  return { version: SHARE_VERSION, manufacturers, drones, batteries, logs };
}

const KINDS = [
  ['drones', 'drone', 'drones'],
  ['batteries', 'battery', 'batteries'],
  ['manufacturers', 'brand', 'brands'],
  ['logs', 'flight log', 'flight logs'],
];

/** Is there anything to confirm? An all-skipped file is a refusal, not an import. */
export function planIsEmpty(plan) {
  return KINDS.every(([key]) => plan[key].kept.length === 0);
}

/**
 * The diff sentence shown before anything is saved — §6.3's "show a diff".
 * Renames are named in full, because "1 renamed" without the pair of ids does not
 * tell the pilot which of their rigs was nearly overwritten.
 */
export function describePlan(plan) {
  const parts = [];
  for (const [key, one, many] of KINDS) {
    const kind = plan[key];
    if (!kind.kept.length && !kind.skipped.length) continue;
    const notes = [];
    const renamed = kind.kept.filter(e => e.renamed);
    if (renamed.length) {
      notes.push(`${renamed.length} renamed: `
        + renamed.map(e => `‘${e.originalId}’ → ‘${e.id}’`).join(', '));
    }
    if (kind.skipped.length) notes.push(`${kind.skipped.length} skipped`);
    parts.push(`${kind.kept.length} ${kind.kept.length === 1 ? one : many}`
      + (notes.length ? ` (${notes.join('; ')})` : ''));
  }
  if (!parts.length) return 'Nothing in that file — no drones, packs or flights to add.';
  return `${parts.join(', ')}.`;
}

/** Every skipped record across all kinds, in the order the panel lists them. */
export function planSkips(plan) {
  return KINDS.flatMap(([key, one]) => plan[key].skipped.map(s => ({
    kind: one, originalId: s.originalId, reason: s.reason,
  })));
}

/**
 * Persist a plan. The only function in this module that writes, and it writes
 * through the same registry and logbook helpers the forms use — so an imported
 * pack is indistinguishable from a typed one afterwards, and an imported rig's
 * logs feed fitForDrone() the moment they land.
 */
export function applyPlan(plan) {
  for (const e of plan.manufacturers.kept) saveCustomManufacturer(e.record);
  for (const e of plan.drones.kept) saveCustomDrone(e.record);
  for (const e of plan.batteries.kept) saveCustomBattery(e.record);
  for (const e of plan.logs.kept) saveFlightLog(e.record);
  return {
    manufacturers: plan.manufacturers.kept.length,
    drones: plan.drones.kept.length,
    batteries: plan.batteries.kept.length,
    logs: plan.logs.kept.length,
  };
}
