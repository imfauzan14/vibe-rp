// UI hardening: the behaviours added in the 2026-09-30 pass.
//
// The pure helper gets a real behavioural test. The rest are contract
// assertions on code that needs a full browser to drive — the live probe
// (`live_turn_a11y.mjs`) exercises those end to end, and these keep the
// invariant visible to the suite so a later edit cannot quietly undo it.
import { describe, test, expect, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { prefersReducedMotion, scrollIntoViewRespectingMotion } from "../public/ui/dom.js";

const ROOT = path.join(import.meta.dir, "..");
const PUBLIC = path.join(ROOT, "public");
const read = (rel: string) => fs.readFileSync(path.join(PUBLIC, rel), "utf8");

describe("the one programmatic scroll", () => {
  const realMatchMedia = (globalThis as any).matchMedia;
  const withMotionPreference = (reduce: boolean) => {
    (globalThis as any).matchMedia = () => ({ matches: reduce });
  };
  afterEach(() => {
    if (realMatchMedia === undefined) delete (globalThis as any).matchMedia;
    else (globalThis as any).matchMedia = realMatchMedia;
  });

  test("an explicit smooth scroll is downgraded when the OS asks for less motion", () => {
    // The stylesheet sets `scroll-behavior: auto` under reduced motion, but an
    // explicit `behavior: "smooth"` handed to scrollIntoView outranks it. That
    // was measured on the real page: the option passed straight through, so four
    // call sites kept animating for a reader who had asked them not to.
    withMotionPreference(true);
    const seen: Array<Record<string, unknown>> = [];
    const target = { scrollIntoView: (opts: Record<string, unknown>) => seen.push(opts) };
    scrollIntoViewRespectingMotion(target, { block: "center", behavior: "smooth" });
    expect(seen[0].behavior).toBe("auto");
    // Everything else about the call is preserved.
    expect(seen[0].block).toBe("center");
  });

  test("and is honoured when the OS has no preference", () => {
    withMotionPreference(false);
    const seen: Array<Record<string, unknown>> = [];
    const target = { scrollIntoView: (opts: Record<string, unknown>) => seen.push(opts) };
    scrollIntoViewRespectingMotion(target, { block: "start", behavior: "smooth" });
    expect(seen[0].behavior).toBe("smooth");
  });

  test("no preference, no matchMedia, no element: none of them throw", () => {
    delete (globalThis as any).matchMedia;
    expect(prefersReducedMotion()).toBe(false);
    expect(scrollIntoViewRespectingMotion(null)).toBe(false);
    expect(scrollIntoViewRespectingMotion({})).toBe(false);
  });

  test("every programmatic scroll in the UI goes through it", () => {
    // A direct `scrollIntoView` call anywhere else would silently opt out of the
    // reduced-motion handling, which is exactly how the four gaps appeared.
    for (const file of [
      "ui/chat/search.js",
      "ui/chat/message_feed.js",
      "ui/chat/turn_machine.js",
      "ui/settings/engine_panel.js",
    ]) {
      const src = read(file);
      const direct = src.match(/\.scrollIntoView\(/g) || [];
      expect(direct.length).toBe(0);
    }
  });
});

describe("the search panel has one owner for its open state", () => {
  const src = read("ui/chat/search.js");

  test("Escape reports the close instead of writing the attribute itself", () => {
    // It used to set `root.dataset.open = "false"` directly, which left the
    // toggle advertising `aria-expanded="true"` on a hidden panel and focus
    // stranded inside a `display:none` field. Measured on the real page.
    expect(src).toContain("onClose");
    // The module must not write the attribute, and must not keep a fallback
    // that would let a future caller reintroduce the drift.
    expect(src).not.toMatch(/root\.dataset\.open\s*=/);
    expect(src).not.toContain("root = null");
  });

  test("the count can describe the whole transcript, not just the window", () => {
    // The feed renders a capped window, so counting the DOM reported a phrase in
    // an older turn as "No matches".
    expect(src).toContain("matchTotal");
    expect(src).toContain("onExpand");
    expect(src).toContain("loaded");
  });
});

describe("the settled reply is announced", () => {
  const src = read("ui/chat/message_feed.js");
  const machine = read("ui/chat/turn_machine.js");

  test("the text is written while the element is still a live region", () => {
    // The order is the whole contract: clearing `aria-busy` and retiring the
    // role BEFORE writing the text meant the settled reply landed on an element
    // that was no longer a live region, so it was never announced.
    const write = src.indexOf("proseEl.innerHTML = formatProse(prose);");
    const clearBusy = src.indexOf('proseEl.setAttribute("aria-busy", "false")');
    const retire = src.indexOf("retireLiveRegion(proseEl)");
    expect(write).toBeGreaterThan(-1);
    expect(clearBusy).toBeGreaterThan(write);
    expect(retire).toBeGreaterThan(clearBusy);
    // And the old order must not come back.
    expect(src).not.toMatch(/proseEl\.removeAttribute\("role"\);\s*\n\s*proseEl\.removeAttribute\("aria-live"\);\s*\n\s*proseEl\.classList\.remove\("is-streaming"\)/);
  });

  test("the role is retired, so search highlighting cannot re-announce", () => {
    expect(src).toContain("LIVE_REGION_RETIRE_MS");
    expect(src).toMatch(/setTimeout\(\(\) => \{[\s\S]*?removeAttribute\("role"\)/);
  });

  test("the turn status says the reply is ready rather than going blank", () => {
    expect(machine).toContain('notifier.setStatus("Reply ready.")');
  });
});

describe("editor errors are announced", () => {
  const src = read("ui/editors/editor_dialog.js");

  test("the error carries its role before any text lands in it", () => {
    expect(src).toContain('error.setAttribute("role", "alert")');
    expect(src).toContain("aria-describedby");
  });

  test("a save in flight looks like one", () => {
    expect(src).toMatch(/saveBtn\.disabled = true/);
    expect(src).toContain('saveBtn.setAttribute("aria-busy", "true")');
  });
});

describe("the library seeds samples once, and marks them", () => {
  const page = read("ui/library_page.js");
  const view = read("ui/library_view.js");

  test("the seeding is gated, so a cleared library stays cleared", () => {
    // It used to re-seed whenever the library happened to be empty, so deleting
    // the samples and reloading brought them back and the empty state could
    // never be reached.
    expect(page).toContain("SEEDED_FLAG");
    const claim = page.indexOf("localStorage.setItem(SEEDED_FLAG");
    const check = page.indexOf("LocalDb.getAllCards()");
    expect(claim).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(claim);
    expect(page).not.toContain("seedRosterIfEmpty");
  });

  test("a seeded card is written with the marker and rendered with it", () => {
    expect(page).toContain("sample: true");
    expect(view).toContain("paintSampleBadge");
    expect(view).toContain("rp-card__sample");
  });
});

describe("the 404 page belongs to the design system", () => {
  const html = read("404.html");

  test("it reads the tokens and honours the reader's theme", () => {
    expect(html).toContain("/design/tokens.css");
    expect(html).toContain("/theme-boot.js");
  });

  test("it carries no literal colour of its own", () => {
    // It used to hardcode #0B0C10 / #F3F4F6 / #D8B273 / #9CA3AF, none of which
    // were tokens, so the one page reached by a broken link looked like a
    // different product. The theme-color meta is the single deliberate exception.
    const body = html.slice(html.indexOf("</head>"));
    expect(body).not.toMatch(/#[0-9A-Fa-f]{6}/);
    expect(html).not.toMatch(/background:\s*#/);
  });

  test("the return control takes the touch floor", () => {
    expect(html).toContain("min-height: var(--tap-min)");
  });
});

describe("the toast keeps the page clear of itself", () => {
  const src = read("ui/toast.js");

  test("the host publishes its height and clears it again", () => {
    expect(src).toContain("syncReservedBand");
    expect(src).toContain('"--rp-toast-band"');
    // Count CALL SITES, not mentions: matching the bare name also matched the
    // function's own definition, so removing one call still satisfied the count.
    // The semicolon is what distinguishes a call from the declaration.
    const calls = src.match(/syncReservedBand\(region\);/g) || [];
    expect(calls.length).toBe(4);
  });

  test("both scroll surfaces reserve the band", () => {
    expect(read("ui/chat/chat.css")).toContain("var(--rp-toast-band, 0px)");
    expect(read("ui/library.css")).toContain("var(--rp-toast-band, 0px)");
  });
});

describe("the composer is usable in both modes", () => {
  test("nothing hides the input or Send while choices are live", () => {
    const css = read("ui/chat/chat.css");
    const scope = '.rp-composer[data-mode="choice"][data-has-choices="true"]';
    expect(css).not.toContain(`${scope} .rp-composer__input`);
    expect(css).not.toContain(`${scope} #send-btn`);
  });

  test("the reader's name is the last thing that yields, and stays reachable", () => {
    const css = read("ui/chat/chat.css");
    const composer = read("ui/chat/composer.js");
    // The mobile overrides are written with a `.rp-composer` prefix because the
    // base rules sit BELOW them in the file and would otherwise win.
    expect(css).toContain(".rp-composer .rp-composer__identity .rp-chat__persona");
    expect(composer).toContain("personaNameEl.title = name");
  });
});
