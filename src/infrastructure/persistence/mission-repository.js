// mission-repository.js — the persistence port for mission documents
// (ADR 0005). Domain code never sees IndexedDB; it sees this.
//
// The port owns every mission *semantic* — migrate on read, validate on write,
// quarantine what cannot be read, mint a new identity for a duplicate, refuse
// an import that would land a half-mission. Underneath it, an adapter owns
// nothing but transport: get, getAll, put, delete, move-aside. Two adapters
// ship (`indexeddb-store.js`, `memory-store.js`) and the same contract suite
// runs against both, which is the only way to know the fallback is a fallback
// and not a different product.
//
// Four postures, each of which is a decision rather than an implementation
// detail:
//
//   **writes fail loudly.** `save` throws a typed `MissionRepositoryError` —
//     `quota-exceeded`, `not-clonable`, `verify-failed`, `invalid-document` —
//     rather than returning false or swallowing. R-OFFLINE F1/F2: swallowing is
//     right for preferences in store.js and catastrophic for the only copy of a
//     mission plan. The in-memory document stays usable and `exportJson` stays
//     reachable, which is what makes a full disk survivable.
//
//   **reads never hand back a half-mission.** Anything that fails
//     `migrateMission` is moved into the quarantine store — never deleted —
//     and reported by `quarantined()` so it can be exported and looked at. A
//     corrupt record disappears from `list()` because it is not a mission any
//     more; it does not disappear from the disk.
//
//   **durability is per call, defaulting to strict for saves.** Chrome 121
//     moved the browser default to `relaxed` (R-OFFLINE F11) and a mission save
//     is the write where the last few seconds matter.
//
//   **persistence is requested once, on the first save**, because that is the
//     moment the user has expressed durable intent (ADR 0005, R-OFFLINE §7).
//     The granted/denied answer is returned as data, not ignored — and the
//     export path, not `persist()`, is the actual guarantee.

import { migrateMission } from '../../domain/mission/mission-migrations.js';
import { ID_PREFIXES, defaultIdgen, validateMission } from '../../domain/mission/mission-schema.js';
import { openIndexedDbStore } from './indexeddb-store.js';
import { openMemoryStore } from './memory-store.js';

/** @typedef {import('../../domain/mission/mission-schema.js').MissionDocumentV1} MissionDocumentV1 */
/** @typedef {import('../../domain/mission/mission-schema.js').ValidationIssue} ValidationIssue */

/** @typedef {{ id: string, title: string, updatedAt: string }} MissionSummary */

/** @typedef {'manual'|'auto'|'restore'|'import'} VersionKind */

/**
 * One stored checkpoint: the whole document at a moment, plus why the moment
 * mattered. `seq` is per-mission and only ever grows — pruning old versions
 * never renumbers the survivors, so "v8" stays v8 for as long as it exists.
 * @typedef {object} VersionRecord
 * @property {string} id
 * @property {string} missionId
 * @property {number} seq
 * @property {VersionKind} kind
 * @property {string} savedAt
 * @property {MissionDocumentV1} doc
 */

/**
 * What a history timeline needs without hauling every full document out of the
 * store's raw records unexamined.
 * @typedef {object} VersionSummary
 * @property {string} id
 * @property {string} missionId
 * @property {number} seq
 * @property {VersionKind} kind
 * @property {string} savedAt
 * @property {string} title
 * @property {number} waypoints
 */

/** Versions kept per mission. Old ones fall off the end, newest-first. */
export const VERSION_KEEP = 20;

/** The four moments worth a checkpoint; anything else is a caller bug. */
const VERSION_KINDS = new Set(['manual', 'auto', 'restore', 'import']);

/**
 * @typedef {object} QuarantineEnvelope
 * @property {string} id
 * @property {string} quarantinedAt
 * @property {{ code: string, message: string }} reason
 * @property {unknown} record   kept verbatim so it can still be exported
 */

/**
 * The transport an adapter provides. Both shipped adapters satisfy it
 * structurally; anything else that does is a valid adapter.
 * @typedef {object} MissionStore
 * @property {'memory'|'indexeddb'} kind
 * @property {boolean} durable
 * @property {(id: string) => Promise<unknown>} read
 * @property {() => Promise<{ key: string, value: unknown }[]>} readAll
 * @property {(record: { id: string }, opts?: { durability?: IDBTransactionDurability }) => Promise<void>} write
 * @property {(id: string) => Promise<boolean>} remove
 * @property {(id: string, envelope: QuarantineEnvelope) => Promise<void>} quarantine
 * @property {() => Promise<unknown[]>} readQuarantine
 * @property {() => Promise<unknown[]>} readVersions
 * @property {(record: { id: string }) => Promise<void>} writeVersion
 * @property {(id: string) => Promise<void>} removeVersion
 * @property {(missionId: string) => Promise<void>} removeVersionsFor
 * @property {() => void} close
 */

/** A persistence failure with a code a caller can branch on. */
export class MissionRepositoryError extends Error {
  /**
   * @param {'invalid-document'|'invalid-argument'|'quota-exceeded'|'not-clonable'|'verify-failed'|'write-failed'} code
   * @param {string} message
   * @param {{ cause?: unknown, errors?: ValidationIssue[] }} [details]
   */
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'MissionRepositoryError';
    this.code = code;
    /** @type {ValidationIssue[]} */
    this.errors = details.errors ?? [];
  }
}

/**
 * @typedef {object} RepositoryDeps
 * @property {'auto'|'memory'|'indexeddb'} [adapter] 'auto' prefers IndexedDB
 *   and falls back to memory when it is absent or refuses to open
 * @property {IDBFactory} [indexedDB]
 * @property {string} [databaseName]
 * @property {Map<string, unknown>} [backing]     memory adapter's mission map
 * @property {Map<string, unknown>} [quarantine]  memory adapter's quarantine map
 * @property {Map<string, unknown>} [versions]    memory adapter's version map
 * @property {MissionStore} [store]               a ready-made adapter, used as-is
 * @property {StorageManager} [storage]           defaults to navigator.storage
 * @property {(prefix: string) => string} [idgen]
 * @property {() => string} [now]
 */

/**
 * Ask the browser to exempt this origin from best-effort eviction. Called once,
 * lazily, on the first save. Returns `true`/`false` for granted/denied and
 * `null` where the question cannot be asked — the three states are different
 * and flattening them to a boolean would report "denied" for Safari, where the
 * call is largely moot (R-OFFLINE F13).
 *
 * @param {StorageManager|undefined} storage
 * @returns {Promise<boolean|null>}
 */
async function requestPersistence(storage) {
  if (!storage || typeof storage.persist !== 'function' || typeof storage.persisted !== 'function') return null;
  try {
    if (await storage.persisted()) return true;
    return await storage.persist();
  } catch {
    return null; // a refused or unavailable permission is not a save failure
  }
}

/** @param {unknown} e @returns {MissionRepositoryError} */
function writeFailure(e) {
  const name = e instanceof Error ? e.name : '';
  const message = e instanceof Error ? e.message : String(e);
  if (name === 'QuotaExceededError') {
    return new MissionRepositoryError('quota-exceeded',
      'Device storage is full, so this mission was not saved. The mission is still open — '
      + 'export it to a file, then free space and save again.', { cause: e });
  }
  if (name === 'DataCloneError') {
    return new MissionRepositoryError('not-clonable',
      'This mission carries something that cannot be stored (a live object or a function). '
      + 'Mission documents must be plain data.', { cause: e });
  }
  if (message.startsWith('write verification failed')) {
    return new MissionRepositoryError('verify-failed',
      'The mission could not be read back after saving, so the save was not confirmed. '
      + 'The previous version is intact.', { cause: e });
  }
  return new MissionRepositoryError('write-failed', `The mission could not be saved: ${message}`, { cause: e });
}

/**
 * Structural equality, because a checkpoint that only re-stores the same
 * document is noise in a 20-slot history. JSON-shaped data only — mission
 * documents are plain data by contract (the store enforces it at write time).
 * @param {unknown} a @param {unknown} b @returns {boolean}
 */
function deepEquals(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  return keysA.every((k) => Object.hasOwn(b, k)
    && deepEquals(/** @type {Record<string, unknown>} */ (a)[k], /** @type {Record<string, unknown>} */ (b)[k]));
}

/**
 * Same mission content, ignoring the write clock: a flush that changed nothing
 * but `updatedAt` has nothing to say to the history.
 * @param {MissionDocumentV1} a @param {MissionDocumentV1} b
 */
function sameDoc(a, b) {
  return deepEquals({ ...a, updatedAt: '' }, { ...b, updatedAt: '' });
}

/**
 * Open a mission repository over the best available adapter.
 *
 * @param {RepositoryDeps} [deps]
 */
export async function openMissionRepository(deps = {}) {
  const idgen = deps.idgen ?? defaultIdgen;
  const now = deps.now ?? (() => new Date().toISOString());
  const storage = deps.storage ?? globalThis.navigator?.storage;
  const store = deps.store ?? await selectStore(deps);

  /** @type {boolean|null|undefined} undefined until the first save asks */
  let persisted;

  /**
   * Read one raw record and judge it. A record that cannot be migrated is moved
   * aside here, on the read that found it, so the same criterion decides for
   * `get` and for `list` and the two can never disagree about what is corrupt.
   *
   * @param {string} id @param {unknown} raw
   * @returns {Promise<MissionDocumentV1|null>}
   */
  async function accept(id, raw) {
    if (raw === undefined || raw === null) return null;
    const result = migrateMission(raw);
    if (result.ok && result.doc) return result.doc;
    const first = result.errors?.[0];
    await store.quarantine(id, {
      id,
      quarantinedAt: now(),
      reason: {
        code: first?.code ?? 'E-DOC-UNREADABLE',
        message: first?.message ?? 'This record could not be read as a mission.',
      },
      record: raw,
    });
    return null;
  }

  /**
   * @param {MissionDocumentV1} doc
   * @param {{ durability?: IDBTransactionDurability }} [opts]
   */
  async function persist(doc, opts = {}) {
    const durability = opts.durability ?? 'strict';
    const verdict = validateMission(doc);
    if (!verdict.ok) {
      throw new MissionRepositoryError('invalid-document',
        `This mission is not a valid v${1} document, so it was not saved: ${verdict.errors[0]?.message ?? ''}`,
        { errors: verdict.errors });
    }
    if (persisted === undefined) persisted = await requestPersistence(storage);
    try {
      await store.write(doc, { durability });
    } catch (e) {
      throw writeFailure(e);
    }
    return {
      ok: /** @type {const} */ (true),
      id: doc.id,
      updatedAt: doc.updatedAt,
      storage: { adapter: store.kind, durable: store.durable, durability, persisted: persisted ?? null },
    };
  }

  /**
   * Every stored version of one mission, newest first. Filtering happens here
   * rather than in the adapter because "which records belong to a mission" is
   * a repository semantic, and at ≤ VERSION_KEEP records it costs nothing.
   * @param {string} missionId
   * @returns {Promise<VersionRecord[]>}
   */
  async function versionRecords(missionId) {
    const raws = await store.readVersions();
    return /** @type {VersionRecord[]} */ (raws
      .filter((r) => /** @type {{ missionId?: unknown }} */ (r)?.missionId === missionId))
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
  }

  /**
   * Record one checkpoint. Best-effort by design: the live mission record is
   * the verified copy and a history that could veto a save would invert that,
   * so every failure here comes back as data, never a throw.
   *
   * The `updatedAt`-blind dedup applies only to `manual` and `auto` — a
   * `restore` or `import` is an *event*, and the mockup rule is explicit that
   * restoring creates a new version even when its content matches the newest.
   *
   * @param {MissionDocumentV1} doc
   * @param {VersionKind} kind
   * @returns {Promise<{ ok: true, id: string, seq: number, skipped: boolean }
   *   | { ok: false, message: string }>}
   */
  async function recordCheckpoint(doc, kind) {
    if (!doc || typeof doc.id !== 'string' || !doc.id) {
      return { ok: false, message: 'A checkpoint needs a mission document with an id.' };
    }
    if (!VERSION_KINDS.has(kind)) {
      return { ok: false, message: `"${kind}" is not a checkpoint kind.` };
    }
    try {
      const existing = await versionRecords(doc.id);
      const newest = existing[0];
      if (newest && (kind === 'manual' || kind === 'auto') && sameDoc(newest.doc, doc)) {
        return { ok: true, id: newest.id, seq: newest.seq, skipped: true };
      }
      /** @type {VersionRecord} */
      const record = {
        // 'ver' stays out of ID_PREFIXES on purpose: version identity is a
        // storage concern, not part of the mission document schema.
        id: idgen('ver'),
        missionId: doc.id,
        seq: (newest?.seq ?? 0) + 1,
        kind,
        savedAt: now(),
        doc,
      };
      await store.writeVersion(record);
      // Prune past the cap, oldest first. A failed prune is tolerated the same
      // way a failed write is: the checkpoint that mattered already landed.
      for (const old of existing.slice(VERSION_KEEP - 1)) {
        try { await store.removeVersion(old.id); } catch { /* prune is best-effort */ }
      }
      return { ok: true, id: record.id, seq: record.seq, skipped: false };
    } catch (e) {
      return { ok: false, message: writeFailure(e).message };
    }
  }

  return {
    /** Which adapter this repository ended up on — surfaced, not hidden. */
    adapter: store.kind,
    durable: store.durable,

    /**
     * Write the whole document in one transaction, verified.
     *
     * @param {MissionDocumentV1} doc
     * @param {{ durability?: IDBTransactionDurability }} [opts] `'strict'` by
     *   default: a mission save is the write worth waiting for
     */
    save(doc, opts = {}) {
      return persist(doc, opts);
    },

    /**
     * The mission, or `null` when it is missing or unreadable. An unreadable
     * record is quarantined on the way past — never returned half-built, never
     * deleted.
     * @param {string} id
     * @returns {Promise<MissionDocumentV1|null>}
     */
    async get(id) {
      if (typeof id !== 'string' || !id) return null;
      return accept(id, await store.read(id));
    },

    /**
     * Newest first, which is the order a "recent missions" list wants and the
     * only order that does not need a second index.
     * @returns {Promise<MissionSummary[]>}
     */
    async list() {
      const raws = await store.readAll();
      /** @type {MissionSummary[]} */ const summaries = [];
      for (const { key, value } of raws) {
        const doc = await accept(key, value);
        if (doc) summaries.push({ id: doc.id, title: doc.title, updatedAt: doc.updatedAt });
      }
      return summaries.sort((a, b) => {
        const delta = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
        return delta !== 0 ? delta : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
    },

    /** @param {string} id @returns {Promise<boolean>} true when something was there */
    async remove(id) {
      if (typeof id !== 'string' || !id) return false;
      const existed = await store.remove(id);
      // The history goes with the mission — unconditionally, so a version
      // orphaned by an earlier partial delete is swept on the next attempt.
      try { await store.removeVersionsFor(id); } catch { /* best-effort cleanup */ }
      return existed;
    },

    /**
     * A copy with its own identity. Only the mission id changes: waypoint and
     * segment ids are scoped to the document they live in, so keeping them
     * preserves every internal reference for free, and re-minting them would
     * break nothing but cost the copy its comparability with the original.
     * @param {string} id
     * @returns {Promise<MissionDocumentV1|null>}
     */
    async duplicate(id) {
      const original = await this.get(id);
      if (!original) return null;
      const at = now();
      /** @type {MissionDocumentV1} */
      const copy = {
        ...structuredClone(original),
        id: idgen(ID_PREFIXES.mission),
        title: `${original.title} copy`,
        createdAt: at,
        updatedAt: at,
        provenance: { ...original.provenance, origin: 'duplicated' },
      };
      await persist(copy);
      return copy;
    },

    /**
     * @param {string} id @param {string} title
     * @returns {Promise<MissionDocumentV1|null>}
     */
    async rename(id, title) {
      if (typeof title !== 'string') {
        throw new MissionRepositoryError('invalid-argument', 'A mission title must be text.');
      }
      const doc = await this.get(id);
      if (!doc) return null;
      /** @type {MissionDocumentV1} */
      const renamed = { ...doc, title, updatedAt: now() };
      await persist(renamed);
      return renamed;
    },

    /**
     * The backup escape hatch (ADR 0005, R-OFFLINE §5): self-contained JSON,
     * no server round trip, readable at a trailhead. The document *is* the
     * export format — it already carries its schema version, so the file that
     * comes out of here is the file `importJson` and `migrateMission` know how
     * to read, with no envelope in between to version separately.
     * @param {string} id
     * @returns {Promise<string|null>}
     */
    async exportJson(id) {
      const doc = await this.get(id);
      return doc ? JSON.stringify(doc, null, 2) : null;
    },

    /**
     * Read a mission back in from a file. Parses, migrates, validates, and only
     * then saves — a garbage file can never leave a partial record behind.
     *
     * On an id collision the import gets a fresh identity rather than silently
     * overwriting the mission already under that id; `replace: true` is how a
     * caller says they meant to overwrite. A re-identified import is stamped
     * `origin: 'imported'` with a note naming where it came from, because a
     * copy that claims to be the original is a lie the pilot will find later.
     *
     * @param {string} text
     * @param {{ replace?: boolean }} [opts]
     * @returns {Promise<{ ok: true, doc: MissionDocumentV1, id: string, fromVersion: number,
     *   warnings: ValidationIssue[], reidentified: boolean }
     *   | { ok: false, errors: ValidationIssue[] }>}
     */
    async importJson(text, opts = {}) {
      /** @type {unknown} */ let parsed;
      try {
        parsed = JSON.parse(typeof text === 'string' ? text : '');
      } catch (e) {
        return {
          ok: false,
          errors: [{
            path: '', code: 'E-IMPORT-PARSE',
            message: `This file is not readable JSON: ${e instanceof Error ? e.message : String(e)}`,
          }],
        };
      }
      const migrated = migrateMission(parsed);
      if (!migrated.ok || !migrated.doc) {
        return { ok: false, errors: migrated.errors ?? [] };
      }

      let doc = migrated.doc;
      let reidentified = false;
      if (!opts.replace && await store.read(doc.id) !== undefined) {
        const originalId = doc.id;
        doc = {
          ...doc,
          id: idgen(ID_PREFIXES.mission),
          updatedAt: now(),
          provenance: {
            ...doc.provenance,
            origin: 'imported',
            notes: `Imported alongside the existing mission ${originalId}.`,
          },
        };
        reidentified = true;
      }
      await persist(doc);
      return {
        ok: true,
        doc,
        id: doc.id,
        fromVersion: migrated.fromVersion ?? 1,
        warnings: migrated.warnings ?? [],
        reidentified,
      };
    },

    /**
     * Records that could not be read as missions, still on disk. This is what
     * "quarantined, not deleted" is worth: the raw record travels with the
     * reason, so it can be exported, inspected, or hand-repaired.
     * @returns {Promise<QuarantineEnvelope[]>}
     */
    async quarantined() {
      return /** @type {QuarantineEnvelope[]} */ (await store.readQuarantine());
    },

    /**
     * Record the document as a version checkpoint (M14, L-04/H-04). Never
     * throws: the live record is the guarantee, the history is the net under
     * it, and a net must not be able to fail the save it protects.
     * @param {MissionDocumentV1} doc
     * @param {VersionKind} [kind]
     */
    checkpoint(doc, kind = 'manual') {
      return recordCheckpoint(doc, kind);
    },

    /**
     * The history of one mission, newest first, as timeline-ready summaries.
     * @param {string} missionId
     * @returns {Promise<VersionSummary[]>}
     */
    async versions(missionId) {
      if (typeof missionId !== 'string' || !missionId) return [];
      const records = await versionRecords(missionId);
      return records.map((r) => ({
        id: r.id,
        missionId: r.missionId,
        seq: r.seq,
        kind: r.kind,
        savedAt: r.savedAt,
        title: typeof r.doc?.title === 'string' ? r.doc.title : 'Untitled mission',
        waypoints: Array.isArray(r.doc?.route?.waypoints) ? r.doc.route.waypoints.length : 0,
      }));
    },

    /**
     * Make a stored version the live document again. The restored document is
     * saved through the same validated, verified path as any other save (and
     * throws the same typed errors when that fails), and the restore itself is
     * recorded as a new checkpoint — the version being restored is never
     * deleted or rewound, so the history only ever moves forward.
     * @param {string} missionId @param {string} versionId
     * @returns {Promise<{ ok: true, doc: MissionDocumentV1 }
     *   | { ok: false, errors: ValidationIssue[] }>}
     */
    async restoreVersion(missionId, versionId) {
      if (typeof missionId !== 'string' || !missionId || typeof versionId !== 'string' || !versionId) {
        return {
          ok: false,
          errors: [{ path: '', code: 'E-VERSION-ARG', message: 'A restore needs a mission id and a version id.' }],
        };
      }
      const record = (await versionRecords(missionId)).find((r) => r.id === versionId);
      if (!record) {
        return {
          ok: false,
          errors: [{ path: '', code: 'E-VERSION-MISSING', message: 'That version is no longer in the history.' }],
        };
      }
      // Migrate on read, exactly like `get`: a version written by an older
      // build must come forward before it can become the live document.
      const migrated = migrateMission(record.doc);
      if (!migrated.ok || !migrated.doc) {
        return { ok: false, errors: migrated.errors ?? [] };
      }
      /** @type {MissionDocumentV1} */
      const restored = { ...migrated.doc, id: missionId, updatedAt: now() };
      await persist(restored);
      await recordCheckpoint(restored, 'restore');
      return { ok: true, doc: restored };
    },

    close() { store.close(); },
  };
}

/**
 * IndexedDB when there is one, memory when there is not. A browser that refuses
 * to open the database (old Firefox private windows, R-OFFLINE F6) gets a
 * working session rather than a dead app — a session that cannot outlive itself,
 * which the caller can see from `repository.durable`.
 *
 * @param {RepositoryDeps} deps
 * @returns {Promise<MissionStore>}
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
