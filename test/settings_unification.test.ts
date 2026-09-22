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

  test("the engine panel reads and writes the cache key the engine sends", () => {
    const panel = read("ui/settings/engine_panel.js");
    expect(panel).toContain('qs(root, "#popup-cache-key")');
    expect(panel).toMatch(/cacheKey:\s*cacheKey\?\.value/);
    // The engine really consumes it.
    expect(read("browser_engine.js")).toContain("prompt_cache_key");
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
});
