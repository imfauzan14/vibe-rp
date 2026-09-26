// The storage seam. The static surface keeps delegating to a shared default
// instance, but the real proof is the instance: a LocalDb built with
// `new LocalDb()` must drive the same backends, carry its own connection
// handle, and accept an injected backend in place of a browser global. This is
// the injection point candidate 2 (the turn state machine) needs.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { LocalDb } from "../public/local_db.js";
import { createFakeIndexedDB } from "./helpers.ts";

let fakeStorage: Record<string, string>;

function fakeLocalStorage() {
  return {
    getItem: (k: string) => fakeStorage[k] ?? null,
    setItem: (k: string, v: string) => {
      fakeStorage[k] = String(v);
    },
    removeItem: (k: string) => {
      delete fakeStorage[k];
    },
    clear: () => {
      fakeStorage = {};
    },
    key: (i: number) => Object.keys(fakeStorage)[i] || null,
    get length() {
      return Object.keys(fakeStorage).length;
    },
  };
}

beforeEach(() => {
  fakeStorage = {};
  Object.defineProperty(globalThis, "localStorage", { value: fakeLocalStorage(), configurable: true });
  LocalDb.db = null;
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "indexedDB");
  LocalDb.db = null;
});

describe("instance seam", () => {
  test("an instance drives the same IndexedDB backend as the statics", async () => {
    Object.defineProperty(globalThis, "indexedDB", { value: createFakeIndexedDB(), configurable: true });
    const db = new LocalDb();

    await db.saveCard({ id: "c1", name: "Hero" });
    await db.saveSession({ id: "s1", cardId: "c1", title: "Chapter 1" });

    expect((await db.getAllCards()).map((c) => c.id)).toEqual(["c1"]);
    expect((await db.getSessionsForCard("c1")).map((s) => s.id)).toEqual(["s1"]);
    expect((await db.getAllSessions()).map((s) => s.id)).toEqual(["s1"]);
  });

  test("a second instance carries its own connection handle", async () => {
    Object.defineProperty(globalThis, "indexedDB", { value: createFakeIndexedDB(), configurable: true });
    const a = new LocalDb();
    const b = new LocalDb();

    await a.open();
    expect(a.db).toBeTruthy();
    expect(b.db).toBeNull();
  });

  test("instance presets and settings use the injected local backend", async () => {
    const db = new LocalDb();
    const personas = await db.getAllPersonas();
    expect(personas).toHaveLength(1);
    expect(personas[0].id).toBe("persona_default");

    const saved = await db.savePersona({ name: "Valen" });
    expect(saved.id).toMatch(/^persona_/);
    expect((await db.getPersona(saved.id))?.name).toBe("Valen");

    expect(db.getSettings().model).toBe("");
    db.saveSettings({ model: "custom-model" });
    expect(db.getSettings().model).toBe("custom-model");
    expect(fakeStorage["vibe_rp_settings"]).toContain("custom-model");
  });

  test("an injected local backend replaces the default entirely", () => {
    // The seam, not the globals: a caller supplies its own settings store.
    const calls: string[] = [];
    const db = new LocalDb({
      local: {
        getSettings() {
          calls.push("getSettings");
          return { model: "injected-model" };
        },
        saveSettings() {
          calls.push("saveSettings");
        },
      },
    });

    expect(db.getSettings().model).toBe("injected-model");
    db.saveSettings({ model: "next" });
    expect(calls).toEqual(["getSettings", "saveSettings"]);
  });

  test("export/import round-trips through the instance backends", async () => {
    Object.defineProperty(globalThis, "indexedDB", { value: createFakeIndexedDB(), configurable: true });
    const db = new LocalDb();
    await db.saveCard({ id: "card_1", name: "Hero" });
    await db.saveSession({ id: "sess_1", cardId: "card_1", title: "Chapter 1" });

    const backup = await db.exportAllData();
    expect(backup.format).toBe("vibe-rp-full-backup");
    expect(backup.data.indexedDb.cards).toHaveLength(1);
    expect(backup.data.indexedDb.sessions).toHaveLength(1);

    const res = await db.importAllData(
      {
        format: "vibe-rp-full-backup",
        data: {
          indexedDb: { cards: [{ id: "new_card" }], sessions: [{ id: "new_sess", cardId: "new_card" }] },
          localStorage: {},
          sessionStorage: {},
          cookies: [],
        },
      },
      { mode: "replace" },
    );
    expect(res.ok).toBe(true);
    expect((await db.getAllCards()).map((c) => c.id)).toEqual(["new_card"]);
    expect((await db.getAllSessions()).map((s) => s.id)).toEqual(["new_sess"]);
  });

  test("the static default instance is the shared connection cache", async () => {
    Object.defineProperty(globalThis, "indexedDB", { value: createFakeIndexedDB(), configurable: true });
    await LocalDb.saveCard({ id: "static_card", name: "Static" });

    expect(LocalDb.db).toBeTruthy();
    LocalDb.db = null;
    expect(LocalDb.db).toBeNull();
  });
});
