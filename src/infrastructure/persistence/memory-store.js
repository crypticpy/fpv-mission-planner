// memory-store.js — the mission store that lives in a Map.
//
// Not a test double: it is the adapter the app falls back to when IndexedDB is
// absent or refuses to open (R-OFFLINE F6 — old Firefox private windows), and
// it is what the Node contract suite runs the same tests against. A session on
// this adapter is honest about being a session: nothing survives a reload, and
// the export path (ADR 0005) is the only way out.
//
// Two details exist purely to make it behave like IndexedDB rather than like a
// convenient object cache, because a fallback that is *easier* than the real
// thing hides bugs until the field:
//
//   values are structured-cloned on the way in and on the way out, so a caller
//     cannot hold a reference into the store and mutate a "saved" mission after
//     the fact — and so a document carrying something unclonable (a Leaflet
//     layer, a function — R-OFFLINE F12) fails here exactly as it would fail
//     against a real object store, at write time, loudly.
//
//   the clone happens before the Map is touched, so a rejected write leaves the
//     previous version of that mission exactly where it was (ADR 0005: a failed
//     transaction leaves the previous version intact).

/** @typedef {{ key: string, value: unknown }} RawRecord */

/**
 * @typedef {object} MemoryStoreOptions
 * @property {Map<string, unknown>} [backing]    missions, keyed by id
 * @property {Map<string, unknown>} [quarantine] quarantined records, keyed by id
 */

/**
 * @param {MemoryStoreOptions} [options]
 */
export function openMemoryStore(options = {}) {
  const missions = options.backing ?? new Map();
  const quarantine = options.quarantine ?? new Map();
  let open = true;

  const assertOpen = () => {
    if (!open) throw new Error('mission store is closed');
  };

  return {
    kind: /** @type {const} */ ('memory'),
    /** This session's data does not outlive the session; say so out loud. */
    durable: false,

    /** @param {string} id @returns {Promise<unknown>} */
    async read(id) {
      assertOpen();
      const value = missions.get(id);
      return value === undefined ? undefined : structuredClone(value);
    },

    /** @returns {Promise<RawRecord[]>} */
    async readAll() {
      assertOpen();
      return [...missions].map(([key, value]) => ({ key, value: structuredClone(value) }));
    },

    /**
     * @param {{ id: string }} record
     * @param {{ durability?: IDBTransactionDurability }} [_opts] accepted for
     *   contract parity; there is no disk here to flush to
     * @returns {Promise<void>}
     */
    async write(record, _opts = {}) {
      assertOpen();
      const stored = structuredClone(record); // throws before the Map is touched
      missions.set(record.id, stored);
      const readback = missions.get(record.id);
      if (!readback || /** @type {{ id?: unknown }} */ (readback).id !== record.id) {
        throw new Error('write verification failed');
      }
    },

    /** @param {string} id @returns {Promise<boolean>} */
    async remove(id) {
      assertOpen();
      return missions.delete(id);
    },

    /**
     * Move aside, never delete (ADR 0005). Both halves happen with no await
     * between them, which is this adapter's stand-in for one transaction.
     * @param {string} id @param {unknown} envelope @returns {Promise<void>}
     */
    async quarantine(id, envelope) {
      assertOpen();
      quarantine.set(id, structuredClone(envelope));
      missions.delete(id);
    },

    /** @returns {Promise<unknown[]>} */
    async readQuarantine() {
      assertOpen();
      return [...quarantine.values()].map((v) => structuredClone(v));
    },

    close() { open = false; },
  };
}
