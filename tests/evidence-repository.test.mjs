import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { openEvidenceRepository } from '../src/infrastructure/persistence/evidence-repository.js';
import { EVIDENCE_STORE } from '../src/infrastructure/persistence/indexeddb-store.js';

/* One contract, two adapters — the same posture mission-repository.test.mjs
 * takes, for the same reason: a fallback that behaves differently from the
 * durable store is a second product with its own bugs, discovered in the
 * field, not a fallback. What is different here is the contract itself —
 * evidence is derived, best-effort, and silent about its own failures
 * (ADR 0012 §2), where a mission is authoritative and loud about them. */

/** A TerrainField shaped closely enough to round-trip and carry provenance. */
function terrainField(missionId = 'msn_1') {
  return {
    missionId,
    revision: 'rev_1',
    samples: [
      {
        id: 'smp_1', stationId: 'stn_1', track: 'centre', lat: 30.30, lng: -97.80,
        distanceKm: 0, bearingDeg: 0, segmentId: null, groundMslM: 210, slopeDeg: 2,
        aspectDeg: 90, gradientBasis: 'along-track', source: 'provider',
      },
    ],
    byId: { smp_1: { id: 'smp_1' } },
    features: [],
    launchGroundMslM: 168,
    provenance: {
      source: 'open-meteo', dataset: 'copernicus-30m', resolutionM: 30,
      attribution: 'Copernicus DEM', retrievedAt: '2026-07-28T12:00:00.000Z',
      spacingM: 50, corridorWidthM: 100, requested: 4, cacheHits: 0, fetched: 4,
      missing: 0, coverage: 'complete', notes: [],
    },
  };
}

/** An AdvisoryGridField shaped closely enough to round-trip and carry provenance. */
function advisoryGrid() {
  return {
    grid: {
      rows: 2, cols: 2, cellSizeM: 25,
      cells: [
        { lat: 30.30, lng: -97.80, elevM: 210 },
        { lat: 30.30, lng: -97.79, elevM: 212 },
        { lat: 30.29, lng: -97.80, elevM: 208 },
        { lat: 30.29, lng: -97.79, elevM: 209 },
      ],
    },
    provenance: {
      source: 'open-meteo', dataset: 'copernicus-30m', resolutionM: 30,
      attribution: 'Copernicus DEM', retrievedAt: '2026-07-28T12:00:00.000Z',
      requested: 4, cacheHits: 0, fetched: 4, missing: 0, coverage: 'complete', notes: [],
    },
  };
}

function evidenceRecord(id = 'msn_1') {
  return {
    id,
    savedAt: '2026-07-28T12:00:05.000Z',
    terrainField: terrainField(id),
    advisoryGrid: advisoryGrid(),
    profile: { bearingDeg: 45, samples: [{ distanceKm: 0, groundMslM: 168 }] },
  };
}

/* ---------- the two environments ---------- */

function memoryEnv() {
  return { kind: 'memory', durable: false, deps: { adapter: 'memory' } };
}

function indexedDbEnv() {
  const indexedDB = new IDBFactory();
  return { kind: 'indexeddb', durable: true, deps: { adapter: 'indexeddb', indexedDB }, indexedDB };
}

/** Plant a raw record directly into the evidence store, bypassing the repository. */
async function plantMemory(deps, record) {
  const evidence = deps.evidence ?? (deps.evidence = new Map());
  evidence.set(record.id, record);
}

async function plantIndexedDb(env, record) {
  const db = await new Promise((resolve, reject) => {
    const req = env.indexedDB.open('fpv-planner', 1);
    req.onupgradeneeded = () => {
      for (const name of ['missions', 'quarantine', 'evidence']) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction(EVIDENCE_STORE, 'readwrite');
    tx.objectStore(EVIDENCE_STORE).put(record);
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

const ENVIRONMENTS = [
  { make: memoryEnv, plant: plantMemory },
  { make: indexedDbEnv, plant: (env, record) => plantIndexedDb(env, record) },
];

/* ---------- the contract, run against both adapters ---------- */

for (const { make, plant } of ENVIRONMENTS) {
  const { kind } = make();

  const openRepo = async (t) => {
    const env = make();
    const repo = await openEvidenceRepository(env.deps);
    t.after(() => repo.close());
    return { repo, env };
  };

  test(`[${kind}] saved evidence comes back exactly as it went in, provenance included`, async (t) => {
    const { repo } = await openRepo(t);
    const record = evidenceRecord();
    await repo.save(record);
    const read = await repo.get('msn_1');
    assert.deepEqual(read, record);
    assert.deepEqual(read.terrainField.provenance, record.terrainField.provenance);
    assert.deepEqual(read.advisoryGrid.provenance, record.advisoryGrid.provenance);
  });

  test(`[${kind}] saving the same mission id again replaces the whole record`, async (t) => {
    const { repo } = await openRepo(t);
    await repo.save(evidenceRecord());
    const replacement = { ...evidenceRecord(), savedAt: '2026-07-28T13:00:00.000Z', advisoryGrid: null };
    await repo.save(replacement);
    const read = await repo.get('msn_1');
    assert.equal(read.savedAt, '2026-07-28T13:00:00.000Z');
    assert.equal(read.advisoryGrid, null, 'no leftovers from the earlier version');
  });

  test(`[${kind}] a missing mission's evidence is null, not an error`, async (t) => {
    const { repo } = await openRepo(t);
    assert.equal(await repo.get('msn_nope'), null);
    assert.equal(await repo.get(''), null);
    assert.equal(await repo.get(null), null);
  });

  test(`[${kind}] removing a mission removes its evidence`, async (t) => {
    const { repo } = await openRepo(t);
    await repo.save(evidenceRecord());
    await repo.remove('msn_1');
    assert.equal(await repo.get('msn_1'), null);
  });

  test(`[${kind}] removing evidence that was never saved is a no-op, not an error`, async (t) => {
    const { repo } = await openRepo(t);
    await assert.doesNotReject(() => repo.remove('msn_never_existed'));
  });

  test(`[${kind}] a corrupt record is discarded silently and deleted`, async (t) => {
    const { repo, env } = await openRepo(t);
    await plant(env, { id: 'msn_1', title: 'not evidence at all' });

    const read = await repo.get('msn_1');
    assert.equal(read, null, 'never handed back half-shaped');

    // The bad record is gone, not just ignored — a second read still finds nothing,
    // and a fresh save is free to use the id without fighting a stale corpse.
    await repo.save(evidenceRecord());
    assert.deepEqual(await repo.get('msn_1'), evidenceRecord());
  });

  test(`[${kind}] a record with an unparsable savedAt is treated as corrupt`, async (t) => {
    const { repo, env } = await openRepo(t);
    await plant(env, { ...evidenceRecord(), savedAt: 'not-a-date' });
    assert.equal(await repo.get('msn_1'), null);
  });
}

/* ---------- the failure taxonomy: swallowed, not surfaced ---------- */

/** A store whose writeEvidence always fails the way a full disk would. */
function quotaFailingStore() {
  return {
    kind: 'memory',
    durable: false,
    async readEvidence() { return undefined; },
    async writeEvidence() { throw new DOMException('simulated quota', 'QuotaExceededError'); },
    async removeEvidence() {},
    close() {},
  };
}

test('a quota-style write failure is swallowed, not surfaced', async (t) => {
  const repo = await openEvidenceRepository({ store: quotaFailingStore() });
  t.after(() => repo.close());

  const originalWarn = console.warn;
  let warned = 0;
  console.warn = (...args) => { warned += 1; originalWarn(...args); };
  t.after(() => { console.warn = originalWarn; });

  await assert.doesNotReject(() => repo.save(evidenceRecord()));
  assert.equal(warned, 1, 'the failure is logged, not silent, but never thrown');
});

test('a read failure is treated as absent, not an error', async (t) => {
  const store = {
    kind: 'memory', durable: false,
    async readEvidence() { throw new Error('simulated read failure'); },
    async writeEvidence() {},
    async removeEvidence() {},
    close() {},
  };
  const repo = await openEvidenceRepository({ store });
  t.after(() => repo.close());
  assert.equal(await repo.get('msn_1'), null);
});

test('a remove failure never throws — there is nothing left to protect', async (t) => {
  const store = {
    kind: 'memory', durable: false,
    async readEvidence() { return undefined; },
    async writeEvidence() {},
    async removeEvidence() { throw new Error('simulated remove failure'); },
    close() {},
  };
  const repo = await openEvidenceRepository({ store });
  t.after(() => repo.close());
  await assert.doesNotReject(() => repo.remove('msn_1'));
});

/* ---------- choosing an adapter ---------- */

test('with no IndexedDB in sight, the repository falls back to memory and admits it', async (t) => {
  const repo = await openEvidenceRepository({});
  t.after(() => repo.close());
  assert.equal(repo.adapter, 'memory');
  assert.equal(repo.durable, false);
});

test('an explicit indexeddb request is not silently downgraded', async (t) => {
  const indexedDB = new IDBFactory();
  const repo = await openEvidenceRepository({ adapter: 'indexeddb', indexedDB });
  t.after(() => repo.close());
  assert.equal(repo.adapter, 'indexeddb');
  assert.equal(repo.durable, true);
});
