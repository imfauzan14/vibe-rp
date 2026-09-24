// Choice Mode: the presentation-layer contract.
//
// These are source-level guards for the things that must not silently regress:
// a choice is a real button, model text never becomes markup, the mode switch
// is a chip group (not a hidden setting), and the panel is wired from the
// controller's machine rather than from a render-time request. The rendered
// behaviour is covered by the browser test; these pin the structure.
import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const PUBLIC = path.join(ROOT, "public");
const read = (rel) => fs.readFileSync(path.join(PUBLIC, rel), "utf8");

describe("choice UI drift-guard", () => {
  // SOURCE-TEXT guard (not behavior): pins call-site shape so refactors stay in sync.
  const panel = read("ui/chat/choice_panel.js");
  const boot = read("ui/chat/chat_boot.js");
  const engine = read("browser_engine.js");

  test("panel, boot and engine call-sites keep their pinned shape", () => {
    // a choice is a real button, not a clickable div
    {
      expect(panel).toContain('el("button"');
      expect(panel).not.toMatch(/createElement\(["']div["']\)[^;]*data-choice-id/);
      // The option class is applied to a button element.
      expect(panel).toMatch(/el\(\s*"button",\s*\{[\s\S]*?rp-choices__option/);
    }
    // model choice text lands as a text node, never as HTML
    {
      // The text is passed through `text:`, which dom.js assigns to textContent.
      expect(panel).toMatch(/el\(\s*"span",\s*\{\s*class:\s*"rp-choices__text",\s*text:\s*choice\.text/);
      expect(panel).not.toContain("innerHTML");
      expect(panel).not.toContain("insertAdjacentHTML");
    }
    // disabled and selected states are expressed on the button
    {
      expect(panel).toContain("btn.disabled = true");
      expect(panel).toContain("is-selected");
      expect(panel).toContain("aria-disabled");
    }
    // a live region announces that choices arrived
    {
      expect(panel).toMatch(/role:\s*"status"/);
      expect(panel).toMatch(/aria-live":\s*"polite"/);
    }
    // numeric shortcuts are suppressed while a field has focus
    {
      expect(panel).toContain("isEditableTarget");
      expect(panel).toMatch(/isEditableTarget\(event\.target\)/);
    }
    // regenerate is an explicit action, not a render side effect
    {
      expect(panel).toContain("onRegenerate");
      expect(panel).toMatch(/regenBtn\.addEventListener\("click",\s*\(\)\s*=>\s*onRegenerate\(\)\)/);
    }
    // the panel provides a collapse/expand affordance with accessible attributes
    {
      expect(panel).toContain("rp-choices__collapse-btn");
      expect(panel).toContain('"aria-expanded"');
      expect(panel).toContain('"aria-controls"');
      expect(panel).toMatch(/collapseBtn\.addEventListener\("click"/);
    }
    // the header displays a status badge and dynamic collapsed state
    {
      expect(panel).toContain("rp-choices__badge");
      expect(panel).toContain("is-generating");
      expect(panel).toContain("is-ready");
      expect(panel).toContain("is-submitting");
      expect(panel).toContain("is-error");
      expect(panel).toContain("isMobileViewport");
    }
    // shortcuts and escape handle collapse state cleanly
    {
      expect(panel).toMatch(/event\.key === "Escape"/);
      expect(panel).toMatch(/if \(isCollapsed\) return/);
    }
    // choice generation is requested only after a settled turn or explicitly
    {
      // One call site after a settled turn, plus the panel's own regenerate/retry.
      const afterTurn = boot.match(/if \(settledOk && mode === "choice"\)/g) || [];
      expect(afterTurn.length).toBe(1);
      // No request is issued from a render helper.
      expect(boot).not.toMatch(/function renderChoices\(\)[\s\S]{0,400}?requestChoices\(\)/);
    }
    // the panel is repainted after a failed turn so it cannot sit disabled
    {
      const body = boot.slice(boot.indexOf("async function streamTurn"), boot.indexOf("async function submitTurn"));
      expect(body).toMatch(/catch \(err\)[\s\S]*?if \(mode === "choice"\) renderChoices\(\)/);
    }
    // choice generation is a separate, non-streaming request
    {
      expect(engine).toMatch(/static async generateChoices/);
      expect(engine).toMatch(/stream:\s*false/);
    }
    // choice generation never touches the transcript or the ledger
    {
      const body = engine.slice(engine.indexOf("static async generateChoices"), engine.indexOf("static #providerContextWindow"));
      expect(body).not.toMatch(/session\.messages\s*=/);
      expect(body).not.toMatch(/session\.ledger\s*=/);
      expect(body).not.toMatch(/session\.consumed\s*=/);
    }
    // the choice prompt is not part of the RP system prompt
    {
      // The RP prefix is built by buildSystemSections; the choice instruction must
      // never appear there.
      const sections = engine.slice(engine.indexOf("export function buildSystemSections"), engine.indexOf("export function allocateContext"));
      expect(sections).not.toContain("CHOICE_SYSTEM_PROMPT");
    }
  });
});

describe("chat surface wiring", () => {
  const boot = read("ui/chat/chat_boot.js");
  const html = read("chat.html");
  const css = read("ui/chat/chat.css");

  test("the panel and the mode switch are real markup", () => {
    expect(html).toContain('id="choice-panel"');
    expect(html).toContain('id="mode-switch"');
    // Both modes are visible buttons, not a settings-only control.
    expect(html).toContain('data-mode="normal"');
    expect(html).toContain('data-mode="choice"');
  });

  test("choice list has a bounded max-height so chat feed remains visible", () => {
    expect(css).toMatch(/\.rp-choices__list\s*\{[\s\S]*?max-height:\s*min\(44dvh,\s*320px\)/);
    expect(css).toContain("overscroll-behavior: contain");
  });

  test("composer input yields in choice mode when choices are active", () => {
    expect(css).toMatch(/\.rp-composer\[data-mode="choice"\]\[data-has-choices="true"\]\s+\.rp-composer__input[\s\S]*?display:\s*none/);
    expect(boot).toMatch(/\$\("composer"\)\.dataset\.hasChoices\s*=/);
  });

  test("a selected choice goes through the ordinary user-turn path", () => {
    // Selection appends a normal user message and streams it; it does not
    // create an assistant message or a special choice turn.
    expect(boot).toMatch(/async function selectChoice[\s\S]*?submitTurn\(choice\.text\)/);
    expect(boot).toMatch(/controller\.appendMessage\(\{\s*role:\s*"user"/);
  });

  test("leaving Choice Mode preserves the pending set for return without token waste", () => {
    // Mode toggle hides the panel but does not invalidate the session's cached choices.
    expect(boot).not.toMatch(/function setMode[\s\S]*?controller\.invalidateChoices/);
  });

  test("the mode is persisted through the existing settings store", () => {
    expect(boot).toMatch(/choiceMode/);
    expect(boot).toMatch(/db\.saveSettings/);
  });

  test("reduced motion and coarse-pointer targets are respected", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/--tap-min/);
  });

  test("the panel never covers the reading area: it is sticky with the dock", () => {
    // The panel lives inside the composer form, which is the sticky element.
    const composerStart = html.indexOf('id="composer"');
    const panelIndex = html.indexOf('id="choice-panel"');
    expect(composerStart).toBeGreaterThan(-1);
    expect(panelIndex).toBeGreaterThan(composerStart);
    expect(css).toMatch(/\.rp-choices\s*\{[\s\S]*?max-width:\s*var\(--measure-wide\)/);
  });

  test("choice panel maintains consistent width and box-sizing across states", () => {
    expect(css).toMatch(/\.rp-choices\s*\{[\s\S]*?width:\s*100%/);
    expect(css).toMatch(/\.rp-choices\s*\{[\s\S]*?box-sizing:\s*border-box/);
    expect(css).toMatch(/\.rp-choices\[data-collapsed="true"\]\s*\{[\s\S]*?width:\s*100%/);
    expect(css).toMatch(/\.rp-choices\[data-collapsed="true"\]\s*\{[\s\S]*?box-sizing:\s*border-box/);
  });

  test("mobile choices provide generous breathing room and distinct button height", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*?\.rp-choices__list\s*\{[\s\S]*?gap:\s*var\(--space-2-5\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*?\.rp-choices__option\s*\{[\s\S]*?min-height:\s*2\.75rem/);
  });

  test("composer dock drops visible border while preserving layout bounds", () => {
    expect(css).toMatch(/\.rp-composer\[data-mode="choice"\]\[data-has-choices="true"\]\s+\.rp-composer__box\s*\{[\s\S]*?border:\s*var\(--border-width\)\s+solid\s+transparent/);
  });
});

describe("failed-generation recovery affordance", () => {
  const feed = read("ui/chat/message_feed.js");
  const boot = read("ui/chat/chat_boot.js");

  test("a trailing unanswered user turn offers a durable Retry, not just a toast", () => {
    // The toast expires and a reload loses it, so the transcript itself must
    // carry the way back to a reply.
    expect(feed).toMatch(/showRetry:\s*msg\.role === "user" && start \+ i === total - 1/);
    expect(feed).toContain('data-action="retry"');
    expect(boot).toMatch(/action === "retry"[\s\S]*?retryUnansweredTurn/);
  });

  test("retry re-streams the existing turn instead of appending a new one", () => {
    // Appending would duplicate the user's turn; the recovery must reuse it.
    const body = boot.slice(boot.indexOf("async function retryUnansweredTurn"), boot.indexOf("// Context stats"));
    expect(body).toContain("controller.pendingUserTurn()");
    expect(body).toContain("streamTurn(pending.content)");
    expect(body).not.toMatch(/appendMessage/);
    expect(body).not.toMatch(/submitTurn/);
  });
});
