// packinstances.js — the physical copies of a pack model a pilot actually owns
// (§5 Phase 3: "per-pack instances (cycle count, measured IR)").
//
// A catalog or custom battery record is a *model*: "GNB 6S 5500". A pilot who
// flies long range owns three of them, bought a year apart, and one of them has
// been through 180 cycles and reads 34 mΩ at the charger where the fresh one
// reads 22. The plan should be able to fly that pack, not the model.
//
// So: a small list of instances, each one pointing at a battery id, and a
// per-battery record of which one is selected. Two deliberate limits:
//   - The measured pack IR is the *only* thing that reaches the model. Cycle
//     count is bookkeeping — a capacity-derating curve per cycle count is a
//     model nobody has anchored data for, and inventing one would be worse than
//     showing the number and letting the pilot re-weigh their expectations.
//   - Nothing here mutates a battery record. `instanceBattery()` spreads a copy,
//     exactly the way flightlog.calibratedDrone() does for an airframe, because
//     the catalog literals are module-scope objects shared app-wide.
//
// Layering matches flightlog.js: this module reads storage and is read by
// state.js. It never imports state.js, the registry, or anything under render/.

import { get as storeGet, set as storeSet } from './store.js';

const KEY = 'pack-instances';
const SELECTED_KEY = 'pack-instance-selected';

// Where "this pack has been around the block" starts being worth a sentence.
// Cycle life is chemistry-shaped: the 21700 Li-Ion cells in a long-range pack
// are specified for hundreds of cycles at these currents, where a high-rate
// LiPo/LiHV is visibly tired much sooner. Soft note only — never a refusal.
const HIGH_CYCLES = { liion: 300, lipo: 150, lihv: 150 };

/* ---------- the record ---------- */

/**
 * Sanitize one stored instance. Per-record, like normalizeLog() and
 * loadCustomDrones(): one corrupt entry is dropped and the rest of the shelf
 * survives. A missing IR is a legitimate instance — plenty of pilots track
 * cycles without owning a charger that reports resistance — so it comes back as
 * null rather than voiding the record.
 */
export function normalizeInstance(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const inRange = (v, lo, hi) => (
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null
  );
  const id = str(raw.id);
  const batteryId = str(raw.batteryId);
  const label = str(raw.label).slice(0, 24);
  if (!id || !batteryId || !label) return null;
  return {
    id,
    batteryId,
    label,
    // A blank cycle field reads back as null — Math.round(null) is 0, which
    // would assert a brand-new pack the pilot never described.
    cycleCount: inRange(Number.isFinite(raw.cycleCount) ? Math.round(raw.cycleCount) : null, 0, 5000),
    irPackMilliOhm: inRange(raw.irPackMilliOhm, 0.5, 500),
    // The temperature the resistance was read at, when the pilot said. Same
    // status as the battery record's own `irTempC`: provenance, not an input —
    // pack-temperature modeling is Phase 4.
    irTempC: inRange(raw.irTempC, -20, 60),
  };
}

/* ---------- persistence ---------- */

export function loadPackInstances() {
  const raw = storeGet(KEY, []);
  return Array.isArray(raw) ? raw.map(normalizeInstance).filter(Boolean) : [];
}

/** Every physical copy of one pack model, oldest entry first (list order). */
export function instancesForBattery(batteryId) {
  return loadPackInstances().filter(i => i.batteryId === batteryId);
}

/** Upsert by id. Returns the stored record, or null when it wasn't one. */
export function savePackInstance(instance) {
  const clean = normalizeInstance(instance);
  if (!clean) return null;
  const list = loadPackInstances().filter(i => i.id !== clean.id);
  list.push(clean);
  storeSet(KEY, list);
  return clean;
}

/**
 * Forget one physical pack. The selection goes with it — a plan pointing at a
 * pack the pilot just threw away has to fall back to the catalog spec, not to a
 * dangling id.
 */
export function deletePackInstance(id) {
  const gone = loadPackInstances().find(i => i.id === id);
  storeSet(KEY, loadPackInstances().filter(i => i.id !== id));
  if (gone && selectedInstanceId(gone.batteryId) === id) setSelectedInstance(gone.batteryId, null);
}

/** Everything belonging to a pack model that no longer exists. */
export function deletePackInstancesFor(batteryId) {
  storeSet(KEY, loadPackInstances().filter(i => i.batteryId !== batteryId));
  setSelectedInstance(batteryId, null);
}

export function newInstanceId() {
  return `pack-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/* ---------- the selection ---------- */

function selectionMap() {
  const raw = storeGet(SELECTED_KEY, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

export function selectedInstanceId(batteryId) {
  const v = selectionMap()[batteryId];
  return typeof v === 'string' && v ? v : null;
}

/** Per battery id, so switching packs in the rail and back remembers. */
export function setSelectedInstance(batteryId, instanceId) {
  if (!batteryId) return;
  const map = selectionMap();
  if (instanceId) map[batteryId] = instanceId;
  else delete map[batteryId];
  storeSet(SELECTED_KEY, map);
}

/**
 * The physical pack the plan is flying, or null for "catalog spec" — which is
 * also the answer when the stored selection names an instance that has since
 * been deleted or re-pointed at another model.
 */
export function selectedInstance(batteryId) {
  const id = selectedInstanceId(batteryId);
  if (!id) return null;
  return instancesForBattery(batteryId).find(i => i.id === id) || null;
}

/* ---------- the overlay ---------- */

/**
 * The pack record the planner should fly: `batt` with this physical copy's
 * measured resistance in place of the model's, when there is one.
 *
 * Never mutates its argument, and idempotent — `loadoutBattery()` runs it over
 * whatever it is handed, which may already have been through `battery()`.
 *
 * The `packInstance` block rides along so the provenance copy can say a measured
 * IR is in play without going back to storage. An instance with no measured IR
 * still lands there: the plan is unchanged, but the pilot is flying Pack #2 and
 * the UI should agree with them about which pack that is.
 */
export function instanceBattery(batt) {
  if (!batt || batt.packInstance) return batt;
  const inst = selectedInstance(batt.id);
  if (!inst) return batt;
  const measured = Number.isFinite(inst.irPackMilliOhm);
  const out = {
    ...batt,
    packInstance: {
      id: inst.id,
      label: inst.label,
      cycleCount: inst.cycleCount,
      irPackMilliOhm: inst.irPackMilliOhm,
      irTempC: inst.irTempC,
      measured,
      // What the model would have flown, so the sentence can name both figures.
      specIrPackMilliOhm: batt.irPackMilliOhm,
    },
  };
  if (measured) out.irPackMilliOhm = inst.irPackMilliOhm;
  return out;
}

/** True when this many cycles is worth a sentence for this chemistry. */
export function highCycleCount(chem, cycleCount) {
  const limit = HIGH_CYCLES[chem];
  return !!limit && Number.isFinite(cycleCount) && cycleCount >= limit;
}
