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

  // A character/preset name is user data and can be arbitrarily long. An
  // unbounded name stretched one card five lines tall and pushed the detail
  // sheet's byline, scenario pill and tabs far down the page. Both name
  // surfaces must clamp to a bounded number of lines with an ellipsis.
  describe("long character names are clamped, not allowed to push layout", () => {
    test("the card title clamps to two lines", () => {
      const rule = ruleFor(componentsCss, ".rp-card__title {");
      expect(rule).not.toBeNull();
      expect(rule).toContain("-webkit-line-clamp: 2");
      expect(rule).toContain("-webkit-box-orient: vertical");
      expect(rule).toContain("overflow: hidden");
    });

    test("the detail-sheet name clamps and steps its size down on a narrow sheet", () => {
      const rule = ruleFor(libraryCss, ".rp-detail__name {");
      expect(rule).not.toBeNull();
      expect(rule).toContain("-webkit-line-clamp: 2");
      expect(rule).toContain("overflow: hidden");
      // A clamp without a shrink step still overflows at a big display size.
      expect(rule).toContain("clamp(");
    });
  });

  // On touch there is no hover, so the "Change artwork" scrim used to rest as
  // the FULL-COVER overlay and dimmed the portrait on every phone. It must
  // become a small corner chip instead, and the label must give way to an icon
  // so the chip is not nearly as wide as the portrait it sits on.
  describe("the artwork affordance never covers the portrait on touch", () => {
    test("the coarse-pointer scrim is a small fixed-size chip", () => {
      // There are two `@media (pointer: coarse)` blocks in this sheet; find the
      // one that styles the portrait hint.
      const marker = "@media (pointer: coarse) {\n  .rp-detail__portrait-hint {";
      const start = libraryCss.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      const open = libraryCss.indexOf("{", start);
      let depth = 0;
      let block = "";
      for (let i = open; i < libraryCss.length; i++) {
        if (libraryCss[i] === "{") depth++;
        else if (libraryCss[i] === "}") {
          depth--;
          if (depth === 0) {
            block = libraryCss.slice(open + 1, i);
            break;
          }
        }
      }
      expect(block).toContain("width: 30px");
      expect(block).toContain("height: 30px");
      // It must pin to a corner, not stretch to `inset: 0`.
      expect(block).toContain("inset: auto");
      // The label is dropped on touch; the icon is shown in its place.
      expect(block).toContain(".rp-detail__portrait-hint-text");
      expect(block).toContain("display: none");
      expect(block).toContain(".rp-detail__portrait-hint-icon");
    });

    test("the icon is hidden by default so it only appears on the touch chip", () => {
      const rule = ruleFor(libraryCss, ".rp-detail__portrait-hint-icon {");
      expect(rule).not.toBeNull();
      expect(rule).toContain("display: none");
    });

    test("the fine-pointer scrim still rests as the full overlay", () => {
      // Guard the other direction: the desktop hover treatment is unchanged.
      const rule = ruleFor(libraryCss, ".rp-detail__portrait-hint {");
      expect(rule).not.toBeNull();
      expect(rule).toContain("inset: 0");
    });
  });

  describe("settings modal mobile reflow", () => {
    test("tab buttons carry flex-shrink: 0 so horizontal tabs do not crush", () => {
      const rule = ruleFor(componentsCss, ".rp-tab {");
      expect(rule).not.toBeNull();
      expect(rule).toContain("flex-shrink: 0");
    });

    test("settings tabs wrap into multi-row segmented pills on mobile", () => {
      expect(componentsCss).toContain(".rp-settings__tabs {");
      expect(componentsCss).toContain("flex-wrap: wrap");
      expect(componentsCss).toContain(".rp-settings__tabs .rp-tab {");
      expect(componentsCss).toContain("border-radius: var(--radius-md)");
    });

    test("storage stats collapse to a 2-column grid on mobile", () => {
      expect(componentsCss).toContain(".rp-storage-stats {");
      expect(componentsCss).toContain("grid-template-columns: repeat(2, 1fr)");
    });

    test("destructive actions and save buttons stack to full width on mobile", () => {
      expect(componentsCss).toContain(".rp-actions-row {");
      expect(componentsCss).toContain("flex-direction: column");
      expect(componentsCss).toContain(".rp-settings__footer .rp-btn");
      expect(componentsCss).toContain("min-height: var(--tap-min)");
    });
  });
});
