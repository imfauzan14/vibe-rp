// Regression tests for the LocalDb hardening pass (defects 6 and 7).
//
// Bun ships no IndexedDB, so these tests inject a small in-memory fake that
// implements exactly the surface LocalDb uses (open/upgrade, transactions,
// stores, an index, requests). The fake records scan and transaction counts so
// the tests can prove the cardId index is actually used and the delete fan-out
// is a single transaction — behavior, not implementation shape.
import { LocalDb, LocalDbQuotaError, LocalDbBlockedError } from "../public/local_db.js";
import { createFakeIndexedDB } from "./helpers.ts";

const DB_NAME = "vibe_rp";

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
