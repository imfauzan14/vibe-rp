// Tests for the module-unification pass.
//
//   - message_format.js must use the canonical escapeHtml (safe_html.js)
//     instead of its own legacy copy, leaving exactly one definition.
//   - ui/toast.js is the single notification module: createToastHost for the
//     library surface and createNotifier as the chat adapter.
//   - ui/theme.js is the single theme module for both pages.
//   - sw.js must not precache the deleted editorial.css and must carry a bumped
//     CACHE constant so returning users drop the stale shell.
//
// No DOM library is used: a tiny fake document/localStorage is installed for
// the duration of each case, matching the "drive the public seam" style of the
// rest of the suite.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { escapeHtml as canonicalEscapeHtml } from "../public/safe_html.js";
import { createToastHost, createNotifier } from "../public/ui/toast.js";
import { runWithUndo, UNDO_WINDOW_MS } from "../public/ui/chat/confirm.js";
import {
  THEMES,
  THEME_STORAGE_KEY,
  isTheme,
  resolveSystemTheme,
  getTheme,
  applyTheme,
  setTheme,
  toggleTheme,
  initTheme,
  onThemeChange,
} from "../public/ui/theme.js";

// ---------------------------------------------------------------------------
// Minimal DOM
// ---------------------------------------------------------------------------
function classesOf(el) {
  return new Set(String(el.className || "").split(/\s+/).filter(Boolean));
}

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    _listeners: {},
    className: "",
    textContent: "",
    type: "",
    parentNode: null,
    classList: {
      add: (...c) => {
        const set = classesOf(el);
        c.forEach((x) => set.add(x));
        el.className = [...set].join(" ");
      },
      remove: (...c) => {
        const set = classesOf(el);
        c.forEach((x) => set.delete(x));
        el.className = [...set].join(" ");
      },
      contains: (c) => classesOf(el).has(c),
    },
    setAttribute(k, v) {
      el.attributes[k] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(el.attributes, k) ? el.attributes[k] : null;
    },
    removeAttribute(k) {
      delete el.attributes[k];
    },
    appendChild(child) {
      el.children.push(child);
      child.parentNode = el;
      return child;
    },
    remove() {
      if (el.parentNode) {
        const i = el.parentNode.children.indexOf(el);
        if (i >= 0) el.parentNode.children.splice(i, 1);
      }
    },
    addEventListener(type, fn) {
      (el._listeners[type] ||= []).push(fn);
    },
    dispatch(type) {
      for (const fn of el._listeners[type] || []) fn({ type, target: el });
    },
    querySelector(sel) {
      const cls = String(sel).split(".").pop();
      return el.children.find((c) => classesOf(c).has(cls)) || null;
    },
    querySelectorAll() {
      return [];
    },
  };
  return el;
}

const realGlobals = {};
function installDom() {
  for (const k of ["document", "window", "localStorage", "requestAnimationFrame"]) {
    realGlobals[k] = globalThis[k];
  }
  const store = new Map();
  const documentElement = makeElement("html");
  globalThis.document = {
    documentElement,
    body: makeElement("body"),
    createElement: (tag) => makeElement(tag),
  };
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
  };
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.requestAnimationFrame = (fn) => {
    fn();
    return 0;
  };
  return { store, documentElement };
}

function restoreDom() {
  for (const k of Object.keys(realGlobals)) {
    if (realGlobals[k] === undefined) delete globalThis[k];
    else globalThis[k] = realGlobals[k];
  }
}

// ---------------------------------------------------------------------------
// message_format uses the canonical escapeHtml (no competing definition)
// ---------------------------------------------------------------------------
describe("message_format uses the canonical escapeHtml", () => {
  test("public/ has exactly one escapeHtml definition, in safe_html.js", () => {
    const dir = path.join(import.meta.dir, "..", "public");
    const offenders = [];
    for (const file of fs.readdirSync(dir, { recursive: true })) {
      const rel = String(file);
      if (!rel.endsWith(".js") || rel.includes("safe_html")) continue;
      const text = fs.readFileSync(path.join(dir, rel), "utf8");
      if (/export\s+(?:function|const)\s+escapeHtml\b/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test("message_format.js imports escapeHtml from safe_html.js", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dir, "..", "public", "message_format.js"),
      "utf8",
    );
    expect(src).toMatch(/import\s*\{\s*escapeHtml\s*\}\s*from\s*"\.\/safe_html\.js"/);
  });

  test("escapes all five dangerous characters under the canonical policy", () => {
    const input = `<a href="x">&\'</a>`;
    expect(canonicalEscapeHtml(input)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });

  test("coerces falsy input to an empty string", () => {
    expect(canonicalEscapeHtml("")).toBe("");
    expect(canonicalEscapeHtml(null)).toBe("");
    expect(canonicalEscapeHtml(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// theme module contract
// ---------------------------------------------------------------------------
describe("ui/theme.js contract", () => {
  beforeEach(() => installDom());
  afterEach(() => restoreDom());

  test("exposes the storage key and the two theme names", () => {
    expect(THEME_STORAGE_KEY).toBe("vibe_rp_theme");
    expect(THEMES).toEqual(["marginalia", "paper"]);
    expect(isTheme("paper")).toBe(true);
    expect(isTheme("marginalia")).toBe(true);
    expect(isTheme("nope")).toBe(false);
  });

  test("defaults to the dark theme when nothing is stored", () => {
    expect(getTheme()).toBe("marginalia");
    expect(resolveSystemTheme()).toBe("marginalia");
  });

  test("applyTheme toggles the data-theme attribute and notifies subscribers", () => {
    const seen = [];
    const off = onThemeChange((t) => seen.push(t));
    applyTheme("paper");
    expect(globalThis.document.documentElement.getAttribute("data-theme")).toBe("paper");
    applyTheme("marginalia");
    // marginalia is the default and is expressed by removing the attribute.
    expect(globalThis.document.documentElement.getAttribute("data-theme")).toBeNull();
    expect(seen).toEqual(["paper", "marginalia"]);
    off();
  });

  test("setTheme persists, toggleTheme swaps, and initTheme is idempotent", () => {
    expect(setTheme("paper")).toBe("paper");
    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe("paper");
    expect(toggleTheme()).toBe("marginalia");
    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe("marginalia");
    // initTheme reapplies the stored choice without changing it.
    expect(initTheme()).toBe("marginalia");
    expect(getTheme()).toBe("marginalia");
  });

  test("a broken subscriber does not stop the others", () => {
    const seen = [];
    onThemeChange(() => {
      throw new Error("boom");
    });
    onThemeChange((t) => seen.push(t));
    expect(() => applyTheme("paper")).not.toThrow();
    expect(seen).toContain("paper");
  });
});

describe("ui/toast.js contract", () => {
  beforeEach(() => installDom());
  afterEach(() => restoreDom());

  test("createToastHost adopts the page's live region once", () => {
    // Both pages ship this exact element; the host must adopt it, not add one.
    const root = makeElement("body");
    const existing = makeElement("div");
    existing.className = "rp-toast-region";
    existing.setAttribute("role", "status");
    existing.setAttribute("aria-live", "polite");
    root.appendChild(existing);
    const host = createToastHost({ root });
    expect(typeof host.toast).toBe("function");
    expect(typeof host.dismiss).toBe("function");
    expect(typeof host.destroy).toBe("function");
    expect(host.region).toBe(existing);
    expect(host.region.getAttribute("role")).toBe("status");
    expect(host.region.getAttribute("aria-live")).toBe("polite");
    // A second host adopts the same region rather than mounting a new one.
    expect(createToastHost({ root }).region).toBe(existing);
    expect(root.children.length).toBe(1);
  });

  test("danger tone marks the toast as an alert and returns a dismiss function", () => {
    const region = makeElement("div");
    const host = createToastHost({ region });
    const dismiss = host.toast("Could not save", { tone: "danger" });
    expect(typeof dismiss).toBe("function");
    const node = region.children[0];
    expect(node.classList.contains("rp-toast")).toBe(true);
    expect(node.classList.contains("rp-toast--danger")).toBe(true);
    expect(node.getAttribute("role")).toBe("alert");
    expect(dismiss).not.toThrow();
  });

  test("an action renders an inline control wired to onSelect", () => {
    const region = makeElement("div");
    const host = createToastHost({ region });
    let picked = 0;
    host.toast("Message deleted.", {
      action: { label: "Undo", onSelect: () => (picked += 1) },
    });
    const button = region.children[0].children.find(
      (c) => c.tagName === "BUTTON" && c.textContent === "Undo",
    );
    expect(button).toBeTruthy();
    button.dispatch("click");
    expect(picked).toBe(1);
  });

  test("createNotifier keeps the chat adapter shape and maps error to danger", () => {
    const region = makeElement("div");
    const status = makeElement("p");
    const notifier = createNotifier({ region, status });
    expect(typeof notifier.toast).toBe("function");
    expect(typeof notifier.setStatus).toBe("function");
    expect(typeof notifier.clear).toBe("function");
    expect(notifier.region).toBe(region);

    const handle = notifier.toast("Boom", {
      tone: "error",
      actionLabel: "Retry",
      onAction: () => {},
    });
    expect(typeof handle.dismiss).toBe("function");
    const node = region.children[0];
    expect(node.classList.contains("rp-toast--danger")).toBe(true);
    expect(node.getAttribute("role")).toBe("alert");

    notifier.setStatus("Writing a reply.");
    expect(status.textContent).toBe("Writing a reply.");

    notifier.clear();
    expect(region.textContent).toBe("");
    expect(status.textContent).toBe("");
  });

  test("createNotifier requires a region", () => {
    expect(() => createNotifier({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Undo toast: the misclick trap and the window (regressions for the report)
// ---------------------------------------------------------------------------
describe("runWithUndo — the undo window", () => {
  beforeEach(() => installDom());
  afterEach(() => restoreDom());

  // The defect: every toast rendered an × that removed the toast but left the
  // action's own commit timer running, so a misclicked × lost the Undo for
  // good. An action-bearing toast must expose NO such dismissal.
  test("an undo toast offers no dismissal control that forecloses the undo", async () => {
    const region = makeElement("div");
    const notifier = createNotifier({ region });
    const handle = runWithUndo({ notifier, message: "Message deleted.", undo: () => {} });

    const node = region.children[0];
    expect(node).toBeTruthy();
    // No generic close control of any kind.
    expect(node.querySelector(".rp-toast__close")).toBe(null);
    expect(node.children.some((c) => c.classList.contains("rp-toast__close"))).toBe(false);
    // Exactly one control: Undo.
    const controls = node.children.filter((c) => c.tagName === "BUTTON");
    expect(controls.map((c) => c.textContent)).toEqual(["Undo"]);
    // Undo stays reachable for as long as the toast exists, and taking it
    // closes the window so the deferred commit never runs.
    controls[0].dispatch("click");
    await Promise.resolve();
    expect(handle.undone).toBe(true);
    expect(region.children.length).toBe(0);
  });

  test("a plain toast still carries its × dismissal", () => {
    const region = makeElement("div");
    const host = createToastHost({ region });
    host.toast("Saved.");
    const close = region.children[0].children.find((c) => c.classList.contains("rp-toast__close"));
    expect(close).toBeTruthy();
    close.dispatch("click");
    expect(region.children.length).toBe(0);
  });

  // The defect: the notifier gave an action toast `duration + 3000`, so Undo
  // stayed clickable for ~1.2s after the action had committed.
  test("an undo toast lives exactly as long as its window — no added grace", () => {
    const realSetTimeout = globalThis.setTimeout;
    const delays = [];
    globalThis.setTimeout = (fn, ms) => {
      delays.push(ms);
      return realSetTimeout(fn, ms);
    };
    try {
      const region = makeElement("div");
      const notifier = createNotifier({ region });
      const handle = runWithUndo({
        notifier,
        message: "Message deleted.",
        undo: () => {},
        commit: () => {},
      });
      // The toast host is the ONLY clock, and it fires at the window exactly.
      expect(delays).toEqual([UNDO_WINDOW_MS]);
      handle.settle();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("the toast expires once, and only then does the commit run", async () => {
    const realSetTimeout = globalThis.setTimeout;
    // Fire scheduled timers on the next tick so the case is deterministic.
    globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
    try {
      const region = makeElement("div");
      const notifier = createNotifier({ region });
      let committed = 0;
      runWithUndo({
        notifier,
        message: "Message deleted.",
        undo: () => {},
        commit: () => { committed += 1; },
      });
      expect(region.children.length).toBe(1); // visible before the window closes
      const settled = Promise.withResolvers<void>();
      realSetTimeout(settled.resolve, 5);
      await settled.promise;
      expect(committed).toBe(1);
      expect(region.children.length).toBe(0); // gone the moment it commits
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("taking Undo suppresses the deferred commit", async () => {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
    try {
      const region = makeElement("div");
      const notifier = createNotifier({ region });
      let committed = 0;
      const handle = runWithUndo({
        notifier,
        message: "Message deleted.",
        undo: () => {},
        commit: () => { committed += 1; },
      });
      region.children[0].children.find((c) => c.textContent === "Undo").dispatch("click");
      const settled = Promise.withResolvers<void>();
      realSetTimeout(settled.resolve, 5);
      await settled.promise;
      expect(handle.undone).toBe(true);
      expect(committed).toBe(0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  // The defect: a full stack evicted the OLDEST toast, which could be the undo
  // toast, silently losing the undo. Eviction must prefer a toast with no
  // action, and never drop an action toast while its window is open.
  test("eviction never drops an undo toast while its window is open", () => {
    const region = makeElement("div");
    const notifier = createNotifier({ region });
    const handle = runWithUndo({ notifier, message: "Message deleted.", undo: () => {} });
    const undoNode = region.children[0];
    // Bury it under a burst of plain toasts, each with no timer of its own.
    for (let i = 0; i < 10; i += 1) notifier.toast(`filler ${i}`, { duration: 0 });
    expect(region.children.includes(undoNode)).toBe(true);
    expect(undoNode.querySelector(".rp-toast__close")).toBe(null);
    expect(undoNode.children.some((c) => c.textContent === "Undo")).toBe(true);
    handle.settle();
  });
});

// ---------------------------------------------------------------------------
// sw.js shell list and cache version
// ---------------------------------------------------------------------------
describe("sw.js precache shell", () => {
  const src = fs.readFileSync(path.join(import.meta.dir, "..", "public", "sw.js"), "utf8");

  test("does not precache the deleted editorial.css", () => {
    expect(src).not.toContain("editorial.css");
  });

  test("CACHE version was bumped past v3", () => {
    const m = src.match(/const CACHE = "([^"]+)"/);
    expect(m).toBeTruthy();
    const version = m[1];
    expect(version).not.toBe("vibe-rp-shell-v3");
    const n = Number(version.match(/v(\d+)$/)?.[1]);
    expect(n).toBeGreaterThanOrEqual(4);
  });

  test("every precached shell entry exists on disk", () => {
    const block = src.match(/const SHELL = \[([\s\S]*?)\];/);
    expect(block).toBeTruthy();
    const entries = [...block[1].matchAll(/"\.\/([^"]+)"/g)].map((m) => m[1]);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries).not.toContain("editorial.css");
    const publicDir = path.join(import.meta.dir, "..", "public");
    for (const rel of entries) {
      expect(fs.existsSync(path.join(publicDir, rel))).toBe(true);
    }
  });
});
