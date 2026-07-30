import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { createMission, validateMission } from '../src/domain/mission/mission-schema.js';
import { missionReduce } from '../src/domain/mission/mission-reducer.js';
import {
  MissionRepositoryError, openMissionRepository,
} from '../src/infrastructure/persistence/mission-repository.js';
import {
  DATABASE_NAME, DATABASE_VERSION, MISSION_STORE, QUARANTINE_STORE, EVIDENCE_STORE,
} from '../src/infrastructure/persistence/indexeddb-store.js';

/* One contract, two adapters. Everything under "the contract" runs identically
 * against the Map-backed fallback and against a real IndexedDB implementation
 * (fake-indexeddb, a fresh factory per test), because a fallback that behaves
 * differently from the durable store is not a fallback — it is a second product
 * with its own bugs, discovered in the field.
 *
 * The adapter-specific sections below cover what only one of them can show:
 * the database layout ADR 0005 specifies, and the failure taxonomy, which is
 * driven through an injected store that fails on demand rather than by trying
 * to genuinely fill a disk. */

const AUSTIN = { latitude: 30.2672, longitude: -97.7431, elevationMslM: 168 };

function harness() {
  let ids = 0;
  let ticks = 0;
  return {
    idgen: (prefix) => `${prefix}_${++ids}`,
    now: () => new Date(Date.UTC(2026, 6, 30, 12, 0, ticks++)).toISOString(),
  };
}

/** A valid, routed mission — the thing this repository exists to keep. */
function makeMission(deps, title = 'Pedernales ridge run') {
  const doc = createMission({ launch: AUSTIN, title }, deps);
  return [
    { type: 'addWaypoint', payload: { latitude: 30.30, longitude: -97.80 } },
    { type: 'addWaypoint', payload: { latitude: 30.40, longitude: -97.90, intent: 'orbit', holdS: 40 } },
  ].reduce((d, c) => missionReduce(d, c, deps), doc);
}

/* ---------- the two environments ---------- */

/** @returns {{ kind: string, deps: object, plant: (record: object) => Promise<void> }} */
function memoryEnv(deps) {
  const backing = new Map();
  return {
    kind: 'memory',
    durable: false,
    deps: { ...deps, adapter: 'memory', backing, quarantine: new Map() },
    async plant(record) { backing.set(record.id, record); },
  };
}

function indexedDbEnv(deps) {
  const indexedDB = new IDBFactory();
  return {
    kind: 'indexeddb',
    durable: true,
    deps: { ...deps, adapter: 'indexeddb', indexedDB },
    async plant(record) { await rawPut(indexedDB, MISSION_STORE, record); },
  };
}

/** Open the database the way the adapter does, without going through it. */
function rawOpen(factory) {
  return new Promise((resolve, reject) => {
    const req = factory.open(DATABASE_NAME, DATABASE_VERSION);
    req.onupgradeneeded = () => {
      for (const name of [MISSION_STORE, QUARANTINE_STORE, EVIDENCE_STORE]) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function rawPut(factory, storeName, record) {
  const db = await rawOpen(factory);
  await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(record);
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function rawGetAll(factory, storeName) {
  const db = await rawOpen(factory);
  const values = await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return values;
}

const ENVIRONMENTS = [memoryEnv, indexedDbEnv];

/* ---------- the contract, run against both adapters ---------- */

for (const makeEnv of ENVIRONMENTS) {
  const { kind } = makeEnv({});

  /** Open a repository on a fresh store, closed when the test ends. */
  const openRepo = async (t, deps = harness()) => {
    const env = makeEnv(deps);
    const repo = await openMissionRepository(env.deps);
    t.after(() => repo.close());
    return { repo, env, deps };
  };

  test(`[${kind}] a saved mission comes back exactly as it went in`, async (t) => {
    const { repo, deps } = await openRepo(t);
    const doc = makeMission(deps);
    const receipt = await repo.save(doc);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.id, doc.id);
    assert.equal(receipt.updatedAt, doc.updatedAt);

    const read = await repo.get(doc.id);
    assert.deepEqual(read, doc);
    assert.notEqual(read, doc, 'the store hands back a copy, not a live reference');
  });

  test(`[${kind}] a mutation of a returned document does not reach the store`, async (t) => {
    const { repo, deps } = await openRepo(t);
    const doc = makeMission(deps);
    await repo.save(doc);
    const read = await repo.get(doc.id);
    read.title = 'Tampered';
    read.route.waypoints.pop();
    assert.deepEqual(await repo.get(doc.id), doc);
  });

  test(`[${kind}] the save receipt states the storage posture it got`, async (t) => {
    const { repo, env, deps } = await openRepo(t);
    const receipt = await repo.save(makeMission(deps));
    assert.deepEqual(receipt.storage, {
      adapter: env.kind, durable: env.durable, durability: 'strict', persisted: null,
    });
    assert.equal(repo.adapter, env.kind);
    assert.equal(repo.durable, env.durable, 'a session-only store says so out loud');
  });

  test(`[${kind}] durability is per call and defaults to strict`, async (t) => {
    const { repo, deps } = await openRepo(t);
    const doc = makeMission(deps);
    assert.equal((await repo.save(doc)).storage.durability, 'strict');
    const relaxed = await repo.save({ ...doc, title: 'Autosave' }, { durability: 'relaxed' });
    assert.equal(relaxed.storage.durability, 'relaxed');
    assert.equal((await repo.get(doc.id)).title, 'Autosave');
  });

  test(`[${kind}] saving the same id again replaces the whole document`, async (t) => {
    const { repo, deps } = await openRepo(t);
    const doc = makeMission(deps);
    await repo.save(doc);
    const edited = missionReduce(doc, { type: 'removeWaypoint', payload: { id: doc.route.waypoints[0].id } }, deps);
    await repo.save(edited);
    const read = await repo.get(doc.id);
    assert.equal(read.route.waypoints.length, 1, 'no leftovers from the longer version');
    assert.deepEqual(read, edited);
    assert.equal((await repo.list()).length, 1);
  });

  test(`[${kind}] a missing mission is null, not an error`, async (t) => {
    const { repo } = await openRepo(t);
    assert.equal(await repo.get('msn_nope'), null);
    assert.equal(await repo.get(''), null);
    assert.equal(await repo.get(null), null);
    assert.equal(await repo.exportJson('msn_nope'), null);
    assert.equal(await repo.duplicate('msn_nope'), null);
    assert.equal(await repo.rename('msn_nope', 'x'), null);
    assert.equal(await repo.remove('msn_nope'), false);
  });

  test(`[${kind}] list is newest first and carries only what a picker needs`, async (t) => {
    const { repo, deps } = await openRepo(t);
    const first = makeMission(deps, 'First');
    const second = makeMission(deps, 'Second');
    const third = makeMission(deps, 'Third');
    for (const doc of [second, third, first]) await repo.save(doc);

    const listed = await repo.list();
    assert.deepEqual(listed.map((m) => m.title), ['Third', 'Second', 'First']);
    assert.deepEqual(Object.keys(listed[0]).sort(), ['id', 'title', 'updatedAt']);
    assert.equal(listed[0].id, third.id);
  });

  test(`[${kind}] an empty store lists nothing`, async (t) => {
    const { repo } = await openRepo(t);
    assert.deepEqual(await repo.list(), []);
    assert.deepEqual(await repo.quarantined(), []);
  });

  test(`[${kind}] remove says whether there was anything there`, async (t) => {
    const { repo, deps } = await openRepo(t);
    const doc = makeMission(deps);
    await repo.save(doc);
    assert.equal(await repo.remove(doc.id), true);
    assert.equal(await repo.remove(doc.id), false);
    assert.equal(await repo.get(doc.id), null);
    assert.deepEqual(await repo.list(), []);
  });

  test(`[${kind}] rename changes the title, the clock, and nothing else`, async (t) => {
    const { repo, deps } = await openRepo(t);
    const doc = makeMission(deps);
    await repo.save(doc);
    const renamed = await repo.rename(doc.id, 'Bull Creek at golden hour');
    assert.equal(renamed.title, 'Bull Creek at golden hour');
    assert.equal(renamed.id, doc.id);
    assert.equal(renamed.createdAt, doc.createdAt);
    assert.notEqual(renamed.updatedAt, doc.updatedAt);
    assert.deepEqual(renamed.route, doc.route);
    assert.deepEqual(await repo.get(doc.id), renamed, 'and it was persisted, not just returned');
  });

  test(`[${kind}] rename refuses a title that is not text`, async (t) => {
    const { repo, deps } = await openRepo(t);
    const doc = makeMission(deps);
    await repo.save(doc);
    await assert.rejects(() => repo.rename(doc.id, 42), (e) => {
      assert.ok(e instanceof MissionRepositoryError);
      assert.equal(e.code, 'invalid-argument');
      return true;
    });
    assert.equal((await repo.get(doc.id)).title, doc.title);
  });

  test(`[${kind}] duplicate gets its own identity and keeps the route intact`, async (t) => {
    const { repo, deps } = await openRepo(t);
    const doc = makeMission(deps);
    await repo.save(doc);
    const copy = await repo.duplicate(doc.id);

    assert.notEqual(copy.id, doc.id);
    assert.match(copy.id, /^msn_/);
    assert.equal(copy.title, 'Pedernales ridge run copy');
    assert.equal(copy.provenance.origin, 'duplicated');
    assert.equal(copy.createdAt, copy.updatedAt, 'the copy is new, whatever age the original was');
    assert.deepEqual(copy.route, doc.route, 'waypoint and segment ids are scoped to the document, so they travel');
    assert.deepEqual(validateMission(copy).errors, []);

    assert.deepEqual(await repo.get(doc.id), doc, 'the original is untouched');
    assert.deepEqual(await repo.get(copy.id), copy, 'and the copy was saved, not just returned');
    assert.equal((await repo.list()).length, 2);
  });

  test(`[${kind}] a duplicate of a duplicate does not share state with either`, async (t) => {
    const { repo, deps } = await openRepo(t);
    const doc = makeMission(deps);
    await repo.save(doc);
    const copy = await repo.duplicate(doc.id);
    const copyOfCopy = await repo.duplicate(copy.id);
    assert.equal(copyOfCopy.title, 'Pedernales ridge run copy copy');
    assert.equal(new Set([doc.id, copy.id, copyOfCopy.id]).size, 3);
  });

  test(`[${kind}] export produces the file import reads back`, async (t) => {
    const { repo, deps } = await openRepo(t);
    const doc = makeMission(deps);
    await repo.save(doc);

    const json = await repo.exportJson(doc.id);
    assert.deepEqual(JSON.parse(json), doc, 'the document is the export format — no envelope in between');
    assert.match(json, /\n {2}"schemaVersion": 1/, 'and it is readable by a human at a trailhead');

    await repo.remove(doc.id);
    const imported = await repo.importJson(json);
    assert.equal(imported.ok, true);
    assert.equal(imported.reidentified, false);
    assert.equal(imported.fromVersion, 1);
    assert.deepEqual(imported.doc, doc, 'a round trip through a file changes nothing');
    assert.deepEqual(await repo.get(doc.id), doc);
  });

  test(`[${kind}] importing a mission that is already here does not overwrite it`, async (t) => {
    const { repo, deps } = await openRepo(t);
    const doc = makeMission(deps);
    await repo.save(doc);
    const json = await repo.exportJson(doc.id);
    await repo.rename(doc.id, 'The one I have been editing');

    const imported = await repo.importJson(json);
    assert.equal(imported.ok, true);
    assert.equal(imported.reidentified, true);
    assert.notEqual(imported.id, doc.id);
    assert.equal(imported.doc.provenance.origin, 'imported');
    assert.match(imported.doc.provenance.notes, new RegExp(doc.id));
    assert.equal((await repo.get(doc.id)).title, 'The one I have been editing', 'the local edit survived');
    assert.equal((await repo.list()).length, 2);
  });

  test(`[${kind}] an import that means to replace says so`, async (t) => {
    const { repo, deps } = await openRepo(t);
    const doc = makeMission(deps);
    await repo.save(doc);
    const json = await repo.exportJson(doc.id);
    await repo.rename(doc.id, 'Local edits about to be discarded');

    const imported = await repo.importJson(json, { replace: true });
    assert.equal(imported.ok, true);
    assert.equal(imported.id, doc.id);
    assert.equal(imported.reidentified, false);
    assert.deepEqual(await repo.get(doc.id), doc);
    assert.equal((await repo.list()).length, 1);
  });

  const garbage = [
    ['an empty file', '', 'E-IMPORT-PARSE'],
    ['a truncated write', '{"schemaVersion":1,"id":"msn_1"', 'E-IMPORT-PARSE'],
    ['a photo somebody renamed', ' PNG', 'E-IMPORT-PARSE'],
    ['nothing at all', null, 'E-IMPORT-PARSE'],
    ['valid JSON that is not a mission', '{"hello":"world"}', 'E-DOC-VERSION-MISSING'],
    ['a JSON null', 'null', 'E-DOC-NOT-OBJECT'],
    ['a JSON array', '[]', 'E-DOC-NOT-OBJECT'],
    ['a bare number', '42', 'E-DOC-NOT-OBJECT'],
    ['a mission from a newer app', '{"schemaVersion":2,"id":"msn_x"}', 'E-DOC-VERSION-FUTURE'],
  ];

  for (const [label, text, code] of garbage) {
    test(`[${kind}] importing ${label} fails safely and writes nothing`, async (t) => {
      const { repo, deps } = await openRepo(t);
      const doc = makeMission(deps);
      await repo.save(doc);

      const result = await repo.importJson(text);
      assert.equal(result.ok, false);
      assert.equal(result.errors[0].code, code);
      assert.ok(result.errors[0].message.length > 0, 'and it says something a person can act on');
      assert.deepEqual(await repo.list(), [{ id: doc.id, title: doc.title, updatedAt: doc.updatedAt }],
        'no half-mission left behind');
      assert.deepEqual(await repo.quarantined(), [], 'a file that never landed is not a corrupt record');
    });
  }

  test(`[${kind}] importing a half-written mission fails on the fields it is missing`, async (t) => {
    const { repo, deps } = await openRepo(t);
    const half = makeMission(deps);
    delete half.route;
    const result = await repo.importJson(JSON.stringify(half));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === 'E-ROUTE-MISSING'));
    assert.deepEqual(await repo.list(), []);
  });

  test(`[${kind}] a document that is not a valid mission is never written`, async (t) => {
    const { repo, deps } = await openRepo(t);
    const broken = { ...makeMission(deps), launch: null };
    await assert.rejects(() => repo.save(broken), (e) => {
      assert.ok(e instanceof MissionRepositoryError);
      assert.equal(e.code, 'invalid-document');
      assert.ok(e.errors.some((issue) => issue.code === 'E-LAUNCH-MISSING'));
      return true;
    });
    assert.deepEqual(await repo.list(), []);
  });

  test(`[${kind}] a write that cannot be cloned leaves the previous version intact`, async (t) => {
    const { repo, deps } = await openRepo(t);
    const doc = makeMission(deps, 'The version worth keeping');
    await repo.save(doc);

    // A live object where plain data belongs: R-OFFLINE F12. It passes
    // validation — nothing here inspects cameraProfile — and dies at the store.
    const poisoned = {
      ...doc,
      title: 'Never lands',
      scene: { ...doc.scene, cameraProfile: { render: () => 'a function is not data' } },
    };
    assert.equal(validateMission(poisoned).ok, true, 'the validator has no opinion about this');

    await assert.rejects(() => repo.save(poisoned), (e) => {
      assert.ok(e instanceof MissionRepositoryError);
      assert.equal(e.code, 'not-clonable');
      return true;
    });
    assert.deepEqual(await repo.get(doc.id), doc, 'the previous version is exactly where it was');
    assert.equal((await repo.list()).length, 1);
  });

  test(`[${kind}] an unreadable record is quarantined on the read that finds it`, async (t) => {
    const { repo, env, deps } = await openRepo(t);
    const good = makeMission(deps, 'Still fine');
    await repo.save(good);
    await env.plant({ id: 'msn_corrupt', schemaVersion: 1, title: 'Half a mission' });

    assert.equal(await repo.get('msn_corrupt'), null, 'never returned half-built');

    const [envelope] = await repo.quarantined();
    assert.equal(envelope.id, 'msn_corrupt');
    assert.ok(envelope.reason.code.startsWith('E-'));
    assert.ok(envelope.reason.message.length > 0);
    assert.deepEqual(envelope.record, { id: 'msn_corrupt', schemaVersion: 1, title: 'Half a mission' },
      'the raw record travels with the reason, so it can still be exported');
    assert.ok(!Number.isNaN(Date.parse(envelope.quarantinedAt)));

    assert.deepEqual((await repo.list()).map((m) => m.id), [good.id], 'gone from the list, not gone from the disk');
  });

  test(`[${kind}] list quarantines what it cannot read and returns the rest`, async (t) => {
    const { repo, env, deps } = await openRepo(t);
    const good = makeMission(deps, 'Readable');
    await repo.save(good);
    await env.plant({ id: 'msn_future', schemaVersion: 99, title: 'From a newer app' });
    await env.plant({ id: 'msn_nonsense', title: 'No version at all' });

    assert.deepEqual((await repo.list()).map((m) => m.id), [good.id]);
    const quarantined = await repo.quarantined();
    assert.deepEqual(quarantined.map((q) => q.id).sort(), ['msn_future', 'msn_nonsense']);
    assert.deepEqual(quarantined.find((q) => q.id === 'msn_future').reason.code, 'E-DOC-VERSION-FUTURE');
    assert.deepEqual(quarantined.find((q) => q.id === 'msn_nonsense').reason.code, 'E-DOC-VERSION-MISSING');
    assert.deepEqual(await repo.list(), [{ id: good.id, title: good.title, updatedAt: good.updatedAt }],
      'and a second pass does not re-quarantine anything');
  });

  test(`[${kind}] a repaired mission can be saved back over a quarantined id`, async (t) => {
    const { repo, env, deps } = await openRepo(t);
    await env.plant({ id: 'msn_corrupt', schemaVersion: 1, title: 'Half a mission' });
    await repo.get('msn_corrupt');

    const repaired = { ...makeMission(deps, 'Repaired'), id: 'msn_corrupt' };
    await repo.save(repaired);
    assert.deepEqual(await repo.get('msn_corrupt'), repaired);
    assert.equal((await repo.quarantined()).length, 1, 'the quarantined copy is kept for comparison');
  });
}

/* ---------- the database ADR 0005 describes ---------- */

test('[indexeddb] the database is fpv-planner, with missions, quarantine and evidence', async (t) => {
  const indexedDB = new IDBFactory();
  const repo = await openMissionRepository({ adapter: 'indexeddb', indexedDB, ...harness() });
  t.after(() => repo.close());

  const db = await rawOpen(indexedDB);
  t.after(() => db.close());
  assert.equal(db.name, DATABASE_NAME);
  assert.equal(db.version, DATABASE_VERSION);
  assert.deepEqual([...db.objectStoreNames].sort(), ['evidence', 'missions', 'quarantine'],
    'evidence exists from version 1 so M2 never has to bump the version on a running tab');
  assert.equal(db.transaction(MISSION_STORE).objectStore(MISSION_STORE).keyPath, 'id');
});

test('[indexeddb] the mission is stored whole, under its own id', async (t) => {
  const deps = harness();
  const indexedDB = new IDBFactory();
  const repo = await openMissionRepository({ adapter: 'indexeddb', indexedDB, ...deps });
  t.after(() => repo.close());

  const doc = makeMission(deps);
  await repo.save(doc);
  assert.deepEqual(await rawGetAll(indexedDB, MISSION_STORE), [doc],
    'one record per mission, no shredding into rows');
});

test('[indexeddb] quarantine moves the record aside rather than deleting it', async (t) => {
  const indexedDB = new IDBFactory();
  const repo = await openMissionRepository({ adapter: 'indexeddb', indexedDB, ...harness() });
  t.after(() => repo.close());

  await rawPut(indexedDB, MISSION_STORE, { id: 'msn_corrupt', schemaVersion: 1 });
  await repo.get('msn_corrupt');

  assert.deepEqual(await rawGetAll(indexedDB, MISSION_STORE), []);
  const [envelope] = await rawGetAll(indexedDB, QUARANTINE_STORE);
  assert.deepEqual(envelope.record, { id: 'msn_corrupt', schemaVersion: 1 });
});

test('[indexeddb] a fresh connection sees what the previous one saved', async (t) => {
  const deps = harness();
  const indexedDB = new IDBFactory();
  const first = await openMissionRepository({ adapter: 'indexeddb', indexedDB, ...deps });
  const doc = makeMission(deps);
  await first.save(doc);
  first.close();

  const second = await openMissionRepository({ adapter: 'indexeddb', indexedDB, ...deps });
  t.after(() => second.close());
  assert.deepEqual(await second.get(doc.id), doc, 'this is the whole point of the durable adapter');
});

/* ---------- choosing an adapter ---------- */

test('with no IndexedDB in sight, the repository falls back to memory and admits it', async (t) => {
  const repo = await openMissionRepository({ ...harness() });
  t.after(() => repo.close());
  assert.equal(repo.adapter, 'memory', 'node has no indexedDB, which is the same shape as a locked-down browser');
  assert.equal(repo.durable, false);
});

test('a browser that refuses to open the database still gets a working session', async (t) => {
  const refusing = {
    open() {
      const req = { onerror: null, onsuccess: null, onupgradeneeded: null, onblocked: null, error: new Error('denied') };
      queueMicrotask(() => req.onerror?.());
      return req;
    },
  };
  const repo = await openMissionRepository({ indexedDB: refusing, ...harness() });
  t.after(() => repo.close());
  assert.equal(repo.adapter, 'memory');

  const deps = harness();
  const doc = makeMission(deps);
  await repo.save(doc);
  assert.deepEqual(await repo.get(doc.id), doc, 'a session that cannot outlive itself is still a session');
});

test('an explicit indexeddb request is not silently downgraded', async (t) => {
  const indexedDB = new IDBFactory();
  const repo = await openMissionRepository({ adapter: 'indexeddb', indexedDB, ...harness() });
  t.after(() => repo.close());
  assert.equal(repo.adapter, 'indexeddb');
  assert.equal(repo.durable, true);
});

/* ---------- persistence permission (ADR 0005, R-OFFLINE §7) ---------- */

test('persistence is requested once, on the first save', async (t) => {
  let asked = 0;
  const storage = { persisted: async () => false, persist: async () => { asked++; return true; } };
  const deps = harness();
  const repo = await openMissionRepository({ adapter: 'memory', storage, ...deps });
  t.after(() => repo.close());

  assert.equal(asked, 0, 'opening a repository is not durable intent');
  const first = await repo.save(makeMission(deps, 'One'));
  assert.equal(asked, 1);
  assert.equal(first.storage.persisted, true);

  const second = await repo.save(makeMission(deps, 'Two'));
  assert.equal(asked, 1, 'asked once per session, not once per save');
  assert.equal(second.storage.persisted, true);
});

test('an origin that is already persistent is not asked again', async (t) => {
  let asked = 0;
  const storage = { persisted: async () => true, persist: async () => { asked++; return true; } };
  const deps = harness();
  const repo = await openMissionRepository({ adapter: 'memory', storage, ...deps });
  t.after(() => repo.close());
  assert.equal((await repo.save(makeMission(deps))).storage.persisted, true);
  assert.equal(asked, 0);
});

test('a denied or unavailable permission is reported, not treated as a failure', async (t) => {
  const deps = harness();
  const cases = [
    [{ persisted: async () => false, persist: async () => false }, false],
    [{ persisted: async () => { throw new Error('nope'); }, persist: async () => true }, null],
    [{}, null],
    [undefined, null],
  ];
  for (const [storage, expected] of cases) {
    const repo = await openMissionRepository({ adapter: 'memory', storage, ...deps });
    t.after(() => repo.close());
    const receipt = await repo.save(makeMission(deps));
    assert.equal(receipt.ok, true, 'the mission is saved either way');
    assert.equal(receipt.storage.persisted, expected);
  }
});

/* ---------- the failure taxonomy ---------- */

/** A store that behaves until told to fail, so the error mapping can be driven. */
function scriptedStore(fail) {
  const missions = new Map();
  const quarantine = new Map();
  return {
    kind: 'memory',
    durable: false,
    async read(id) { return missions.get(id); },
    async readAll() { return [...missions].map(([key, value]) => ({ key, value })); },
    async write(record) {
      const error = fail(record);
      if (error) throw error;
      missions.set(record.id, record);
    },
    async remove(id) { return missions.delete(id); },
    async quarantine(id, envelope) { quarantine.set(id, envelope); missions.delete(id); },
    async readQuarantine() { return [...quarantine.values()]; },
    close() {},
  };
}

/** DOMException is how browsers name these; Node has it too. */
const domException = (name) => new DOMException(`simulated ${name}`, name);

test('a full disk is reported as a full disk, with the export path still open', async (t) => {
  const deps = harness();
  const repo = await openMissionRepository({ store: scriptedStore(() => domException('QuotaExceededError')), ...deps });
  t.after(() => repo.close());

  await assert.rejects(() => repo.save(makeMission(deps)), (e) => {
    assert.equal(e.code, 'quota-exceeded');
    assert.match(e.message, /export/i, 'the message names the way out');
    return true;
  });
});

test('a save that cannot be verified is not reported as a save', async (t) => {
  const deps = harness();
  const repo = await openMissionRepository({
    store: scriptedStore(() => new Error('write verification failed: the record was not readable after commit')),
    ...deps,
  });
  t.after(() => repo.close());

  await assert.rejects(() => repo.save(makeMission(deps)), (e) => {
    assert.equal(e.code, 'verify-failed');
    assert.match(e.message, /previous version is intact/);
    return true;
  });
});

test('an unrecognised storage failure still arrives as a MissionRepositoryError', async (t) => {
  const deps = harness();
  const repo = await openMissionRepository({ store: scriptedStore(() => new Error('the disk fell off')), ...deps });
  t.after(() => repo.close());

  await assert.rejects(() => repo.save(makeMission(deps)), (e) => {
    assert.ok(e instanceof MissionRepositoryError);
    assert.equal(e.code, 'write-failed');
    assert.match(e.message, /the disk fell off/, 'the original failure is quoted, not swallowed');
    assert.ok(e.cause instanceof Error, 'and carried, for a log');
    return true;
  });
});

test('a failed save leaves the previous version readable', async (t) => {
  const deps = harness();
  let armed = false;
  const repo = await openMissionRepository({
    store: scriptedStore(() => (armed ? domException('QuotaExceededError') : null)), ...deps,
  });
  t.after(() => repo.close());

  const doc = makeMission(deps, 'The version worth keeping');
  await repo.save(doc);
  armed = true;
  await assert.rejects(() => repo.save({ ...doc, title: 'Never lands' }));
  assert.equal((await repo.get(doc.id)).title, 'The version worth keeping');
});
