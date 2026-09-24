// Guards for the unified settings surface.
//
// History: the library and chat pages each carried their own settings UI.
// They shared the same backing store (LocalDb.getSettings) but diverged in
// markup, labels and, crucially, fields:
//   - the chat panel had a prompt-cache-key field the library lacked, and the
//     engine actually sends it (`prompt_cache_key`);
//   - the library panel had a session-import block and a thought-model select
//     the chat lacked;
//   - the chat's "Manage" buttons called an `openSettingsPopup` that was never
//     defined, so they threw a ReferenceError.
//
// The fix mounts ONE surface (ui/settings/settings_modal.js) from both pages.
// These tests pin that contract at the source level:
//   1. The chat-only settings panel module is gone.
//   2. chat_boot.js imports the shared modal and no longer defines a
//      page-local settings panel.
//   3. chat.html no longer carries the settings/editor dialog markup.
//   4. The engine panel reads and writes the cache key the engine consumes.
//   5. The session-import block is rendered only when a saveSession handler is
//      supplied, so the chat surface does not ship an affordance it cannot
//      service.
import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { mountEnginePanel } from "../public/ui/settings/engine_panel.js";

const ROOT = path.join(import.meta.dir, "..");
const PUBLIC = path.join(ROOT, "public");
const read = (rel) => fs.readFileSync(path.join(PUBLIC, rel), "utf8");

describe("Unified settings surface", () => {
  test("the chat-only settings panel module no longer exists", () => {
    expect(fs.existsSync(path.join(PUBLIC, "ui", "chat", "settings_panel.js"))).toBe(false);
  });

  test("chat_boot mounts the shared settings modal", () => {
    const src = read("ui/chat/chat_boot.js");
    expect(src).toMatch(/import\s+\{\s*openSettingsModal\s*\}\s+from\s+["'][^"']*settings\/settings_modal\.js["']/);
    // And no page-local panel factory.
    expect(src).not.toContain("createSettingsPanel");
    expect(src).not.toContain("settings_panel.js");
  });

  test("the shared modal is the only settings implementation", () => {
    const modal = read("ui/settings/settings_modal.js");
    expect(modal).toContain("export function openSettingsModal");
    // The library page and the chat page both import the same module.
    for (const rel of ["ui/library_page.js", "ui/chat/chat_boot.js"]) {
      expect(read(rel)).toContain("settings/settings_modal.js");
    }
  });

  test("chat.html no longer carries settings or editor dialog markup", () => {
    const html = read("chat.html");
    expect(html).not.toContain('id="settings-popup"');
    expect(html).not.toContain('id="editor-modal"');
    expect(html).not.toContain('id="editor-modal-directive"');
    // The history modal is still page-owned static markup.
    expect(html).toContain('id="history-modal"');
  });

  test("prompt cache key and thoughts are not present while choice model is configured", () => {
    const modal = read("ui/settings/settings_modal.js");
    const panel = read("ui/settings/engine_panel.js");
    const engine = read("browser_engine.js");
    expect(modal).not.toContain("popup-cache-key");
    expect(panel).not.toContain("popup-cache-key");
    expect(panel).not.toContain("cacheKey");
    expect(engine).not.toContain("prompt_cache_key");

    expect(modal).not.toContain("popup-thought-model-select");
    expect(modal).toContain("popup-choice-model-select");
    expect(panel).not.toContain("popup-thought-model-select");
    expect(panel).toContain("popup-choice-model-select");
    expect(panel).not.toContain("thoughtModel");
    expect(panel).toContain("choiceModel");
  });

  test("the session-import block is gated on a saveSession handler", () => {
    const modal = read("ui/settings/settings_modal.js");
    // The block is only spread in when options.saveSession is provided.
    expect(modal).toMatch(/\.\.\.\(options\.saveSession/);
    // The chat page does not pass saveSession; the library does.
    expect(read("ui/chat/chat_boot.js")).not.toMatch(/saveSession:\s*\(/);
    expect(read("ui/library_page.js")).toMatch(/saveSession:\s*\(/);
  });

  test("the previously-undefined openSettingsPopup is defined in chat_boot", () => {
    const src = read("ui/chat/chat_boot.js");
    expect(src).toMatch(/function\s+openSettingsPopup\s*\(/);
    // Every caller resolves to that definition (the manage buttons).
    expect(src).toContain('openSettingsPopup("settings-personas-tab")');
    expect(src).toContain('openSettingsPopup("settings-system-prompts-tab")');
  });

  // Unifying the markup was not enough: the modal's own CSS lived in the
  // library page sheet, which the chat page never loads, so the two surfaces
  // still looked like different products. Every rule the shared modal needs
  // must live in design/components.css, the one layer both pages load.
  test("the settings modal's CSS lives in the shared layer, not a page sheet", () => {
    const components = read("design/components.css");
    const library = read("ui/library.css");
    for (const sel of [
      ".rp-settings__guidance {",
      ".rp-settings__status {",
      ".rp-settings__check {",
      ".rp-settings__check-box {",
      ".rp-settings__divider {",
      ".rp-settings__footer {",
      ".rp-settings__footer-spacer {",
      ".rp-field__head {",
      ".rp-dialog--wide .rp-dialog__panel {",
      ".rp-persona-editor__hero {",
      ".rp-directive-editor__row {",
      ".rp-textarea--mono {",
    ]) {
      expect(components).toContain(sel);
      // And it must NOT also live in the library sheet, or the two can drift.
      expect(library).not.toContain(sel);
    }
  });

  // The character's own name is marginalia: tokens.css reserves the gold for
  // it. It was rendered in plain ink, so the chat lost the at-a-glance signal
  // the design contract calls for (and the user reported).
  test("the assistant speaker name wears the annotation gold", () => {
    const components = read("design/components.css");
    const rule = components.slice(components.indexOf(".rp-message--assistant .rp-message__speaker {"));
    const body = rule.slice(rule.indexOf("{") + 1, rule.indexOf("}"));
    expect(body).toContain("color: var(--accent-annotation)");
  });

  // The closed-dialog hiding guard was stated in BOTH page sheets, at
  // different specificities, so a fix to one would not reach the other. It is
  // now in the shared layer only.
  test("the closed-dialog hiding guard lives in the shared layer only", () => {
    // Comments are prose: the page sheets document the move, so strip them
    // before scanning for the actual rule.
    const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
    const guard = "dialog.rp-dialog:not([open])";
    expect(strip(read("design/components.css"))).toContain(guard);
    expect(strip(read("ui/library.css"))).not.toContain(".rp-dialog:not([open])");
    expect(strip(read("ui/chat/chat.css"))).not.toContain(".rp-dialog:not([open])");
  });

  test("mountEnginePanel wires choice model save", () => {
    interface MockNode {
      id: string | null;
      tagName: string;
      value: string;
      checked: boolean;
      hidden: boolean;
      innerHTML: string;
      children: MockNode[];
      addEventListener(evt: string, fn: () => void): void;
      removeEventListener(evt: string, fn: () => void): void;
      dispatchEvent(evt: string): void;
      appendChild(child: MockNode): void;
    }

    function makeNode(id: string | null, type = "div"): MockNode {
      const listeners: Record<string, Array<() => void>> = {};
      return {
        id,
        tagName: type.toUpperCase(),
        value: "",
        checked: false,
        hidden: false,
        innerHTML: "",
        children: [],
        addEventListener(evt: string, fn: () => void) {
          listeners[evt] = listeners[evt] || [];
          listeners[evt].push(fn);
        },
        removeEventListener(evt: string, fn: () => void) {
          if (listeners[evt]) listeners[evt] = listeners[evt].filter(f => f !== fn);
        },
        dispatchEvent(evt: string) {
          for (const fn of listeners[evt] || []) fn();
        },
        appendChild(child: MockNode) {
          this.children.push(child);
        },
      };
    }

    type GlobalWithDoc = typeof globalThis & { document?: { createElement(tag: string): MockNode } };
    const globalHost = globalThis as GlobalWithDoc;
    const origDoc = globalHost.document;
    try {
      globalHost.document = {
        createElement(tag: string) {
          return makeNode(null, tag);
        },
      };

      const nodes: Record<string, MockNode> = {
        "#popup-api-endpoint": makeNode("popup-api-endpoint", "input"),
        "#popup-api-key": makeNode("popup-api-key", "input"),
        "#popup-model-select": makeNode("popup-model-select", "select"),
        "#popup-choice-model-select": makeNode("popup-choice-model-select", "select"),
        "#popup-fetch-models-btn": makeNode("popup-fetch-models-btn", "button"),
        "#popup-save-engine-btn": makeNode("popup-save-engine-btn", "button"),
        "#popup-engine-status": makeNode("popup-engine-status", "p"),
        ".rp-settings__footer": makeNode(null, "div"),
      };

      const root = {
        querySelector(sel: string) {
          return nodes[sel] || null;
        },
      };

      let saved: Record<string, unknown> | null = null;
      const panel = mountEnginePanel(root as unknown as HTMLElement, {
        getSettings: () => ({
          model: "primary-story-model",
          choiceModel: "choice-menu-model",
          availableModels: ["primary-story-model", "choice-menu-model"],
        }),
        saveSettings: (patch: Record<string, unknown>) => { saved = patch; },
      });

      panel.refresh();

      // Save settings
      nodes["#popup-model-select"].value = "primary-story-model";
      nodes["#popup-choice-model-select"].value = "choice-menu-model";
      nodes["#popup-save-engine-btn"].dispatchEvent("click");

      expect(saved?.model).toBe("primary-story-model");
      expect(saved?.choiceModel).toBe("choice-menu-model");
    } finally {
      if (origDoc === undefined) {
        delete globalHost.document;
      } else {
        globalHost.document = origDoc;
      }
    }
  });
});
