// Responsive layout guards for the phone-width regressions.
//
// These pin three CSS contracts that were each broken on a real ~320-360px
// phone. They are source-level guards: the repo has no DOM/CSS engine in the
// suite, so the contract is asserted against the stylesheet text (the same
// style used by unified_modules.test.ts for sw.js). Each assertion names the
// exact selector + declaration that prevents the regression, so a revert of
// the fix fails the test.
//
//   1. Library filter bar: Sort and Tag must share one row below the
//      full-width Search field. Their desktop `min-width: 140px` plus the gap
//      exceeded a 360px row and wrapped Tag onto a third line. The mobile rule
//      must therefore neutralise that min-width and let the pair split the row.
//   2. Persona/directive row badge: the "Default" badge is atomic (flex: none,
//      nowrap) so a long preset name truncates instead of squeezing the badge
//      until its text spills past its own border.
//   3. Message speaker: `.rp-message__title` must be allowed to shrink
//      (min-width: 0). Without it a flex item's automatic minimum size is its
//      content, so a long user persona name pushed the speaker span off-screen
//      (measured 545px wide on a 320px viewport).
import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const PUBLIC = path.join(import.meta.dir, "..", "public");
const libraryCss = fs.readFileSync(path.join(PUBLIC, "ui", "library.css"), "utf8");
const componentsCss = fs.readFileSync(path.join(PUBLIC, "design", "components.css"), "utf8");

/** The `@media (max-width: 720px) { ... }` block from library.css. */
function libraryMobileBlock() {
  const start = libraryCss.indexOf("@media (max-width: 720px)");
  expect(start).toBeGreaterThan(-1);
  // Match braces from the first `{` after the query.
  const open = libraryCss.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < libraryCss.length; i++) {
    if (libraryCss[i] === "{") depth++;
    else if (libraryCss[i] === "}") {
      depth--;
      if (depth === 0) return libraryCss.slice(open + 1, i);
    }
  }
  throw new Error("unterminated @media block");
}

/** The declaration block for a selector, or null when absent. */
function ruleFor(css, selector) {
  const idx = css.indexOf(selector);
  if (idx === -1) return null;
  const open = css.indexOf("{", idx);
  const close = css.indexOf("}", open);
  if (open === -1 || close === -1) return null;
  // Strip comments so a declaration cannot be "found" inside prose that
  // documents it (a comment mentioning `min-width: 0` is not the declaration).
  return css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("Responsive layout guards", () => {
  describe("library filter bar stays inline on phones", () => {
    const mobile = libraryMobileBlock();

    test("Sort and Tag share the row instead of each keeping a 140px floor", () => {
      const rule = ruleFor(mobile, ".rp-library__sort,\n  .rp-library__tags");
      expect(rule).not.toBeNull();
      // The pair must be allowed to shrink: flex-basis 0 and min-width 0.
      expect(rule).toContain("flex: 1 1 0");
      expect(rule).toContain("min-width: 0");
    });

    test("the mobile selects drop the desktop 140px minimum", () => {
      const rule = ruleFor(mobile, ".rp-library__sort .rp-select,\n  .rp-library__tags .rp-select");
      expect(rule).not.toBeNull();
      expect(rule).toContain("min-width: 0");
      expect(rule).toContain("width: 100%");
    });

    test("the desktop floor is still present above the breakpoint", () => {
      // Guard against deleting the desktop rule while fixing mobile.
      const desktop = ruleFor(libraryCss, ".rp-library__sort .rp-select,");
      expect(desktop).not.toBeNull();
      expect(desktop).toContain("min-width: 140px");
    });
  });

  describe("preset-row badge is atomic beside a long name", () => {
    test("the Default badge cannot be squeezed by a long title", () => {
      const rule = ruleFor(componentsCss, ".rp-persona-row__heading .rp-badge,");
      expect(rule).not.toBeNull();
      expect(rule).toContain("flex: none");
      expect(rule).toContain("white-space: nowrap");
    });

    test("the row title still truncates rather than wrapping", () => {
      const rule = ruleFor(componentsCss, ".rp-persona-row__title,");
      expect(rule).not.toBeNull();
      expect(rule).toContain("text-overflow: ellipsis");
      expect(rule).toContain("white-space: nowrap");
    });
  });

  describe("message speaker truncates instead of running off-screen", () => {
    test(".rp-message__title is allowed to shrink", () => {
      const rule = ruleFor(componentsCss, ".rp-message__title {");
      expect(rule).not.toBeNull();
      expect(rule).toContain("min-width: 0");
    });

    test(".rp-message__speaker keeps its ellipsis contract", () => {
      const chatCss = fs.readFileSync(path.join(PUBLIC, "ui", "chat", "chat.css"), "utf8");
      const rule = ruleFor(chatCss, ".rp-message__speaker {");
      expect(rule).not.toBeNull();
      expect(rule).toContain("min-width: 0");
      expect(rule).toContain("text-overflow: ellipsis");
    });
  });
});
