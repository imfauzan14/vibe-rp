// Tests for the unified Data & Storage management, browser backup export/import,
// and complete cleanup of legacy chat-only export code.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { LocalDb, DEFAULT_SETTINGS, DEFAULT_AGENTS_CONTRACT } from "../public/local_db.js";
import {
  readBrowserCookies,
  restoreBrowserCookies,
  clearBrowserCookies,
} from "../public/ui/data_transfer.js";

const ROOT = path.join(import.meta.dir, "..");
const PUBLIC = path.join(ROOT, "public");
const read = (rel: string) => fs.readFileSync(path.join(PUBLIC, rel), "utf8");

// Helpers for in-memory IndexedDB fake for Bun tests
function makeStringList(names: string[]) {
  return {
    contains: (n: string) => names.includes(n),
    length: names.length,
    [Symbol.iterator]: () => names[Symbol.iterator](),
  };
}

function makeStore(name: string, keyPath: string) {
  return { name, keyPath, records: new Map<any, any>(), indexes: new Map<string, string>() };
}

function createFakeIndexedDB() {
  const dbs = new Map<string, any>();

  const makeRequest = () => ({ result: undefined as any, error: null as any, onsuccess: null as any, onerror: null as any });

  function makeStoreHandle(rec: any, name: string, tx: any) {
    const store = rec.stores.get(name);
    if (!store) throw new Error(`NotFoundError: ${name}`);
    const handle = {
      get keyPath() {
        return store.keyPath;
      },
      get indexNames() {
        return makeStringList([...store.indexes.keys()]);
      },
      createIndex(ixName: string, keyPath: string) {
        if (!store.indexes.has(ixName)) store.indexes.set(ixName, keyPath);
        return handle.index(ixName);
      },
      index(ixName: string) {
        const keyPath = store.indexes.get(ixName);
        if (!keyPath) throw new Error(`NotFoundError: index ${ixName}`);
        return {
          getAll(value: any) {
            const req = makeRequest();
            tx._ops.push(() => {
              req.result = [...store.records.values()]
                .filter((r) => r[keyPath] === value)
                .map((r) => structuredClone(r));
              if (req.onsuccess) req.onsuccess({ target: req });
            });
            return req;
          },
        };
      },
      getAll() {
        const req = makeRequest();
        tx._ops.push(() => {
          req.result = [...store.records.values()].map((r) => structuredClone(r));
          if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
      },
      put(value: any) {
        const req = makeRequest();
        tx._ops.push(() => {
          store.records.set(value[store.keyPath], structuredClone(value));
          req.result = value[store.keyPath];
          if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
      },
      delete(key: any) {
        const req = makeRequest();
        tx._ops.push(() => {
          store.records.delete(key);
          if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
      },
      clear() {
        const req = makeRequest();
        tx._ops.push(() => {
          store.records.clear();
          if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
      },
    };
    return handle;
  }

  function makeVersionChangeTx(rec: any) {
    const dummy = { _ops: [] };
    return { objectStore: (n: string) => makeStoreHandle(rec, n, dummy), abort() {} };
  }

  function makeDbHandle(rec: any) {
    return {
      name: rec.name,
      get version() {
        return rec.version;
      },
      get objectStoreNames() {
        return makeStringList([...rec.stores.keys()]);
      },
      createObjectStore(name: string, opts: any) {
        rec.stores.set(name, makeStore(name, opts && opts.keyPath));
        return makeStoreHandle(rec, name, { _ops: [] });
      },
      transaction(names: string | string[]) {
        const list = Array.isArray(names) ? names : [names];
        for (const n of list) if (!rec.stores.has(n)) throw new Error(`NotFoundError: ${n}`);
        const tx = { error: null, oncomplete: null as any, onerror: null as any, onabort: null as any, _ops: [] as Function[], _drained: false };
        tx.objectStore = (n: string) => makeStoreHandle(rec, n, tx);
        tx.abort = () => {
          tx.error = tx.error || new Error("AbortError");
          queueMicrotask(() => tx.onabort && tx.onabort({ target: tx }));
        };
        queueMicrotask(() => {
          if (tx._drained) return;
          tx._drained = true;
          try {
            while (tx._ops.length) tx._ops.shift()!();
          } catch (err) {
            tx.error = err as any;
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
    open(name: string, version: number) {
      const req = { result: undefined as any, error: null as any, onsuccess: null as any, onerror: null as any, onupgradeneeded: null as any };
      queueMicrotask(() => {
        let rec = dbs.get(name);
        if (!rec) {
          rec = { name, version: 0, stores: new Map() };
          dbs.set(name, rec);
        }
        if (version > rec.version) {
          const oldVersion = rec.version;
          rec.version = version;
          if (req.onupgradeneeded) {
            req.result = makeDbHandle(rec);
            req.transaction = makeVersionChangeTx(rec);
            req.onupgradeneeded({
              target: req,
              oldVersion,
              newVersion: version,
            });
          }
        }
        req.result = makeDbHandle(rec);
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
  };
}

describe("Redundancy cleanup and legacy export removal", () => {
  test("public/ui/chat/export.js is completely removed", () => {
    expect(fs.existsSync(path.join(PUBLIC, "ui", "chat", "export.js"))).toBe(false);
  });

  test("chat.html no longer contains the legacy export and restore buttons", () => {
    const html = read("chat.html");
    expect(html).not.toContain('id="export-json-btn"');
    expect(html).not.toContain('id="export-text-btn"');
    expect(html).not.toContain('id="import-restore-btn"');
    expect(html).not.toContain('id="import-restore-input"');
    expect(html).not.toContain("This conversation");
  });

  test("chat_boot.js no longer imports or references export.js", () => {
    const src = read("ui/chat/chat_boot.js");
    expect(src).not.toContain("export.js");
    expect(src).not.toContain("downloadExport");
    expect(src).not.toContain("readImportFile");
    expect(src).not.toContain("export-json-btn");
  });

  test("settings_modal.js mounts the Data & Storage tab", () => {
    const src = read("ui/settings/settings_modal.js");
    expect(src).toContain("settings-data-tab");
    expect(src).toContain("Data & Storage");
    expect(src).toContain("mountDataPanel");
  });
});

describe("Cookie serialization helpers", () => {
  const origDocument = (globalThis as any).document;

  afterEach(() => {
    (globalThis as any).document = origDocument;
  });

  test("readBrowserCookies parses cookie string into key-value items", () => {
    (globalThis as any).document = {
      cookie: "token=abc123xyz; session_id=sess_456; theme=dark",
    };
    const cookies = readBrowserCookies();
    expect(cookies).toEqual([
      { name: "token", value: "abc123xyz" },
      { name: "session_id", value: "sess_456" },
      { name: "theme", value: "dark" },
    ]);
  });

  test("restoreBrowserCookies sets cookies safely with SameSite=Lax", () => {
    const setLog: string[] = [];
    (globalThis as any).document = {
      get cookie() {
        return "";
      },
      set cookie(val: string) {
        setLog.push(val);
      },
    };

    restoreBrowserCookies([
      { name: "user_pref", value: "prose" },
      { name: "token", value: "xyz" },
    ]);

    expect(setLog.length).toBe(2);
    expect(setLog[0]).toBe("user_pref=prose; path=/; max-age=31536000; SameSite=Lax");
    expect(setLog[1]).toBe("token=xyz; path=/; max-age=31536000; SameSite=Lax");
  });

  test("clearBrowserCookies expires all existing cookies", () => {
    const setLog: string[] = [];
    (globalThis as any).document = {
      get cookie() {
        return "foo=1; bar=2";
      },
      set cookie(val: string) {
        setLog.push(val);
      },
    };

    clearBrowserCookies();
    expect(setLog.length).toBe(2);
    expect(setLog[0]).toContain("max-age=0");
    expect(setLog[1]).toContain("max-age=0");
  });
});

describe("LocalDb storage management, export and import", () => {
  let fakeStorage: Record<string, string>;

  beforeEach(() => {
    fakeStorage = {};
    const mockLocalStorage = {
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
    (globalThis as any).localStorage = mockLocalStorage;

    const fakeIdb = createFakeIndexedDB();
    (globalThis as any).indexedDB = fakeIdb;
    LocalDb.db = null;
  });

  afterEach(() => {
    delete (globalThis as any).localStorage;
    delete (globalThis as any).indexedDB;
    LocalDb.db = null;
  });

  test("getStorageStats returns accurate counts", async () => {
    await LocalDb.saveCard({ id: "card_1", name: "Card 1" });
    await LocalDb.saveCard({ id: "card_2", name: "Card 2" });
    await LocalDb.saveSession({ id: "sess_1", cardId: "card_1", title: "Session 1" });

    await LocalDb.savePersona({ id: "p1", name: "Persona 1", prompt: "Hello" });
    await LocalDb.saveDirective({ id: "d1", name: "Directive 1", content: "Stay in voice" });

    (globalThis as any).navigator = {
      storage: {
        estimate: async () => ({ usage: 1048576, quota: 1073741824 }),
      },
    };

    const stats = await LocalDb.getStorageStats();
    expect(stats.cardCount).toBe(2);
    expect(stats.sessionCount).toBe(1);
    expect(stats.personaCount).toBe(2);
    expect(stats.directiveCount).toBe(2);
    expect(stats.usage).toBe(1048576);
    expect(stats.quota).toBe(1073741824);

    delete (globalThis as any).navigator;
  });

  test("exportAllData produces a self-describing vibe-rp-full-backup document", async () => {
    await LocalDb.saveCard({ id: "card_1", name: "Hero" });
    await LocalDb.saveSession({ id: "sess_1", cardId: "card_1", title: "Chapter 1", messages: [{ role: "user", content: "Hi" }] });
    await LocalDb.savePersona({ id: "p_custom", name: "Custom Persona", prompt: "I am a tester." });
    LocalDb.saveSettings({ model: "custom-model", temperature: 0.8 });

    const backup = await LocalDb.exportAllData({
      cookies: [{ name: "auth_token", value: "secret123" }],
    });

    expect(backup.format).toBe("vibe-rp-full-backup");
    expect(backup.version).toBe(1);
    expect(backup.exportedAt).toBeTruthy();
    expect(backup.data.indexedDb.cards.length).toBe(1);
    expect(backup.data.indexedDb.cards[0].name).toBe("Hero");
    expect(backup.data.indexedDb.sessions.length).toBe(1);
    expect(backup.data.indexedDb.sessions[0].title).toBe("Chapter 1");
    const personas = JSON.parse(backup.data.localStorage["vibe_rp_personas"]);
    expect(personas.some((p: any) => p.name === "Custom Persona")).toBe(true);
    const settings = JSON.parse(backup.data.localStorage["vibe_rp_settings"]);
    expect(settings.model).toBe("custom-model");
    expect(backup.data.cookies).toEqual([{ name: "auth_token", value: "secret123" }]);
  });

  test("importAllData with mode: replace replaces all data", async () => {
    // Populate initial state
    await LocalDb.saveCard({ id: "old_card", name: "Old Card" });
    await LocalDb.saveSession({ id: "old_sess", cardId: "old_card", title: "Old Sess" });
    await LocalDb.savePersona({ id: "old_p", name: "Old Persona", prompt: "old" });

    const payload = {
      format: "vibe-rp-full-backup",
      version: 1,
      data: {
        indexedDb: {
          cards: [{ id: "new_card", name: "New Card" }],
          sessions: [{ id: "new_sess", cardId: "new_card", title: "New Sess", messages: [] }],
        },
        localStorage: {
          vibe_rp_settings: JSON.stringify({ model: "new-gpt-model" }),
          vibe_rp_personas: JSON.stringify([{ id: "new_p", name: "New Persona", prompt: "new" }]),
          vibe_rp_directives: JSON.stringify([{ id: "new_d", name: "New Directive", content: "new" }]),
        },
        cookies: [{ name: "cookie_key", value: "cookie_val" }],
      },
    };

    const res = await LocalDb.importAllData(payload, { mode: "replace" });
    expect(res.ok).toBe(true);

    const cards = await LocalDb.getAllCards();
    expect(cards.length).toBe(1);
    expect(cards[0].id).toBe("new_card");

    const sessions = await LocalDb.getAllSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe("new_sess");

    const personas = await LocalDb.getAllPersonas();
    expect(personas.length).toBe(1);
    expect(personas[0].id).toBe("new_p");

    expect(LocalDb.getSettings().model).toBe("new-gpt-model");
    expect(res.cookies).toEqual([{ name: "cookie_key", value: "cookie_val" }]);
  });

  test("importAllData with mode: merge preserves existing non-colliding items", async () => {
    await LocalDb.saveCard({ id: "existing_card", name: "Existing Card" });
    await LocalDb.saveSession({ id: "existing_sess", cardId: "existing_card", title: "Existing Sess" });

    const payload = {
      format: "vibe-rp-full-backup",
      version: 1,
      data: {
        indexedDb: {
          cards: [{ id: "incoming_card", name: "Incoming Card" }],
          sessions: [{ id: "incoming_sess", cardId: "incoming_card", title: "Incoming Sess" }],
        },
        localStorage: {
          vibe_rp_custom: "custom_merged_val",
        },
      },
    };

    const res = await LocalDb.importAllData(payload, { mode: "merge" });
    expect(res.ok).toBe(true);

    const cards = await LocalDb.getAllCards();
    expect(cards.length).toBe(2);
    expect(cards.map((c: any) => c.id)).toContain("existing_card");
    expect(cards.map((c: any) => c.id)).toContain("incoming_card");

    const sessions = await LocalDb.getAllSessions();
    expect(sessions.length).toBe(2);
  });

  test("importAllData seamlessly accepts legacy vibe-rp-conversation export files", async () => {
    const legacyDoc = {
      format: "vibe-rp-conversation",
      version: 1,
      title: "Memories of the Hall",
      ledger: "- Settled fact 1",
      character: { name: "Aria" },
      messages: [
        { id: "m1", role: "user", content: "Hello there." },
        { id: "m2", role: "assistant", content: "Greetings, traveler." },
      ],
    };

    const res = await LocalDb.importAllData(legacyDoc, { mode: "merge" });
    expect(res.ok).toBe(true);
    expect(res.sessionsImported).toBe(1);

    const sessions = await LocalDb.getAllSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].title).toBe("Memories of the Hall");
    expect(sessions[0].ledger).toBe("- Settled fact 1");
    expect(sessions[0].messages.length).toBe(2);
    expect(sessions[0].messages[0].content).toBe("Hello there.");
  });

  test("granular clears and resets behave properly", async () => {
    await LocalDb.saveCard({ id: "c1", name: "Card 1" });
    await LocalDb.saveSession({ id: "s1", cardId: "c1", title: "Sess 1" });
    await LocalDb.savePersona({ id: "p1", name: "P1", prompt: "Hello" });
    await LocalDb.saveDirective({ id: "d1", name: "D1", content: "World" });
    LocalDb.saveSettings({ model: "custom-setting" });

    // Clear sessions
    await LocalDb.clearAllSessions();
    expect((await LocalDb.getAllSessions()).length).toBe(0);
    expect((await LocalDb.getAllCards()).length).toBe(1); // cards still there

    // Clear cards
    await LocalDb.clearAllCards();
    expect((await LocalDb.getAllCards()).length).toBe(0);

    // Reset personas
    LocalDb.resetPersonas();
    const personas = await LocalDb.getAllPersonas();
    expect(personas.length).toBeGreaterThan(0); // restored default
    expect(personas.some((p: any) => p.name === "User")).toBe(true);

    // Reset directives
    LocalDb.resetDirectives();
    const directives = await LocalDb.getAllDirectives();
    expect(directives.length).toBeGreaterThan(0); // restored default craft contract
    expect(directives[0].content).toBe(DEFAULT_AGENTS_CONTRACT);

    // Reset settings
    LocalDb.resetSettings();
    expect(LocalDb.getSettings().model).toBe(DEFAULT_SETTINGS.model);
  });

  test("wipeAllData erases all tables and wipes all vibe_rp localStorage keys", async () => {
    await LocalDb.saveCard({ id: "c1", name: "Card 1" });
    await LocalDb.saveSession({ id: "s1", cardId: "c1", title: "Sess 1" });
    fakeStorage["vibe_rp_custom_key"] = "test";
    fakeStorage["unrelated_key"] = "keep_me";

    await LocalDb.wipeAllData();

    expect((await LocalDb.getAllCards()).length).toBe(0);
    expect((await LocalDb.getAllSessions()).length).toBe(0);
    expect(fakeStorage["vibe_rp_custom_key"]).toBeUndefined();
    expect(fakeStorage["unrelated_key"]).toBe("keep_me");

    // Defaults re-initialized
    expect((await LocalDb.getAllPersonas()).length).toBeGreaterThan(0);
    expect((await LocalDb.getAllDirectives()).length).toBeGreaterThan(0);
    expect(LocalDb.getSettings().model).toBe(DEFAULT_SETTINGS.model);
  });
});
