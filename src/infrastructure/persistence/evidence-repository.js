// evidence-repository.js — the derived-data sibling of mission-repository.js
// (ADR 0012 §2).
//
// A mission document is authoritative and its writes fail loudly (see
// mission-repository.js's own header); evidence is the opposite on both
// counts. It is a cache of what the corridor and the advisory grid looked
// like the last time the network answered, keyed by mission id, and it exists
// only so a reopened mission can show ground immediately instead of asking
// again. Losing it costs nothing but a re-fetch, so this module never lets a
// storage problem become the mission's problem:
//
//   a write that fails — quota above all — is swallowed with a console.warn
//     and never reaches a caller. The mission itself was not touched.
//
//   a read that comes back malformed is discarded silently and the record is
//     deleted, on the theory that a corrupt cache entry is worth exactly as
//     much as no entry — the caller re-derives it from the network either way,
//     and a stale, half-broken record left on disk would only be found again
//     by the same code that already decided it was unusable.
//
// What "usable" means for a given corridor/grid — whether a restored record
// still describes the mission's current geometry — is not this module's
// question. That is domain knowledge (TerrainField, AdvisoryGrid shapes) that
// belongs to analysis-host.js, the one place ADR 0009 lets reach into both the
// application layer and this one. This module only knows how to keep a shaped
// envelope and hand it back.

import { openIndexedDbStore } from './indexeddb-store.js';
import { openMemoryStore } from './memory-store.js';

/** @typedef {import('../../application/terrain/terrain-contracts.js').TerrainField} TerrainField */
/** @typedef {import('../../application/terrain/terrain-contracts.js').AdvisoryGridField} AdvisoryGridField */

/**
 * One mission's worth of sampled evidence, verbatim — whatever
 * analysis-host.js had in hand when it last saved, provenance included.
 * @typedef {object} EvidenceRecord
 * @property {string} id           the mission id this evidence describes
 * @property {string} savedAt      ISO instant
 * @property {TerrainField|null} terrainField
 * @property {AdvisoryGridField|null} advisoryGrid
 * @property {unknown} profile     the single-bearing terrain profile (src/terrain.js's activeProfile())
 */

/**
 * @typedef {object} EvidenceStoreDeps
 * @property {'auto'|'memory'|'indexeddb'} [adapter]
 * @property {IDBFactory} [indexedDB]
 * @property {string} [databaseName]
 * @property {Map<string, unknown>} [backing]
 * @property {Map<string, unknown>} [quarantine]
 * @property {Map<string, unknown>} [evidence]
 * @property {import('./mission-repository.js').MissionStore & {
 *   readEvidence: (id: string) => Promise<unknown>,
 *   writeEvidence: (record: { id: string }) => Promise<void>,
 *   removeEvidence: (id: string) => Promise<void>,
 * }} [store]  a ready-made adapter, used as-is (tests)
 */

/**
 * IndexedDB when there is one, memory when there is not — the exact rule
 * mission-repository.js's own selectStore() follows, restated rather than
 * shared: the two repositories have no other reason to depend on each other,
 * and a shared helper would be the only one.
 * @param {EvidenceStoreDeps} deps
 */
async function selectStore(deps) {
  const wanted = deps.adapter ?? 'auto';
  const factory = deps.indexedDB ?? globalThis.indexedDB;
  if (wanted === 'memory') return openMemoryStore(deps);
  if (wanted === 'indexeddb') {
    return openIndexedDbStore({ indexedDB: factory, databaseName: deps.databaseName });
  }
  if (!factory) return openMemoryStore(deps);
  try {
    return await openIndexedDbStore({ indexedDB: factory, databaseName: deps.databaseName });
  } catch {
    return openMemoryStore(deps);
  }
}

/**
 * A record is admissible the moment it is shaped like an EvidenceRecord — this
 * is a shallow check on purpose. Whether a restored TerrainField/AdvisoryGrid
 * actually matches the mission's current corridor/grid is a signature
 * question analysis-host.js asks separately; a record that passes here but
 * fails that later test is simply never admitted, not thrown away.
 * @param {unknown} raw @param {string} id @returns {boolean}
 */
function isValidRecord(raw, id) {
  if (!raw || typeof raw !== 'object') return false;
  const r = /** @type {Record<string, unknown>} */ (raw);
  if (r.id !== id) return false;
  if (typeof r.savedAt !== 'string' || Number.isNaN(Date.parse(r.savedAt))) return false;
  for (const key of ['terrainField', 'advisoryGrid', 'profile']) {
    const v = r[key];
    if (v !== null && v !== undefined && typeof v !== 'object') return false;
  }
  return true;
}

/**
 * Open an evidence repository over the best available adapter.
 * @param {EvidenceStoreDeps} [deps]
 */
export async function openEvidenceRepository(deps = {}) {
  const store = deps.store ?? await selectStore(deps);

  return {
    /** Which adapter this repository ended up on — surfaced, not hidden. */
    adapter: store.kind,
    durable: store.durable,

    /**
     * Save one mission's evidence, replacing whatever was there for that id.
     * Never throws: a write failure (QuotaExceededError above all, ADR 0012
     * §2 rule a) is swallowed here and only here, because the mission itself
     * must never learn that its derived cache could not be written.
     * @param {EvidenceRecord} record
     * @returns {Promise<void>}
     */
    async save(record) {
      try {
        await store.writeEvidence(record);
      } catch (e) {
        console.warn(`evidence: "${record?.id}" could not be saved; the mission itself is unaffected `
          + '— it will simply be re-sampled next time.', e);
      }
    },

    /**
     * The evidence for one mission, or null when there is none or what is on
     * disk cannot be trusted to be an EvidenceRecord at all. A record that
     * fails the shallow shape check is deleted on the way out (ADR 0012 §2
     * rule b: derived data that cannot even be read as evidence is worth
     * exactly as much as no evidence).
     * @param {string} id
     * @returns {Promise<EvidenceRecord|null>}
     */
    async get(id) {
      if (typeof id !== 'string' || !id) return null;
      /** @type {unknown} */
      let raw;
      try {
        raw = await store.readEvidence(id);
      } catch (e) {
        console.warn(`evidence: "${id}" could not be read; treating it as absent.`, e);
        return null;
      }
      if (raw === undefined || raw === null) return null;
      if (!isValidRecord(raw, id)) {
        try {
          await store.removeEvidence(id);
        } catch { /* best-effort: a record already too corrupt to read is not worth a retry */ }
        return null;
      }
      return /** @type {EvidenceRecord} */ (raw);
    },

    /**
     * Remove one mission's evidence — best-effort, for the "removing a
     * mission removes its evidence" rule (ADR 0012 §2 rule c). Never throws:
     * there is nothing left to protect once the mission itself is gone.
     * @param {string} id
     * @returns {Promise<void>}
     */
    async remove(id) {
      try {
        await store.removeEvidence(id);
      } catch (e) {
        console.warn(`evidence: "${id}" could not be removed alongside its mission.`, e);
      }
    },

    close() { store.close(); },
  };
}
