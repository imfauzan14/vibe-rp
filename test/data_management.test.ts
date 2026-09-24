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
import { createFakeIndexedDB } from "./helpers.ts";

const ROOT = path.join(import.meta.dir, "..");
const PUBLIC = path.join(ROOT, "public");
const read = (rel: string) => fs.readFileSync(path.join(PUBLIC, rel), "utf8");

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

  test("el handles both string and object styles safely without throwing index setter error", async () => {
    const { el } = await import("../public/ui/dom.js");
    const fakeDoc = {
      createElement(tag: string) {
        return {
          tagName: tag.toUpperCase(),
          style: { cssText: "" },
          className: "",
          textContent: "",
          setAttribute() {},
          append() {},
        };
      },
    };
    const orig = (globalThis as any).document;
    (globalThis as any).document = fakeDoc;
    try {
      const nodeString = el("div", { style: "margin-bottom: var(--space-3);" });
      expect(nodeString.style.cssText).toBe("margin-bottom: var(--space-3);");

      const nodeObj = el("div", { style: { display: "none" } });
      expect((nodeObj.style as any).display).toBe("none");
    } finally {
      if (orig === undefined) {
        delete (globalThis as any).document;
      } else {
        (globalThis as any).document = orig;
      }
    }
  });

  test("on helper in dom.js attaches and detaches event listeners safely", async () => {
    const { on } = await import("../public/ui/dom.js");
    let called = 0;
    const listeners: Record<string, Function[]> = {};
    const fakeNode = {
      addEventListener(type: string, fn: Function) {
        (listeners[type] ||= []).push(fn);
      },
      removeEventListener(type: string, fn: Function) {
        if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
      },
    };

    const unsub = on(fakeNode as any, "click", () => {
      called++;
    });
    expect(listeners["click"]?.length).toBe(1);

    listeners["click"][0]();
    expect(called).toBe(1);

    unsub();
    expect(listeners["click"]?.length).toBe(0);

    // Null node safety
    const noopUnsub = on(null as any, "click", () => {});
    expect(typeof noopUnsub).toBe("function");
    noopUnsub();
  });

  test("mountDataPanel mounts without throwing ReferenceError for on", async () => {
    const { mountDataPanel } = await import("../public/ui/settings/data_panel.js");
    const listeners: Record<string, Function[]> = {};
    const makeNode = (tag: string) => ({
      tagName: tag.toUpperCase(),
      style: { cssText: "" },
      className: "",
      textContent: "",
      value: "",
      files: [],
      hidden: false,
      children: [] as any[],
      setAttribute() {},
      removeAttribute() {},
      append(...nodes: any[]) {
        this.children.push(...nodes);
      },
      addEventListener(type: string, fn: Function) {
        (listeners[type] ||= []).push(fn);
      },
      removeEventListener(type: string, fn: Function) {
        if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
      },
    });

    const fakeDoc = {
      createElement: makeNode,
    };
    const orig = (globalThis as any).document;
    (globalThis as any).document = fakeDoc;
    try {
      const root = makeNode("div");
      const panel = mountDataPanel(root as any);
      expect(panel).toBeDefined();
      expect(typeof panel.refresh).toBe("function");
      expect(typeof panel.destroy).toBe("function");
      expect(listeners["click"]?.length ?? 0).toBeGreaterThan(0);
      expect(panel.destroy).not.toThrow();
      expect(listeners["click"]?.length ?? 0).toBe(0);
    } finally {
      if (orig === undefined) {
        delete (globalThis as any).document;
      } else {
        (globalThis as any).document = orig;
      }
    }
  });

  test("mountDataPanel ignores a 2-arg delete confirmation helper and uses structured confirmAction", async () => {
    const { mountDataPanel } = await import("../public/ui/settings/data_panel.js");
    const listeners: Record<string, Function[]> = {};
    const nodesById: Record<string, any> = {};
    const makeNode = (tag: string) => {
      const node = {
        tagName: tag.toUpperCase(),
        style: { cssText: "" },
        className: "",
        textContent: "",
        value: "",
        files: [],
        hidden: false,
        children: [] as any[],
        setAttribute(k: string, v: string) {
          if (k === "id") nodesById[v] = node;
        },
        removeAttribute() {},
        append(...nodes: any[]) {
          this.children.push(...nodes);
        },
        appendChild(child: any) {
          this.children.push(child);
          return child;
        },
        querySelector(sel: string) {
          if (sel.startsWith("#")) return nodesById[sel.slice(1)];
          return null;
        },
        addEventListener(type: string, fn: Function) {
          (listeners[type] ||= []).push(fn);
        },
        removeEventListener(type: string, fn: Function) {
          if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
        },
      };
      return node;
    };

    const orig = (globalThis as any).document;
    (globalThis as any).document = { createElement: makeNode };
    try {
      const root = makeNode("div");
      let deleteHelperCalled = false;
      const fakeDeleteHelper = (kind: any, label: any) => {
        deleteHelperCalled = true;
        return Promise.resolve(false);
      };

      let structuredConfirmOpts: any = null;
      const fakeConfirmAction = (opts: any) => {
        structuredConfirmOpts = opts;
        return Promise.resolve(false);
      };

      mountDataPanel(root as any, {
        confirm: fakeDeleteHelper as any,
        confirmAction: fakeConfirmAction as any,
      });

      const clickListeners = listeners["click"] || [];
      expect(clickListeners.length).toBeGreaterThan(0);

      // Trigger clearSessionsBtn click (listener index 2)
      await clickListeners[2]?.();

      expect(deleteHelperCalled).toBe(false);
      expect(structuredConfirmOpts).not.toBeNull();
      expect(structuredConfirmOpts.title).toBe("Clear all conversations?");
      expect(structuredConfirmOpts.confirmLabel).toBe("Clear Sessions");
    } finally {
      if (orig === undefined) {
        delete (globalThis as any).document;
      } else {
        (globalThis as any).document = orig;
      }
    }
  });
});

describe("Cookie serialization helpers", () => {
  const origDocument = (globalThis as any).document;

  afterEach(() => {
    if (origDocument === undefined) {
      delete (globalThis as any).document;
    } else {
      (globalThis as any).document = origDocument;
    }
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
