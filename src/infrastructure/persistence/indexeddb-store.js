// indexeddb-store.js — the durable mission store (ADR 0005, R-OFFLINE).
//
// Database `fpv-planner`, object store `missions` keyed by mission id, plus
// `quarantine` for records that came back unreadable and `evidence` for the
// forecast/terrain snapshots M2 and M8 will write. The evidence store is
// created empty *now*, in this same schema version, on purpose: R-OFFLINE F9
// points out that `skipWaiting()`/`clients.claim()` can leave an old tab and a
// new tab alive at once, so every store this app will ever need should exist
// before two versions can disagree about the database version number.
//
// The write path is the part worth reading. R-OFFLINE turns four separate
// failure modes into one shape:
//
//   F12 — the record is built and cloned *before* the transaction opens, so an
//     unclonable value (a live map layer, a function) throws at the caller
//     rather than aborting a transaction halfway.
//   F10 — nothing is awaited inside a transaction except IndexedDB's own
//     requests. A stray `await` on anything else lets the transaction commit
//     out from under the next request and it fails with TransactionInactiveError.
//   F1 — quota exhaustion is caught by name and re-thrown as a typed
//     `quota-exceeded` failure instead of being swallowed the way store.js
//     legitimately swallows quota errors for preferences.
//   ADR 0005 — the put and the verifying read happen in the *same* transaction,
//     and `oncomplete` (not the put's own success) is what "saved" means. A
//     transaction that aborts leaves the previous version of the mission
//     exactly as it was.
//
// Durability is a per-call argument rather than a global default because Chrome
// 121 moved the browser default from `strict` to `relaxed` (R-OFFLINE F11) and
// a mission save is precisely the write where the last few seconds matter.
//
// Safari drops IndexedDB connections under load and has shipped at least one
// release where a dropped connection could not be reused (R-OFFLINE §3.3), so
// every operation goes through `withDb`, which reopens once and retries before
// reporting a hard failure.

/** @typedef {{ key: string, value: unknown }} RawRecord */

export const DATABASE_NAME = 'fpv-planner';
// v2 (M14): the `versions` store. The bump is the one F9 allows for: additive,
// with `onversionchange` handlers below so a tab on this build closes its
// connection instead of blocking the next upgrade. A tab still on v1 has no
// such handler — if one is open during the one-time 1→2 upgrade, the new tab's
// open is blocked, falls back to the memory adapter for that session, and says
// so through `durable: false`.
export const DATABASE_VERSION = 2;
export const MISSION_STORE = 'missions';
export const QUARANTINE_STORE = 'quarantine';
export const EVIDENCE_STORE = 'evidence';
export const VERSION_STORE = 'versions';

/** Errors that mean "the connection is gone", not "the data is bad". */
const RECONNECT_ERRORS = new Set(['InvalidStateError', 'UnknownError', 'AbortError', 'NotFoundError']);

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
function requestDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** @param {IDBTransaction} tx @returns {Promise<void>} */
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * @param {IDBFactory} factory
 * @param {string} name
 * @returns {Promise<IDBDatabase>}
 */
function openDatabase(factory, name) {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, DATABASE_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Additive only, forever: an upgrade that drops or renames a store can
      // strand a tab still running the previous build (R-OFFLINE F9).
      for (const store of [MISSION_STORE, QUARANTINE_STORE, EVIDENCE_STORE, VERSION_STORE]) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'));
  });
}

/**
 * @typedef {object} IndexedDbStoreOptions
 * @property {IDBFactory} [indexedDB] injected so tests can hand over a fresh
 *   `fake-indexeddb` factory instead of sharing the environment's
 * @property {string} [databaseName]
 */

/**
 * @param {IndexedDbStoreOptions} [options]
 */
export async function openIndexedDbStore(options = {}) {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new Error('IndexedDB is not available in this environment');
  const name = options.databaseName ?? DATABASE_NAME;

  /** @type {IDBDatabase|null} */
  let db = null;
  let closed = false;

  /**
   * Track the live connection and give it the two exit handlers: `onclose` for
   * a connection the browser dropped, `onversionchange` so this tab yields the
   * database instead of blocking a newer build's upgrade in another tab (F9).
   * @param {IDBDatabase} connection
   */
  function adopt(connection) {
    db = connection;
    connection.onclose = () => { if (db === connection) db = null; };
    connection.onversionchange = () => {
      connection.close();
      if (db === connection) db = null;
    };
    return connection;
  }

  adopt(await openDatabase(factory, name));

  async function ensureDb() {
    if (closed) throw new Error('mission store is closed');
    return db ?? adopt(await openDatabase(factory, name));
  }

  /**
   * Run one unit of work against a live connection, reopening once if the
   * connection turned out to be dead. The retry is deliberately shallow: a
   * second failure is a real failure and the caller needs to hear about it.
   * @template T
   * @param {(db: IDBDatabase) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function withDb(fn) {
    try {
      return await fn(await ensureDb());
    } catch (e) {
      const name_ = e instanceof Error ? e.name : '';
      if (!RECONNECT_ERRORS.has(name_)) throw e;
      db = null;
      return fn(await ensureDb());
    }
  }

  return {
    kind: /** @type {const} */ ('indexeddb'),
    durable: true,

    /** @param {string} id @returns {Promise<unknown>} */
    read(id) {
      return withDb(async (database) => {
        const tx = database.transaction(MISSION_STORE, 'readonly');
        const value = await requestDone(tx.objectStore(MISSION_STORE).get(id));
        await transactionDone(tx);
        return value;
      });
    },

    /** @returns {Promise<RawRecord[]>} */
    readAll() {
      return withDb(async (database) => {
        const tx = database.transaction(MISSION_STORE, 'readonly');
        const store = tx.objectStore(MISSION_STORE);
        const values = await requestDone(store.getAll());
        const keys = await requestDone(store.getAllKeys());
        await transactionDone(tx);
        return values.map((value, i) => ({ key: String(keys[i]), value }));
      });
    },

    /**
     * One transaction, one full document, verified by reading the key back
     * inside that same transaction before `oncomplete` is allowed to mean
     * "saved".
     *
     * @param {{ id: string }} record
     * @param {{ durability?: IDBTransactionDurability }} [opts]
     * @returns {Promise<void>}
     */
    write(record, opts = {}) {
      const durability = opts.durability ?? 'strict';
      return withDb(async (database) => {
        const tx = database.transaction(MISSION_STORE, 'readwrite', { durability });
        const store = tx.objectStore(MISSION_STORE);
        /** @type {IDBRequest<unknown>} */
        let readback;
        try {
          store.put(record);        // DataCloneError throws synchronously (F12)
          readback = store.get(record.id);
        } catch (e) {
          try { tx.abort(); } catch { /* already dead */ }
          throw e;
        }
        await transactionDone(tx);
        const saved = /** @type {{ id?: unknown }|undefined} */ (readback.result);
        if (!saved || saved.id !== record.id) {
          throw new Error('write verification failed: the record was not readable after commit');
        }
      });
    },

    /** @param {string} id @returns {Promise<boolean>} */
    remove(id) {
      return withDb(async (database) => {
        const tx = database.transaction(MISSION_STORE, 'readwrite');
        const store = tx.objectStore(MISSION_STORE);
        const existing = await requestDone(store.count(id));
        store.delete(id);
        await transactionDone(tx);
        return existing > 0;
      });
    },

    /**
     * Move aside, never delete (ADR 0005). Both stores are in one transaction,
     * so a record can never be gone from `missions` without being present in
     * `quarantine`.
     * @param {string} id @param {{ id: string }} envelope @returns {Promise<void>}
     */
    quarantine(id, envelope) {
      return withDb(async (database) => {
        const tx = database.transaction([MISSION_STORE, QUARANTINE_STORE], 'readwrite');
        tx.objectStore(QUARANTINE_STORE).put(envelope);
        tx.objectStore(MISSION_STORE).delete(id);
        await transactionDone(tx);
      });
    },

    /** @returns {Promise<unknown[]>} */
    readQuarantine() {
      return withDb(async (database) => {
        const tx = database.transaction(QUARANTINE_STORE, 'readonly');
        const values = await requestDone(tx.objectStore(QUARANTINE_STORE).getAll());
        await transactionDone(tx);
        return values;
      });
    },

    /**
     * The evidence trio (ADR 0012 §2), structurally identical to the mission
     * trio above but simpler: no quarantine dance and no read-back
     * verification, because evidence-repository.js's own posture is
     * best-effort — a write that fails is swallowed there, not confirmed here.
     * @param {string} id @returns {Promise<unknown>}
     */
    readEvidence(id) {
      return withDb(async (database) => {
        const tx = database.transaction(EVIDENCE_STORE, 'readonly');
        const value = await requestDone(tx.objectStore(EVIDENCE_STORE).get(id));
        await transactionDone(tx);
        return value;
      });
    },

    /** @param {{ id: string }} record @returns {Promise<void>} */
    writeEvidence(record) {
      return withDb(async (database) => {
        const tx = database.transaction(EVIDENCE_STORE, 'readwrite');
        try {
          tx.objectStore(EVIDENCE_STORE).put(record); // DataCloneError throws synchronously (F12)
        } catch (e) {
          try { tx.abort(); } catch { /* already dead */ }
          throw e;
        }
        await transactionDone(tx);
      });
    },

    /** @param {string} id @returns {Promise<void>} */
    removeEvidence(id) {
      return withDb(async (database) => {
        const tx = database.transaction(EVIDENCE_STORE, 'readwrite');
        tx.objectStore(EVIDENCE_STORE).delete(id);
        await transactionDone(tx);
      });
    },

    /**
     * The versions trio (M14). Shaped like the evidence trio — plain put, no
     * read-back — because a checkpoint is best-effort by design: the
     * repository tolerates a failed one, and the live mission record above
     * keeps the verified path. Filtering by mission happens in the
     * repository; at ≤ ~20 versions per mission an index would be ceremony.
     * @returns {Promise<unknown[]>}
     */
    readVersions() {
      return withDb(async (database) => {
        const tx = database.transaction(VERSION_STORE, 'readonly');
        const values = await requestDone(tx.objectStore(VERSION_STORE).getAll());
        await transactionDone(tx);
        return values;
      });
    },

    /** @param {{ id: string }} record @returns {Promise<void>} */
    writeVersion(record) {
      return withDb(async (database) => {
        const tx = database.transaction(VERSION_STORE, 'readwrite');
        try {
          tx.objectStore(VERSION_STORE).put(record); // DataCloneError throws synchronously (F12)
        } catch (e) {
          try { tx.abort(); } catch { /* already dead */ }
          throw e;
        }
        await transactionDone(tx);
      });
    },

    /** @param {string} id @returns {Promise<void>} */
    removeVersion(id) {
      return withDb(async (database) => {
        const tx = database.transaction(VERSION_STORE, 'readwrite');
        tx.objectStore(VERSION_STORE).delete(id);
        await transactionDone(tx);
      });
    },

    /**
     * Drop every version belonging to one mission, in one transaction, so a
     * deleted mission never leaves a partial history behind.
     * @param {string} missionId @returns {Promise<void>}
     */
    removeVersionsFor(missionId) {
      return withDb(async (database) => {
        const tx = database.transaction(VERSION_STORE, 'readwrite');
        const store = tx.objectStore(VERSION_STORE);
        const values = await requestDone(store.getAll());
        for (const value of values) {
          const record = /** @type {{ id?: unknown, missionId?: unknown }} */ (value);
          if (record?.missionId === missionId && typeof record.id === 'string') store.delete(record.id);
        }
        await transactionDone(tx);
      });
    },

    close() {
      closed = true;
      db?.close();
      db = null;
    },
  };
}
