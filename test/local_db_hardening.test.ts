// Regression tests for the LocalDb hardening pass (defects 6 and 7).
//
// Bun ships no IndexedDB, so these tests inject a small in-memory fake that
// implements exactly the surface LocalDb uses (open/upgrade, transactions,
// stores, an index, requests). The fake records scan and transaction counts so
// the tests can prove the cardId index is actually used and the delete fan-out
// is a single transaction — behavior, not implementation shape.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { LocalDb, LocalDbQuotaError, LocalDbBlockedError } from "../public/local_db.js";

const DB_NAME = "vibe_rp";

function makeStringList(names) {
  return {
    contains: (n) => names.includes(n),
    length: names.length,
    [Symbol.iterator]: () => names[Symbol.iterator](),
  };
}

function makeStore(name, keyPath) {
  return { name, keyPath, records: new Map(), indexes: new Map() };
}

function createFakeIndexedDB() {
  const dbs = new Map();
  const stats = { fullScans: 0, indexScans: 0, transactions: 0 };
  const flags = { blockNextOpen: false, failNextPutWith: null };

  const makeRequest = () => ({ result: undefined, error: null, onsuccess: null, onerror: null });

  function makeStoreHandle(rec, name, tx) {
    const store = rec.stores.get(name);
    if (!store) throw new Error(`NotFoundError: ${name}`);
    const handle = {
      get keyPath() {
        return store.keyPath;
      },
      get indexNames() {
        return makeStringList([...store.indexes.keys()]);
      },
      createIndex(ixName, keyPath) {
        if (!store.indexes.has(ixName)) store.indexes.set(ixName, keyPath);
        return handle.index(ixName);
      },
      index(ixName) {
        const keyPath = store.indexes.get(ixName);
        if (!keyPath) throw new Error(`NotFoundError: index ${ixName}`);
        return {
          getAll(value) {
            const req = makeRequest();
            tx._ops.push(() => {
              stats.indexScans++;
              req.result = [...store.records.values()]
                .filter((r) => r[keyPath] === value)
                .map((r) => structuredClone(r));
              if (req.onsuccess) req.onsuccess({ target: req });
            });
            return req;
          },
          getAllKeys(value) {
            const req = makeRequest();
            tx._ops.push(() => {
              stats.indexScans++;
              req.result = [...store.records.values()]
                .filter((r) => r[keyPath] === value)
                .map((r) => r[store.keyPath]);
              if (req.onsuccess) req.onsuccess({ target: req });
            });
            return req;
          },
        };
      },
      getAll() {
        const req = makeRequest();
        tx._ops.push(() => {
          stats.fullScans++;
          req.result = [...store.records.values()].map((r) => structuredClone(r));
          if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
      },
      put(value) {
        const req = makeRequest();
        tx._ops.push(() => {
          if (flags.failNextPutWith) {
            const err = flags.failNextPutWith;
            flags.failNextPutWith = null;
            throw err;
          }
          store.records.set(value[store.keyPath], structuredClone(value));
          req.result = value[store.keyPath];
          if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
      },
      delete(key) {
        const req = makeRequest();
        tx._ops.push(() => {
          store.records.delete(key);
          if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
      },
    };
    return handle;
  }

  function makeVersionChangeTx(rec) {
    const dummy = { _ops: [] };
    return { objectStore: (n) => makeStoreHandle(rec, n, dummy), abort() {} };
  }

  function makeDbHandle(rec) {
    return {
      name: rec.name,
      get version() {
        return rec.version;
      },
      get objectStoreNames() {
        return makeStringList([...rec.stores.keys()]);
      },
      createObjectStore(name, opts) {
        rec.stores.set(name, makeStore(name, opts && opts.keyPath));
        return makeStoreHandle(rec, name, { _ops: [] });
      },
      transaction(names, mode = "readonly") {
        stats.transactions++;
        const list = Array.isArray(names) ? names : [names];
        for (const n of list) if (!rec.stores.has(n)) throw new Error(`NotFoundError: ${n}`);
        const tx = { error: null, oncomplete: null, onerror: null, onabort: null, _ops: [], _drained: false };
        tx.objectStore = (n) => makeStoreHandle(rec, n, tx);
        tx.abort = () => {
          tx.error = tx.error || new Error("AbortError");
          queueMicrotask(() => tx.onabort && tx.onabort({ target: tx }));
        };
        // Requests queue synchronously after transaction() returns; drain them
        // on the next microtask, then complete (or abort) the transaction.
        queueMicrotask(() => {
          if (tx._drained) return;
          tx._drained = true;
          try {
            while (tx._ops.length) tx._ops.shift()();
          } catch (err) {
            tx.error = err;
            if (tx.onabort) tx.onabort({ target: tx });
            if (tx.onerror) tx.onerror({ target: tx });
            return;
          }
          if (tx.oncomplete) tx.oncomplete({ target: tx });
        });
        return tx;
      },
      close() {},
    };
  }

  return {
    stats,
    flags,
    open(name, version) {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        if (flags.blockNextOpen) {
          flags.blockNextOpen = false;
          if (req.onblocked) req.onblocked({ target: req });
          return;
        }
        let rec = dbs.get(name);
        if (!rec) {
          rec = { name, version: 0, stores: new Map() };
          dbs.set(name, rec);
        }
        if (version > rec.version) {
          rec.version = version;
          req.result = makeDbHandle(rec);
          req.transaction = makeVersionChangeTx(rec);
          if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        }
        req.result = makeDbHandle(rec);
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
    // Simulates a database that already exists at `version` (no index yet).
    seed(name, version, { cards = [], sessions = [] } = {}) {
      const rec = { name, version, stores: new Map() };
      const cardStore = makeStore("cards", "id");
      for (const c of cards) cardStore.records.set(c.id, structuredClone(c));
      const sessionStore = makeStore("sessions", "id");
      for (const s of sessions) sessionStore.records.set(s.id, structuredClone(s));
      rec.stores.set("cards", cardStore);
      rec.stores.set("sessions", sessionStore);
      dbs.set(name, rec);
    },
  };
}

let fake;
beforeEach(() => {
  fake = createFakeIndexedDB();
  globalThis.indexedDB = fake;
  LocalDb.db = null;
});
afterEach(() => {
  globalThis.indexedDB = undefined;
  LocalDb.db = null;
});

describe("Defect 6 - indexed sessions and atomic card deletion", () => {
  test("upgrading an existing v1 database adds the cardId index without data loss", async () => {
    fake.seed(DB_NAME, 1, {
      cards: [{ id: "c1", name: "Old" }],
      sessions: [
        { id: "s1", cardId: "c1", messages: [] },
        { id: "s2", cardId: "c2", messages: [] },
      ],
    });
    const db = await LocalDb.open();
    const store = db.transaction("sessions", "readonly").objectStore("sessions");
    expect(store.indexNames.contains("cardId")).toBe(true);
    // The pre-existing rows survived the upgrade.
    const cards = await LocalDb.getAllCards();
    expect(cards.map((c) => c.id)).toEqual(["c1"]);
    const sessions = await LocalDb.getSessionsForCard("c1");
    expect(sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  test("getSessionsForCard uses the cardId index and returns only that card's sessions", async () => {
    fake.seed(DB_NAME, 1, {
      sessions: [
        { id: "s1", cardId: "c1", messages: [] },
        { id: "s2", cardId: "c2", messages: [] },
        { id: "s3", cardId: "c1", messages: [] },
      ],
    });
    await LocalDb.open();
    fake.stats.fullScans = 0;
    fake.stats.indexScans = 0;
    const got = await LocalDb.getSessionsForCard("c1");
    expect(got.map((s) => s.id).sort()).toEqual(["s1", "s3"]);
    // No full-store scan: the query is served by the index (defeats the N+1).
    expect(fake.stats.fullScans).toBe(0);
    expect(fake.stats.indexScans).toBeGreaterThanOrEqual(1);
  });

  test("deleteCard removes the card and its sessions in a single transaction", async () => {
    fake.seed(DB_NAME, 1, {
      cards: [{ id: "c1" }, { id: "c2" }],
      sessions: [
        { id: "s1", cardId: "c1", messages: [] },
        { id: "s2", cardId: "c1", messages: [] },
        { id: "s3", cardId: "c2", messages: [] },
      ],
    });
    await LocalDb.open();
    fake.stats.transactions = 0;
    await LocalDb.deleteCard("c1");
    expect(fake.stats.transactions).toBe(1);
    expect((await LocalDb.getAllCards()).map((c) => c.id)).toEqual(["c2"]);
    expect(await LocalDb.getSessionsForCard("c1")).toEqual([]);
    expect((await LocalDb.getSessionsForCard("c2")).map((s) => s.id)).toEqual(["s3"]);
  });
});

describe("Defect 7 - blocked and quota failures surface as typed errors", () => {
  test("a quota failure on write rejects with a typed LocalDbQuotaError and loses no data", async () => {
    fake.seed(DB_NAME, 1, { cards: [], sessions: [] });
    await LocalDb.open();
    fake.flags.failNextPutWith = new DOMException("quota exceeded", "QuotaExceededError");
    const err = await LocalDb.saveSession({ id: "s9", cardId: "c1", messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(LocalDbQuotaError);
    expect(err.name).toBe("QuotaExceededError");
    expect(err.code).toBe("QUOTA_EXCEEDED");
    expect(await LocalDb.getSessionsForCard("c1")).toEqual([]);
  });

  test("a blocked upgrade surfaces a typed error instead of hanging", async () => {
    fake.seed(DB_NAME, 1, { cards: [], sessions: [] });
    fake.flags.blockNextOpen = true;
    const err = await LocalDb.open().catch((e) => e);
    expect(err).toBeInstanceOf(LocalDbBlockedError);
    expect(err.code).toBe("BLOCKED");
    // The block is transient: a retry still succeeds.
    LocalDb.db = null;
    const db = await LocalDb.open();
    expect(db).toBeTruthy();
  });

  test("the success path is unchanged (card/session round-trip and delete)", async () => {
    await LocalDb.open();
    await LocalDb.saveCard({ id: "c1", name: "A" });
    await LocalDb.saveSession({ id: "s1", cardId: "c1", messages: [{ role: "user", content: "hi" }] });
    expect((await LocalDb.getAllCards()).map((c) => c.id)).toEqual(["c1"]);
    expect((await LocalDb.getSessionsForCard("c1")).map((s) => s.id)).toEqual(["s1"]);
    await LocalDb.deleteSession("s1");
    expect(await LocalDb.getSessionsForCard("c1")).toEqual([]);
  });
});
